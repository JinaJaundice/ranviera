"""Tests for the compiler, run on a fake set-up with fake harvesters."""
import json
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cortex_kg import compile as comp  # noqa: E402
from cortex_kg.config import Config, norm_path  # noqa: E402
from cortex_kg.model import Harvest, Node  # noqa: E402


def make_cfg(tmp: Path) -> Config:
    for d in ("home", "projects", "memory", "data", "data/profile/assertions", "repo/ontology"):
        (tmp / d).mkdir(parents=True, exist_ok=True)
    return Config(claude_home=tmp / "home", projects_root=tmp / "projects", memory_dir=tmp / "memory",
                  data_dir=tmp / "data", port=5182, include_sensitivity=["public", "internal"],
                  log_prompt_snippets=False, repo_root=tmp / "repo")


def fake_modules(monkeypatch, harvest_fn):
    """Every harvester returns harvest_fn() for its own name, and the optional modules are absent."""
    for name in comp.HARVEST_ORDER:
        mod = types.ModuleType(f"cortex_kg.harvest.{name}")
        mod.harvest = lambda cfg, *a, _n=name: harvest_fn(cfg, _n)
        monkeypatch.setitem(sys.modules, f"cortex_kg.harvest.{name}", mod)
    vocab = sys.modules["cortex_kg.harvest.vocab"]
    vocab.load = lambda cfg: []
    vocab.patterns = lambda concepts: []
    for name in ("ledger", "events", "activation", "sync"):
        monkeypatch.setitem(sys.modules, f"cortex_kg.{name}", None)


def standard(cfg, name):
    h = Harvest(name)
    if name != "harness":
        return h
    doc = cfg.projects_root / "doc.md"
    doc.write_text("x", encoding="utf-8")
    folder = cfg.projects_root / "apps" / "demo"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "main.py").write_text("x", encoding="utf-8")
    h.add_node(Node("claudemd:global", "Global map", path=str(cfg.claude_home / "CLAUDE.md")))
    h.add_node(Node("rulefile:writing", "Writing", path=str(cfg.claude_home / "rules" / "writing.md")))
    h.add_node(Node("template:doc", "Doc", path=str(doc)))
    h.add_node(Node("app:demo", "Demo", path=str(folder)))
    h.add_node(Node("agent:builder", "Builder", props={"name": "builder", "model": "sonnet"}))
    h.add_edge("claudemd:global", "contains", "rulefile:writing", "CLAUDE.md:1")
    h.add_edge("claudemd:global", "contains", "rule:ghost-001", "CLAUDE.md:2")  # the end node is missing
    h.ref("claudemd:global", "doc.md", norm_path(doc), "CLAUDE.md:3")
    h.ref("rulefile:writing", "demo/main.py", norm_path(folder / "main.py"), "writing.md:4")
    h.ref("rulefile:writing", "gone/file.md", None, "writing.md:5")
    return h


def read(cfg, name):
    return json.loads((cfg.data_dir / name).read_text(encoding="utf-8"))


def test_build_writes_five_files_with_contract_keys(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    fake_modules(monkeypatch, standard)
    result = comp.build(cfg, today="2026-10-05")
    assert result["nodes"] == 5 and result["dropped_edges"] == 1
    for f in ("graph.json", "graph.ttl", "findings.json", "index.json", "changes/2026-10-05.json"):
        assert (cfg.data_dir / f).is_file(), f
    g = read(cfg, "graph.json")
    assert set(g) == {"v", "built", "source", "classes", "relations", "nodes", "edges", "schemes", "health", "stats"}
    assert set(g["nodes"][0]) >= {"id", "type", "label", "family", "path", "summary", "date", "status", "sensitivity", "props", "metrics"}
    assert g["nodes"][0]["metrics"]["last_used"] is None and g["nodes"][0]["metrics"]["base_level"] is None
    assert all(set(e) == {"s", "r", "t", "w", "evidence", "provenance"} for e in g["edges"])
    idx = read(cfg, "index.json")
    assert set(idx) == {"v", "built", "paths", "prefixes", "routes", "skills", "agents", "tools", "terms", "faults", "hooks", "always"}
    assert idx["agents"] == {"builder": "agent:builder"}
    assert idx["always"] == ["claudemd:global", "rulefile:writing"]
    assert "https://cortex.local/id/agent/builder" in (cfg.data_dir / "graph.ttl").read_text(encoding="utf-8")


def test_refs_become_edges_and_missing_paths_become_p01(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    fake_modules(monkeypatch, standard)
    comp.build(cfg, today="2026-10-05")
    edges = {(e["s"], e["r"], e["t"]) for e in read(cfg, "graph.json")["edges"]}
    assert ("claudemd:global", "refersTo", "template:doc") in edges
    assert ("rulefile:writing", "refersTo", "app:demo") in edges  # longest folder prefix
    findings = read(cfg, "findings.json")["findings"]
    p01 = [f for f in findings if f["check"] == "P01"]
    # a relative path that the file index cannot find is a warning; a path from a known root is a violation
    assert len(p01) == 1 and p01[0]["severity"] == "warning"
    assert p01[0]["message"] == "The path gone/file.md cited in writing.md:5 does not exist."


def test_dangling_edge_is_dropped_and_reported(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    fake_modules(monkeypatch, standard)
    comp.build(cfg, today="2026-10-05")
    g = read(cfg, "graph.json")
    assert not any(e["t"] == "rule:ghost-001" for e in g["edges"])
    b02 = [f for f in read(cfg, "findings.json")["findings"] if f["check"] == "B02"]
    assert len(b02) == 1 and b02[0]["severity"] == "warning" and "1 contains edges" in b02[0]["message"]


def test_assertions_applied_and_bad_one_rejected(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    fake_modules(monkeypatch, standard)
    good = {"s": "claudemd:global", "r": "supersedes", "t": "template:doc", "status": "ratified",
            "date": "2026-10-05", "by": "test", "evidence": "test"}
    bad = {"s": "claudemd:global", "r": "restates", "t": "rule:nowhere-001", "status": "proposed",
           "date": "2026-10-05", "by": "test", "evidence": "test"}
    (cfg.profile_dir / "assertions" / "a.json").write_text(json.dumps({"assertions": [good, bad]}), encoding="utf-8")
    comp.build(cfg, today="2026-10-05")
    edges = {(e["s"], e["r"], e["t"]) for e in read(cfg, "graph.json")["edges"]}
    assert ("claudemd:global", "supersedes", "template:doc") in edges
    assert ("claudemd:global", "restates", "rule:nowhere-001") not in edges
    p05 = [f for f in read(cfg, "findings.json")["findings"] if f["check"] == "P05"]
    assert len(p05) == 1 and p05[0]["severity"] == "violation"


def test_a_rejected_assertion_is_kept_but_never_applied(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    fake_modules(monkeypatch, standard)
    rejected = {"s": "claudemd:global", "r": "supersedes", "t": "template:doc", "status": "rejected",
                "date": "2026-10-05", "by": "test", "evidence": "test", "reviewed_on": "2026-10-06",
                "reviewed_by": "test", "reason": "the evidence line states no decision"}
    (cfg.profile_dir / "assertions" / "a.json").write_text(json.dumps({"assertions": [rejected]}), encoding="utf-8")
    comp.build(cfg, today="2026-10-05")
    edges = {(e["s"], e["r"], e["t"]) for e in read(cfg, "graph.json")["edges"]}
    assert ("claudemd:global", "supersedes", "template:doc") not in edges
    findings = read(cfg, "findings.json")["findings"]
    assert not [f for f in findings if f["check"] in ("P05", "P10")]


def test_second_build_records_added_node(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    fake_modules(monkeypatch, standard)
    comp.build(cfg, today="2026-10-05")

    def more(cfg_, name):
        h = standard(cfg_, name)
        if name == "harness":
            h.add_node(Node("agent:writer", "Writer", props={"model": "sonnet"}))
        return h

    fake_modules(monkeypatch, more)
    comp.build(cfg, today="2026-10-05")
    ch = read(cfg, "changes/2026-10-05.json")
    assert {"id": "agent:writer", "label": "Writer"} in ch["added"]
    assert ch["removed"] == []


def test_failed_harvester_becomes_b01_and_build_continues(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)

    def broken(cfg_, name):
        if name == "memory":
            raise RuntimeError("boom")
        return standard(cfg_, name)

    fake_modules(monkeypatch, broken)
    comp.build(cfg, today="2026-10-05")
    b01 = [f for f in read(cfg, "findings.json")["findings"] if f["check"] == "B01"]
    assert len(b01) == 1 and "memory" in b01[0]["message"] and "boom" in b01[0]["message"]
    assert read(cfg, "graph.json")["stats"]["nodes"] == 5


def test_mentions_use_vocabulary_patterns_and_skip_self(tmp_path, monkeypatch):
    import re
    cfg = make_cfg(tmp_path)

    def with_text(cfg_, name):
        h = standard(cfg_, name)
        if name == "vocab":
            h.add_node(Node("term:builder", "Builder"))
        if name == "harness":
            h.texts["rulefile:writing"] = "Ask the Builder agent."
            h.texts["agent:builder"] = "I am the Builder."
        return h

    fake_modules(monkeypatch, with_text)
    vocab = sys.modules["cortex_kg.harvest.vocab"]
    vocab.patterns = lambda concepts: [({"id": "term:builder"}, re.compile(r"\bbuilder\b", re.I), ["agent:builder"])]
    comp.build(cfg, today="2026-10-05")
    edges = {(e["s"], e["r"], e["t"]) for e in read(cfg, "graph.json")["edges"]}
    assert ("rulefile:writing", "mentions", "term:builder") in edges
    assert ("agent:builder", "mentions", "term:builder") not in edges
    assert read(cfg, "index.json")["terms"][0]["fires"] == ["term:builder", "agent:builder"]


def test_sensitivity_filter_drops_nodes_and_edges(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)

    def sens(cfg_, name):
        h = standard(cfg_, name)
        if name == "harness":
            h.add_node(Node("person:jane", "Jane", sensitivity="client-confidential"))
            h.add_edge("claudemd:global", "mentions", "person:jane")
        return h

    fake_modules(monkeypatch, sens)
    comp.build(cfg, today="2026-10-05")
    g = read(cfg, "graph.json")
    assert "person:jane" not in {n["id"] for n in g["nodes"]}
    assert not any("person:jane" in (e["s"], e["t"]) for e in g["edges"])


def test_route_patterns_key_from_harvester_reaches_index_and_rdf(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)

    def with_route(c, name):
        h = Harvest(name)
        if name == "harness":
            h.add_node(Node("route:decks", "Decks", props={"patterns": ["\bdeck\b", "slide"]}))
        return h

    fake_modules(monkeypatch, with_route)
    comp.build(cfg, today="2026-10-05")
    route = read(cfg, "index.json")["routes"][0]
    assert route["patterns"] == ["\bdeck\b", "slide"]
    ttl = (cfg.data_dir / "graph.ttl").read_text(encoding="utf-8")
    assert "cx:pattern" in ttl and "slide" in ttl


def with_assertions(cfg, items):
    (cfg.profile_dir / "assertions" / "a.json").write_text(json.dumps({"assertions": items}), encoding="utf-8")


def assertion(s, r, t, status):
    return {"s": s, "r": r, "t": t, "status": status, "date": "2026-10-05", "by": "test", "evidence": "test"}


def test_every_edge_carries_its_provenance(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)

    def more(cfg_, name):
        h = standard(cfg_, name)
        if name == "harness":
            h.add_node(Node("agent:writer", "Writer", props={"model": "sonnet"}))
            h.add_node(Node("agent:checker", "Checker", props={"model": "sonnet"}))
        return h

    fake_modules(monkeypatch, more)
    restate = types.ModuleType("cortex_kg.restate")
    restate.add_edges = lambda h: h.add_edge("agent:writer", "restates", "agent:checker", "computed: 0.60 of the words")
    monkeypatch.setitem(sys.modules, "cortex_kg.restate", restate)
    reason = types.ModuleType("cortex_kg.reason")
    inferred = {"v": 1, "built": "2026-10-05T10:00:00Z", "facts": [], "rules": []}

    def run(cfg_, graph, today=None):
        comp.write_json(cfg_.data_dir / "inferred.json", inferred)
        return inferred, [{"s": "agent:builder", "r": "overrides", "t": "agent:writer", "evidence": "rule R03"}], []

    reason.run, reason.weights = run, lambda cfg_: {"overrides": 0.5}
    monkeypatch.setitem(sys.modules, "cortex_kg.reason", reason)
    with_assertions(cfg, [assertion("agent:builder", "governs", "agent:writer", "ratified"),
                          assertion("agent:builder", "governs", "agent:checker", "proposed"),
                          assertion("claudemd:global", "contains", "rulefile:writing", "ratified")])
    comp.build(cfg, today="2026-10-05")
    prov = {(e["s"], e["r"], e["t"]): e["provenance"] for e in read(cfg, "graph.json")["edges"]}
    assert prov[("claudemd:global", "contains", "rulefile:writing")] == "stated"  # a harvester stated it first
    assert prov[("agent:writer", "restates", "agent:checker")] == "computed"
    assert prov[("agent:builder", "governs", "agent:writer")] == "ratified"
    assert prov[("agent:builder", "governs", "agent:checker")] == "proposed"
    assert prov[("agent:builder", "overrides", "agent:writer")] == "inferred"
    from rdflib import Dataset, URIRef
    ds = Dataset()
    ds.parse(str(cfg.data_dir / "graph.trig"), format="trig")
    inferred_graph = ds.graph(URIRef("https://cortex.local/graph/inferred"))
    assert (URIRef("https://cortex.local/id/agent/builder"), URIRef("https://cortex.local/ont#overrides"),
            URIRef("https://cortex.local/id/agent/writer")) in inferred_graph


def test_graph_trig_has_five_named_graphs_and_ttl_is_the_stated_graph(tmp_path, monkeypatch):
    from rdflib import Dataset, URIRef
    cfg = make_cfg(tmp_path)
    fake_modules(monkeypatch, standard)
    with_assertions(cfg, [assertion("claudemd:global", "supersedes", "template:doc", "ratified"),
                          assertion("agent:builder", "governs", "template:doc", "proposed")])
    (cfg.repo_root / "ontology" / "cortex.ttl").write_text(
        "@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<https://cortex.local/ont> a owl:Ontology .\n", encoding="utf-8")
    comp.build(cfg, today="2026-10-05")
    ds = Dataset()
    ds.parse(str(cfg.data_dir / "graph.trig"), format="trig")
    names = {str(g.identifier) for g in ds.graphs()}
    assert {f"https://cortex.local/graph/{n}" for n in ("ontology", "stated", "ratified", "proposed")} <= names
    cx, cxi = "https://cortex.local/ont#", "https://cortex.local/id/"
    ratified = ds.graph(URIRef("https://cortex.local/graph/ratified"))
    proposed = ds.graph(URIRef("https://cortex.local/graph/proposed"))
    assert (URIRef(cxi + "claudemd/global"), URIRef(cx + "supersedes"), URIRef(cxi + "template/doc")) in ratified
    assert (URIRef(cxi + "agent/builder"), URIRef(cx + "governs"), URIRef(cxi + "template/doc")) in proposed
    ttl = (cfg.data_dir / "graph.ttl").read_text(encoding="utf-8")
    assert "supersedes" not in ttl and "governs" not in ttl and "agent/builder" in ttl


def test_build_runs_the_check_and_stamps_health(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    fake_modules(monkeypatch, standard)
    comp.build(cfg, today="2026-10-05")
    health = read(cfg, "health.json")
    assert health["graph_built"] == read(cfg, "graph.json")["built"]
    assert health["inferred_built"] == read(cfg, "inferred.json")["built"]
    assert health["counts"] == {k: sum(1 for f in health["findings"] if f["severity"] == k) for k in ("violation", "warning", "info")}
    assert any(f["check"] == "B02" for f in health["findings"])  # the finding of this build, not of the one before


def test_a_write_failure_raises_and_leaves_a_finding(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    fake_modules(monkeypatch, standard)
    real = comp.atomic_write

    def flaky(path, text):
        if path.name == "graph.trig":
            raise OSError("disk full")
        real(path, text)

    monkeypatch.setattr(comp, "atomic_write", flaky)
    with pytest.raises(comp.OutputWriteError, match="graph.trig"):
        comp.build(cfg, today="2026-10-05")
    b05 = [f for f in read(cfg, "findings.json")["findings"] if f["check"] == "B05"]
    assert len(b05) == 1 and b05[0]["severity"] == "violation" and "graph.trig" in b05[0]["message"]


def test_the_command_exits_non_zero_on_a_write_failure(tmp_path, monkeypatch, capsys):
    from cortex_kg import __main__ as cli
    cfg = make_cfg(tmp_path)
    fake_modules(monkeypatch, standard)
    monkeypatch.setattr(cli, "load_config", lambda path=None: cfg)

    def refuse(path, text):
        raise OSError("read-only")

    monkeypatch.setattr(comp, "atomic_write", refuse)
    assert cli.main(["build"]) == 1
    assert "could not write" in capsys.readouterr().out


def test_invalid_event_lines_are_skipped_and_counted(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    fake_modules(monkeypatch, standard)
    monkeypatch.delitem(sys.modules, "cortex_kg.events")
    monkeypatch.delitem(sys.modules, "cortex_kg.activation")
    from cortex_kg import events
    good = events.make("read", ["agent:builder"], "s", "hook", "ok")
    events.append(cfg, good)
    events.append(cfg, {**good, "nodes": 5})  # nodes must be a list
    events.append(cfg, {**good, "ts": "not a date"})
    with (cfg.events_dir / f"{good['ts'][:7]}.jsonl").open("a", encoding="utf-8") as fh:
        fh.write("{broken\n")
    comp.build(cfg, today="2026-10-05")
    b04 = [f for f in read(cfg, "findings.json")["findings"] if f["check"] == "B04"]
    assert len(b04) == 1 and b04[0]["message"].startswith("3 event lines were skipped")
    assert [n["metrics"]["uses"] for n in read(cfg, "graph.json")["nodes"] if n["id"] == "agent:builder"] == [1]


def test_a_proposed_edge_carries_its_author_a_lower_weight_and_one_warning_per_file(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)

    def more(cfg_, name):
        h = standard(cfg_, name)
        if name == "harness":
            h.add_node(Node("agent:writer", "Writer", props={"model": "sonnet"}))
            h.add_node(Node("agent:checker", "Checker", props={"model": "sonnet"}))
        return h

    fake_modules(monkeypatch, more)
    (cfg.repo_root / "ontology" / "weights.json").write_text(json.dumps(
        {"relations": [{"id": "governs", "label": "governs", "inverse_label": "governed by", "weight": 0.8}]}), encoding="utf-8")
    with_assertions(cfg, [assertion("agent:builder", "governs", "agent:writer", "ratified"),
                          assertion("agent:builder", "governs", "agent:checker", "proposed"),
                          assertion("agent:writer", "governs", "agent:checker", "proposed")])
    comp.build(cfg, today="2026-10-05")
    rows = {(e["s"], e["r"], e["t"]): e for e in read(cfg, "graph.json")["edges"]}
    ratified, proposed = rows[("agent:builder", "governs", "agent:writer")], rows[("agent:builder", "governs", "agent:checker")]
    assert ratified["by"] == proposed["by"] == "test" and ratified["w"] == 0.8 and proposed["w"] == 0.4
    stated = rows[("claudemd:global", "contains", "rulefile:writing")]
    assert "by" not in stated
    p10 = [f for f in read(cfg, "findings.json")["findings"] if f["check"] == "P10"]
    assert len(p10) == 1 and p10[0]["severity"] == "warning" and "2 proposed assertions" in p10[0]["message"]
