"""The controlled vocabulary check: variants of a preferred name are found in text and reported.

Each hidden label of a concept in ontology/vocab/*.json, or in the private overlay vocab folder, becomes one
rule. A concept that is only proposed is reported as a warning. A ratified concept is enforced by the register
hook through faults_for_register, which must never raise and needs no Cortex configuration.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

RULES_NAME = "lexicon_rules.json"
_FENCE = re.compile(r"(```|~~~).*?(\1|\Z)", re.S)
_INLINE = re.compile(r"`[^`\n]*`")
_URL = re.compile(r"(?:https?://|www\.)[^\s)>\]]+")
_LINK_TARGET = re.compile(r"(?<=\])\([^)\n]*\)")
# table rows are skipped, as the register hook skips them (prose_only in tools/register/hook.py)
_TABLE = re.compile(r"^[ \t]*\|.*$", re.M)
_QUOTES = [
    re.compile(r'"[^"\n]*"'),
    re.compile(r"“[^”\n]*”"),
    re.compile(r"(?<!\w)'[^'\n]*'(?!\w)"),
    re.compile(r"‘[^’\n]*’"),
]


def _vocab_files(cfg) -> list[Path]:
    files = sorted((cfg.ontology_dir / "vocab").glob("*.json"))
    files += sorted((cfg.overlay_dir / "vocab").glob("*.json"))
    return files


def _blank(m: re.Match) -> str:
    return re.sub(r"[^\n]", " ", m.group(0))


def strip_text(text: str) -> str:
    """Blank out code, URLs, link targets and quotations, keeping every other character at its position."""
    for rx in (_FENCE, _INLINE, _URL, _LINK_TARGET, _TABLE, *_QUOTES):
        text = rx.sub(_blank, text)
    return text


def compile_rules(cfg) -> list[dict]:
    """One rule per hidden label. Writes cfg.data_dir/lexicon_rules.json and returns the rules."""
    rules: list[dict] = []
    for f in _vocab_files(cfg):
        try:
            doc = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for c in doc.get("concepts", []):
            hidden = c.get("hiddenLabels") or c.get("hidden_labels") or []
            sensitive = str(c.get("case", "")).lower() == "sensitive"
            # The accepted forms of the concept protect their own words: "compliance engine" inside
            # "Example Compliance Platform" is part of the full name and is not a fault.
            accepted = [x for x in [c.get("prefLabel"), *(c.get("altLabels") or [])] if x]
            protect = "|".join(re.escape(x) for x in sorted(accepted, key=len, reverse=True))
            # a hyphen counts as part of a word, so "fincrime" inside "da-fincrime-intel" is not a separate match
            protect = (r"(?<![\w-])(?:" + protect + r")(?![\w-])") if protect else ""
            for label in hidden:
                if not label:
                    continue
                core = r"(?<![\w-])" + re.escape(label) + r"(?![\w-])"
                rules.append({
                    "concept": c.get("id"),
                    "pattern": core if sensitive else "(?i)" + core,
                    "found_label": label,
                    "preferred": c.get("prefLabel"),
                    "severity": c.get("severity", "warn"),
                    "status": c.get("status", "proposed"),
                    "protect": protect,
                })
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    (cfg.data_dir / RULES_NAME).write_text(
        json.dumps({"v": 1, "rules": rules}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return rules


def _load_rules(cfg) -> list[dict]:
    p = cfg.data_dir / RULES_NAME
    if p.is_file():
        try:
            if all(p.stat().st_mtime >= f.stat().st_mtime for f in _vocab_files(cfg)):
                return json.loads(p.read_text(encoding="utf-8")).get("rules", [])
        except (OSError, json.JSONDecodeError, AttributeError):
            pass
    return compile_rules(cfg)


def _apply(rules: list[dict], text: str) -> list[dict]:
    clean = strip_text(text)
    hits = []
    for r in rules:
        try:
            rx = re.compile(r["pattern"])
        except re.error:
            continue
        spans = []
        if r.get("protect"):
            try:
                spans = [(m.start(), m.end()) for m in re.finditer(r["protect"], clean)]
            except re.error:
                spans = []
        for m in rx.finditer(clean):
            if any(a <= m.start() and m.end() <= b for a, b in spans):
                continue
            hits.append({"concept": r["concept"], "found": text[m.start():m.end()], "preferred": r["preferred"],
                         "index": m.start(), "severity": r["severity"], "status": r["status"]})
    hits.sort(key=lambda h: (h["index"], h["concept"] or ""))
    return hits


def check_text(cfg, text: str) -> list[dict]:
    """LexiconHit dicts {concept, found, preferred, index, severity, status} for each variant found."""
    return _apply(_load_rules(cfg), text)


def ratify(cfg, concept_id: str, today: str) -> Path:
    """Set the concept to ratified with the date, write its file back and return the path."""
    for f in _vocab_files(cfg):
        try:
            doc = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for c in doc.get("concepts", []):
            if c.get("id") == concept_id:
                c["status"] = "ratified"
                c["ratified"] = today
                f.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
                return f
    raise KeyError(f"no concept {concept_id!r} in the vocabulary files")


def default_rules_path() -> Path:
    if os.environ.get("CORTEX_DATA_DIR"):
        return Path(os.environ["CORTEX_DATA_DIR"]) / RULES_NAME
    try:
        from .config import load_config
        return load_config().data_dir / RULES_NAME
    except Exception:
        return Path.home() / ".claude" / "ranviera" / RULES_NAME


def faults_for_register(text: str, rules_path=None) -> list[tuple[str, str]]:
    """Faults for the register hook from ratified rules only, as ("lexicon", "use 'X' for 'Y'"). Never raises."""
    try:
        p = Path(rules_path) if rules_path else default_rules_path()
        # The register hook already checks the banned words and house phrases with its own lists, so only the
        # named things and domain terms are added here, which keeps each fault from being reported twice.
        rules = [r for r in json.loads(p.read_text(encoding="utf-8")).get("rules", [])
                 if r.get("status") == "ratified"
                 and not str(r.get("concept", "")).startswith(("term:banned-", "term:house-"))]
        out: list[tuple[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for h in _apply(rules, text):
            k = (h["preferred"], h["found"])
            if k not in seen:
                seen.add(k)
                out.append(("lexicon", f"use '{h['preferred']}' for '{h['found']}'"))
        return out
    except Exception:
        return []
