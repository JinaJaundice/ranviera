"""Tests of the producers behind shapes F02 to F04, F06, F08, F14 and S20 and of check P08 for the instruction store
(12 October 2026). Each test has a positive case and a negative case: the data that is present gives no finding, and the
data that is missing still gives it. Only invented content is read."""
from __future__ import annotations

import copy
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
from pyshacl import validate
from rdflib import Graph
from rdflib.namespace import SH, Namespace

KG = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KG))
from cortex_kg import ingest_run, mappings as mp  # noqa: E402
from cortex_kg import validate as val  # noqa: E402
from cortex_kg import compile as comp  # noqa: E402
from cortex_kg.model import Harvest  # noqa: E402
from cortex_kg.runledger import RunLedger  # noqa: E402
from test_validate import make_cfg  # noqa: E402

ONT = KG.parent / "ontology"
CX = Namespace("https://cortex.local/ont#")
NOW = datetime(2026, 10, 12, 9, 0, tzinfo=timezone.utc)
GRAPH = {"clause:a": {"id": "clause:a", "text": "Screen every customer."},
         "control:b": {"id": "control:b", "text": "Screening runs at onboarding."}}
RUN_FILE = Path(__file__).resolve().parent / "fixtures" / "runs" / "triage.run.v1.jsonl"


# ---- F02 to F04: the person edges and the ratification properties of a mapping ----

def propose(tmp_path, **kw):
    args = dict(relation="implementsClause", s="control:b", t="clause:a", basis="Screen every customer.",
                owner="role:mlro", maker="ana", now=NOW)
    args.update(kw)
    return mp.propose(tmp_path, **args)


def test_a_ratified_mapping_carries_anchors_date_and_person_edges(tmp_path):
    rec = propose(tmp_path)
    mp.ratify(tmp_path, rec["id"], by="ben", resolve=GRAPH.get, now=NOW)
    nodes, _edges = mp.graph_parts(tmp_path)
    props = nodes[0]["props"]
    assert props["sourceAnchor"] and props["targetAnchor"] and props["ratifiedOn"] == "2026-10-12"
    people, edges = mp.person_parts(nodes)
    assert {(e["r"], e["t"]) for e in edges} == {("ownedBy", "person:role-mlro"), ("proposedBy", "person:ana"), ("approvedBy", "person:ben")}
    assert {p["id"] for p in people} == {"person:role-mlro", "person:ana", "person:ben"}


def test_a_proposed_mapping_has_no_approver_and_no_anchors(tmp_path):
    propose(tmp_path)
    nodes, _ = mp.graph_parts(tmp_path)
    assert "sourceAnchor" not in nodes[0]["props"] and "ratifiedOn" not in nodes[0]["props"]
    assert {e["r"] for e in mp.person_parts(nodes)[1]} == {"ownedBy", "proposedBy"}


def test_a_mapping_without_owner_or_maker_gives_no_edge_so_f02_still_fires(tmp_path):
    node = {"id": "map:x", "status": "ratified", "evidence": "mappings/default.json#map:x",
            "props": {"owner": None, "maker": " ", "checker": "ben"}}
    _, edges = mp.person_parts([node])
    assert {e["r"] for e in edges} == {"approvedBy"}


def test_a_ratified_mapping_without_a_checker_or_anchors_gives_no_approver_or_anchor(tmp_path):
    rec = propose(tmp_path)
    mp.ratify(tmp_path, rec["id"], by="ben", resolve=GRAPH.get, now=NOW)
    path = tmp_path / "mappings" / "default.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["mappings"][0].update(checker=None, anchors={"s_hash": None, "t_hash": None}, valid_from=None)
    path.write_text(json.dumps(data), encoding="utf-8")
    nodes, _ = mp.graph_parts(tmp_path)
    assert all(nodes[0]["props"][k] is None for k in ("sourceAnchor", "targetAnchor", "ratifiedOn"))
    assert "approvedBy" not in {e["r"] for e in mp.person_parts(nodes)[1]}


# ---- F06 and F08: the run and its decision ----

def graph_of(records):
    return ingest_run.build_graph(ingest_run.check_runs([(i, r) for i, r in enumerate(records, 1)]))[0]


def edges_of(g, rel):
    return {(e["s"], e["t"]) for e in g.edges.values() if e["r"] == rel}


def test_the_run_holds_the_prompt_hash_and_the_decision_states_its_rationale():
    recs = ingest_run.parse_lines(RUN_FILE.read_text(encoding="utf-8"))
    g = graph_of(recs)
    run = g.nodes[g.run_id]
    assert run["props"]["promptHash"] == recs[0]["agent"]["prompt_hash"]
    decision = next(n["id"] for n in g.nodes.values() if n["type"] == "AgentDecision")
    rationale = {n["id"] for n in g.nodes.values() if n["type"] == "StatedRationale"}
    assert {t for s, t in edges_of(g, "statesRationale") if s == decision} <= rationale and edges_of(g, "statesRationale")


def test_a_run_without_a_prompt_hash_or_a_decision_without_a_rationale_gets_neither():
    recs = ingest_run.parse_lines(RUN_FILE.read_text(encoding="utf-8"))
    bare = copy.deepcopy(recs)
    for r in bare:
        r["payload"].pop("rationale_hash", None)
        r["payload"].pop("content_ref", None)
    g = graph_of(bare)
    assert edges_of(g, "statesRationale") == set()
    g2 = graph_of(recs)
    g2.nodes[g2.run_id]["props"].pop("promptHash")
    assert "promptHash" not in g2.nodes[g2.run_id]["props"]


# ---- F14: the ledger entries of a run ----

def test_a_run_entry_of_the_ledger_becomes_a_node_with_an_entry_of_edge(tmp_path):
    cfg = make_cfg(tmp_path)
    ledger = RunLedger(cfg.data_dir)
    ledger.append("instruction.approve", {"x": 1}, actor="ana")
    ledger.append("run.record", {"y": 2}, run="AT-1", step=0, actor="agent")
    h = Harvest("transparency")
    assert comp.ledger_parts(h, cfg, {"AT-1": "run:at-1"}) == 1
    assert [n for n in h.nodes if n.startswith("ledger:")] == ["ledger:000002"]
    assert ("ledger:000002", "entryOf", "run:at-1") in h.edges


def test_a_run_with_no_ledger_entry_gets_no_ledger_node(tmp_path):
    cfg = make_cfg(tmp_path)
    RunLedger(cfg.data_dir).append("run.record", {"y": 2}, run="AT-1", step=0, actor="agent")
    h = Harvest("transparency")
    assert comp.ledger_parts(h, cfg, {"AT-2": "run:at-2"}) == 0 and not h.nodes


# ---- S20: a step may contain a stated rationale and nothing else of its own kind ----

PRE = "@prefix cx: <https://cortex.local/ont#> . @prefix cxi: <https://cortex.local/id/> .\n"


def s20_found(body: str) -> bool:
    shapes = Graph().parse(ONT / "shapes.ttl", format="turtle")
    cortex = Graph().parse(ONT / "cortex.ttl", format="turtle")
    data = Graph().parse(data=PRE + body, format="turtle")
    _ok, report, _t = validate(data, shacl_graph=shapes, ont_graph=cortex, inference="none", advanced=True)
    return any("S20" in {str(v) for v in shapes.objects(s, CX.checkId)} for s in report.objects(None, SH.sourceShape))


def test_s20_accepts_a_step_that_contains_a_tool_call_or_a_stated_rationale():
    assert not s20_found("cxi:s1 a cx:Step ; cx:contains cxi:r1 , cxi:c1 . cxi:r1 a cx:StatedRationale . cxi:c1 a cx:ToolCall .")


@pytest.mark.parametrize("child", ["Evidence", "Decision", "Section"])
def test_s20_still_reports_a_step_that_contains_anything_else(child):
    assert s20_found(f"cxi:s1 a cx:Step ; cx:contains cxi:x1 . cxi:x1 a cx:{child} .")


def test_s20_still_reports_a_run_that_contains_a_rationale_directly():
    assert s20_found("cxi:r a cx:Run ; cx:contains cxi:x1 . cxi:x1 a cx:StatedRationale .")


# ---- P08: the evidence of the instruction store ----

def store(cfg, versions=("instr:a-v1",)):
    d = cfg.profile_dir / "instructions"
    d.mkdir(parents=True, exist_ok=True)
    (d / "alert-triage.json").write_text(json.dumps({"v": 1, "agent": "dagent:alert-triage", "instructions": [
        {"id": "instr:a", "versions": [{"id": v} for v in versions]}]}), encoding="utf-8")


def p08(cfg, evidence):
    nodes = [{"id": "instr:a-v1", "type": "InstructionVersion", "props": {"evidence": evidence}}]
    return [f["message"] for f in val.check_p08(cfg, nodes, [])]


def test_p08_accepts_instruction_store_evidence_that_the_file_holds(tmp_path):
    cfg = make_cfg(tmp_path)
    store(cfg)
    assert p08(cfg, "instructions/alert-triage.json") == []
    assert p08(cfg, "instructions/alert-triage.json#instr:a-v1") == []


def test_p08_still_reports_a_missing_file_a_missing_version_and_a_malformed_id(tmp_path):
    cfg = make_cfg(tmp_path)
    assert "does not exist in the profile" in p08(cfg, "instructions/alert-triage.json")[0]
    store(cfg)
    assert "which instructions/alert-triage.json does not hold" in p08(cfg, "instructions/alert-triage.json#instr:a-bogus-v9")[0]
    assert p08(cfg, "instructions/alert-triage.json#bogus")      # not the documented form, so the path check reports it
    assert "does not exist in the profile" in p08(cfg, "instructions/gone.json#instr:a-v1")[0]


def test_p08_resolves_a_bare_vocabulary_file_in_the_profile(tmp_path):
    cfg = make_cfg(tmp_path)
    assert p08(cfg, "northgate.json:1")
    (cfg.profile_dir / "vocab").mkdir(parents=True)
    (cfg.profile_dir / "vocab" / "northgate.json").write_text("{}\n", encoding="utf-8")
    assert p08(cfg, "northgate.json:1") == []
