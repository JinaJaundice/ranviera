"""Builds on an empty and a small Claude folder, bad input findings, the routing table, the config keys and the
atomic ledger write. Nothing here reads Jordan's own folders: every test has its own temporary tree."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from cortex_kg import compile as comp
from cortex_kg import config as cfgmod
from cortex_kg import ledger
from cortex_kg.config import Config, REPO_ROOT
from cortex_kg.harvest import harness, tasktypes
from cortex_kg.model import Harvest


def home_cfg(tmp: Path, **kw) -> Config:
    home = tmp / "home"
    home.mkdir(exist_ok=True)
    return Config(claude_home=home, projects_root=kw.pop("projects_root", None), memory_dir=kw.pop("memory_dir", None),
                  data_dir=tmp / "data", port=5182, include_sensitivity=["public", "internal"],
                  log_prompt_snippets=False, repo_root=REPO_ROOT, raw=kw.pop("raw", {"product": "ranviera"}),
                  product="ranviera", **kw)


def graph(cfg: Config) -> dict:
    return json.loads((cfg.data_dir / "graph.json").read_text(encoding="utf-8"))


def findings(cfg: Config) -> list[dict]:
    return json.loads((cfg.data_dir / "findings.json").read_text(encoding="utf-8"))["findings"]


# ---------------------------------------------------------------- empty and sample folders

def test_empty_claude_folder_gives_the_defaults_and_no_violation(tmp_path):
    cfg = home_cfg(tmp_path)
    comp.build(cfg)
    g = graph(cfg)
    ids = {n["id"] for n in g["nodes"]}
    assert {f"task:{t}" for t in ("code", "review", "debug", "plan", "research", "document", "data", "slides")} <= ids
    assert g["health"]["errors"] == 0 and not [f for f in findings(cfg) if f["severity"] == "violation"]
    assert (cfg.profile_dir / "tasktypes.json").is_file()
    assert not any("jordan" in n["id"] or "falcon" in n["id"] for n in g["nodes"])


def test_sample_claude_folder_gives_its_own_nodes(tmp_path):
    cfg = home_cfg(tmp_path)
    h = cfg.claude_home
    (h / "rules").mkdir()
    (h / "agents").mkdir()
    (h / "skills" / "tidy").mkdir(parents=True)
    (h / "CLAUDE.md").write_text("# Map\n\n## Rules\n\n1. **Tests.** Run the tests before you finish.\n", encoding="utf-8")
    (h / "rules" / "alpha.md").write_text("# Alpha\n\n- Name each file after its topic.\n", encoding="utf-8")
    (h / "rules" / "beta.md").write_text("# Beta\n\n- Keep each function short.\n", encoding="utf-8")
    (h / "skills" / "tidy" / "SKILL.md").write_text("---\nname: tidy\ndescription: Tidy a folder\n---\nSteps.\n", encoding="utf-8")
    (h / "agents" / "scout.md").write_text("---\nname: scout\ndescription: Searches files\nmodel: sonnet\n---\nSearch.\n",
                                           encoding="utf-8")
    mem = tmp_path / "memory"
    mem.mkdir()
    (mem / "MEMORY.md").write_text("- [Note](note.md) - a note\n", encoding="utf-8")
    (mem / "note.md").write_text("---\nname: note\ndescription: A note\nmetadata:\n  type: project\n---\nText\n", encoding="utf-8")
    cfg = home_cfg(tmp_path, memory_dir=mem)
    comp.build(cfg)
    ids = {n["id"] for n in graph(cfg)["nodes"]}
    assert any(i.startswith("rulefile:") and "alpha" in i for i in ids) and any("beta" in i for i in ids)
    assert "skill:tidy" in ids and "agent:scout" in ids
    assert any(i.startswith("rule:") for i in ids)
    assert any(i.startswith("memory:") and "note" in i for i in ids)


# ---------------------------------------------------------------- findings for bad input

def checks(h: Harvest) -> list[str]:
    return [f.check for f in h.findings]


def test_missing_folders_and_ontology_files_are_findings(tmp_path):
    onto = tmp_path / "repo" / "ontology"
    onto.mkdir(parents=True)
    (onto / "cortex.ttl").write_text("", encoding="utf-8")
    cfg = home_cfg(tmp_path, memory_dir=tmp_path / "nomem", projects_root=tmp_path / "noproj",
                   raw={"memory_dir": str(tmp_path / "nomem")}, ontology_path=onto)
    h = Harvest("pre")
    comp.precheck(h, cfg)
    msgs = " ".join(f.message for f in h.findings) if hasattr(h.findings[0], "message") else ""
    assert checks(h).count("B06") == 3
    assert "shapes.ttl" in msgs or any("shapes.ttl" in str(f) for f in h.findings)


def test_bad_bytes_and_front_matter_are_findings_and_the_file_is_still_read(tmp_path):
    h = Harvest("x")
    reader = harness.Checked(h)
    bad = tmp_path / "bad.md"
    bad.write_bytes(b"caf\xff text\n")
    assert "text" in reader(bad) and checks(h) == ["B07"]
    unclosed = tmp_path / "open.md"
    unclosed.write_text("---\nname: a\nbody\n", encoding="utf-8")
    reader(unclosed)
    empty = tmp_path / "empty.md"
    empty.write_text("---\n---\nbody\n", encoding="utf-8")
    reader(empty)
    assert checks(h) == ["B07", "B08", "B08"]


def test_a_crash_during_a_ledger_save_leaves_the_old_file_whole(tmp_path, monkeypatch):
    path = tmp_path / "rules.json"
    ledger.write_atomic(path, '{"v": 1, "rules": {}, "next": {}}\n')
    before = path.read_text(encoding="utf-8")

    def boom(src, dst):
        raise OSError("disk full")
    monkeypatch.setattr(ledger.os, "replace", boom)
    with pytest.raises(OSError):
        ledger.write_atomic(path, '{"v": 1, "rules": {"a": 1}, "next": {}}\n')
    assert path.read_text(encoding="utf-8") == before


# ---------------------------------------------------------------- routing table

TABLE = ("| Task | Read first |\n|---|---|\n| Writing code | `rules/alpha.md` |\n| Underwater welding | `rules/beta.md` |\n"
         "| Reviewing code | `rules/gone.md` |\n")


def route_edges(tmp_path, claude_md: str | None):
    cfg = home_cfg(tmp_path)
    (cfg.claude_home / "rules").mkdir()
    (cfg.claude_home / "rules" / "alpha.md").write_text("# Alpha\n\n- A rule.\n", encoding="utf-8")
    (cfg.claude_home / "rules" / "beta.md").write_text("# Beta\n\n- A rule.\n", encoding="utf-8")
    if claude_md is not None:
        (cfg.claude_home / "CLAUDE.md").write_text(claude_md, encoding="utf-8")
    comp.build(cfg)
    return [e for e in graph(cfg)["edges"] if e["r"] == "readsFirst"], cfg


def test_routing_table_adds_reads_first_for_a_matching_task(tmp_path):
    edges, _ = route_edges(tmp_path, "# Map\n\n" + TABLE)
    pairs = {(e["s"], e["t"]) for e in edges}
    assert any(s == "task:code" and "alpha" in t for s, t in pairs)
    assert not any("beta" in t for _, t in pairs)


def test_routing_table_without_a_claude_md_adds_nothing(tmp_path):
    edges, _ = route_edges(tmp_path, None)
    assert edges == []


# ---------------------------------------------------------------- configuration

def test_defaults_and_overrides(tmp_path, monkeypatch):
    for k in ("CORTEX_DATA_DIR", "CORTEX_ONTOLOGY", "CORTEX_CONFIG"):
        monkeypatch.delenv(k, raising=False)
    conf = tmp_path / "c.json"
    conf.write_text("{}", encoding="utf-8")
    c = cfgmod.load_config(conf)
    assert c.product == "ranviera" and c.projects_root is not None and not c.has_projects
    assert c.data_dir.name == "ranviera" and c.raw["memory_dir"] == "auto"
    conf.write_text(json.dumps({"product": "cortex"}), encoding="utf-8")
    assert cfgmod.load_config(conf).data_dir.name == "cortex"
    monkeypatch.setenv("CORTEX_DATA_DIR", str(tmp_path / "d"))
    monkeypatch.setenv("CORTEX_ONTOLOGY", str(tmp_path / "o"))
    c = cfgmod.load_config(conf)
    assert c.data_dir == tmp_path / "d" and c.ontology_dir == tmp_path / "o"


def test_profile_settings_fill_the_harvest_keys(tmp_path, monkeypatch):
    monkeypatch.delenv("CORTEX_CONFIG", raising=False)
    prof = tmp_path / "prof"
    prof.mkdir()
    (prof / "config.json").write_text(json.dumps({"client_folders": {"c1": "client:one"}, "owner_names": ["Ann"]}), encoding="utf-8")
    conf = tmp_path / "c.json"
    conf.write_text(json.dumps({"profile_dir": str(prof), "owner_names": ["Bob"]}), encoding="utf-8")
    c = cfgmod.load_config(conf)
    assert c.raw["client_folders"] == {"c1": "client:one"} and c.raw["owner_names"] == ["Bob"]


def test_frozen_run_reads_the_ontology_from_the_environment(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setenv("CORTEX_ONTOLOGY", str(tmp_path / "bundle"))
    conf = tmp_path / "c.json"
    conf.write_text("{}", encoding="utf-8")
    assert cfgmod.load_config(conf).ontology_dir == tmp_path / "bundle"
