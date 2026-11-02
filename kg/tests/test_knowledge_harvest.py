"""Tests for the knowledge harvester (1 November 2026): the claims, arguments, sources and learning sessions that
kg/cortex_kg/harvest/knowledge.py reads from the learning folder, their provenance, sensitivity and derived metrics, and the
way a build keeps an extracted edge out of the rules until a person ratifies it. Only the invented ledgers of
kg/tests/fixtures/knowledge_harvest/ are read, and every run happens in a temporary folder."""
from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from rdflib import Dataset, URIRef

KG = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KG))
from cortex_kg import compile as comp  # noqa: E402
from cortex_kg import reason, validate  # noqa: E402
from cortex_kg.config import Config, load_config  # noqa: E402
from cortex_kg.harvest import knowledge as K  # noqa: E402
from cortex_kg.model import Harvest, Node  # noqa: E402
from cortex_kg.rdf import GRAPH_BASE  # noqa: E402

FX = Path(__file__).resolve().parent / "fixtures" / "knowledge_harvest"
ONT = KG.parent / "ontology"

A, B, C, D, E = ("claim:a00000000001", "claim:b00000000002", "claim:c00000000003", "claim:d00000000004",
                 "claim:e00000000005")
ARG1, ARG2, ARG4 = "argument:a00000000001", "argument:a00000000002", "argument:a00000000004"
SRC_VAULT, SRC_TRANSCRIPT = "source:111111111111", "source:333333333333"
SESSION1, SESSION2 = "learnsession:chat-k1-aaaa1111", "learnsession:chat-k2-bbbb2222"


def stage(root: Path, memory: Path) -> Path:
    """Copy the fixture ledgers and files to <root>/ws, with the placeholders replaced by real folders."""
    ws = root / "ws"
    shutil.copytree(FX, ws)
    for f in ws.rglob("*"):
        if f.is_file() and f.suffix in (".json", ".jsonl"):
            f.write_bytes(f.read_bytes().replace(b"@ROOT@", ws.as_posix().encode()).replace(b"@MEMORY@", memory.as_posix().encode()))
    return ws


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for key in ("CORTEX_CONFIG", "CORTEX_DATA_DIR", "CORTEX_LEARN_DIR", "CORTEX_PACK_DIR", "CORTEX_PACK_REGISTER",
                "CORTEX_PACK_PROFILE", "CORTEX_HUB_DIR", "CORTEX_INCLUDE_PRIVATE_GRAPHS", "CORTEX_MONITORING_BOUNDS",
                "CORTEX_LEDGER_KEY"):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture
def ws(mini_home, mini_cfg):
    return stage(mini_home, mini_cfg.memory_dir)


@pytest.fixture
def cfg(mini_cfg, ws):
    mini_cfg.raw = {"learn_dir": str(ws / "learn")}
    return mini_cfg


def memory_harvest(cfg) -> Harvest:
    """What the other harvesters would hold: the memory node of the file that one claim came from."""
    h = Harvest("others")
    h.add_node(Node("memory:a", "A", path=(cfg.memory_dir / "a.md").as_posix(), sensitivity="internal"))
    return h


def snapshot(h: Harvest) -> str:
    return json.dumps({"nodes": [n.to_json() for _i, n in sorted(h.nodes.items())],
                       "edges": [(*k, e.evidence) for k, e in sorted(h.edges.items())],
                       "extracted": sorted(h.extracted), "knowledge": h.knowledge, "findings": [vars(f) for f in h.findings]},
                      sort_keys=True, default=str)


# ---------------------------------------------------------------- the folder

def test_learn_dir_default_key_and_variable(mini_cfg, monkeypatch, tmp_path):
    assert mini_cfg.learn_dir == mini_cfg.data_dir / "learn"
    mini_cfg.raw = {"learn_dir": str(tmp_path / "key")}
    assert mini_cfg.learn_dir == (tmp_path / "key").resolve()
    monkeypatch.setenv("CORTEX_LEARN_DIR", str(tmp_path / "env"))
    assert mini_cfg.learn_dir == (tmp_path / "env").resolve()


def test_no_learn_folder_adds_nothing(mini_cfg):
    h = K.harvest(mini_cfg, Harvest("others"))
    assert not h.nodes and not h.edges and not h.findings and not h.extracted and not h.knowledge


def test_newer_format_adds_nothing(cfg):
    (cfg.learn_dir / "graph" / "format.json").write_text('{"version": 2}', encoding="utf-8")
    h = K.harvest(cfg, memory_harvest(cfg))
    assert not h.nodes and [f.check for f in h.findings] == ["B09"]


# ---------------------------------------------------------------- the merge of the ledgers

def test_nodes_merge_by_id_with_aliases_and_provenance(cfg):
    h = K.harvest(cfg, memory_harvest(cfg))
    a = h.nodes[A]
    assert a.label == "force law"                                  # a later name is ignored
    assert a.props["statement"] == "Force equals mass times acceleration."
    assert a.props["alias"] == ["F = ma", "Newton second law"]     # the later statement and alias, with the empty one skipped
    assert a.date == "2026-10-01" and a.props["learnId"] == "n_a00000000001"
    assert h.nodes[B].props["alias"] == ["Linear momentum is the product of mass and velocity."]
    assert "claim:f00000000006" not in h.nodes                      # a line with no statement is skipped, so is a line of bad JSON


def test_chains_merge_by_key_and_keep_the_first_premise_order(cfg):
    lines = K._read_jsonl(cfg.learn_dir / "graph" / "chains.jsonl")
    merged = K.merge_chains(lines)
    key = "n_a00000000001+n_b00000000002>n_c00000000003"
    assert merged[key]["premises"] == ["n_a00000000001", "n_b00000000002"]
    assert merged[key]["createdAt"] == "2026-10-03T09:30:00Z"
    assert merged[key]["provenance"] == [("src_111111111111", ""), ("chat_k2_bbbb2222", "msg_9")]
    assert len(merged) == 4


def test_a_bad_line_is_skipped_and_never_repaired(cfg):
    path = cfg.learn_dir / "graph" / "nodes.jsonl"
    before = path.read_bytes()
    K.harvest(cfg, memory_harvest(cfg))
    assert path.read_bytes() == before


# ---------------------------------------------------------------- the nodes and edges

def test_a_claim_points_at_the_node_of_its_file_and_otherwise_at_a_source(cfg):
    h = K.harvest(cfg, memory_harvest(cfg))
    assert (B, "documentedIn", "memory:a") in h.edges
    assert not any(i.startswith("source:") and "2222" in i for i in h.nodes)           # no Source node for a file with a node
    assert (A, "documentedIn", SRC_VAULT) in h.edges and (C, "documentedIn", SRC_VAULT) in h.edges
    src = h.nodes[SRC_VAULT]
    assert src.props["sourceKind"] == "notes" and src.props["rootId"] == "root_aaaa0001"
    assert src.path.endswith("/vault/physics.md") and src.label == "physics.md"
    t = h.nodes[SRC_TRANSCRIPT]
    assert t.props["sourceKind"] == "claude-transcripts" and t.props["sessionId"] == "s1"
    assert (D, "documentedIn", SRC_TRANSCRIPT) in h.edges
    assert (A, "discussedIn", SESSION1) in h.edges and (C, "discussedIn", SESSION2) in h.edges
    assert not any(e.r == "discussedIn" and e.s == E for e in h.edges.values())


def test_arguments_join_premises_and_conclusion(cfg):
    h = K.harvest(cfg, memory_harvest(cfg))
    assert {(A, "premiseOf", ARG1), (B, "premiseOf", ARG1), (ARG1, "concludes", C)} <= set(h.edges)
    assert h.nodes[ARG1].props["learnId"] == "arg_a00000000001"
    assert h.nodes[ARG1].props["text"] == "force law, momentum" + K.ARROW + "impulse"
    assert (A, "premiseOf", ARG2) in h.edges and (B, "premiseOf", ARG2) not in h.edges


def test_session_nodes_carry_kind_phase_and_path(cfg):
    h = K.harvest(cfg, memory_harvest(cfg))
    s1, s2 = h.nodes[SESSION1], h.nodes[SESSION2]
    assert (s1.props["sessionKind"], s1.props["phase"]) == ("teach", "teach")
    assert (s2.props["sessionKind"], s2.props["phase"]) == ("practice", "probe")
    assert s1.label == "Newton session" and s1.path.endswith("/chats/chat_k1_aaaa1111.json")
    assert s1.evidence == s1.path


def test_phase_plan_follows_a_successful_probe_done():
    rec = {"messages": [{"role": "toolResult", "toolName": "probe_done", "isError": False}]}
    assert K._session_facts(rec)["phase"] == "plan"
    rec = {"messages": [{"role": "toolResult", "toolName": "probe_done", "isError": True}]}
    assert K._session_facts(rec)["phase"] == "probe"


# ---------------------------------------------------------------- dropped edges

def test_dangling_ends_are_dropped_and_reported(cfg):
    h = K.harvest(cfg, memory_harvest(cfg))
    assert not any(i.startswith("argument:") and i.endswith("0003") for i in h.nodes)         # the conclusion has no claim
    assert (A, "premiseOf", "argument:a00000000004") in h.edges
    assert not any("ghost" in k[0] or "ghost" in k[2] for k in h.edges)
    msgs = " ".join(f.message for f in h.findings)
    assert "1 arguments and 1 premises were left out" in msgs
    assert "1 source references of 1 claims" in msgs and "1 session references of 1 claims" in msgs
    assert all(f.check == "B09" for f in h.findings)


def test_the_compiler_drops_an_edge_to_a_missing_harness_node(cfg):
    h = K.harvest(cfg, memory_harvest(cfg))
    assert (B, "documentedIn", "memory:a") in h.edges      # the node belongs to another harvest, and a later step removes it
    merged = Harvest("all")
    merged.merge(h)                                        # the memory node never joins, as when a filter drops it
    assert comp.drop_dangling(merged) >= 1 and (B, "documentedIn", "memory:a") not in merged.edges
    assert any(f.check == "B02" and "documentedIn" in f.message for f in merged.findings)


# ---------------------------------------------------------------- evidence

def test_evidence_is_the_first_located_passage(cfg):
    h = K.harvest(cfg, memory_harvest(cfg))
    vault = h.nodes[SRC_VAULT].path
    assert h.nodes[A].evidence == f"{vault}:3" and h.nodes[A].props["unlocated"] is False
    assert h.nodes[B].evidence == f"{(cfg.memory_dir / 'a.md').as_posix()}:2"
    assert h.edges[(A, "documentedIn", SRC_VAULT)].evidence == f"{vault}:3"
    assert h.nodes[ARG1].evidence == h.nodes[C].evidence                                      # an argument takes its conclusion's


def test_an_unlocated_claim_takes_the_file_without_a_line(cfg):
    h = K.harvest(cfg, memory_harvest(cfg))
    assert h.nodes[C].props["unlocated"] is True and h.nodes[C].evidence == h.nodes[SRC_VAULT].path
    assert h.nodes[E].props["unlocated"] is True and h.nodes[E].evidence is None


def test_a_transcript_passage_names_the_file_and_no_line(cfg):
    h = K.harvest(cfg, memory_harvest(cfg))
    assert h.nodes[D].evidence == h.nodes[SRC_TRANSCRIPT].path and h.nodes[D].props["unlocated"] is False
    assert h.edges[(ARG1, "concludes", C)].evidence.endswith("/graph/chains.jsonl:1")


# ---------------------------------------------------------------- sensitivity

def test_sensitivity_inherits_to_a_fixed_point(cfg):
    h = K.harvest(cfg, memory_harvest(cfg))
    s = {i: n.sensitivity for i, n in h.nodes.items()}
    assert s[SRC_VAULT] == "internal" and s[SRC_TRANSCRIPT] == "client-confidential"
    assert s[SESSION1] == "client-confidential" and s[SESSION2] == "internal"
    assert s[B] == "internal"                      # a file that has a node keeps the sensitivity of that node
    assert s[C] == "internal" and s[D] == "client-confidential"
    assert s[A] == "client-confidential"           # through the session that discusses it
    assert s[ARG1] == s[ARG2] == s[ARG4] == "client-confidential"
    assert all(v != "public" for v in s.values())  # never lower than internal


def test_a_session_takes_the_sensitivity_of_its_graph_context_and_it_spreads_back(cfg):
    chat = cfg.learn_dir / "chats" / "chat_k1_aaaa1111.json"
    rec = json.loads(chat.read_text(encoding="utf-8"))
    rec["messages"][1]["content"] = rec["messages"][1]["content"][:1]     # no file tool call, so only the context counts
    chat.write_text(json.dumps(rec), encoding="utf-8")
    h = K.harvest(cfg, memory_harvest(cfg))
    assert h.nodes[SESSION1].sensitivity == "client-confidential"        # claim D is in its graph context
    assert h.nodes[A].sensitivity == "client-confidential"               # the session lifts the claim it discusses
    rec["messages"][0]["details"]["propositions"] = []
    chat.write_text(json.dumps(rec), encoding="utf-8")
    h = K.harvest(cfg, memory_harvest(cfg))
    assert h.nodes[SESSION1].sensitivity == "internal" and h.nodes[A].sensitivity == "internal"


# ---------------------------------------------------------------- metrics

def test_support_counts_distinct_sources_and_sessions(cfg):
    h = K.harvest(cfg, memory_harvest(cfg))
    assert [h.knowledge[i]["support"] for i in (A, B, C, D, E)] == [2, 1, 2, 1, 2]


def test_held_band_and_last_tested(cfg):
    h = K.harvest(cfg, memory_harvest(cfg))
    assert h.knowledge[A]["held"] == "held" and h.knowledge[A]["lastTested"] == "2026-10-10T10:20:00Z"
    assert h.knowledge[B]["held"] == "held"
    assert h.knowledge[C]["held"] == "shaky"       # the newest answer was the not known option
    assert h.knowledge[D] == {"support": 1, "held": "unknown", "lastTested": None, "calibration": None}


def test_held_needs_two_outcomes_clean_rungs_and_no_recent_structural_miss():
    def o(at, correct=True, rung=None, miss=None):
        return {"at": at, "correct": correct, "rung": rung, "missClass": miss}
    assert K.held_band([o("1")])[0] == "shaky"
    assert K.held_band([o("1"), o("2")])[0] == "held"
    assert K.held_band([o("1"), o("2", rung="R2")])[0] == "shaky"
    assert K.held_band([o("1", correct=False, miss="structural"), o("2"), o("3")])[0] == "shaky"
    assert K.held_band([o("1", correct=False, miss="structural"), o("2"), o("3"), o("4")])[0] == "held"


def test_calibration_waits_for_five_answers_and_names_the_band(cfg):
    h = K.harvest(cfg, memory_harvest(cfg))
    assert h.knowledge[A]["calibration"] == {"n": 5, "meanConfidence": 0.88, "accuracy": 0.8, "gap": 0.08, "band": "calibrated"}
    assert h.knowledge[B]["calibration"] is None
    rows = [{"source": "choice", "confidence": 90, "correct": False}] * 5
    assert K.calibration_of(rows)["band"] == "overconfident"
    rows = [{"source": "choice", "confidence": 30, "correct": True}] * 5
    assert K.calibration_of(rows)["band"] == "underconfident"
    assert K.calibration_of(rows[:4]) is None


# ---------------------------------------------------------------- determinism

def test_two_harvests_of_the_same_files_are_identical(cfg):
    assert snapshot(K.harvest(cfg, memory_harvest(cfg))) == snapshot(K.harvest(cfg, memory_harvest(cfg)))


# ---------------------------------------------------------------- the build

@pytest.fixture
def env(mini_home, mini_cfg, monkeypatch):
    """A configuration file that names the staged learning folder, and the Config that load_config reads from it."""
    ws = stage(mini_home, mini_cfg.memory_dir)
    monkeypatch.setenv("CORTEX_ONTOLOGY", str(ONT))
    conf = {"claude_home": str(mini_home / "home"), "projects_root": str(mini_home / "projects"),
            "memory_dir": str(mini_home / "memory"), "data_dir": str(mini_home / "data"),
            "profile_dir": str(mini_home / "profile"), "learn_dir": str(ws / "learn")}
    path = mini_home / "cortex.config.json"
    path.write_text(json.dumps(conf), encoding="utf-8")
    cfg = load_config(path)
    cfg.repo_root = mini_home / "repo"
    return SimpleNamespace(root=mini_home, conf=conf, path=path, cfg=cfg, ws=ws)


def graph_of(cfg) -> dict:
    return json.loads((cfg.data_dir / "graph.json").read_text(encoding="utf-8"))


def edge_rows(g, r=None, s_prefix=None):
    return [e for e in g["edges"] if (r is None or e["r"] == r) and (s_prefix is None or e["s"].startswith(s_prefix))]


def test_build_without_a_learn_folder_adds_no_knowledge_node(env):
    shutil.rmtree(env.ws / "learn")
    comp.build(env.cfg, "2026-11-01")
    g = graph_of(env.cfg)
    assert not [n for n in g["nodes"] if n["family"] == "knowledge"]
    assert not [f for f in json.loads((env.cfg.data_dir / "findings.json").read_text())["findings"] if f["check"] == "B09"]


def test_build_extracts_edges_halves_their_weight_and_keeps_them_out_of_the_rules(env):
    comp.build(env.cfg, "2026-11-01")
    g = graph_of(env.cfg)
    assert {n["id"] for n in g["nodes"] if n["family"] == "knowledge"} >= {A, B, C, D, E, ARG1, SRC_VAULT, SESSION1}
    weights = {r["id"]: r["weight"] for r in g["relations"]}
    assert weights["premiseOf"] == 0.7 and weights["concludes"] == 0.8 and weights["discussedIn"] == 0.4
    mine = [e for e in g["edges"] if e["r"] in ("premiseOf", "concludes", "documentedIn", "discussedIn")
            and (e["s"].startswith(("claim:", "argument:")))]
    assert mine and all(e["provenance"] == "extracted" for e in mine)
    assert all(e["w"] == round(weights[e["r"]] * 0.5, 4) for e in mine)
    rows = reason.fact_rows(g, "2026-11-01")["edge"]
    assert not [r for r in rows if r[0].startswith(("claim:", "argument:")) or r[2].startswith(("claim:", "argument:"))]
    assert not [r for r in rows if r[1] in ("premiseOf", "concludes", "discussedIn")]


def test_build_writes_the_metrics_to_graph_json_and_the_nodes_to_the_extracted_graph_only(env):
    comp.build(env.cfg, "2026-11-01")
    g = graph_of(env.cfg)
    node = next(n for n in g["nodes"] if n["id"] == A)
    assert node["metrics"]["knowledge"]["held"] == "held" and node["metrics"]["knowledge"]["support"] == 2
    assert node["sensitivity"] == "client-confidential" and node["family"] == "knowledge"
    ttl = (env.cfg.data_dir / "graph.ttl").read_text(encoding="utf-8")
    trig = (env.cfg.data_dir / "graph.trig").read_text(encoding="utf-8")
    assert "claim/a00000000001" not in ttl and "argument/" not in ttl and "learnId" not in ttl
    assert "held" not in ttl and "calibration" not in trig and "lastTested" not in trig     # metrics are never RDF
    ds = Dataset()
    ds.parse(data=trig, format="trig")
    extracted = ds.graph(URIRef(GRAPH_BASE + "extracted"))
    assert len(extracted) > 20
    assert any("claim/a00000000001" in str(s) for s in extracted.subjects())
    stated = ds.graph(URIRef(GRAPH_BASE + "stated"))
    assert not any("claim/" in str(s) for s in stated.subjects())


def test_two_builds_give_the_same_knowledge_graph(env):
    def pick(g):
        return ([n for n in g["nodes"] if n["family"] == "knowledge"],
                [e for e in g["edges"] if e["s"].startswith(("claim:", "argument:", "source:", "learnsession:"))])
    comp.build(env.cfg, "2026-11-01")
    first = pick(graph_of(env.cfg))
    comp.build(env.cfg, "2026-11-01")
    assert pick(graph_of(env.cfg)) == first


def test_ratifying_an_edge_lets_the_rules_read_it_and_rejecting_removes_it(env):
    folder = env.cfg.profile_dir / "assertions"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "knowledge.json").write_text(json.dumps({"assertions": [
        {"s": A, "r": "documentedIn", "t": SRC_VAULT, "status": "ratified", "by": "owner", "date": "2026-11-01"},
        {"s": B, "r": "premiseOf", "t": ARG1, "status": "rejected", "by": "owner", "date": "2026-11-01", "reason": "wrong"}]}),
        encoding="utf-8")
    comp.build(env.cfg, "2026-11-01")
    g = graph_of(env.cfg)
    ratified = [e for e in g["edges"] if (e["s"], e["r"], e["t"]) == (A, "documentedIn", SRC_VAULT)]
    assert len(ratified) == 1 and ratified[0]["provenance"] == "ratified" and ratified[0]["w"] == 0.6 and ratified[0]["by"] == "owner"
    assert (A, "documentedIn", SRC_VAULT) in reason.fact_rows(g, "2026-11-01")["edge"]
    assert not [e for e in g["edges"] if (e["s"], e["r"], e["t"]) == (B, "premiseOf", ARG1)]
    trig = (env.cfg.data_dir / "graph.trig").read_text(encoding="utf-8")
    ds = Dataset()
    ds.parse(data=trig, format="trig")
    assert any("claim/a00000000001" in str(s) for s in ds.graph(URIRef(GRAPH_BASE + "ratified")).subjects())


def test_build_checks_report_the_knowledge_findings(env):
    comp.build(env.cfg, "2026-11-01")
    health = json.loads((env.cfg.data_dir / "health.json").read_text(encoding="utf-8"))
    found = {(f["check"], f["node"]) for f in health["findings"]}
    assert ("K01", E) in found                       # no source and no session placed it
    assert ("K05", C) in found and ("K05", E) in found and ("K05", A) not in found
    assert ("K02", ARG4) in found                    # the conclusion is also a premise
    assert not [f for f in health["findings"] if f["check"] in ("K03", "K06") or (f["check"] == "K01" and f["node"] != E)]
    assert not [f for f in health["findings"] if f["check"].startswith("S") and f.get("node", "") and f["node"].startswith(("claim:", "argument:", "source:", "learnsession:"))]
    assert not [f for f in health["findings"] if f["check"] == "P08" and (f.get("node") or "").startswith(("claim:", "argument:", "source:", "learnsession:"))]


def test_k03_reports_a_node_lower_than_its_source(env):
    comp.build(env.cfg, "2026-11-01")
    g = graph_of(env.cfg)
    for n in g["nodes"]:
        if n["id"] == A:
            n["sensitivity"] = "internal"
    found = validate.check_knowledge(env.cfg, g["nodes"], g["edges"])
    assert any(f["check"] == "K03" and f["node"] == A for f in found)
    assert any(f["check"] == "K03" and f["node"] == ARG1 for f in found) is False


def test_k04_reports_an_extracted_edge_with_no_evidence_or_a_missing_file(env):
    comp.build(env.cfg, "2026-11-01")
    g = graph_of(env.cfg)
    for e in g["edges"]:
        if (e["s"], e["r"], e["t"]) == (A, "documentedIn", SRC_VAULT):
            e["evidence"] = None
        if (e["s"], e["r"], e["t"]) == (B, "documentedIn", "memory:a"):
            e["evidence"] = "C:/nowhere/at/all.md:4"
    found = [f for f in validate.check_knowledge(env.cfg, g["nodes"], g["edges"]) if f["check"] == "K04"]
    assert len(found) == 2


def test_a_claim_mention_is_extracted_and_cites_the_claim_file(cfg, monkeypatch):
    from cortex_kg.harvest import vocab
    h = K.harvest(cfg, memory_harvest(cfg))
    merged = Harvest("all")
    merged.merge(h)
    monkeypatch.setattr(vocab, "load", lambda _c: ["concept"])
    monkeypatch.setattr(vocab, "patterns", lambda _c: [("term:mass", re.compile("mass"), [])])
    merged.add_node(Node("term:mass", "Mass"))
    comp.add_mentions(merged, cfg)
    key = (A, "mentions", "term:mass")
    assert key in merged.edges and key in merged.extracted
    assert merged.edges[key].evidence == merged.nodes[A].evidence
    assert comp.provenance_of(key, set(), {}, merged.extracted) == "extracted"


def test_a_claim_restates_a_rule_by_computed_text_match(cfg):
    h = Harvest("all")
    h.add_node(Node("claim:z00000000001", "restated", props={"statement": "Every deck must use the shared template file."}))
    h.add_node(Node("rule:decks-1", "Rule", props={"text": "Every deck must use the shared template file."}))
    h.add_node(Node("rule:other-2", "Other", props={"text": "Never write dashes in prose."}))
    assert K.add_claim_restatements(h) == 1
    assert ("claim:z00000000001", "restates", "rule:decks-1") in h.edges
    assert ("claim:z00000000001", "restates", "rule:decks-1") not in h.extracted      # computed, so its own provenance


# ---------------------------------------------------------------- strict reads of the ledgers

def _node_line(nid: str, statement: str) -> bytes:
    o = {"id": nid, "name": "n", "statement": statement, "aliases": [], "createdAt": "2026-10-01T10:00:00.000Z",
         "provenance": [{"chatId": "chat_a", "messageId": "m1"}]}
    return json.dumps(o, ensure_ascii=False).encode("utf-8")


def test_a_torn_multibyte_append_skips_only_that_line(tmp_path, caplog):
    f = tmp_path / "nodes.jsonl"
    torn = _node_line("n_torn", "caf\u00e9 \u2192 tea")[:-14]   # cut inside the multibyte arrow, with the closing bytes lost
    cut = _node_line("n_cut", "caf\u00e9 \u2192")
    cut = cut[: cut.index("\u2192".encode("utf-8")) + 1]        # one byte of the three of the arrow
    f.write_bytes(_node_line("n_1", "whole") + b"\n" + cut + b"\n" + torn + b"\n" + _node_line("n_2", "also whole") + b"\n")
    skipped: list[int] = []
    with caplog.at_level("WARNING"):
        got = K._read_jsonl(f, skipped)
    assert [o["id"] for _n, o in got] == ["n_1", "n_2"]
    assert skipped == [2, 3] and "nodes.jsonl" in caplog.text


def test_u2028_u2029_and_u0085_do_not_split_a_ledger_line(tmp_path):
    f = tmp_path / "nodes.jsonl"
    body = b"\n".join(_node_line(f"n_{i}", f"first{c}second") for i, c in enumerate(["\u2028", "\u2029", "\u0085", "\x0b", "\x1c"]))
    f.write_bytes(body + b"\n")
    got = K._read_jsonl(f)
    assert [n for n, _o in got] == [1, 2, 3, 4, 5]                   # the line numbers are real file lines
    assert got[0][1]["statement"] == "first\u2028second" and got[2][1]["statement"] == "first\u0085second"


def test_a_build_reads_past_a_torn_line_and_a_u2028_line(cfg):
    nodes = cfg.learn_dir / "graph" / "nodes.jsonl"
    keep = nodes.read_bytes()
    extra = _node_line("n_f00000000009", "pasted\u2028text") + b"\n" + _node_line("n_g00000000010", "tail \u2192")[:-9]
    nodes.write_bytes(keep.rstrip(b"\n") + b"\n" + extra)
    h = K.harvest(cfg, memory_harvest(cfg))
    assert "claim:f00000000009" in h.nodes and h.nodes["claim:f00000000009"].props["statement"] == "pasted\u2028text"
    assert A in h.nodes and "claim:g00000000010" not in h.nodes
