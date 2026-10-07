import pytest
from cortex_kg.harvest import skills, tasktypes
from cortex_kg.ledger import Ledger

TODAY = "2026-10-05"


def test_skills_nodes_and_edges(mini_cfg):
    h = skills.harvest(mini_cfg, Ledger(), TODAY)
    s = h.nodes["skill:jordan-playbook"]
    assert s.props["description"] == "The playbook with folded text."
    assert s.path.endswith("skills/jordan-playbook/SKILL.md")
    assert "reference:decks-common" in h.nodes and "guide:fca-register" in h.nodes
    assert "skill:plain-writing-voice" in h.nodes
    es = {(e.s, e.r, e.t) for e in h.edges.values()}
    assert ("skill:jordan-playbook", "contains", "reference:decks-common") in es
    assert ("skill:plain-writing-voice", "contains", "guide:fca-register") in es
    assert set(h.rule_file_keys) == {"skill-jordan-playbook", "decks-common", "skill-plain-writing-voice",
                                     "fca-register"}
    assert "reference:decks-common" in h.texts


def test_skill_rules_flags(mini_cfg):
    h = skills.harvest(mini_cfg, Ledger(), TODAY)
    rules = {n.id: n for n in h.nodes.values() if n.id.startswith("rule:")}
    od = [n for n in rules.values() if n.props.get("open_decision")]
    assert len(od) == 1 and od[0].props["source"] == "memory, 2026-10-01"
    sup = [n for n in rules.values() if n.status == "superseded"]
    assert len(sup) == 1 and sup[0].props["section"] == "Superseded rules"
    assert "rule:decks-common-001" in rules and "rule:fca-register-001" in rules
    assert "section:fca-register-sentences" in h.nodes
    assert ("section:fca-register-sentences", "rule:fca-register-001") in {(e.s, e.t) for e in h.edges.values()}


def test_tasktypes(mini_cfg):
    mini_cfg.profile_dir.mkdir(parents=True, exist_ok=True)
    (mini_cfg.profile_dir / "tasktypes.json").write_text("""{
 "task_types": [{"id": "task:deck", "label": "Deck or slide", "routes": ["Decks and slides"],
   "table_row": "Deck or slide", "reads_first": ["rulefile:decks"], "agents": ["agent:checker"],
   "gates": ["gate:qa"], "templates": ["template:orbit-template"]}],
 "gates": [{"id": "gate:qa", "label": "QA", "command": "python qa.py", "tool": "tool:qa", "kind": "command"},
           {"id": "gate:look", "label": "Look", "command": null, "tool": null, "kind": "manual"}]}""",
                                                         encoding="utf-8")
    h = tasktypes.harvest(mini_cfg)
    t = h.nodes["task:deck"]
    assert t.props == {"label": "Deck or slide", "table_row": "Deck or slide", "family_files": {}, "always": False}
    assert h.nodes["gate:qa"].props == {"command": "python qa.py", "kind": "command", "label": "QA"}
    es = {(e.s, e.r, e.t) for e in h.edges.values()}
    assert es == {("route:decks-and-slides", "triggers", "task:deck"), ("task:deck", "readsFirst", "rulefile:decks"),
                  ("task:deck", "handledBy", "agent:checker"), ("task:deck", "checkedBy", "gate:qa"),
                  ("task:deck", "usesTemplate", "template:orbit-template"), ("gate:qa", "invokes", "tool:qa")}


@pytest.mark.skipif(not (__import__('pathlib').Path(__file__).resolve().parents[2] / 'profile' / 'tasktypes.json').is_file(),
                    reason="the owner's profile is not in this tree (the public export leaves it out)")
def test_tasktypes_real_file_loads():
    from pathlib import Path
    from cortex_kg.config import Config
    repo = Path(__file__).resolve().parents[2]
    cfg = Config(claude_home=repo / "_no_claude", projects_root=None, memory_dir=None, data_dir=repo / "_no_data", port=5182,
                 include_sensitivity=["internal"], log_prompt_snippets=False, repo_root=repo, profile_path=repo / "profile")
    h = tasktypes.harvest(cfg)
    assert "task:deck" in h.nodes and "gate:prose-check" in h.nodes
