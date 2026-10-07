"""Harvest the controlled vocabulary: the schemes and concepts of the starting vocabulary (ontology/defaults/vocab),
of the person's profile (vocab in the profile folder) and of the private overlay.

A vocabulary file holds one scheme and its concepts (see docs/ONTOLOGY.md). A concept of the profile replaces the
starting concept with the same identifier. Concepts from the overlay are client-confidential and are never written
to a committed file.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from ..config import Config, vocab_files
from ..model import Harvest, Node

ENTITY_SCHEMES = ("entities", "entities-private")


def _files(cfg: Config) -> list[tuple[Path, bool]]:
    return vocab_files(cfg)


def _read(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError("the top level is not an object")
    return data


def _readable(cfg: Config, h: Harvest | None = None) -> list[tuple[Path, bool, dict]]:
    """(file, private, content) for each vocabulary file that can be read. A file that cannot be read, because it is not
    valid UTF-8 or not valid JSON, gives a finding when a harvest is passed, and the build goes on without it."""
    out = []
    for path, private in _files(cfg):
        try:
            out.append((path, private, _read(path)))
        except (OSError, ValueError) as exc:
            if h is not None:
                h.find("B07", "warning", f"The vocabulary file {path.name} could not be read: {exc}.", None,
                       path.as_posix())
    return out


def load(cfg: Config) -> list[dict]:
    """Every concept, with the scheme id added as "scheme" and a "private" flag for overlay concepts. A concept
    of a later file replaces the one with the same id from an earlier file."""
    out: dict[str, dict] = {}
    for path, private, data in _readable(cfg):
        scheme = data.get("scheme", {}).get("id", f"scheme:{path.stem}")
        for c in data.get("concepts", []):
            if isinstance(c, dict) and c.get("id"):
                out[c["id"]] = {**c, "scheme": scheme, "private": private}
    return list(out.values())


class VocabEvidenceError(ValueError):
    """A concept names a source in which neither its label nor an alternative label occurs."""


_FILE_TOKEN = re.compile(r"(?P<p>[~\w./\-]*[\w-]\.\w{1,5})(?::\d+(?:-\d+)?)?")
_DECLARED = re.compile(r"^\s*(decision of|external)\b", re.I)
_MAX_BYTES = 400_000


def _corpus(cfg: Config) -> list[Path]:
    """The files in which a term may be found when its stated source does not hold it, in the order searched."""
    home, files = cfg.claude_home, []
    files += [home / "CLAUDE.md"]
    for pat in ("rules/*.md", "output-styles/*.md", "skills/*/*.md", "skills/*/references/*.md", "tools/*.py",
                "tools/*/*.py"):
        files += sorted(home.glob(pat))
    for root, _label in cfg.memory_dirs:
        if root.is_dir():
            files += sorted(root.glob("*.md"))
    if cfg.has_projects:
        # vocab_corpus names more files, as globs relative to the projects folder (a person's copy may list a README
        # and the register rule scripts)
        for pat in cfg.raw.get("vocab_corpus") or []:
            files += sorted(cfg.projects_root.glob(pat))
    return [f for f in files if f.is_file()]


def _display(cfg: Config, path: Path) -> str:
    """The evidence form that check P08 resolves: relative to the Claude folder, or memory/ or Projects/."""
    roots = [(r.parent, "") for r, _l in cfg.memory_dirs]
    if cfg.has_projects:
        roots.append((cfg.projects_root, "Projects/"))
    roots.append((cfg.claude_home, ""))
    for root, prefix in roots:
        try:
            return prefix + path.relative_to(root).as_posix()
        except ValueError:
            continue
    return path.as_posix()


def _stated_files(cfg: Config, source: str, corpus: list[Path]) -> list[Path]:
    out: list[Path] = []
    for m in _FILE_TOKEN.finditer(source):
        raw = m.group("p")
        cands = [Path(raw.replace("~/.claude", str(cfg.claude_home)))]
        cands += [cfg.claude_home / raw]
        for root, _label in cfg.memory_dirs:
            cands += [root.parent / raw, root / Path(raw).name]
        if cfg.has_projects:
            cands += [cfg.projects_root.parent / raw, cfg.projects_root / raw]
        cands += [f for f in corpus if f.name == Path(raw).name]
        for c in cands:
            try:
                if c.is_file():
                    if c not in out:
                        out.append(c)
                    break
            except OSError:
                continue
    return out


def _first_line(path: Path, patterns: list[re.Pattern]) -> int | None:
    if path.stat().st_size > _MAX_BYTES:
        return None
    for i, line in enumerate(path.read_bytes().decode("utf-8", errors="replace").splitlines(), 1):
        if any(p.search(line) for p in patterns):
            return i
    return None


def locate(cfg: Config, c: dict, corpus: list[Path] | None = None) -> str | None:
    """The evidence of a concept: the first line, in the file it names or else in the corpus, that holds its label or
    an accepted label. None when the concept names no source. A source worded 'decision of ...' or 'external ...'
    is a declared exception and is kept as written. Raises VocabEvidenceError when no line holds the term."""
    source = (c.get("source") or "").strip()
    if not source:
        return None
    if _DECLARED.match(source):
        return source
    labels = [x for x in [c["prefLabel"], *c.get("altLabels", []), *c.get("hiddenLabels", [])] if x]
    ordered = sorted(set(labels), key=lambda s: (-len(s), s))
    corpus = corpus if corpus is not None else _corpus(cfg)
    stated = _stated_files(cfg, source, corpus)
    if not stated and _FILE_TOKEN.search(source) and not corpus:
        # The cited file is not on this machine (a CI runner, or a copy without the memory folder), so the evidence
        # cannot be checked here. The stated source is kept as written, and check P08 reports the missing file.
        return source
    files = [*stated, *[f for f in corpus if f not in stated]]

    def pat(x: str, fold: bool) -> re.Pattern:
        # a label is not matched inside a hyphenated or underscored word (ms in project-ms-da)
        return re.compile(rf"(?<![\w-]){re.escape(x)}(?![\w-])", re.I if fold else 0)

    # exact case first, then a case-insensitive match for labels longer than 3 characters that are not acronyms
    passes = [[pat(x, False) for x in ordered],
              [pat(x, True) for x in ordered if len(x) > 3 and x != x.upper()]]
    for pats in passes:
        for f in files:
            line = _first_line(f, pats)
            if line:
                return f"{_display(cfg, f)}:{line}"
    raise VocabEvidenceError(f"{c['id']} ({c['prefLabel']}): no line of {source} or of the corpus holds the term")


WORLD_PREFIXES = ("client", "org", "person", "instrument")


def harvest(cfg: Config) -> Harvest:
    h = Harvest("vocab")
    corpus = _corpus(cfg)
    missing: list[str] = []
    schemes: dict[str, dict] = {}
    seen: dict[str, tuple[Path, bool, dict]] = {}   # concept id -> its latest definition: the profile replaces a default
    files = _readable(cfg, h)
    for path, private, data in files:
        for c in data.get("concepts", []):
            if isinstance(c, dict) and c.get("id") and c.get("prefLabel"):
                seen[c["id"]] = (path, private, c)
    for path, private, data in files:
        s = data.get("scheme", {})
        sid = s.get("id", f"scheme:{path.stem}")
        schemes.setdefault(sid, {"label": s.get("label") or sid.split(":", 1)[1], "description":
                                 s.get("description"), "path": path, "private": private})
        if not private:
            schemes[sid]["private"] = False
        for c in data.get("concepts", []):
            cid = c.get("id") if isinstance(c, dict) else None
            if not cid or seen.get(cid, (None, None, None))[0] != path or seen[cid][2] is not c:
                continue
            try:
                ev = locate(cfg, c, corpus)
            except VocabEvidenceError as exc:
                # One term whose evidence fails must not remove the whole vocabulary from the graph, so the term is
                # kept with its stated source and the failure is a finding.
                missing.append(str(exc))
                h.find("P08", "warning", f"The evidence of the term {exc}.", cid, str(path.name))
                ev = (c.get("source") or "").strip() or None
            ev = ev or f"{path.name}:1"
            sens = "client-confidential" if private else "internal"
            h.add_node(Node(
                id=cid, label=c["prefLabel"], summary=c.get("definition") or None, date=c.get("ratified"),
                sensitivity=sens, evidence=ev,
                props={"prefLabel": c["prefLabel"], "altLabels": c.get("altLabels", []),
                       "hiddenLabels": c.get("hiddenLabels", []), "definition": c.get("definition"),
                       "status": c.get("status"), "severity": c.get("severity"),
                       "case": c.get("case", "sensitive"), "variant_counts": c.get("variant_counts", {})}))
            h.add_edge(cid, "inScheme", sid, f"{path.name}")
            for target in c.get("denotes", []):
                h.add_edge(cid, "denotes", target, ev)
                # The vocabulary is the source of the world nodes: no file on disk holds a client, an
                # organisation, a person or an instrument, so the concept that names one creates it.
                prefix = target.split(":", 1)[0]
                if prefix in WORLD_PREFIXES and target not in h.nodes:
                    h.add_node(Node(
                        id=target, label=c["prefLabel"], summary=c.get("definition") or None,
                        sensitivity="client-confidential" if (private or prefix == "person") else "internal",
                        evidence=ev, props={"named_by": cid}))
    for sid, s in schemes.items():
        count = sum(1 for e in h.edges.values() if e.r == "inScheme" and e.t == sid)
        h.add_node(Node(id=sid, label=s["label"], summary=s["description"],
                        sensitivity="client-confidential" if s["private"] else "internal",
                        props={"concept_count": count}, evidence=f"{s['path'].name}:1"))
    return h


def patterns(concepts: list[dict]) -> list[tuple[str, str, list[str]]]:
    """(concept id, regex source, node ids it denotes) for the entity concepts.

    The regex matches the preferred label and each accepted label as whole words, longest label first, and is
    case-sensitive unless the concept says its case is "insensitive".
    """
    out: list[tuple[str, str, list[str]]] = []
    for c in concepts:
        if str(c.get("scheme", "")).split(":", 1)[-1] not in ENTITY_SCHEMES:
            continue
        labels = [c["prefLabel"], *c.get("altLabels", [])]
        labels = sorted({lab for lab in labels if lab}, key=lambda s: (-len(s), s))
        if not labels:
            continue
        body = "|".join(re.escape(lab) for lab in labels)
        src = rf"(?<!\w)(?:{body})(?!\w)"
        if c.get("case") == "insensitive":
            src = f"(?i:{src})"
        out.append((c["id"], src, list(c.get("denotes", []))))
    return out
