"""Tests for the reasoning step: the fact export, rules R01 to R12, proof trees and the path without the engine."""
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cortex_kg import reason  # noqa: E402
from cortex_kg.config import Config  # noqa: E402

REPO_RULES = Path(__file__).resolve().parents[2] / "ontology" / "rules"
TODAY = "2026-10-06"


def node(i, typ, status=None, date=None, uses=0, last=None, props=None, source="bracketed"):
    props = dict(props or {})
    if date and source:
        props.setdefault("dateSource", source)   # the harvester gives a date in brackets unless a test says otherwise
    return {"id": i, "type": typ, "label": i, "status": status, "date": date, "sensitivity": "internal",
            "props": props, "metrics": {"uses": uses, "last_used": last, "degree": 0}}


def graph(nodes, edges, provenance=None):
    out = []
    for s, r, t in edges:
        e = {"s": s, "r": r, "t": t, "w": 0.5, "evidence": None}
        if provenance:
            e["provenance"] = provenance
        out.append(e)
    return {"nodes": nodes, "edges": out, "built": "2026-10-06T09:00:00Z"}


@pytest.fixture
def cfg(mini_cfg: Config) -> Config:
    dest = mini_cfg.ontology_dir / "rules"
    dest.mkdir(parents=True, exist_ok=True)
    for f in REPO_RULES.glob("*.rls"):
        shutil.copy(f, dest / f.name)
    return mini_cfg


@pytest.fixture
def engine():
    return pytest.importorskip("nmo_python")


def findings_of(cfg, g, check):
    inferred, edges, findings = reason.run(cfg, g, TODAY)
    assert inferred["engine"] is not None, findings
    return [f["node"] for f in findings if f["check"] == check]


def edges_of(cfg, g, relation):
    _inferred, edges, _findings = reason.run(cfg, g, TODAY)
    return {(e["s"], e["t"]) for e in edges if e["r"] == relation}


# ---------------------------------------------------------------- facts and parsing

def test_facts_export_escapes_and_derives_days_and_idle():
    g = graph([node('rule:a"b', "Rule", status="active", date="2026-09-29"),
               node("project:p", "Project", status="active", uses=3, last="2026-09-26T10:00:00Z"),
               node("file:back\\slash", "RuleFile")],
              [('rule:a"b', "restates", "file:back\\slash")])
    text = reason.facts(g, TODAY)
    assert 'node("""rule:a"b""", "Rule") .' in text
    assert 'node("file:back\\\\slash", "RuleFile") .' in text
    assert 'status("project:p", "active") .' in text
    assert 'day("""rule:a"b""", 20260929) .' in text
    assert 'uses("project:p", 3) .' in text
    assert 'idle("project:p", 10) .' in text
    assert 'stated_day("""rule:a"b""", 20260929) .' in text
    assert 'sensitivity("project:p", "internal") .' in text
    assert 'edge("""rule:a"b""", "restates", "file:back\\\\slash") .' in text
    assert "idle(" not in text.split('idle("project:p", 10)')[1]  # no other node has a last use


def test_facts_skip_inferred_edges():
    g = graph([node("rule:a", "Rule"), node("rule:b", "Rule")], [("rule:a", "restates", "rule:b")])
    g["edges"].append({"s": "rule:b", "r": "restates", "t": "rule:a", "w": 0.6, "evidence": None, "inferred": True})
    assert text_count(reason.facts(g, TODAY), "edge(") == 1


def text_count(text, needle):
    return text.count(needle)


def test_parse_rules_reads_headers_and_statements():
    rules = reason.parse_rules(REPO_RULES / "cortex.rls")
    assert [r["id"] for r in rules] == [f"R{i:02d}" for i in range(1, 14)]
    kinds = {r["id"]: r["kind"] for r in rules}
    assert kinds["R01"] == "inference" and kinds["R04"] == "violation" and kinds["R11"] == "info" and kinds["R10"] == "warning"
    assert all(r["message"].endswith(".") and r["text"].endswith(".") for r in rules)
    two = reason.parse_rules("%% X1 | warning | One.\nwarning(\"X1\", ?A) :- node(?A,\n   \"Rule\") .\n")
    assert two == [{"id": "X1", "kind": "warning", "message": "One.", "text": 'warning("X1", ?A) :- node(?A, "Rule") .'}]


# ---------------------------------------------------------------- rules R01 to R12

def test_r01_restates_is_symmetric(cfg, engine):
    nodes = [node("rule:a", "Rule"), node("rule:b", "Rule")]
    assert edges_of(cfg, graph(nodes, [("rule:a", "restates", "rule:b")]), "restates") == {("rule:b", "rule:a")}
    both = graph(nodes, [("rule:a", "restates", "rule:b"), ("rule:b", "restates", "rule:a")])
    assert edges_of(cfg, both, "restates") == set()


def test_r02_supersedes_chain(cfg, engine):
    nodes = [node(f"rule:{c}", "Rule") for c in "abc"]
    chain = graph(nodes, [("rule:a", "supersedes", "rule:b"), ("rule:b", "supersedes", "rule:c")])
    assert edges_of(cfg, chain, "supersedesChain") == {("rule:a", "rule:c")}
    assert edges_of(cfg, graph(nodes, [("rule:a", "supersedes", "rule:b")]), "supersedesChain") == set()


def test_r03_later_rule_overrides(cfg, engine):
    dated = graph([node("rule:a", "Rule", date="2026-09-01"), node("rule:b", "Rule", date="2026-08-01")],
                  [("rule:a", "conflictsWith", "rule:b")])
    assert edges_of(cfg, dated, "overrides") == {("rule:a", "rule:b")}
    undated = graph([node("rule:a", "Rule", date="2026-09-01"), node("rule:b", "Rule")],
                    [("rule:a", "conflictsWith", "rule:b")])
    assert edges_of(cfg, undated, "overrides") == set()
    # a date that the text only mentions is not a date the rule was given, so it orders nothing (reasoning-F10)
    mentioned = graph([node("rule:a", "Rule", date="2026-09-01", source="text"), node("rule:b", "Rule", date="2026-08-01")],
                      [("rule:a", "conflictsWith", "rule:b")])
    assert edges_of(cfg, mentioned, "overrides") == set()
    assert findings_of(cfg, mentioned, "R04") == ["rule:a", "rule:b"]


def test_r04_unsettled_conflict(cfg, engine):
    e = [("rule:a", "conflictsWith", "rule:b")]
    assert findings_of(cfg, graph([node("rule:a", "Rule"), node("rule:b", "Rule")], e), "R04") == ["rule:a", "rule:b"]
    dated = graph([node("rule:a", "Rule", date="2026-09-01"), node("rule:b", "Rule", date="2026-08-01")], e)
    assert findings_of(cfg, dated, "R04") == []
    both = graph([node("rule:a", "Rule"), node("rule:b", "Rule"), node("decision:d", "Decision")],
                 e + [("decision:d", "governs", "rule:a"), ("decision:d", "governs", "rule:b")])
    assert findings_of(cfg, both, "R04") == []
    # a decision about only one of the rules does not name the conflict, so it settles nothing (reasoning-F10)
    one = graph([node("rule:a", "Rule"), node("rule:b", "Rule"), node("decision:d", "Decision")],
                e + [("decision:d", "governs", "rule:a")])
    assert findings_of(cfg, one, "R04") == ["rule:a", "rule:b"]
    old = graph([node("rule:a", "Rule"), node("rule:b", "Rule", status="superseded")], e)
    assert findings_of(cfg, old, "R04") == []


def read_first_graph(read=True, extra=()):
    nodes = [node("task:deck", "TaskType"), node("reference:x", "ReferenceFile"), node("section:x-s", "Section"),
             node("rule:x-001", "Rule"), *extra]
    edges = [("reference:x", "contains", "section:x-s"), ("section:x-s", "contains", "rule:x-001")]
    if read:
        edges.append(("task:deck", "readsFirst", "reference:x"))
    return nodes, edges


def test_r05_rule_applies_to_task(cfg, engine):
    nodes, edges = read_first_graph(True)
    assert edges_of(cfg, graph(nodes, edges), "appliesToTask") == {("rule:x-001", "task:deck")}
    nodes, edges = read_first_graph(False)
    assert edges_of(cfg, graph(nodes, edges), "appliesToTask") == set()
    nodes, edges = read_first_graph(True)  # a superseded rule applies to no task type (reasoning-F09)
    nodes[3] = node("rule:x-001", "Rule", status="superseded")
    assert edges_of(cfg, graph(nodes, edges), "appliesToTask") == set()


def test_r06_unrouted_reference(cfg, engine):
    nodes, edges = read_first_graph(False)
    assert findings_of(cfg, graph(nodes, edges), "R06") == ["reference:x"]
    nodes, edges = read_first_graph(True)
    assert findings_of(cfg, graph(nodes, edges), "R06") == []
    nodes, edges = read_first_graph(False, [node("rulefile:r", "RuleFile")])
    assert findings_of(cfg, graph(nodes, edges + [("rulefile:r", "refersTo", "reference:x")]), "R06") == []
    # a citation two hops from a rule file does not count
    nodes, edges = read_first_graph(False, [node("rulefile:r", "RuleFile"), node("reference:y", "ReferenceFile")])
    chain = edges + [("rulefile:r", "refersTo", "reference:y"), ("reference:y", "refersTo", "reference:x")]
    assert findings_of(cfg, graph(nodes, chain), "R06") == ["reference:x"]


def test_r07_restated_rules_with_different_dates(cfg, engine):
    e = [("rule:a", "restates", "rule:b")]
    older = graph([node("rule:a", "Rule", date="2026-09-01"), node("rule:b", "Rule", date="2026-09-29")], e)
    assert findings_of(cfg, older, "R07") == ["rule:a"]
    same = graph([node("rule:a", "Rule", date="2026-09-29"), node("rule:b", "Rule", date="2026-09-29")], e)
    assert findings_of(cfg, same, "R07") == []


def test_r08_supersedes_itself(cfg, engine):
    nodes = [node("rule:a", "Rule"), node("rule:b", "Rule")]
    loop = graph(nodes, [("rule:a", "supersedes", "rule:b"), ("rule:b", "supersedes", "rule:a")])
    assert sorted(findings_of(cfg, loop, "R08")) == ["rule:a", "rule:b"]
    assert findings_of(cfg, graph(nodes, [("rule:a", "supersedes", "rule:b")]), "R08") == []


def test_r09_active_rule_superseded_by_an_active_rule(cfg, engine):
    e = [("rule:new", "supersedes", "rule:old")]
    both = graph([node("rule:new", "Rule"), node("rule:old", "Rule")], e)
    assert findings_of(cfg, both, "R09") == ["rule:old"]
    marked = graph([node("rule:new", "Rule"), node("rule:old", "Rule", status="superseded")], e)
    assert findings_of(cfg, marked, "R09") == []


def test_r09_runs_on_harvested_rules(cfg, engine):
    """The harvester sets status superseded from the heading, so the rule cannot rest on that status (reasoning-F02).
    Run the real harvest of the skill files and check that a rule under 'Superseded rules' is not reported by R09."""
    from cortex_kg.harvest import skills
    from cortex_kg.ledger import Ledger
    h = skills.harvest(cfg, Ledger(), TODAY)
    nodes = [{**n.to_json(), "metrics": {"uses": 0, "last_used": None}} for n in h.nodes.values()]
    old = next(n for n in nodes if n["status"] == "superseded")
    edges = [{"s": e.s, "r": e.r, "t": e.t} for e in h.edges.values()]
    live = next(n["id"] for n in nodes if n["type"] == "Rule" and n["status"] is None)
    assert findings_of(cfg, {"nodes": nodes, "edges": edges}, "R09") == []
    edges.append({"s": live, "r": "supersedes", "t": old["id"]})
    assert findings_of(cfg, {"nodes": nodes, "edges": edges}, "R09") == []   # the target is already marked superseded
    old["status"] = None
    assert findings_of(cfg, {"nodes": nodes, "edges": edges}, "R09") == [old["id"]]


def test_r10_idle_active_project(cfg, engine):
    idle = graph([node("project:p", "Project", status="active", uses=2, last="2026-08-27T00:00:00Z")], [])
    assert findings_of(cfg, idle, "R10") == ["project:p"]
    recent = graph([node("project:p", "Project", status="active", uses=2, last="2026-09-26T00:00:00Z")], [])
    assert findings_of(cfg, recent, "R10") == []
    parked = graph([node("project:p", "Project", status="parked", uses=2, last="2026-08-27T00:00:00Z")], [])
    assert findings_of(cfg, parked, "R10") == []


def write_event(cfg, ts):
    cfg.events_dir.mkdir(parents=True, exist_ok=True)
    line = json.dumps({"v": 1, "ts": ts, "kind": "prompt", "nodes": []})
    (cfg.events_dir / f"{ts[:7]}.jsonl").write_text(line + "\n", encoding="utf-8")


def test_r13_active_project_never_used_while_events_cover_30_days(cfg, engine):
    g = graph([node("project:p", "Project", status="active"), node("project:q", "Project", status="parked")], [])
    assert findings_of(cfg, g, "R13") == []                       # no event store, so no coverage to judge by
    write_event(cfg, "2026-10-01T00:00:00Z")
    assert findings_of(cfg, g, "R13") == []                       # the store is 5 days old
    write_event(cfg, "2026-05-02T20:24:01.816Z")
    (cfg.events_dir / "2026-10.jsonl").unlink()
    assert findings_of(cfg, g, "R13") == ["project:p"]
    used = graph([node("project:p", "Project", status="active", uses=1, last="2026-10-01T00:00:00Z")], [])
    assert findings_of(cfg, used, "R13") == []


def test_r11_ratified_term_nobody_mentions(cfg, engine):
    nodes = [node("term:t", "Concept", props={"status": "ratified"}), node("project:p", "Project"),
             node("memory:m", "MemoryFile")]
    edges = [("term:t", "denotes", "project:p")]
    assert findings_of(cfg, graph(nodes, edges), "R11") == ["term:t"]
    assert findings_of(cfg, graph(nodes, edges + [("memory:m", "mentions", "term:t")]), "R11") == []
    proposed = [node("term:t", "Concept", props={"status": "proposed"}), nodes[1]]
    assert findings_of(cfg, graph(proposed, edges), "R11") == []


def test_r12_unrouted_unused_instruction_file(cfg, engine):
    nodes = [node("rulefile:r", "RuleFile")]
    assert findings_of(cfg, graph(nodes, []), "R12") == ["rulefile:r"]
    assert findings_of(cfg, graph([node("rulefile:r", "RuleFile", uses=1)], []), "R12") == []
    scoped = graph([*nodes, node("scope:s", "PathScope")], [("rulefile:r", "appliesTo", "scope:s")])
    assert findings_of(cfg, scoped, "R12") == []


# ---------------------------------------------------------------- proofs

def depth(p):
    return 1 + max((depth(c) for c in p["children"]), default=0)


def test_findings_carry_proofs(cfg, engine):
    g = graph([node("rule:a", "Rule"), node("rule:b", "Rule")], [("rule:a", "conflictsWith", "rule:b")])
    inferred, _edges, findings = reason.run(cfg, g, TODAY)
    assert inferred["engine"]["name"] == "nemo"
    f = next(x for x in inferred["facts"] if x["kind"] == "violation")
    assert f["key"] == 'violation("R04","rule:a")' and f["rule"] == "R04" and f["args"] == ["R04", "rule:a"]
    assert f["proof"]["rule"] == "R04" and f["proof"]["fact"] == 'violation("R04", "rule:a")'
    leaves = []

    def walk(p):
        leaves.extend(p["fact"] for p in [p] if p["rule"] is None)
        for c in p["children"]:
            walk(c)

    walk(f["proof"])
    assert 'edge("rule:a", "conflictsWith", "rule:b")' in leaves
    assert findings[0]["message"].startswith("Two active rules conflict")
    assert json.loads((cfg.data_dir / "inferred.json").read_text(encoding="utf-8"))["engine"]["version"]


def test_proof_trees_are_cut_at_depth_8(cfg, engine):
    names = [f"rule:c{i:02d}" for i in range(14)]
    g = graph([node(n, "Rule") for n in names], [(a, "supersedes", b) for a, b in zip(names, names[1:])])
    inferred, _edges, _f = reason.run(cfg, g, TODAY)
    proofs = [f["proof"] for f in inferred["facts"] if f["proof"]]
    assert proofs and max(depth(p) for p in proofs) == 8
    far = next(f for f in inferred["facts"] if f["key"] == 'inferred("rule:c00","supersedesChain","rule:c13")')
    assert depth(far["proof"]) == 8


def test_explain_prints_an_indented_proof(cfg, engine):
    g = graph([node("rule:a", "Rule"), node("rule:b", "Rule")], [("rule:a", "conflictsWith", "rule:b")])
    inferred, _e, _f = reason.run(cfg, g, TODAY)
    lines = reason.explain(inferred, 'violation("R04","rule:a")')
    assert lines[0].startswith('violation("R04","rule:a") was derived by R04')
    assert any(line.startswith("  ") and "given as a fact" in line for line in lines)
    assert reason.explain(inferred, "nothing here")[0].startswith("No inferred fact matches")


# ---------------------------------------------------------------- the path without the engine

def test_missing_engine_gives_b03_and_no_exception(cfg, monkeypatch):
    monkeypatch.setitem(sys.modules, "nmo_python", None)
    g = graph([node("rule:a", "Rule")], [])
    inferred, edges, findings = reason.run(cfg, g, TODAY)
    assert inferred["engine"] is None and inferred["facts"] == [] and edges == []
    assert [f["check"] for f in findings] == ["B03"] and findings[0]["severity"] == "warning"
    assert json.loads((cfg.data_dir / "inferred.json").read_text(encoding="utf-8"))["engine"] is None


def test_engine_failure_gives_b03(cfg, monkeypatch):
    class Broken:
        def load_string(self, text):
            raise RuntimeError("bad program")

    monkeypatch.setattr(reason, "_import_nemo", lambda: Broken())
    _inferred, _edges, findings = reason.run(cfg, graph([node("rule:a", "Rule")], []), TODAY)
    assert [f["check"] for f in findings] == ["B03"]


def build_cfg(tmp_path, monkeypatch):
    import test_compile as tc
    cfg = tc.make_cfg(tmp_path)
    tc.fake_modules(monkeypatch, tc.standard)
    (cfg.ontology_dir / "rules").mkdir(parents=True, exist_ok=True)
    for f in REPO_RULES.glob("*.rls"):
        shutil.copy(f, cfg.ontology_dir / "rules" / f.name)
    return cfg


def test_build_writes_every_file_without_the_engine(tmp_path, monkeypatch):
    from cortex_kg import compile as comp
    cfg = build_cfg(tmp_path, monkeypatch)
    monkeypatch.setitem(sys.modules, "nmo_python", None)
    r = comp.build(cfg, today="2026-10-06")
    for name in ("graph.json", "graph.ttl", "findings.json", "index.json", "inferred.json", "inferred.ttl"):
        assert (cfg.data_dir / name).is_file(), name
    findings = json.loads((cfg.data_dir / "findings.json").read_text(encoding="utf-8"))
    assert [f["check"] for f in findings["findings"] if f["check"] == "B03"] == ["B03"]
    assert r["nodes"] == 5


def test_build_adds_weighted_inferred_edges(tmp_path, monkeypatch, engine):
    from cortex_kg import compile as comp
    from cortex_kg.model import Harvest, Node
    import test_compile as tc

    def harvest(cfg, name):
        h = tc.standard(cfg, name)
        if name == "harness":
            h.add_node(Node("rule:a-001", "A"))
            h.add_node(Node("rule:b-001", "B"))
            h.add_edge("rule:a-001", "restates", "rule:b-001", "x:1")
        return h

    cfg = build_cfg(tmp_path, monkeypatch)
    tc.fake_modules(monkeypatch, harvest)
    (cfg.ontology_dir / "weights.json").write_text(json.dumps(
        {"relations": [{"id": "restates", "label": "restates", "inverse_label": "is restated by", "weight": 0.6,
                        "reverse_weight": 0.6}]}), encoding="utf-8")
    comp.build(cfg, today="2026-10-06")
    g = json.loads((cfg.data_dir / "graph.json").read_text(encoding="utf-8"))
    inferred = [e for e in g["edges"] if e.get("inferred")]
    assert inferred == []  # the mirror of a restates link stays in inferred.json until the links are reviewed
    assert g["stats"]["edges"] == len(g["edges"])
    assert any(f["args"] == ["rule:b-001", "restates", "rule:a-001"]
               for f in json.loads((cfg.data_dir / "inferred.json").read_text(encoding="utf-8"))["facts"])
    assert next(n for n in g["nodes"] if n["id"] == "rule:a-001")["metrics"]["degree"] == 1  # inferred edges add no degree
    ttl = (cfg.data_dir / "inferred.ttl").read_text(encoding="utf-8")
    assert "rule/b-001" in ttl and "restates" in ttl


# ---------------------------------------------------------------- provenance, negation, helpers and the stamp

def test_a_proposed_or_inferred_edge_feeds_no_rule(cfg, engine):
    nodes = [node("rule:a", "Rule"), node("rule:b", "Rule")]
    e = [("rule:a", "conflictsWith", "rule:b")]
    for prov in ("stated", "computed", "ratified"):
        assert findings_of(cfg, graph(nodes, e, prov), "R04") == ["rule:a", "rule:b"], prov
    for prov in ("proposed", "inferred"):
        assert findings_of(cfg, graph(nodes, e, prov), "R04") == [], prov
    assert findings_of(cfg, graph(nodes, e), "R04") == ["rule:a", "rule:b"]  # no provenance counts as stated
    assert text_count(reason.facts(graph(nodes, e, "proposed"), TODAY), "edge(") == 0


def leaves_and_nots(p, out=None):
    out = {"given": [], "absent": []} if out is None else out
    if p["rule"] is None:
        out["given"].append(p["fact"])
    if p["rule"] == reason.ABSENT:
        out["absent"].append(p["fact"])
    for c in p["children"]:
        leaves_and_nots(c, out)
    return out


def proof_of(inferred, key):
    return next(f for f in inferred["facts"] if f["key"] == key)["proof"]


def test_proofs_record_each_negated_atom(cfg, engine):
    g = graph([node("rule:a", "Rule"), node("rule:b", "Rule")], [("rule:a", "conflictsWith", "rule:b")])
    inferred, _e, _f = reason.run(cfg, g, TODAY)
    absent = leaves_and_nots(proof_of(inferred, 'violation("R04","rule:a")'))["absent"]
    assert sorted(absent) == ['not decided("rule:a", "rule:b")', 'not inactive("rule:a")', 'not inactive("rule:b")',
                              'not overrides("rule:a", "rule:b")', 'not overrides("rule:b", "rule:a")']
    nodes = [node("guide:g", "GuideFile")]
    inferred, _e, _f = reason.run(cfg, graph(nodes, []), TODAY)
    p = proof_of(inferred, 'warning("R06","guide:g")')
    assert sorted(leaves_and_nots(p)["absent"]) == ['not pointed("guide:g")', 'not routed("guide:g")']
    assert any(c["rule"] == reason.ABSENT and c["children"] == [] for c in p["children"])
    inferred, _e, _f = reason.run(cfg, graph([node("rule:a", "Rule"), node("rule:b", "Rule")],
                                             [("rule:a", "restates", "rule:b")]), TODAY)
    p = proof_of(inferred, 'inferred("rule:b","restates","rule:a")')
    assert leaves_and_nots(p)["absent"] == ['not edge("rule:b", "restates", "rule:a")']
    lines = reason.explain(inferred, 'inferred("rule:b","restates","rule:a")')
    assert any("absent from the graph" in line and "not edge(" in line for line in lines)


def test_a_negation_the_engine_contradicts_is_refused(cfg, engine):
    class Engine:
        pass

    prover = reason._Prover(Engine(), [], [], lambda pred, terms: True)
    with pytest.raises(reason.NegationError):
        prover.negations('x(?A) :- y(?A), ~z(?A) .', {"?A": '"a"'})
    ok = reason._Prover(Engine(), [], [], lambda pred, terms: False)
    assert ok.negations('x(?A) :- y(?A), ~z(?A, "k") .', {"?A": '"a"'})[0]["fact"] == 'not z("a", "k")'


def test_helpers_get_identifiers_and_the_run_is_stamped(cfg, engine):
    g = graph([node("rule:a", "Rule"), node("rule:b", "Rule")], [("rule:a", "conflictsWith", "rule:b")])
    inferred, _e, _f = reason.run(cfg, g, TODAY)
    helpers = inferred["helpers"]
    assert [h["id"] for h in helpers][:3] == ["H01", "H02", "H03"] and all(h["text"].endswith(".") for h in helpers)
    assert any(h["text"].startswith("active(?X)") for h in helpers)
    assert not any(h["text"].startswith("@") for h in helpers)  # an @output declaration is not a helper rule
    active = next(h["id"] for h in helpers if h["text"].startswith("active(?X)"))
    ids = set()

    def walk(p):
        ids.add(p["rule"])
        for c in p["children"]:
            walk(c)

    walk(proof_of(inferred, 'violation("R04","rule:a")'))
    assert active in ids and not any(i and ":-" in i for i in ids)  # no proof step shows raw rule text
    assert inferred["today"] == TODAY
    assert inferred["inputs"] == {"graph_built": "2026-10-06T09:00:00Z", "graph_sha256": reason.graph_digest(g)}
    assert list(inferred)[:4] == ["v", "built", "today", "inputs"]
    changed = graph([node("rule:a", "Rule"), node("rule:b", "Rule", status="parked")], [("rule:a", "conflictsWith", "rule:b")])
    assert reason.graph_digest(changed) != reason.graph_digest(g)
    g["edges"].append({"s": "rule:a", "r": "overrides", "t": "rule:b", "inferred": True, "provenance": "inferred"})
    assert reason.graph_digest(g) == reason.graph_digest(graph(g["nodes"], [("rule:a", "conflictsWith", "rule:b")]))


def test_a_helper_after_a_header_is_refused(cfg, engine):
    (cfg.ontology_dir / "rules" / "bad.rls").write_text(
        '%% X1 | warning | A rule.\nhelp(?A) :- node(?A, "Rule") .\nwarning("X1", ?A) :- help(?A) .\n', encoding="utf-8")
    inferred, _edges, findings = reason.run(cfg, graph([node("rule:a", "Rule")], []), TODAY)
    assert [f["check"] for f in findings] == ["B03"] and "follows the header of rule X1" in findings[0]["evidence"]
    assert inferred["engine"] is None


def test_dates_are_validated_and_idle_uses_the_run_date():
    assert reason._day("2026-09-29T10:00:00Z") == 20260929
    assert reason._day("2026-13-45") is None and reason._day("2026-02-30") is None and reason._day("soon") is None
    g = graph([node("rule:a", "Rule", date="2026-13-45")], [])
    assert text_count(reason.facts(g, TODAY), "day(") == 0
    assert reason._idle("2026-10-01T12:00:00", "2026-10-06") == 5   # a time with no zone is read as local
    assert reason._idle("garbage", TODAY) is None


def test_a_failed_write_raises(cfg, engine, monkeypatch):
    def broken(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr("cortex_kg.reason.os.replace", broken)
    with pytest.raises(OSError):
        reason.run(cfg, graph([node("rule:a", "Rule")], []), TODAY)
    monkeypatch.setitem(sys.modules, "nmo_python", None)  # the path without the engine writes too, and so raises too
    with pytest.raises(OSError):
        reason.run(cfg, graph([node("rule:a", "Rule")], []), TODAY)


def test_inferred_json_and_ttl_are_replaced_together(cfg, engine, monkeypatch):
    """reasoning-F09 review defect 8. A failure on the second rename leaves the first run's pair, and no temporary file."""
    g = graph([node("rule:a", "Rule")], [])
    reason.run(cfg, g, TODAY)
    before = {n: (cfg.data_dir / n).read_bytes() for n in ("inferred.json", "inferred.ttl")}
    real, calls = os.replace, []

    def second_fails(src, dst):
        calls.append(dst)
        if len(calls) == 2:
            raise OSError("disk full")
        return real(src, dst)

    monkeypatch.setattr("cortex_kg.reason.os.replace", second_fails)
    with pytest.raises(OSError):
        reason.run(cfg, graph([node("rule:a", "Rule"), node("rule:b", "Rule")], []), "2026-10-07")
    assert {n: (cfg.data_dir / n).read_bytes() for n in before} == before
    assert not list(cfg.data_dir.glob("inferred.*.tmp")) and not list(cfg.data_dir.glob("*.tmp"))
