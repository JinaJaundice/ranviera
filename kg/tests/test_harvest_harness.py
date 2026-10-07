from cortex_kg.harvest import harness
from cortex_kg.ledger import Ledger

TODAY = "2026-10-05"


def run(cfg):
    ledger = Ledger()
    h = harness.harvest(cfg, ledger, TODAY)
    return h, ledger


def edges(h, r):
    return {(e.s, e.t) for e in h.edges.values() if e.r == r}


def test_file_nodes_and_texts(mini_cfg):
    mini_cfg.raw["public_rule_files"] = ["writing"]   # which rule files are public is configuration, not code
    h, _ = run(mini_cfg)
    for nid in ("claudemd:global", "rulefile:writing", "rulefile:decks", "outputstyle:plain-english",
                "agent:builder"):
        assert nid in h.nodes and nid in h.texts
    assert h.nodes["rulefile:writing"].sensitivity == "public"
    assert h.nodes["rulefile:decks"].sensitivity == "internal"
    assert h.nodes["outputstyle:plain-english"].sensitivity == "public"
    agent = h.nodes["agent:builder"].props
    assert agent["model"] == "sonnet" and agent["effort"] == "medium" and agent["memory"] == "user"
    assert agent["description"] == "Makes scoped code changes."


def test_rules_sections_and_skipped_headings(mini_cfg):
    h, ledger = run(mini_cfg)
    rules = [n for n in h.nodes.values() if n.id.startswith("rule:")]
    keys = {n.props["file_key"] for n in rules}
    assert keys == {"claude-md", "writing", "decks", "style-plain-english", "agent-builder"}
    claude = [n for n in rules if n.props["file_key"] == "claude-md"]
    assert len(claude) == 3  # the two skipped headings add none
    assert "section:claude-md-where-things-are-kept" not in h.nodes
    r = h.nodes["rule:claude-md-002"]
    assert r.props["modal"] in ("none", "imperative") and r.date == "2026-10-05"
    assert r.evidence == "claude/CLAUDE.md:8" and r.label.startswith("Answer first.")
    assert len(r.label) <= 80
    assert ("section:claude-md-rules-for-every-task", "rule:claude-md-002") in edges(h, "contains")
    assert ("claudemd:global", "section:claude-md-rules-for-every-task") in edges(h, "contains")
    assert "section:decks-layout-2" in h.nodes  # repeated heading
    assert h.nodes["rule:writing-002"].props["modal"] == "should"
    assert h.nodes["rule:writing-001"].props["modal"] == "imperative"


def test_scopes(mini_cfg):
    h, _ = run(mini_cfg)
    assert h.nodes["scope:decks"].label == "**/decks/**"
    assert h.nodes["scope:pptx"].label == "**/*.pptx"
    assert ("rulefile:decks", "scope:decks") in edges(h, "appliesTo")


def test_hooks_tools_and_p07(mini_cfg):
    h, _ = run(mini_cfg)
    assert "hook:sessionstart-hook" in h.nodes and "hook:sessionstart-hook-2" in h.nodes
    hook = h.nodes["hook:sessionstart-hook"].props
    assert hook["event"] == "SessionStart" and hook["timeout"] == 15 and hook["async"] is False
    assert h.nodes["hook:sessionstart-hook-2"].props["async"] is True
    assert h.nodes["hook:pretooluse-guard"].props["matcher"] == "Bash"
    assert ("hook:pretooluse-guard", "tool:register-guard") in edges(h, "invokes")
    assert "tool:register-hook" in h.nodes and "tool:prose-check" in h.nodes
    assert h.nodes["tool:register-hook"].props["purpose"] == "The register hook for the mini set-up."
    assert h.nodes["tool:register-hook"].props["scope"] == "harness"
    assert not any("skipped" in n for n in h.nodes)
    assert "tool:register-routes" in h.nodes
    p07 = [f for f in h.findings if f.check == "P07"]
    assert len(p07) == 1 and p07[0].node == "hook:stop-missing-script"


def test_routes_and_refs(mini_cfg, mini_paths):
    h, _ = run(mini_cfg)
    r = h.nodes["route:decks-and-slides"]
    assert r.props["patterns"] == ["\\bdecks?\\b", "\\bslides?\\b"]
    assert r.props["load"].startswith("Read rules/decks.md")
    ref_rules = [x for x in h.refs if x.source == "route:decks-and-slides"]
    assert ref_rules and ref_rules[0].raw == "rules/decks.md"
    ok = [x for x in h.refs if x.source.startswith("rule:decks") and x.raw.endswith("decks-common.md")]
    assert ok and ok[0].resolved.endswith("skills/jordan-playbook/references/decks-common.md")
    missing = [x for x in h.refs if x.raw == "skills/missing/nothing.md"]
    assert missing and missing[0].acknowledged_missing and missing[0].resolved is None
    assert missing[0].evidence == "claude/rules/decks.md:13"
    in_file = [x for x in h.refs if x.source == "claudemd:global" or x.source.startswith("rule:claude-md")]
    assert any(x.raw == "rules/writing.md" and x.resolved for x in in_file)


def test_faults(mini_cfg):
    h, _ = run(mini_cfg)
    for key in ("exclaim", "semicolon", "tail", "colons", "commit-exclamation-mark"):
        assert f"fault:{key}" in h.nodes, key
    assert h.nodes["fault:exclaim"].props["message"] == "an exclamation mark"
    assert h.nodes["fault:colons"].props["message"].startswith("{} colons per 1,000 words")
    assert ("tool:register-hook", "fault:tail") in edges(h, "contains")
    assert ("tool:register-guard", "fault:commit-exclamation-mark") in edges(h, "contains")
    assert h.nodes["fault:exclaim"].props["script"] == "tools/register/hook.py"


def test_a_rule_file_is_internal_unless_the_configuration_makes_it_public(mini_cfg):
    h, _ = run(mini_cfg)
    assert h.nodes["rulefile:writing"].sensitivity == "internal"


def test_schedules_builtins_records(mini_cfg):
    (mini_cfg.memory_dir / "_changelog.md").write_text("# Log\n", encoding="utf-8")
    (mini_cfg.claude_home / "register-log").mkdir()
    (mini_cfg.claude_home / "digests").mkdir()
    h, _ = run(mini_cfg)
    assert h.nodes["schedule:nightly"].props["description"] == "A nightly check."
    assert h.nodes["schedule:nightly"].path.endswith("scheduled-tasks/nightly/SKILL.md")
    built = [n for n in h.nodes if n.startswith("builtin:")]
    assert len(built) == 20 and "builtin:powershell" in built
    assert h.nodes["builtin:read"].sensitivity == "public"
    for rid in ("record:memory-index", "record:memory-changelog", "record:register-log", "record:digests",
                "record:backlog", "record:projects-readme"):
        assert rid in h.nodes
    assert h.nodes["record:backlog"].path.endswith("projects/BACKLOG.md")


def test_determinism_and_seen_keys(mini_cfg):
    a, _ = run(mini_cfg)
    b, _ = run(mini_cfg)
    assert list(a.nodes) == list(b.nodes) and list(a.edges) == list(b.edges)
    assert "claude-md" in a.rule_file_keys


def test_frontmatter_folded_block():
    fm = harness.frontmatter("---\nname: x\ndescription: >-\n  one\n  two: three\ntools:\n  - a\n  - b\n---\nBody")
    assert fm == {"name": "x", "description": "one two: three", "tools": ["a", "b"]}


def _doc(cfg, rel, text):
    from cortex_kg.model import Harvest
    h, ledger = Harvest("t"), Ledger()
    path = cfg.claude_home / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    harness.harvest_doc(h, ledger, TODAY, cfg, file_id="file:x", path=path, file_key="x", text=text)
    return h, ledger


def test_every_rule_has_a_kind_and_a_nested_bullet_follows_its_parent(mini_cfg):
    h, _ = _doc(mini_cfg, "rules/kinds.md", "# Layout\n\n- Keep one source line on each page.\n"
                "- Files to read first:\n  - `a/b.md`\n  - `c/d.md`\n\n## Examples\n\n- Use the old template.\n")
    rules = {n.id: n for n in h.nodes.values() if n.id.startswith("rule:")}
    assert {n.props["kind"] for n in rules.values()} <= {"instruction", "note"}
    assert rules["rule:x-001"].props["kind"] == "instruction" and rules["rule:x-001"].props["modal"] == "imperative"
    assert rules["rule:x-003"].props["kind"] == "note" and rules["rule:x-003"].props["parent"] == "rule:x-002"
    assert rules["rule:x-005"].props["kind"] == "note"      # under an Examples heading


def test_a_worked_example_file_is_kept_as_notes_and_ids_do_not_depend_on_the_kind(mini_cfg):
    text = "# Before and after\n\n- 42 words, over the 20-word instruction cap.\n- Never add a fact.\n"
    h, ledger = _doc(mini_cfg, "skills/asd-ste100/examples/before-after.md", text)
    rules = [n for n in h.nodes.values() if n.id.startswith("rule:")]
    assert len(rules) == 2 and all(n.props["kind"] == "note" for n in rules)
    h2, _ = _doc(mini_cfg, "skills/asd-ste100/examples/before-after.md", text)
    assert {n.id for n in h2.nodes.values() if n.id.startswith("rule:")} == {n.id for n in rules}
