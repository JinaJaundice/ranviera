"""Tests for the task type harvester and for the agreement of ontology/tasktypes.json with the task routing table."""
import json
import re
from pathlib import Path

import pytest

from cortex_kg.config import Config
from cortex_kg.harvest import tasktypes

PROFILE = Path(__file__).resolve().parents[2] / "profile"
needs_profile = pytest.mark.skipif(not (PROFILE / "tasktypes.json").is_file(), reason="the owner's profile is not in this tree (the public export leaves it out)")
CLAUDE_MD = Path.home() / ".claude" / "CLAUDE.md"


def make_cfg(tmp_path: Path) -> Config:
    return Config(claude_home=tmp_path / "claude", projects_root=tmp_path / "proj", memory_dir=tmp_path / "mem",
                  data_dir=tmp_path / "data", port=5182, include_sensitivity=["internal"],
                  log_prompt_snippets=False, repo_root=tmp_path / "repo")


def test_harvest_reads_first_condition_and_note(tmp_path):
    cfg = make_cfg(tmp_path)
    cfg.profile_dir.mkdir(parents=True)
    (cfg.profile_dir / "tasktypes.json").write_text(json.dumps({"task_types": [
        {"id": "task:email", "label": "Email", "routes": ["Emails"], "table_row": "r", "condition": "over 300 words",
         "routing_note": "n", "reads_first": ["rulefile:documents"], "agents": ["agent:writer", "agent:checker"],
         "gates": ["gate:prose-check"]}], "gates": []}), encoding="utf-8")
    h = tasktypes.harvest(cfg)
    assert h.nodes["task:email"].props["condition"] == "over 300 words"
    assert h.nodes["task:email"].props["routing_note"] == "n"
    assert ("task:email", "readsFirst", "rulefile:documents") in h.edges
    assert ("task:email", "handledBy", "agent:checker") in h.edges


def _types():
    return {t["id"]: t for t in json.loads((PROFILE / "tasktypes.json").read_text(encoding="utf-8"))["task_types"]}


@needs_profile
def test_every_task_type_has_a_first_read():
    """Shape S13 expects a readsFirst edge from each task type, so task:search names the routing table."""
    assert all(t.get("reads_first") for t in _types().values())
    assert "claudemd:global" in _types()["task:search"]["reads_first"]


@needs_profile
def test_email_follows_the_document_row():
    t = _types()["task:email"]
    assert "rulefile:documents" in t["reads_first"] and "rulefile:writing" in t["reads_first"]
    assert t["agents"] == ["agent:writer", "agent:checker"]
    assert {"gate:prose-check", "gate:fca-style-score", "gate:checker-review"} <= set(t["gates"])
    assert t["condition"] == "over 300 words"


@pytest.mark.skipif(not CLAUDE_MD.is_file(), reason="the global CLAUDE.md is not present")
@needs_profile
def test_agents_agree_with_the_routing_table():
    rows = {}
    for line in CLAUDE_MD.read_text(encoding="utf-8").splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 4 and not set(cells[0]) <= {"-", " "} and cells[0] != "Task":
            rows[cells[0]] = cells
    for tid, t in _types().items():
        row = rows.get(t.get("table_row") or "")
        if not row:
            continue
        named = {f"agent:{a}" for a in re.findall(r"\b(writer|checker|builder|scout|researcher|librarian)\b", row[3])}
        assert set(t["agents"]) == named, tid
