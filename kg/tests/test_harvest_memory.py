"""Tests for the memory harvester, on a small fixture memory folder."""
from pathlib import Path

import pytest

from cortex_kg.config import Config
from cortex_kg.harvest import memory


def make_cfg(tmp_path: Path) -> Config:
    return Config(claude_home=tmp_path / "claude", projects_root=tmp_path / "proj", memory_dir=tmp_path / "mem",
                  data_dir=tmp_path / "data", port=5182, include_sensitivity=["internal"],
                  log_prompt_snippets=False, repo_root=tmp_path / "repo")


def fm(name, desc, mtype):
    return f'---\nname: {name}\ndescription: "{desc}"\nmetadata:\n  type: {mtype}\n---\n\n'


@pytest.fixture
def cfg(tmp_path):
    cfg = make_cfg(tmp_path)
    m = cfg.memory_dir
    (m / "_archive").mkdir(parents=True)
    (m / "_archive" / "old.md").write_text("old", encoding="utf-8")
    (m / "MEMORY.md").write_text(
        "# Index\n\n- [Falcon](project_falcon.md) - the tool\n- [Acme Bank](client_acme_engagement.md) - bid\n"
        "- [Style](feedback_style.md) - style\n- [Gone](missing.md) - nothing\n", encoding="utf-8")
    (m / "_changelog.md").write_text("2026-10-05 | no change", encoding="utf-8")
    (m / "project_falcon.md").write_text(
        fm("project-falcon", "Falcon test tool", "project") + "**Status (as of 24 September 2026).** Live. "
        "See [[client-acme-engagement]] and [[nothing_here]].\nLater note 2026-10-01.\n", encoding="utf-8")
    (m / "client_acme_engagement.md").write_text(
        fm("client-acme-engagement", "Acme Bank bid, parked", "project") + "Price £123k at a 33% margin.\n"
        + "x" * 4200, encoding="utf-8")
    (m / "feedback_style.md").write_text(fm("feedback-style", "Style", "feedback") + "No dashes.\n",
                                         encoding="utf-8")
    (m / "orphan.md").write_text(fm("orphan", "Not indexed", "reference") + "Text.\n", encoding="utf-8")
    return cfg


def test_nodes_and_props(cfg):
    h = memory.harvest(cfg)
    n = h.nodes["memory:project-falcon"]
    assert n.props["memoryType"] == "project" and n.props["indexed"] is True
    assert n.label == "Falcon" and n.date == "2026-10-01"
    assert h.nodes["memory:orphan"].props["indexed"] is False
    assert "memory:old" not in h.nodes and "memory:memory" not in h.nodes
    assert "memory:project-falcon" in h.texts
    assert "record:memory-index" in h.nodes and "record:memory-changelog" in h.nodes


def test_projects_and_status(cfg):
    h = memory.harvest(cfg)
    assert h.nodes["project:falcon"].label == "Falcon"
    assert "project:client-acme-engagement" in h.nodes
    assert h.nodes["project:client-acme-engagement"].status == "parked"
    assert ("project:falcon", "documentedIn", "memory:project-falcon") in h.edges


def test_edges(cfg):
    h = memory.harvest(cfg)
    assert ("memory:project-falcon", "linksTo", "memory:client-acme-engagement") in h.edges
    assert ("record:memory-index", "indexes", "memory:feedback-style") in h.edges
    assert ("record:memory-index", "indexes", "memory:missing") not in h.edges


def test_findings(cfg):
    h = memory.harvest(cfg)
    by = {}
    for f in h.findings:
        by.setdefault(f.check, []).append(f)
    assert len(by["M01"]) == 1 and "nothing_here" in by["M01"][0].message
    assert by["M01"][0].evidence.endswith("project_falcon.md:8")
    assert [f.node for f in by["M02"]] == ["memory:client-acme-engagement"]
    assert {f.node for f in by["M03"]} == {"memory:project-falcon", "memory:client-acme-engagement",
                                           "memory:feedback-style"}
    assert by["M04"][0].severity == "violation" and "missing.md" in by["M04"][0].message
    assert [f.node for f in by["M05"]] == ["memory:orphan"]


def test_sensitivity(cfg):
    h = memory.harvest(cfg)
    assert h.nodes["memory:client-acme-engagement"].sensitivity == "client-confidential"
    assert h.nodes["memory:feedback-style"].sensitivity == "internal"
    assert memory.sensitivity_of("a day rate of 900") == "client-confidential"
    assert memory.sensitivity_of("a fee of nothing") == "internal"


def test_sensitivity_restricted_frontmatter_and_project_inherits(cfg):
    """F6: RESTRICTED marks a text client-confidential, a frontmatter key overrides, and a project takes the label
    of its memory file."""
    assert memory.sensitivity_of("169 pages, RESTRICTED handling") == "client-confidential"
    assert memory.sensitivity_of("price 5m", {"sensitivity": "internal"}) == "internal"
    assert memory.sensitivity_of("plain", {"metadata": {"sensitivity": "client-confidential"}}) == "client-confidential"
    h = memory.harvest(cfg)
    assert h.nodes["project:client-acme-engagement"].sensitivity == "client-confidential"
    assert h.nodes["project:falcon"].sensitivity == "internal"
