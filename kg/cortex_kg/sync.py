"""Synchronisation of the Claude Code set-up between machines.

export copies the managed files of ~/.claude into harness/, replacing this machine's values with tokens.
doctor compares the mirror, rendered with this machine's values, with the live files.
install places the mirror on a machine, rendering that machine's values into the tokens.

The tokens are {{CLAUDE_HOME}}, {{PROJECTS_ROOT}}, {{CORTEX_ROOT}}, {{HOME}} and {{MEMORY_KEY}}. A path token has
three forms so that a file round-trips exactly: the bare token stands for forward slashes, the suffix :bs for single
backslashes and the suffix :jbs for the doubled backslashes used inside JSON strings.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path

from . import privacy
from .config import Config

MAX_BYTES = 2 * 1024 * 1024
SKILLS_DIR = "skills"


def skill_names(root: Path) -> list[str]:
    """The skill folders under <root>/skills, so that any person's set-up is mirrored, not a fixed list."""
    d = root / SKILLS_DIR
    return sorted(p.name for p in d.iterdir() if p.is_dir() and p.name not in SKIP_DIRS) if d.is_dir() else []
LINK_DIRS = ["rules", "agents", "output-styles"]
SETTINGS_KEEP = ["outputStyle", "env", "hooks", "autoMemoryDirectory", "extraKnownMarketplaces",
                 "skipWorkflowUsageWarning", "agentPushNotifEnabled"]
SETTINGS = "settings.json"
TEMPLATE = "settings.template.json"
RETIRED = "_retired"
SKIP_DIRS = {"__pycache__", "selftest", RETIRED}
SKIP_SUFFIXES = {".pyc", ".pyo"}

# A value that is plainly a placeholder or a reference to a variable is not a secret.
_PLACEHOLDER_VALUE = r"(?!(?:\{\{|\$|<|%|os\.|process\.|env\.|your|example|xxxx|\.\.\.|changeme|placeholder|none\b|null\b))"
SECRET_PATTERNS = [
    ("GitHub token", re.compile(r"gh[opsu]_[A-Za-z0-9]{20,}")),
    ("GitHub fine-grained token", re.compile(r"github_pat_[A-Za-z0-9_]{20,}")),
    ("Anthropic key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{10,}")),
    ("API key with the sk- prefix", re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}")),
    ("AWS access key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("Slack token", re.compile(r"\bxox[abeprs]-[A-Za-z0-9\-]{10,}")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}")),
    ("JSON web token", re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{6,}")),
    ("authorization header", re.compile(r"(?i)\bauthorization[\"']?\s*[:=]\s*[\"']?(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=\-]{8,}")),
    ("bearer token", re.compile(r"(?i)\bbearer\s+" + _PLACEHOLDER_VALUE + r"[A-Za-z0-9._~+/=\-]{20,}")),
    ("credentials in a URL", re.compile(r"\b[a-z][a-z0-9+.\-]*://[^\s/:@\"'<>]+:" + _PLACEHOLDER_VALUE + r"[^\s/@\"'<>{}]{3,}@")),
    ("password value", re.compile(r"(?i)password[\"']?\s*[:=]\s*[\"']?[^\s\"'<>{}$*\[\]()]{4,}")),
    ("key or secret assignment", re.compile(
        r"(?i)(?<![A-Za-z])[a-z0-9_.\-]*(?:api[_\- ]?key|apikey|secret|token|passwd|credential|auth[_\-]?key)[a-z0-9_\-]*"
        r"[\"']?\s*[:=]\s*[\"']?" + _PLACEHOLDER_VALUE + r"[A-Za-z0-9_\-+/=.]{16,}")),
    ("environment-style secret line", re.compile(
        r"^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)=" + _PLACEHOLDER_VALUE +
        r"[^\s\"'<>]{8,}\s*$")),
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]

# Personal contact details and client figures are not secrets, but they must not reach a repository that may be
# pushed. Since 6 October 2026 they are replaced by placeholders (cortex_kg.privacy) whose values stay in the
# machine-local overlay, so no managed file is withheld any more.
PERSONAL_EMAIL = privacy.PERSONAL_EMAIL
PERSONAL_PHONE = privacy.PERSONAL_PHONE


class SecretFound(Exception):
    """Raised when a managed file matches a token pattern. The message names each file and line."""

    def __init__(self, findings: list[tuple[str, int, str]]):
        self.findings = findings
        super().__init__("; ".join(f"{p} line {n}: {kind}" for p, n, kind in findings))


# ---------------------------------------------------------------- values and templating

def profile_dir(cfg: Config) -> Path:
    """The person's own ontology content: profile_dir of the configuration, else <data_dir>/profile."""
    p = getattr(cfg, "profile_dir", None) or cfg.raw.get("profile_dir")
    return Path(os.path.expanduser(str(p))) if p else cfg.data_dir / "profile"


def ledger_roots(cfg: Config) -> list[Path]:
    """Where a rule ledger may hold placeholders: the profile folder, and the folder it replaced."""
    return [profile_dir(cfg) / "ledger", cfg.ontology_dir / "ledger"]


def memory_key(projects_root: Path) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", str(projects_root))


def _home_of(claude_home: Path) -> Path:
    return claude_home.parent if claude_home.name == ".claude" else Path.home()


def _forms(p: Path) -> dict[str, str]:
    fwd = str(p).replace("\\", "/")
    bs = fwd.replace("/", "\\")
    return {"": fwd, ":bs": bs, ":jbs": bs.replace("\\", "\\\\")}


def values(claude_home: Path, projects_root: Path, cortex_root: Path) -> dict[str, str]:
    """The token values for one machine, as plain strings (forward slashes for the paths)."""
    return {
        "CLAUDE_HOME": str(claude_home).replace("\\", "/"),
        "PROJECTS_ROOT": str(projects_root).replace("\\", "/"),
        "CORTEX_ROOT": str(cortex_root).replace("\\", "/"),
        "HOME": str(_home_of(claude_home)).replace("\\", "/"),
        "MEMORY_KEY": memory_key(projects_root),
    }


# Longest, most specific values first, because the Projects folder holds the repository and the home holds both.
_ORDER = ["CORTEX_ROOT", "PROJECTS_ROOT", "CLAUDE_HOME", "HOME", "MEMORY_KEY"]


def _pairs(vals: dict[str, str]) -> list[tuple[str, str, str]]:
    """(token text, literal text, token name) for every form, in replacement order."""
    out = []
    for name in _ORDER:
        v = vals[name]
        if len(v) < 4:
            continue
        if name == "MEMORY_KEY":
            out.append(("{{MEMORY_KEY}}", v, name))
            continue
        for suffix, lit in _forms(Path(v)).items():
            out.append(("{{%s%s}}" % (name, suffix), lit, name))
    return out


def tokenise(text: str, vals: dict[str, str]) -> str:
    for tok, lit, _ in _pairs(vals):
        text = text.replace(lit, tok)
    return text


def render(text: str, vals: dict[str, str]) -> str:
    for tok, lit, _ in _pairs(vals):
        text = text.replace(tok, lit)
    return text


def token_counts(text: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for m in re.finditer(r"\{\{([A-Z_]+)(?::j?bs)?\}\}", text):
        out[m.group(1)] = out.get(m.group(1), 0) + 1
    return out


def _has_tokens(text: str) -> bool:
    return bool(re.search(r"\{\{[A-Z_]+(?::j?bs)?\}\}", text))


def _decode(b: bytes) -> str | None:
    if b"\x00" in b:
        return None
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return None


# ---------------------------------------------------------------- the managed set

def _is_personal(path: Path) -> bool:
    """Whether a file would still hold a personal contact detail after redaction (expected never)."""
    t = _decode(path.read_bytes())
    if t is None:
        return False
    red, _ = privacy.redact(t)
    return bool(PERSONAL_EMAIL.search(red) or PERSONAL_PHONE.search(red))


def withheld_files(home: Path) -> list[str]:
    """Managed files that hold a personal email address or telephone number and are therefore kept out of the mirror."""
    return [r for r in managed_files(home, include_personal=True) if r != SETTINGS and _is_personal(home / r)]


def managed_files(home: Path, include_personal: bool = False) -> list[str]:
    """Relative paths, with forward slashes, of the managed files that exist under home (settings.json included).

    A file that holds personal contact details is left out unless include_personal is set.
    """
    rels: list[Path] = []

    def add(pattern_dir: str, glob: str) -> None:
        d = home / pattern_dir if pattern_dir else home
        if d.is_dir():
            rels.extend(f for f in sorted(d.glob(glob)) if f.is_file())

    add("", "CLAUDE.md")
    add("rules", "*.md")
    add("agents", "*.md")
    add("output-styles", "*.md")
    for s in skill_names(home):
        d = home / "skills" / s
        if d.is_dir():
            rels.extend(f for f in sorted(d.rglob("*")) if f.is_file())
    add("tools", "*.py")
    add("tools/register", "*.py")
    add("tools/register", "routes.json")
    if (home / SETTINGS).is_file():
        rels.append(home / SETTINGS)
    out = []
    for f in rels:
        rel = f.relative_to(home)
        if any(part in SKIP_DIRS for part in rel.parts) or f.suffix in SKIP_SUFFIXES or f.stat().st_size > MAX_BYTES:
            continue
        if not include_personal and rel.as_posix() != SETTINGS and _is_personal(f):
            continue
        out.append(rel.as_posix())
    return sorted(set(out))


def _mirror_name(rel: str) -> str:
    return TEMPLATE if rel == SETTINGS else rel


def _live_name(mirror_rel: str) -> str:
    return SETTINGS if mirror_rel == TEMPLATE else mirror_rel


def _filter_settings(text: str) -> str:
    d = json.loads(text)
    kept = {k: d[k] for k in SETTINGS_KEEP if k in d}
    return json.dumps(kept, indent=2, ensure_ascii=False) + "\n"


def _live_content(home: Path, rel: str) -> bytes:
    """The live file as it is compared: settings.json is reduced to the kept keys."""
    b = (home / rel).read_bytes()
    if rel == SETTINGS:
        return _filter_settings(b.decode("utf-8")).encode("utf-8")
    return b


def _canonical(rel: str, b: bytes) -> bytes:
    if rel == SETTINGS:
        return json.dumps(json.loads(b.decode("utf-8")), sort_keys=True).encode("utf-8")
    return b


def _entropy(token: str) -> float:
    counts = {c: token.count(c) for c in set(token)}
    return -sum(n / len(token) * math.log2(n / len(token)) for n in counts.values())


_LONG_TOKEN = re.compile(r"[A-Za-z0-9+_\-]{40,}")  # a slash ends a run, so a path is read in its parts


def _high_entropy(line: str) -> bool:
    """A second guard for a secret that no pattern names: a long run of mixed-case letters and digits with high
    entropy, outside a path or a URL, that is not a hex digest."""
    for m in _LONG_TOKEN.finditer(line):
        tok = m.group(0)
        before = line[max(0, m.start() - 1):m.start()]
        if before in ("/", "\\", ".") or re.fullmatch(r"[0-9a-fA-F]+", tok):
            continue
        if re.search(r"[a-z]", tok) and re.search(r"[A-Z]", tok) and re.search(r"\d", tok) \
                and _entropy(tok) >= 4.5 and sum(c.isupper() or c.isdigit() for c in tok) / len(tok) >= 0.3:
            return True
    return False


def _scan(rel: str, text: str) -> list[tuple[str, int, str]]:
    hits = []
    for n, line in enumerate(text.splitlines(), 1):
        for kind, rx in SECRET_PATTERNS:
            if rx.search(line):
                hits.append((rel, n, kind))
        if _high_entropy(line):
            hits.append((rel, n, "high-entropy string"))
    return hits


def _sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ---------------------------------------------------------------- export

def _write_if_changed(dest: Path, data: bytes) -> bool:
    """Writes the file only when its bytes differ, so an export with no change touches nothing and git sees no change."""
    try:
        if dest.is_file() and dest.read_bytes() == data:
            return False
    except OSError:
        pass
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return True


def _retire(mirror: Path, rels: list[str], dry_run: bool) -> list[str]:
    """Moves mirror files whose live source is gone to <mirror>/_retired/<date>/, which doctor and install ignore.
    Nothing is deleted. The content stays in the working tree and in git history, so a file that held something
    that must not be kept needs git filter-repo by hand."""
    moved = []
    day = date.today().isoformat()
    for rel in rels:
        src = mirror / rel
        dst = mirror / RETIRED / day / rel
        moved.append(rel)
        if dry_run:
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            dst.unlink()
        shutil.move(str(src), str(dst))
        parent = src.parent
        while parent != mirror and parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent
    return moved


def export(cfg: Config, dry_run: bool = False) -> dict:
    home = cfg.claude_home
    vals = values(home, cfg.projects_root, cfg.repo_root)
    files = managed_files(home)
    contents: dict[str, tuple[bytes, str | None]] = {}
    findings: list[tuple[str, int, str]] = []
    for rel in files:
        b = _live_content(home, rel)
        t = _decode(b)
        if t is not None:
            findings += _scan(rel, t)
        contents[rel] = (b, t)
    if findings:
        raise SecretFound(findings)

    mirror = cfg.harness_dir
    if dry_run and not privacy.key_path(cfg.overlay_dir).is_file():
        key = os.urandom(privacy.KEY_BYTES)  # a dry run does not create the key file
    else:
        key = privacy.get_key(cfg.overlay_dir)
    terms = privacy.terms_for(cfg)
    counts: dict[str, int] = {}
    hashes: dict[str, str] = {}
    written = 0
    changed = 0
    private: dict[str, str] = {}
    outputs: dict[str, bytes] = {}
    commercial: list[tuple[str, int, str]] = []
    for rel, (b, t) in contents.items():
        hashes[rel] = _sha(b)
        if t is not None:
            t, found = privacy.redact(t, key, terms)
            private.update(found)
            commercial += [(rel, n, "commercial terms of a client: " + line) for n, line in privacy.commercial_detail(t, terms)]
        out = b if t is None else tokenise(t, vals).encode("utf-8")
        if t is not None:
            for k, v in token_counts(out.decode("utf-8")).items():
                counts[k] = counts.get(k, 0) + v
        outputs[_mirror_name(rel)] = out
        written += 1
    if commercial:
        raise SecretFound(commercial)

    if not dry_run:
        # a legacy placeholder in the mirror or the ledger is re-keyed first, so nothing keeps the old hash
        privacy.migrate(cfg.overlay_dir, [mirror, *ledger_roots(cfg)])
    stale = [m for m in _mirror_files(mirror) if not (home / _live_name(m)).is_file()]
    retired = _retire(mirror, stale, dry_run)
    for name, out in outputs.items():
        if dry_run:
            continue
        if _write_if_changed(mirror / name, out):
            changed += 1
    # The manifest holds no time and no host name, so it changes only when a file or a token value does.
    manifest = {"v": 1, "tokens": vals, "files": hashes}
    if not dry_run:
        if _write_if_changed(mirror / "MANIFEST.json", (json.dumps(manifest, indent=2) + "\n").encode("utf-8")):
            changed += 1
        privacy.save_values(cfg.overlay_dir, private)
    counts["PRIVATE"] = len(private)
    return {"files": written, "changed": changed, "retired": retired, "tokens": counts, "withheld": withheld_files(home),
            "mirror": str(mirror).replace("\\", "/"), "dry_run": dry_run}


# ---------------------------------------------------------------- doctor

def _mirror_files(mirror: Path) -> list[str]:
    if not mirror.is_dir():
        return []
    return sorted(f.relative_to(mirror).as_posix() for f in mirror.rglob("*")
                  if f.is_file() and f.name != "MANIFEST.json" and not any(p in SKIP_DIRS for p in f.parts))


def doctor(cfg: Config) -> dict:
    home = cfg.claude_home
    vals = values(home, cfg.projects_root, cfg.repo_root)
    private = privacy.load_values(cfg.overlay_dir)
    live = managed_files(home)
    mirror_rels = {_live_name(m) for m in _mirror_files(cfg.harness_dir)}
    changed, missing_in_mirror = [], []
    for rel in live:
        mp = cfg.harness_dir / _mirror_name(rel)
        if not mp.is_file():
            missing_in_mirror.append(rel)
            continue
        mb = mp.read_bytes()
        mt = _decode(mb)
        rendered = mb if mt is None else render(privacy.restore(mt, private), vals).encode("utf-8")
        try:
            same = _canonical(rel, rendered) == _canonical(rel, _live_content(home, rel))
        except (ValueError, UnicodeDecodeError):
            same = False
        if not same:
            changed.append(rel)
    missing_in_home = sorted(r for r in mirror_rels if not (home / r).is_file())
    return {"withheld": withheld_files(home), "checked": live, "changed": changed, "missing_in_mirror": missing_in_mirror,
            "missing_in_home": missing_in_home}


# ---------------------------------------------------------------- install

CORTEX_HOOK_SCRIPTS = ("cortex_hook.py", "cortex_session.py")


def merge_settings(dst: Path, template_out: bytes, data_dir: Path | None = None) -> dict:
    """Adds the Cortex hook entries of the rendered template to an existing settings.json and changes nothing else.

    The merge is the one of hookinstall.py: an entry is a Cortex entry when one of its commands runs cortex_hook.py or
    cortex_session.py (or the runner in <data_dir>/bin/), and it is added only when its event holds no Cortex entry of
    the same kind. Every other key, hook event and hook entry stays as it is, a file that is not valid JSON is left
    untouched and the layout of the file is kept. The caller has already backed the file up."""
    from . import hookinstall
    try:
        existing = json.loads(dst.read_text(encoding="utf-8"))
        template = json.loads(template_out.decode("utf-8"))
    except ValueError:
        return {"bytes": None, "note": "settings.json is not valid JSON, so it was left unchanged"}
    if not isinstance(existing, dict) or not isinstance(template, dict):
        return {"bytes": None, "note": "settings.json is not a JSON object, so it was left unchanged"}
    try:
        added = hookinstall.merge_template(existing, template, data_dir)
    except hookinstall.HooksError:
        return {"bytes": None, "note": "settings.json has a hooks value that is not an object, so it was left unchanged"}
    if added == 0:
        return {"bytes": None, "note": "settings.json already holds the Cortex hook entries, so it was left unchanged"}
    out = hookinstall._dump(existing, dst.read_text(encoding="utf-8"))
    return {"bytes": out, "note": f"settings.json: added {added} Cortex hook entries and kept every other entry"}


def _link(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        r = subprocess.run(["cmd", "/c", "mklink", "/J", str(dst), str(src)], capture_output=True, text=True)
        if r.returncode != 0:
            raise OSError(r.stderr.strip() or r.stdout.strip())
    else:
        os.symlink(src, dst, target_is_directory=True)


def _dir_has_tokens(d: Path) -> bool:
    for f in d.rglob("*"):
        if f.is_file():
            t = _decode(f.read_bytes())
            if t is not None and (_has_tokens(t) or privacy.has_placeholders(t)):
                return True
    return False


NEXT_STEPS = [
    "pip install -r requirements.txt",
    "npm install",
    "python cortex.py build",
    "claude auth login",
]


def install(cfg: Config, target_home: str | os.PathLike | None = None, projects_root: str | os.PathLike | None = None,
            mode: str = "copy", dry_run: bool = False) -> dict:
    if mode not in ("copy", "link"):
        raise ValueError("mode must be copy or link")
    home = Path(target_home).resolve() if target_home else cfg.claude_home
    proj = Path(projects_root).resolve() if projects_root else cfg.projects_root
    vals = values(home, proj, cfg.repo_root)
    private = privacy.load_values(cfg.overlay_dir)
    mirror = cfg.harness_dir
    mirror_rels = [m for m in _mirror_files(mirror)]
    plan: list[str] = []
    stamp = f"{date.today().isoformat()}-cortex-install"
    backup_root = home / "backups" / stamp

    # 1. backups of every managed file that exists in the target
    backed = 0
    for m in mirror_rels:
        live = home / _live_name(m)
        if live.is_file():
            plan.append(f"backup {_live_name(m)}")
            backed += 1
            if not dry_run:
                dest = backup_root / _live_name(m)
                if dest.exists() and _live_name(m) == SETTINGS:
                    # a second install on the same day keeps the first backup and makes another for this one
                    dest = dest.with_name(f"settings.{datetime.now().strftime('%H%M%S%f')}.json")
                if not dest.exists():
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(live, dest)

    # 2. linked folders
    linked: set[str] = set()
    if mode == "link":
        folders = LINK_DIRS + [f"skills/{s}" for s in skill_names(mirror)]
        for rel in folders:
            src = mirror / rel
            dst = home / rel
            if not src.is_dir():
                continue
            if _dir_has_tokens(src):
                plan.append(f"copy {rel} (holds machine values)")
            elif dst.exists() or dst.is_symlink():
                plan.append(f"copy {rel} (target exists, nothing is deleted)")
            else:
                if dry_run:
                    plan.append(f"link {rel}")
                    linked.add(rel)
                    continue
                try:
                    _link(src, dst)
                except OSError as e:
                    plan.append(f"copy {rel} (link failed: {e})")
                    continue
                plan.append(f"link {rel}")
                linked.add(rel)

    # 3. render-copy the rest
    copied = 0
    for m in mirror_rels:
        live_rel = _live_name(m)
        if any(m == l or m.startswith(l + "/") for l in linked):
            continue
        plan.append(f"copy {live_rel}")
        copied += 1
        if dry_run:
            continue
        mb = (mirror / m).read_bytes()
        mt = _decode(mb)
        out = mb if mt is None else render(privacy.restore(mt, private), vals).encode("utf-8")
        dst = home / live_rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if live_rel == SETTINGS and dst.is_file():
            merged = merge_settings(dst, out, cfg.data_dir)
            plan.append(merged["note"])
            if merged["bytes"] is None:
                continue
            out = merged["bytes"]
        dst.write_bytes(out)

    if dry_run:
        for line in plan:
            print(line)
    print("Next steps:")
    for i, s in enumerate(NEXT_STEPS, 1):
        print(f"  {i}. {s}")
    return {"target_home": str(home).replace("\\", "/"), "mode": mode, "dry_run": dry_run, "backed_up": backed,
            "copied": copied, "linked": sorted(linked), "plan": plan, "next_steps": NEXT_STEPS}


# ---------------------------------------------------------------- command line

def main(argv: list[str] | None = None) -> int:
    from .config import load_config
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in ("export", "doctor", "install", "migrate"):
        print("usage: python -m cortex_kg.sync export|doctor|install|migrate [--dry-run] [--mode copy|link]")
        return 2
    cfg = load_config()
    cmd = argv[0]
    dry = "--dry-run" in argv
    try:
        if cmd == "export":
            res = export(cfg, dry_run=dry)
        elif cmd == "doctor":
            res = doctor(cfg)
        elif cmd == "migrate":
            res = privacy.migrate(cfg.overlay_dir, [cfg.harness_dir, *ledger_roots(cfg)], dry_run=dry)
        else:
            mode = argv[argv.index("--mode") + 1] if "--mode" in argv else "copy"
            res = install(cfg, mode=mode, dry_run=dry)
    except SecretFound as e:
        print(f"Export refused: {e}")
        return 1
    print(json.dumps({k: v for k, v in res.items() if k != "checked"}, indent=2))
    return 1 if cmd == "doctor" and (res["changed"] or res["missing_in_mirror"] or res["missing_in_home"]) else 0


if __name__ == "__main__":
    raise SystemExit(main())
