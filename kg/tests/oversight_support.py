"""Shared set up for the oversight tests: a copy of the invented Northgate fixtures in a temporary folder, with a Config."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from cortex_kg.config import load_config

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "oversight"
V1 = "instr:alert-triage-escalate-match-v1"
V2 = "instr:alert-triage-escalate-match-v2"
NAR = "instr:alert-triage-narrative-v1"
AGENT = "dagent:alert-triage"


def make_env(tmp_path: Path, *, bounds: bool = True, key: bool = True, people: bool = True):
    """Copy the fixtures to tmp_path and return a Config that points at the copy. Nothing outside tmp_path is touched."""
    shutil.copytree(FIXTURES / "data", tmp_path / "data")
    shutil.copytree(FIXTURES / "profile", tmp_path / "profile")
    raw = {"data_dir": str(tmp_path / "data").replace("\\", "/"), "profile_dir": str(tmp_path / "profile").replace("\\", "/"),
           "claude_home": str(tmp_path / "claude").replace("\\", "/"), "memory_dir": str(tmp_path / "memory").replace("\\", "/")}
    if people:
        raw["oversight_people"] = str(tmp_path / "profile" / "people.json").replace("\\", "/")
    if bounds:
        raw["monitoring_bounds"] = str(tmp_path / "profile" / "bounds.json").replace("\\", "/")
    if key:
        k = tmp_path / "bundle.key"
        k.write_bytes(b"northgate-test-key\n")
        raw["bundle_key"] = str(k).replace("\\", "/")
    cfg_path = tmp_path / "ranviera.config.json"
    cfg_path.write_text(json.dumps(raw), encoding="utf-8")
    return load_config(cfg_path), cfg_path
