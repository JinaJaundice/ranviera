"""Tests for the validator, run on a small graph with a small set of shapes."""
import json
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cortex_kg import compile as comp  # noqa: E402
from cortex_kg import validate  # noqa: E402
from cortex_kg.config import Config  # noqa: E402
from cortex_kg.model import Harvest, Node  # noqa: E402

SHAPES = """
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix cx: <https://cortex.local/ont#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
cx:AgentShape a sh:NodeShape ;
  sh:targetClass cx:Agent ;
  sh:property [ sh:path cx:label ; sh:maxCount 1 ; sh:severity sh:Violation ;
                cx:checkId "S99" ; sh:message "An agent has at most 1 label." ] .
"""

LIMITS = {"claude_md_lines": 120, "memory_index_bytes": 15000, "memory_index_lines": 150, "rule_file_chars": 7500}

ONTOLOGY = """
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix cx: <https://cortex.local/ont#> .
cx:Agent a owl:Class .
"""


def make_cfg(tmp: Path, agent_model="sonnet", size_limits=LIMITS) -> Config:
    for d in ("home/rules", "projects", "memory", "data", "repo/ontology"):
        (tmp / d).mkdir(parents=True, exist_ok=True)
    (tmp / "repo/ontology/shapes.ttl").write_text(SHAPES, encoding="utf-8")
    (tmp / "repo/ontology/cortex.ttl").write_text(ONTOLOGY, encoding="utf-8")
    return Config(claude_home=tmp / "home", projects_root=tmp / "projects", memory_dir=tmp / "memory",
                  data_dir=tmp / "data", port=5182, include_sensitivity=["public", "internal", "client-confidential"],
                  log_prompt_snippets=False, repo_root=tmp / "repo",
                  raw={"agent_model": agent_model, "size_limits": size_limits})


def build_small(cfg, monkeypatch, extra=None):
    def harvest(cfg_, name):
        h = Harvest(name)
        if name == "harness":
            h.add_node(Node("agent:good", "Good", props={"model": "sonnet"}))
            h.add_node(Node("agent:bad", "Bad", props={"model": "opus"}))
            if extra:
                extra(h)
        return h

    for name in comp.HARVEST_ORDER:
        mod = types.ModuleType(f"cortex_kg.harvest.{name}")
        mod.harvest = lambda cfg_, *a, _n=name: harvest(cfg_, _n)
        monkeypatch.setitem(sys.modules, f"cortex_kg.harvest.{name}", mod)
    sys.modules["cortex_kg.harvest.vocab"].load = lambda cfg_: []
    sys.modules["cortex_kg.harvest.vocab"].patterns = lambda c: []
    for name in ("ledger", "events", "activation", "sync"):
        monkeypatch.setitem(sys.modules, f"cortex_kg.{name}", None)
    comp.build(cfg, today="2026-10-05")


def test_agent_on_opus_is_s03(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    build_small(cfg, monkeypatch)
    health = validate.check(cfg)
    s03 = [f for f in health["findings"] if f["check"] == "S03"]
    assert len(s03) == 1
    assert s03[0]["node"] == "agent:bad" and s03[0]["severity"] == "violation"
    assert s03[0]["message"] == "Every agent must run on Sonnet."
    assert health["counts"]["violation"] == 1 and health["drift"] is None
    on_disk = json.loads((cfg.data_dir / "health.json").read_text(encoding="utf-8"))
    assert set(on_disk) == {"v", "checked", "counts", "findings", "drift"}


def test_s03_and_p02_are_off_by_default(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path, agent_model=None, size_limits=None)
    (cfg.claude_home / "CLAUDE.md").write_text("line\n" * 500, encoding="utf-8")
    (cfg.claude_home / "rules" / "big.md").write_text("x" * 99999, encoding="utf-8")
    build_small(cfg, monkeypatch)
    checks = [f["check"] for f in validate.check(cfg)["findings"]]
    assert "S03" not in checks and "P02" not in checks
    assert cfg.agent_model is None and cfg.size_limits is None


def test_s03_takes_the_model_from_the_configuration(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path, agent_model="opus")
    build_small(cfg, monkeypatch)
    s03 = [f for f in validate.check(cfg)["findings"] if f["check"] == "S03"]
    assert [f["node"] for f in s03] == ["agent:good"] and s03[0]["message"] == "Every agent must run on Opus."


def test_s03_is_not_a_shape_and_an_agent_with_two_models_fails(tmp_path):
    from rdflib import Graph
    g = Graph().parse(data="""
@prefix cx: <https://cortex.local/ont#> .
@prefix cxi: <https://cortex.local/id/> .
cxi:agent\\/two a cx:Agent ; cx:model "sonnet", "haiku" .
cxi:agent\\/none a cx:Agent .
cxi:agent\\/ok a cx:Agent ; cx:model "sonnet" .
""", format="turtle")
    assert sorted(f["node"] for f in validate.check_s03(g, "sonnet")) == ["agent:none", "agent:two"]
    assert validate.check_s03(g, None) == [] and validate.check_s03(None, "sonnet") == []
    shapes = (Path(__file__).resolve().parents[2] / "ontology" / "shapes.ttl").read_text(encoding="utf-8")
    assert 'cx:checkId "S03"' not in shapes


def test_p02_uses_each_limit_that_the_configuration_gives(tmp_path):
    cfg = make_cfg(tmp_path, size_limits={"claude_md_lines": 3, "rule_file_chars": 10})
    (cfg.claude_home / "CLAUDE.md").write_text("line\n" * 4, encoding="utf-8")
    (cfg.claude_home / "rules" / "big.md").write_text("x" * 11, encoding="utf-8")
    (cfg.memory_dir / "MEMORY.md").write_text("x\n" * 900, encoding="utf-8")  # no memory limit is set, so it is not checked
    found = validate.check_p02(cfg)
    assert [f["message"] for f in found] == ["CLAUDE.md has 4 lines, and the limit is 3.",
                                              "The rule file big.md has 11 characters, and the limit is 10."]


def test_python_checks_p02_p03_p07(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    (cfg.claude_home / "CLAUDE.md").write_text("line\n" * 121, encoding="utf-8")
    (cfg.claude_home / "rules" / "big.md").write_text("x" * 7501, encoding="utf-8")
    (cfg.memory_dir / "MEMORY.md").write_text("x\n" * 151, encoding="utf-8")

    def extra(h):
        h.add_node(Node("route:r1", "R1", props={"pattern": ["(unclosed"]}))
        h.add_node(Node("hook:pre-nothing", "Hook", props={"event": "PreToolUse", "command": "python ~/nowhere/missing_script.py"}))

    build_small(cfg, monkeypatch, extra)
    health = validate.check(cfg)
    checks = [f["check"] for f in health["findings"]]
    assert checks.count("P02") == 3  # CLAUDE.md lines, MEMORY.md lines and one rule file
    assert "P03" in checks and "P07" in checks


def test_strict_flag_is_left_to_the_command(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    build_small(cfg, monkeypatch)
    from cortex_kg.__main__ import main
    monkeypatch.setattr("cortex_kg.__main__.load_config", lambda p: cfg)
    assert main(["check", "--strict"]) == 1
    assert main(["check"]) == 0


# ---- P08: the evidence of a node and of an edge ----

def evidence_graph(cfg):
    (cfg.claude_home / "rules" / "writing.md").write_text("# Writing\n- Do not use dashes in a reply.\n- Use UK spelling.\n", encoding="utf-8")
    nodes = [
        {"id": "rule:writing-001", "type": "Rule", "props": {"text": "Do not use dashes in a reply.", "evidence": "rules/writing.md:2"}},
        {"id": "rule:writing-002", "type": "Rule", "props": {"text": "Do not use dashes in a reply.", "evidence": "rules/writing.md:3"}},
        {"id": "rule:writing-003", "type": "Rule", "props": {"text": "Use UK spelling.", "evidence": "rules/writing.md:99"}},
        {"id": "rule:missing-001", "type": "Rule", "props": {"text": "A rule.", "evidence": "rules/missing.md:1"}},
        {"id": "section:writing-a", "type": "Section", "props": {"evidence": "claude/rules/writing.md:1"}},  # the named root resolves to cfg.claude_home
        {"id": "builtin:read", "type": "BuiltinTool", "props": {"evidence": "Claude Code"}},
    ]
    edges = [
        {"s": "rule:writing-001", "r": "restates", "t": "rule:writing-002", "evidence": "computed: 0.90 of the rule's words"},
        {"s": "rule:writing-001", "r": "refersTo", "t": "tool:x", "evidence": "rules/writing.md:2 and rules/gone.md:4"},
        {"s": "rule:writing-001", "r": "mentions", "t": "term:x", "evidence": "rules/writing.md:40"},
    ]
    return nodes, edges


def test_p08_checks_file_line_and_rule_text(tmp_path):
    cfg = make_cfg(tmp_path)
    nodes, edges = evidence_graph(cfg)
    found = validate.check_p08(cfg, nodes, edges)
    by_node = {f["node"]: f["message"] for f in found if f["message"].startswith("The evidence of the node")}
    assert set(by_node) == {"rule:writing-002", "rule:writing-003", "rule:missing-001"}
    assert "does not hold the text of the rule" in by_node["rule:writing-002"]
    assert "line 99 of rules/writing.md, which has 3 lines" in by_node["rule:writing-003"]
    assert "rules/missing.md, which does not exist" in by_node["rule:missing-001"]
    edge_msgs = [f["message"] for f in found if "of the edge" in f["message"]]
    assert len(edge_msgs) == 2 and any("rules/gone.md" in m for m in edge_msgs) and any("line 40" in m for m in edge_msgs)
    assert all(f["check"] == "P08" and f["severity"] == "warning" for f in found)


def test_p08_runs_in_a_normal_check_and_not_in_ci(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)

    def extra(h):
        h.add_node(Node("rule:missing-001", "Missing", props={"text": "A rule.", "evidence": "rules/missing.md:1"}))

    build_small(cfg, monkeypatch, extra)
    assert any(f["check"] == "P08" and f["node"] == "rule:missing-001" for f in validate.check(cfg)["findings"])
    assert not any(f["check"] == "P08" for f in validate.check(cfg, ci=True)["findings"])


def test_b03_is_a_blocking_violation_in_ci_only(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    build_small(cfg, monkeypatch)
    b03 = {"check": "B03", "severity": "warning", "node": None, "evidence": "No module named nmo_python",
           "message": "The reasoning step did not run because the rule engine Nemo is not available."}
    (cfg.data_dir / "findings.json").write_text(json.dumps({"v": 1, "findings": [b03]}), encoding="utf-8")
    normal = [f for f in validate.check(cfg)["findings"] if f["check"] == "B03"]
    assert [f["severity"] for f in normal] == ["warning"] and not validate.ci_blocking(normal)
    in_ci = [f for f in validate.check(cfg, ci=True)["findings"] if f["check"] == "B03"]
    assert [f["severity"] for f in in_ci] == ["violation"]
    assert "B03" in validate.CI_BLOCKING and validate.ci_blocking(in_ci) == in_ci


# ---- the SHACL run reads the stated and ratified graphs (rigour audit, standards-F02 and the request of round 1) ----

REPO = Path(__file__).resolve().parents[2]
TRIG_HEAD = """@prefix cx: <https://cortex.local/ont#> .
@prefix cxi: <https://cortex.local/id/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
"""
ITEM = """cxi:openitem\\/i a cx:OpenItem ; rdfs:label "i" ; cx:family "record" ; cx:sensitivity "internal" ; cx:text "Do it." ."""
SECTION = """cxi:backlog\\/b a cx:BacklogSection ; rdfs:label "b" ; cx:family "record" ; cx:sensitivity "internal" ."""
PERSON = """cxi:person\\/p a cx:Person ; rdfs:label "p" ; cx:family "world" ; cx:sensitivity "internal" ."""
PROJECT = """cxi:project\\/q a cx:Project ; rdfs:label "q" ; cx:family "work" ; cx:sensitivity "internal" ;
    cx:documentedIn cxi:memory\\/m .
cxi:memory\\/m a cx:MemoryFile ; rdfs:label "m" ; cx:family "record" ; cx:sensitivity "internal" ;
    cx:memoryType "project" ; cx:summary "S." ."""


def shacl_cfg(tmp: Path, stated: str, ratified: str = "", proposed: str = "") -> Config:
    """A data folder with a graph.trig holding the given graphs, and the real ontology and shapes of the repository."""
    data = tmp / "data"
    data.mkdir(parents=True, exist_ok=True)
    base = "https://cortex.local/graph/"
    parts = [TRIG_HEAD]
    for name, body in (("stated", stated), ("ratified", ratified), ("proposed", proposed)):
        parts.append(f"<{base}{name}> {{\n{body}\n}}\n")
    (data / "graph.trig").write_text("\n".join(parts), encoding="utf-8")
    return Config(claude_home=tmp / "home", projects_root=tmp / "projects", memory_dir=tmp / "memory", data_dir=data,
                  port=5182, include_sensitivity=["public", "internal", "client-confidential"],
                  log_prompt_snippets=False, repo_root=REPO)


def checks_of(findings) -> set:
    return {f["check"] for f in findings}


def test_shacl_sees_a_ratified_edge(tmp_path):
    """graph.ttl no longer holds a ratified edge, so a shape over belongsTo must read it from the ratified graph."""
    stated = "\n".join([ITEM, SECTION, PERSON])
    wrong = shacl_cfg(tmp_path / "wrong", stated, ratified="cxi:openitem\\/i cx:belongsTo cxi:person\\/p .")
    found = validate.run_shacl(wrong, {})
    assert "S18" in checks_of(found) and "S26" not in checks_of(found)  # the item has its one belongsTo edge, to a person
    right = shacl_cfg(tmp_path / "right", stated, ratified="cxi:openitem\\/i cx:belongsTo cxi:backlog\\/b .")
    found = validate.run_shacl(right, {})
    assert not {"S18", "S26"} & checks_of(found)  # without the ratified graph the item would break S26 for lack of the edge


def test_shacl_ignores_a_proposed_edge(tmp_path):
    stated = "\n".join([ITEM, SECTION, PERSON])
    cfg = shacl_cfg(tmp_path, stated, ratified="cxi:openitem\\/i cx:belongsTo cxi:backlog\\/b .",
                    proposed="cxi:openitem\\/i cx:belongsTo cxi:person\\/p .")
    assert not {"S18", "S26"} & checks_of(validate.run_shacl(cfg, {}))


def test_shacl_falls_back_to_graph_ttl_without_a_dataset(tmp_path):
    cfg = shacl_cfg(tmp_path, "")
    (cfg.data_dir / "graph.trig").unlink()
    (cfg.data_dir / "graph.ttl").write_text(TRIG_HEAD + "\n".join([ITEM, SECTION]) + "\ncxi:openitem\\/i cx:belongsTo cxi:backlog\\/b .\n",
                                            encoding="utf-8")
    assert not {"S18", "S26", "B03"} & checks_of(validate.run_shacl(cfg, {}))
    (cfg.data_dir / "graph.ttl").unlink()
    assert [f["check"] for f in validate.run_shacl(cfg, {})] == ["B03"]


def test_shacl_reports_a_node_that_lost_its_family_and_a_node_without_a_class(tmp_path):
    lost = 'cxi:agent\\/scout a cx:Agent ; rdfs:label "scout" ; cx:sensitivity "internal" ; cx:model "sonnet" .'
    ghost = 'cxi:rule\\/ghost cx:text "No class." .'
    found = validate.run_shacl(shacl_cfg(tmp_path, "\n".join([lost, ghost])), {})
    by_node = {(f["check"], f["node"]) for f in found}
    assert ("S01", "agent:scout") in by_node and ("S12", "agent:scout") in by_node
    assert ("S23", "rule:ghost") in by_node


def test_p09_reports_an_edge_outside_the_declared_domain_and_range(tmp_path):
    """cx:builtWith has no shape, so the generic check reads its domain and range from cortex.ttl."""
    bad = "cxi:project\\/q cx:builtWith cxi:person\\/p ."
    cfg = shacl_cfg(tmp_path / "bad", "\n".join([PROJECT, PERSON, bad]))
    p09 = [f for f in validate.run_shacl(cfg, {}) if f["check"] == "P09"]
    assert len(p09) == 1 and p09[0]["node"] == "project:q" and "Person" in p09[0]["message"] and p09[0]["severity"] == "warning"
    wrong_subject = "cxi:person\\/p cx:builtWith cxi:project\\/q ."
    cfg = shacl_cfg(tmp_path / "subject", "\n".join([PROJECT, PERSON, wrong_subject]))
    assert len([f for f in validate.run_shacl(cfg, {}) if f["check"] == "P09"]) == 2  # the domain and the range both fail
    good_app = ('cxi:app\\/x a cx:App ; rdfs:label "x" ; cx:family "work" ; cx:sensitivity "internal" .\n'
                "cxi:project\\/q cx:builtWith cxi:app\\/x .")
    cfg = shacl_cfg(tmp_path / "good", "\n".join([PROJECT, good_app]))
    assert "P09" not in checks_of(validate.run_shacl(cfg, {}))


def test_p09_leaves_a_relation_that_has_a_shape_to_its_shape(tmp_path):
    cfg = shacl_cfg(tmp_path, "\n".join([ITEM, SECTION, PERSON]), ratified="cxi:openitem\\/i cx:belongsTo cxi:person\\/p .")
    found = validate.run_shacl(cfg, {})
    assert "S18" in checks_of(found) and "P09" not in checks_of(found)


def test_p09_checks_invokes_because_its_shape_only_counts(tmp_path):
    """S06 gives invokes a minCount and no class, so P09 must still check its domain and range."""
    org = 'cxi:org\\/orbit a cx:Organisation ; rdfs:label "Orbit" ; cx:family "work" ; cx:sensitivity "internal" .'
    tool = 'cxi:tool\\/t a cx:Tool ; rdfs:label "t" ; cx:family "harness" ; cx:sensitivity "internal" .'
    hook = 'cxi:hook\\/h a cx:Hook ; rdfs:label "h" ; cx:family "harness" ; cx:sensitivity "internal" .'
    good = "cxi:hook\\/h cx:invokes cxi:tool\\/t ."
    cfg = shacl_cfg(tmp_path / "good", "\n".join([org, tool, hook, good]))
    assert "P09" not in checks_of(validate.run_shacl(cfg, {}))
    wrong_subject = "cxi:org\\/orbit cx:invokes cxi:tool\\/t ."
    cfg = shacl_cfg(tmp_path / "subject", "\n".join([org, tool, hook, good, wrong_subject]))
    assert "P09" in checks_of(validate.run_shacl(cfg, {}))
    wrong_object = "cxi:hook\\/h cx:invokes cxi:org\\/orbit ."
    cfg = shacl_cfg(tmp_path / "object", "\n".join([org, tool, hook, good, wrong_object]))
    assert "P09" in checks_of(validate.run_shacl(cfg, {}))


def test_the_structural_shapes_block_in_ci():
    """S12 (the family of the class) and S23 (a node with no class) fail a CI run, and the relation shapes do not."""
    assert {"S12", "S23"} <= validate.CI_BLOCKING
    assert not {"S13", "S18", "S21", "S22", "S24", "S25", "S26", "P08", "P09"} & validate.CI_BLOCKING


def _node_text(cls: str, name: str) -> str:
    return f'cxi:{name}\\/{cls} a cx:{cls} ; rdfs:label "{name}" .'


def test_p09_or_a_shape_catches_a_wrong_edge_for_every_relation(tmp_path):
    """standards-F01. For each relation of cortex.ttl that has a domain or a range, plant a subject of a wrong class and then
    an object of a wrong class, and require the check P09 or a relation shape (S13 to S22) to report the subject node."""
    from rdflib import Graph, URIRef
    from rdflib.namespace import OWL, RDF, RDFS
    from rdflib.collection import Collection
    onto = Graph().parse(REPO / "ontology" / "cortex.ttl", format="turtle")
    cx = "https://cortex.local/ont#"
    classes = sorted(str(c) for c in onto.subjects(RDF.type, OWL.Class) if isinstance(c, URIRef) and str(c).startswith(cx))

    def members(expr):
        lst = onto.value(expr, OWL.unionOf)
        return {str(m) for m in Collection(onto, lst)} if lst is not None else {str(expr)}

    def supers(c):
        seen, todo = {c}, [URIRef(c)]
        while todo:
            for p in onto.objects(todo.pop(), RDFS.subClassOf):
                if isinstance(p, URIRef) and str(p) not in seen:
                    seen.add(str(p))
                    todo.append(p)
        return seen

    def name(c):
        return c.rsplit("#", 1)[-1]

    def wrong_for(allowed):
        return next((c for c in classes if not (supers(c) & allowed)), None)

    relation_shapes = {f"S{n}" for n in range(13, 23)}
    checked = 0
    for prop in sorted(onto.subjects(RDF.type, OWL.ObjectProperty)):
        doms = {m for e in onto.objects(prop, RDFS.domain) for m in members(e)}
        rngs = {m for e in onto.objects(prop, RDFS.range) for m in members(e)}
        rel = name(str(prop))
        for side, allowed in (("domain", doms), ("range", rngs)):
            wrong = wrong_for(allowed) if allowed else None
            if wrong is None:  # no declaration, or every class is a subclass of the declared one
                continue
            s_cls = name(wrong) if side == "domain" else (name(sorted(doms)[0]) if doms else "Folder")
            o_cls = name(wrong) if side == "range" else (name(sorted(rngs)[0]) if rngs else "Folder")
            text = [_node_text(s_cls, "a"), _node_text(o_cls, "b"), f"cxi:a\\/{s_cls} cx:{rel} cxi:b\\/{o_cls} ."]
            cfg = shacl_cfg(tmp_path / f"{rel}-{side}", "\n".join(text))
            found = validate.run_shacl(cfg, {})
            hit = [f for f in found if f["node"] == f"a:{s_cls}" and (
                (f["check"] == "P09" and rel in f["message"]) or f["check"] in relation_shapes)]
            assert hit, f"a wrong {side} on {rel} ({s_cls} to {o_cls}) is reported by no check: {sorted(checks_of(found))}"
            checked += 1
    assert checked >= 20


def test_p08_resolves_the_root_that_md_evidence_writes(tmp_path):
    """md.evidence writes '<root>/<relative path>:<line>' with the root memory, claude or projects."""
    cfg = make_cfg(tmp_path)
    (cfg.claude_home / "agents").mkdir(parents=True, exist_ok=True)
    (cfg.claude_home / "agents" / "builder.md").write_text("line\n", encoding="utf-8")
    nodes = [{"id": "agent:builder", "type": "Agent", "props": {"evidence": "claude/agents/builder.md:1"}},
             {"id": "agent:gone", "type": "Agent", "props": {"evidence": "claude/agents/gone.md:1"}}]
    found = validate.check_p08(cfg, nodes, [])
    assert [f["node"] for f in found] == ["agent:gone"]



def test_p08_accepts_a_web_address_among_several_sources(tmp_path):
    from cortex_kg.validate import check_p08
    cfg = make_cfg(tmp_path)
    nodes = [{"id": "term:hook", "type": "Concept", "props": {"evidence": "Claude Code documentation, https://code.claude.com/docs"}}]
    assert check_p08(cfg, nodes, []) == []
    nodes[0]["props"]["evidence"] = "Claude Code documentation, rules/missing.md:3"
    assert len(check_p08(cfg, nodes, [])) == 1   # a missing file among the sources still gives the finding
