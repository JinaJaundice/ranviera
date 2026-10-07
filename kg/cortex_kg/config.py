"""Paths and settings for Cortex and Ranviera.

The configuration is read from cortex.config.json in the repository root, or from the file named in the
environment variable CORTEX_CONFIG. Missing keys take the defaults below. Every path may start with ~.
The environment variables CORTEX_DATA_DIR and CORTEX_ONTOLOGY override data_dir and the ontology folder.
docs/CONTRACTS.md (the public product and the brain view) describes each key.
"""
from __future__ import annotations

import json
import os
import posixpath
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

PRODUCTS = ("cortex", "ranviera")

DEFAULTS = {
    "product": "ranviera",
    "claude_home": "~/.claude",
    "projects_root": None,
    "memory_dir": "auto",
    "data_dir": None,           # ~/.claude/ranviera, or ~/.claude/cortex when the product is cortex
    "profile_dir": None,        # <data_dir>/profile
    "port": 5182,
    "include_sensitivity": ["public", "internal", "client-confidential"],
    "log_prompt_snippets": False,
    "private_terms": None,      # a file of client, project and people names; null reads <data_dir>/overlay/private_terms.json
    "agent_model": None,        # the model name every agent must name (check S03); null runs no check
    "size_limits": None,        # { claude_md_lines, memory_index_bytes, memory_index_lines, rule_file_chars } (check P02); null runs no check
}

SIZE_LIMIT_KEYS = ("claude_md_lines", "memory_index_bytes", "memory_index_lines", "rule_file_chars")


def _path(value: str) -> Path:
    return Path(os.path.expanduser(value)).resolve()


def _opt_path(value) -> Path | None:
    return _path(str(value)) if value else None


def default_data_dir(product: str) -> str:
    return "~/.claude/cortex" if product == "cortex" else "~/.claude/ranviera"


_SLUG_HOME = re.compile(r"^(?:[A-Za-z]--)?-?Users-[^-]+-|^-?home-[^-]+-")


def memory_label(project_folder: str) -> str:
    """A readable label for a folder of <claude_home>/projects, whose name is the project's path with separators
    turned into hyphens (C--Users-name-Downloads-Projects). The user's home prefix is dropped."""
    s = _SLUG_HOME.sub("", project_folder) or project_folder
    return s.replace("--", "/").strip("-") or project_folder


def find_memory_dirs(claude_home: Path) -> list[tuple[Path, str]]:
    """Every <claude_home>/projects/*/memory folder that holds a MEMORY.md, sorted by folder name, with its label."""
    out: list[tuple[Path, str]] = []
    base = claude_home / "projects"
    try:
        for d in sorted(base.iterdir(), key=lambda p: p.name.lower()):
            m = d / "memory"
            if (m / "MEMORY.md").is_file():
                out.append((m.resolve(), memory_label(d.name)))
    except OSError:
        pass
    return out


@dataclass
class Config:
    claude_home: Path
    projects_root: Path | None
    memory_dir: Path | None
    data_dir: Path
    port: int
    include_sensitivity: list[str]
    log_prompt_snippets: bool
    repo_root: Path = REPO_ROOT
    raw: dict = field(default_factory=dict)
    product: str = "ranviera"
    profile_path: Path | None = None        # profile_dir from the configuration
    ontology_path: Path | None = None       # CORTEX_ONTOLOGY
    memory_dirs: list | None = None         # [(Path, label)], from memory_dir "auto" or a given folder
    projects_set: bool | None = None        # whether a projects folder is configured

    def __post_init__(self) -> None:
        # Modules outside the compiler read cfg.projects_root and cfg.memory_dir as paths. When none is configured the
        # attribute names a folder that does not exist, so that they read nothing; has_projects tells the harvesters.
        if self.projects_root is None:
            self.projects_set = False
            self.projects_root = self.data_dir / "_no_projects"
        elif self.projects_set is None:
            self.projects_set = True
        if self.memory_dirs is None:
            self.memory_dirs = [(self.memory_dir, "")] if self.memory_dir is not None else []
        if self.memory_dir is None:
            self.memory_dir = self.memory_dirs[0][0] if self.memory_dirs else self.data_dir / "_no_memory"

    @property
    def agent_model(self) -> str | None:
        """The model that check S03 requires of every agent, or None for no check."""
        v = (self.raw or {}).get("agent_model")
        return str(v).strip().lower() if isinstance(v, str) and v.strip() else None

    @property
    def size_limits(self) -> dict | None:
        """The limits that check P02 applies, or None for no check. A key left out of the table is not checked."""
        v = (self.raw or {}).get("size_limits")
        if not isinstance(v, dict):
            return None
        return {k: int(v[k]) for k in SIZE_LIMIT_KEYS if isinstance(v.get(k), (int, float)) and not isinstance(v.get(k), bool)}

    @property
    def has_projects(self) -> bool:
        return bool(self.projects_set) and self.projects_root.is_dir()

    @property
    def ontology_dir(self) -> Path:
        """The folder of the TBox, shapes, rules and defaults. A frozen build reads CORTEX_ONTOLOGY or its bundle."""
        if self.ontology_path:
            return self.ontology_path
        if getattr(sys, "frozen", False):
            env = os.environ.get("CORTEX_ONTOLOGY")
            if env:
                return Path(os.path.expanduser(env)).resolve()
            bundle = getattr(sys, "_MEIPASS", None)
            if bundle:
                return Path(bundle) / "ontology"
        return self.repo_root / "ontology"

    @property
    def defaults_dir(self) -> Path:
        return self.ontology_dir / "defaults"

    @property
    def profile_dir(self) -> Path:
        """The person's own vocabulary, task types, weight overrides, assertions and rule ledger."""
        return self.profile_path or self.data_dir / "profile"

    @property
    def harness_dir(self) -> Path:
        return self.repo_root / "harness"

    @property
    def overlay_dir(self) -> Path:
        """The private overlay: client-confidential vocabulary and assertions, machine-local."""
        return self.data_dir / "overlay"

    @property
    def events_dir(self) -> Path:
        return self.data_dir / "events"

    def ensure_data_dirs(self) -> None:
        for d in (self.data_dir, self.events_dir, self.overlay_dir, self.data_dir / "changes",
                  self.data_dir / "missions"):
            d.mkdir(parents=True, exist_ok=True)


PROFILE_KEYS = ("client_folders", "app_labels", "owner_names", "apps_folder")


def _merge_profile_settings(merged: dict) -> None:
    """Fill the harvest keys the configuration leaves out from <profile_dir>/config.json, so that a person's clients,
    app labels and names live with the profile. A key in the configuration file wins."""
    prof = merged.get("profile_dir")
    if not prof:
        return
    data = read_json_file(_path(prof) / "config.json", {})
    if isinstance(data, dict):
        for k in PROFILE_KEYS:
            if k in data and k not in merged:
                merged[k] = data[k]


def load_config(path: str | os.PathLike | None = None) -> Config:
    """Load the configuration. An explicit path wins, then CORTEX_CONFIG, then the repository file."""
    candidates = [path, os.environ.get("CORTEX_CONFIG"), REPO_ROOT / "cortex.config.json"]
    raw: dict = {}
    for c in candidates:
        if c and Path(c).is_file():
            raw = json.loads(Path(c).read_text(encoding="utf-8-sig"))
            break
    merged = {**DEFAULTS, **raw}
    _merge_profile_settings(merged)
    product = merged["product"] if merged["product"] in PRODUCTS else "ranviera"
    data_dir = os.environ.get("CORTEX_DATA_DIR") or merged["data_dir"] or default_data_dir(product)
    merged["product"], merged["data_dir"] = product, data_dir
    claude_home = _path(merged["claude_home"])
    mem = merged["memory_dir"]
    if mem in (None, "", "auto"):
        mem_dirs = find_memory_dirs(claude_home)
        memory_dir = None
    else:
        memory_dir = _path(mem)
        mem_dirs = None
    return Config(
        claude_home=claude_home,
        projects_root=_opt_path(merged["projects_root"]),
        memory_dir=memory_dir,
        data_dir=_path(data_dir),
        port=int(merged["port"]),
        include_sensitivity=list(merged["include_sensitivity"]),
        log_prompt_snippets=bool(merged["log_prompt_snippets"]),
        raw=merged,
        product=product,
        profile_path=_opt_path(merged["profile_dir"]),
        ontology_path=_opt_path(os.environ.get("CORTEX_ONTOLOGY")),
        memory_dirs=mem_dirs,
    )


# ---- the starting content and the person's own, read in that order -------------------------------------------------

def read_json_file(path: Path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return default


def _profile_or_default(profile: Path, default: Path, present) -> Path:
    """The starting content only seeds a new profile. Once the profile holds its own copy, the profile alone decides,
    so that an update of the product never changes a person's vocabulary or task types without their knowledge."""
    return profile if present(profile) else default


def vocab_files(cfg: Config) -> list[tuple[Path, bool]]:
    """(file, private) for the profile's vocabulary (or the starting vocabulary when the profile has none), then the
    private overlay's."""
    has_json = lambda d: d.is_dir() and any(d.glob("*.json"))
    first = _profile_or_default(cfg.profile_dir / "vocab", cfg.defaults_dir / "vocab", has_json)
    out: list[tuple[Path, bool]] = []
    for d, private in ((first, False), (cfg.overlay_dir / "vocab", True)):
        if d.is_dir():
            out += [(p, private) for p in sorted(d.glob("*.json"))]
    return out


def tasktype_files(cfg: Config) -> list[Path]:
    """The profile's task types, or the starting task types when the profile has none."""
    chosen = _profile_or_default(cfg.profile_dir / "tasktypes.json", cfg.defaults_dir / "tasktypes.json", Path.is_file)
    return [chosen] if chosen.is_file() else []


def assertion_folders(cfg: Config) -> list[Path]:
    return [cfg.profile_dir / "assertions", cfg.overlay_dir / "assertions"]


def weights_table(cfg: Config) -> dict:
    """Relation id to its weight row. The starting file is ontology/defaults/weights.json (ontology/weights.json when
    that is missing), and a row of the profile's weights.json replaces the starting row with the same id."""
    table: dict = {}
    first = cfg.defaults_dir / "weights.json"
    for p in (first if first.is_file() else cfg.ontology_dir / "weights.json", cfg.profile_dir / "weights.json"):
        data = read_json_file(p, {}) or {}
        rows = data.get("relations", data) if isinstance(data, dict) else data
        if isinstance(rows, list):
            rows = {r.get("id"): r for r in rows if isinstance(r, dict)}
        if isinstance(rows, dict):
            table.update(rows)
    return table


def norm_path(p: str | os.PathLike) -> str:
    """The form used as a key in index.json: absolute, forward slashes, lower case."""
    s = os.path.expanduser(str(p))
    # A Windows path such as C:\Users\... is absolute on every platform: on Linux or macOS it is not resolved
    # against the working folder, so an index built on Windows and events from Windows still match.
    if os.name != "nt" and len(s) > 2 and s[0].isalpha() and s[1] == ":" and s[2] in "\\/":
        return posixpath.normpath(s.replace("\\", "/")).lower()
    return str(Path(s).resolve()).replace("\\", "/").lower()
