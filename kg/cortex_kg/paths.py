"""Resolve a path cited in a file to the file it means, trying the folders the set-up uses in a fixed order."""
from __future__ import annotations

import os
from pathlib import Path

from .config import Config


def candidates(raw: str, citing_file: Path, cfg: Config) -> list[Path]:
    """The places a cited path may refer to, in the order they are tried."""
    raw = raw.strip().strip("`").rstrip("/")
    if raw.startswith("~"):
        return [Path(os.path.expanduser(raw))]
    p = Path(raw)
    if p.is_absolute():
        return [p]
    parts = raw.split("/")
    out: list[Path] = []
    if parts[0] == "Projects" and cfg.has_projects:
        out.append(cfg.projects_root.joinpath(*parts[1:]))
    if parts[0] == ".claude" or raw.startswith("~/.claude"):
        out.append(cfg.claude_home.joinpath(*parts[1:]))
    out.append(citing_file.parent / raw)
    if cfg.has_projects:
        out.append(cfg.projects_root / raw)
    out.append(cfg.claude_home / raw)
    # a file named inside a skill's folder, or its references folder, as the skill's own text names it
    skills = cfg.claude_home / "skills"
    try:
        for sdir in sorted(d for d in skills.iterdir() if d.is_dir()):
            out += [sdir / raw, sdir / "references" / raw]
    except OSError:
        pass
    out += [skills / raw, cfg.claude_home / "tools" / raw]
    out += [root / raw for root, _label in cfg.memory_dirs]
    if cfg.has_projects:
        out += [cfg.projects_root / "build" / raw, cfg.projects_root / "docs" / raw]
    seen: set[str] = set()
    uniq: list[Path] = []
    for c in out:
        k = str(c)
        if k not in seen:
            seen.add(k)
            uniq.append(c)
    return uniq


def resolve_cited(raw: str, citing_file: Path, cfg: Config) -> str | None:
    """The first candidate that exists, as an absolute path with forward slashes, or None."""
    for c in candidates(raw, citing_file, cfg):
        try:
            if c.exists():
                return str(c.resolve()).replace("\\", "/")
        except OSError:
            continue
    return None


# ---- second pass: a file index for citations that the fixed candidates do not resolve ----------------------------

# folders never worth indexing: dependencies, builds, caches and the large raw datasets. The projects that hold such
# datasets are named in index_skip_under in the configuration (folders relative to the projects folder, such as
# "apps/big-project/"), because the compiler cannot know a person's projects.
SKIP_DIRS = {"node_modules", ".git", ".venv", "venv", "__pycache__", "dist", ".next", ".vercel", ".cache", "cache",
             "target", "coverage", "test-results", "playwright-report", ".pytest_cache", "site-packages", ".turbo",
             "shell-snapshots", "file-history", "session-env", "sessions", "telemetry", "plugins", "downloads"}
DATASET_DIRS = {"data", "datasets", "raw", "models", "checkpoints", "parquet", "corpus"}
ANCHORS = {"projects", "apps", "build", "deliverables", "docs", "inputs", "_shared", ".claude"}
MAX_FILES = 400_000


def classify(raw: str) -> str:
    """'anchored' (starts at a known root), 'relative' (has a folder), 'bare' (a file name) or 'not-a-path'."""
    r = raw.strip().strip("`")
    if r.startswith(("~", "/")) or (len(r) > 2 and r[1] == ":"):
        return "anchored"
    parts = [p for p in r.split("/") if p]
    if not parts:
        return "not-a-path"
    last = parts[-1]
    has_ext = "." in last.strip(".")
    if parts[0].lower() in ANCHORS and len(parts) > 1:
        return "anchored"
    if len(parts) == 1:
        return "bare" if has_ext else "not-a-path"
    if not has_ext and not r.endswith("/"):
        return "not-a-path"          # eg react-dom/server or rPr/solidFill/srgbClr
    return "relative"


class FileIndex:
    """Every file and folder under the set-up's roots, by lower-case name, for suffix and name lookups."""

    _cache: dict[str, "FileIndex"] = {}

    def __init__(self) -> None:
        self.by_name: dict[str, list[str]] = {}
        self.count = 0
        self.truncated = False

    @classmethod
    def build(cls, cfg: Config) -> "FileIndex":
        skip = tuple(str(x).replace("\\", "/").lower().strip("/") + "/" for x in cfg.raw.get("index_skip_under") or [])
        key = f"{cfg.claude_home}|{cfg.projects_root if cfg.has_projects else ''}|{[str(m) for m, _l in cfg.memory_dirs]}|{skip}"
        if key in cls._cache:
            return cls._cache[key]
        idx = cls()
        roots = ([cfg.projects_root] if cfg.has_projects else []) + [m for m, _l in cfg.memory_dirs]
        roots += [cfg.claude_home / d for d in ("rules", "agents", "skills", "tools", "output-styles", "digests",
                                                "register-log", "scheduled-tasks", "agent-memory")]
        for root in roots:
            idx._walk(root, skip)
        cls._cache[key] = idx
        return idx

    def _add(self, path: str) -> None:
        name = path.rsplit("/", 1)[-1].lower()
        self.by_name.setdefault(name, []).append(path)
        self.count += 1

    def _walk(self, root: Path, skip_under: tuple = ()) -> None:
        if not root.exists():
            return
        for dirpath, dirnames, filenames in os.walk(root):
            d = dirpath.replace("\\", "/")
            rel = d.lower()
            dirnames[:] = [n for n in dirnames if n not in SKIP_DIRS and not n.startswith(".")
                           and not (any(s in rel + "/" for s in skip_under) and n.lower() in DATASET_DIRS)]
            self._add(d)
            for f in filenames:
                self._add(f"{d}/{f}")
                if self.count >= MAX_FILES:
                    self.truncated = True
                    return

    def find(self, raw: str) -> tuple[str | None, str]:
        """(path, how) where how is 'live', 'archive' or 'none'. A live match wins over an archived one."""
        r = raw.strip().strip("`").rstrip("/")
        if r.startswith("~/"):
            r = r[2:]
        parts = [p for p in r.replace("\\", "/").split("/") if p and p != "."]
        if not parts:
            return None, "none"
        suffix = "/" + "/".join(parts).lower()
        named = self.by_name.get(parts[-1].lower(), [])
        hits = [p for p in named if p.lower().endswith(suffix)]
        if hits:
            live = [p for p in hits if not _archived(p)]
            if live:
                return sorted(live, key=len)[0], "live"
            return sorted(hits, key=len)[0], "archive"
        # the folders in the citation no longer match, but a file of that name exists: the citation is stale
        if named and "." in parts[-1].strip("."):
            live = [p for p in named if not _archived(p)]
            if live:
                return sorted(live, key=len)[0], "moved"
            return sorted(named, key=len)[0], "archive"
        return None, "none"


def _archived(p: str) -> bool:
    segs = p.lower().split("/")
    return "archive" in segs or "_archive" in segs
