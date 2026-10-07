"""Tests for the Projects folder harvester, on a small fixture Projects folder."""
import json
from pathlib import Path

import pytest

from cortex_kg.config import Config
from cortex_kg.harvest import projects


def make_cfg(tmp_path: Path) -> Config:
    return Config(claude_home=tmp_path / "claude", projects_root=tmp_path / "proj", memory_dir=tmp_path / "mem",
                  data_dir=tmp_path / "data", port=5182, include_sensitivity=["internal"],
                  log_prompt_snippets=False, repo_root=tmp_path / "repo")


def w(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


PROJ = "---\nname: {n}\ndescription: {d}\nmetadata:\n  type: project\n---\nText\n"


@pytest.fixture
def cfg(tmp_path):
    cfg = make_cfg(tmp_path)
    cfg.raw.update({"owner_names": ["Jordan", "Claude"], "app_labels": {"nimbus": "Falcon"},
                    "client_folders": {"client-northwind": "client:northwind", "client-ms": "client:globex-securities"}})
    r, m = cfg.projects_root, cfg.memory_dir
    w(m / "MEMORY.md", "- [Falcon](project_falcon.md) - tool\n- [Harbour](project_harbour.md) - parked\n")
    w(m / "project_falcon.md", PROJ.format(n="project-falcon", d="x"))
    w(m / "project_harbour.md", PROJ.format(n="project-harbour", d="Harbour"))
    w(r / "README.md", "# Projects\n\n| Folder | What it is | Status |\n|---|---|---|\n"
      "| `nimbus/` | Falcon, the test tool, live at falcon-tm.vercel.app (`nimbus`, 5178) | Active |\n"
      "| `harbour/` | Ground truth | Parked |\n")
    w(r / "BACKLOG.md", "# Backlog\n\n## 1. Falcon: the tool (`apps/nimbus`)\n\n"
      "- [ ] Jordan to rerun by 5 Oct 2026\n  and check.\n- [ ] Price at a 33% margin\n\n"
      "## 2. Harbour\n\n- [ ] Resume\n\n## 3. Misc\n")
    w(r / ".claude" / "launch.json", json.dumps({"configurations": [
        {"name": "nimbus", "runtimeExecutable": "npm.cmd",
         "runtimeArgs": ["--prefix", "apps/nimbus/web", "run", "dev"], "port": 5178},
        {"name": "ghost", "runtimeExecutable": "npm.cmd",
         "runtimeArgs": ["--prefix", "apps/ghost/web", "run", "dev"], "port": 5999}]}))
    w(r / "apps" / "nimbus" / "web" / "package.json", json.dumps(
        {"dependencies": {"react": "1", "vite": "1"}, "devDependencies": {"tailwindcss": "4"},
         "scripts": {"dev": "vite"}}))
    w(r / "apps" / "nimbus" / "CLAUDE.md", "# Falcon map\n")
    w(r / "apps" / "harbour" / "README.md", "x")
    w(r / "docs" / "harness" / "DECISIONS_2026-10-05.md",
      "# D\n\n1. Whether to use dashes. Evidence in `rules/writing.md`. Decided. No dashes.\n\n"
      "2. Whether to ship. Decided. Yes, see `build/build_x.py`.\n")
    w(cfg.claude_home / "rules" / "writing.md", "x")
    w(r / "docs" / "history" / "backlog" / "09-falcon.md", "log 2026-09-01")
    w(r / "docs" / "history" / "BACKLOG_full.md", "log")
    w(r / "deliverables" / "client-northwind" / "Northwind_Proposal_v4.pptx", "p")
    w(r / "deliverables" / "client-northwind" / "Northwind_Proposal_v4.pdf", "p")
    w(r / "deliverables" / "client-northwind" / "archive" / "Northwind_Proposal_v3.pptx", "p")
    w(r / "deliverables" / "client-northwind" / "sub" / "Deep_v1.docx", "p")
    w(r / "deliverables" / "client-ms" / "MS_v8.pptx", "p")
    w(r / "_shared" / "Orbit_Template.pptx", "t")
    w(r / "build" / "build_deck.py", '"""Build the deck.\n\nMore.\n"""\n')
    w(r / "build" / "gate.mjs", "// Check the gate. Second sentence.\nconsole.log(1)\n")
    w(r / "build" / "tools" / "export.ps1", "# Export a deck\n# to PDF.\n")
    return cfg


def test_apps_and_launches(cfg):
    h = projects.harvest(cfg)
    a = h.nodes["app:nimbus"]
    assert a.label == "Falcon" and a.status == "active"
    assert a.props["stack"] == ["react", "vite", "tailwind"] and a.props["port"] == 5178
    assert a.props["launch"] == "nimbus" and a.props["url"] == "https://falcon-tm.vercel.app"
    assert a.props["scripts"] == {"dev": "vite"}
    assert h.nodes["app:harbour"].status == "parked"
    assert ("app:nimbus", "locatedAt", "folder:apps-nimbus") in h.edges
    assert "claudemd:app-nimbus" in h.nodes and "claudemd:app-nimbus" in h.texts
    assert ("launch:nimbus", "launches", "app:nimbus") in h.edges
    l01 = [f for f in h.findings if f.check == "L01"]
    assert len(l01) == 1 and l01[0].severity == "violation" and "ghost" in l01[0].message


def test_backlog(cfg):
    h = projects.harvest(cfg)
    bid = "backlog:1-falcon-the-tool-apps-nimbus"
    assert h.nodes[bid].props["open_items"] == 2
    assert (bid, "belongsTo", "project:falcon") in h.edges
    assert ("backlog:2-harbour", "belongsTo", "project:harbour") in h.edges
    assert h.nodes["backlog:3-misc"].props["open_items"] == 0
    items = {n.props["text"]: n for n in h.nodes.values() if n.id.startswith("openitem:")}
    o = items["Jordan to rerun by 5 Oct 2026 and check."]
    assert o.props["owner"] == "Jordan" and o.props["due"] == "2026-10-05" and o.sensitivity == "internal"
    assert items["Price at a 33% margin"].sensitivity == "client-confidential"
    assert "record:backlog" in h.texts and "record:projects-readme" in h.texts


def test_decisions(cfg):
    h = projects.harvest(cfg)
    d = h.nodes["decision:2026-10-05-1"]
    assert d.props["question"].startswith("Whether to use dashes") and d.props["decision"] == "No dashes."
    assert "decision:2026-10-05-2" in h.nodes
    refs = {r.raw: r.resolved for r in h.refs}
    assert refs["rules/writing.md"] and refs["build/build_x.py"] is None
    assert "record:decisions-2026-10-05" in h.texts


def test_history_deliverables_templates_tools(cfg):
    h = projects.harvest(cfg)
    assert ("project:falcon", "documentedIn", "history:09-falcon") in h.edges
    assert "history:backlog-full" in h.nodes
    d = h.nodes["deliverable:northwind-proposal-v4"]
    assert d.props["ext"] == "pptx" and d.props["version"] == "v4" and d.props["folder"] == "client-northwind"
    assert d.sensitivity == "client-confidential" and d.props["formats"] == ["pdf", "pptx"]
    assert not [e for e in h.edges if e[1] == "deliveredTo"]       # F2: the folder does not show delivery
    assert ("deliverable:northwind-proposal-v4", "mentions", "client:northwind") in h.edges
    assert ("deliverable:northwind-proposal-v4", "locatedAt", "folder:deliverables-client-northwind") in h.edges
    assert "deliverable:northwind-proposal-v3" not in h.nodes and "deliverable:deep-v1" in h.nodes
    assert ("deliverable:ms-v8", "mentions", "client:globex-securities") in h.edges
    assert "template:orbit-template" in h.nodes
    assert h.nodes["tool:build-build-deck"].props == {"purpose": "Build the deck", "scope": "build"}
    assert h.nodes["tool:build-gate"].props["purpose"] == "Check the gate"
    assert h.nodes["tool:build-tools-export"].props["purpose"] == "Export a deck to PDF"
    for fid in ("folder:apps", "folder:deliverables", "folder:build", "folder:docs", "folder:shared",
                "folder:deliverables-client-northwind"):
        assert fid in h.nodes



def _ids(h):
    return {n.props["text"]: n.id for n in h.nodes.values() if n.id.startswith("openitem:")}


def test_open_item_ids_survive_reordering_and_edits(cfg):
    """F3: an id comes from the content, so reordering the backlog or ticking an item keeps it."""
    before = _ids(projects.harvest(cfg))
    b = cfg.projects_root / "BACKLOG.md"
    b.write_text(b.read_text(encoding="utf-8").replace(
        "- [ ] Price at a 33% margin\n", "- [ ] New item first\n- [ ] Price at a 33% margin\n"), encoding="utf-8")
    after = _ids(projects.harvest(cfg))
    assert after["Price at a 33% margin"] == before["Price at a 33% margin"]
    assert after["Jordan to rerun by 5 Oct 2026 and check."] == before["Jordan to rerun by 5 Oct 2026 and check."]
    b.write_text(b.read_text(encoding="utf-8").replace("- [ ] Price", "- [x] Price"), encoding="utf-8")
    assert _ids(projects.harvest(cfg))["Price at a 33% margin"] == before["Price at a 33% margin"]


def test_open_items_state_nested_and_due(cfg):
    """F9: [x] items are done, nested checkboxes are items, and due comes only from a cue such as 'by'."""
    b = cfg.projects_root / "BACKLOG.md"
    b.write_text("## 1. Harbour\n\n- [x] Shipped on 4 Sep 2026\n- [ ] Parent\n  - [ ] Child by 9 Oct 2026\n"
                 "  - plain nested note\n", encoding="utf-8")
    h = projects.harvest(cfg)
    items = {n.props["text"]: n for n in h.nodes.values() if n.id.startswith("openitem:")}
    assert items["Shipped on 4 Sep 2026"].props["state"] == "done"
    assert items["Shipped on 4 Sep 2026"].props["due"] is None
    assert items["Child by 9 Oct 2026"].props["due"] == "2026-10-09"
    assert items["Child by 9 Oct 2026"].props["parent"] == items["Parent"].id
    assert "plain nested note" not in items
    assert h.nodes["backlog:1-harbour"].props["open_items"] == 2


def test_deliverables_walk_whole_tree_with_unique_ids(cfg):
    """F10: nested files are harvested and 2 files with the same stem in different folders do not merge."""
    r = cfg.projects_root / "deliverables"
    w(r / "orbit-internal" / "Pack" / "1 - START HERE.docx", "a")
    w(r / "client-acme" / "Pack v1" / "deep" / "1 - START HERE.docx", "b")
    h = projects.harvest(cfg)
    ids = [i for i in h.nodes if "start-here" in i]
    assert len(ids) == 2
    assert sorted(h.nodes[i].sensitivity for i in ids) == ["client-confidential", "internal"]
    assert "deliverable:deep-v1" in h.nodes


def test_deliverable_sensitivity(cfg):
    """F6: a client folder and its files are client-confidential."""
    h = projects.harvest(cfg)
    assert h.nodes["deliverable:ms-v8"].sensitivity == "client-confidential"
    assert h.nodes["folder:deliverables-client-northwind"].sensitivity == "client-confidential"
