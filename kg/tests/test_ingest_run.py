"""Tests of run capture (docs/CONTRACTS.md, ranviera.run.v1). Every fixture is synthetic."""
import copy
import json
from pathlib import Path

import pytest

from cortex_kg import ingest_run, trace_map
from cortex_kg.ingest_run import RunFormatError

FIX = Path(__file__).parent / "fixtures" / "runs"
INSTR = [{"id": "instr:triage-agent-core@3", "hash": "sha256:" + "b" * 64, "path": "synthetic/core.md"},
         {"id": "instr:triage-agent-escalation@1", "hash": "sha256:" + "c" * 64, "path": "synthetic/escalation.md"}]


def fixture_text() -> str:
    return (FIX / "triage.run.v1.jsonl").read_text(encoding="utf-8")


def lines(records) -> str:
    return "".join(json.dumps(r) + "\n" for r in records)


def sdk_records():
    events = json.loads((FIX / "sdk.events.json").read_text(encoding="utf-8"))
    return trace_map.from_sdk_events(events, "R-001", "triage-agent", prompt_hash="sha256:" + "a" * 64,
                                     params={"temperature": 0}, instructions_loaded=INSTR, case_ref="CASE-SYN-1",
                                     evidence_tools=("fetch_kb",))


def graph_of(records):
    return ingest_run.build_graph(ingest_run.check_runs([(i, r) for i, r in enumerate(records, 1)]))[0]


def edges(g, rel):
    return {(e["s"], e["t"]) for e in g.edges.values() if e["r"] == rel}


def test_fixture_reads_in_order():
    recs = ingest_run.parse_lines(fixture_text())
    assert [r["kind"] for r in recs] == ["start", "tool", "retrieval", "rationale", "decision", "end"]
    assert recs[-1]["payload"]["steps_reported"] == 5


def test_three_routes_give_one_graph():
    native = graph_of(ingest_run.parse_lines(fixture_text()))
    sdk = graph_of(sdk_records())
    otlp = graph_of(ingest_run.read_records((FIX / "otlp.json").read_text(encoding="utf-8"), "otlp"))
    assert ingest_run.graph_signature(native) == ingest_run.graph_signature(sdk) == ingest_run.graph_signature(otlp)


def test_sdk_records_equal_the_fixture_file():
    assert trace_map.records_to_lines(sdk_records()) == fixture_text()


def test_graph_shape():
    g = graph_of(ingest_run.parse_lines(fixture_text()))
    kinds = {n["type"] for n in g.nodes.values()}
    assert {"Run", "Step", "ToolCall", "Evidence", "StatedRationale", "AgentDecision", "InstructionVersion",
            "DeployedAgent", "ModelVersion"} <= kinds
    run = g.nodes[g.run_id]
    assert run["props"]["replayStatus"] == "replayable" and run["props"]["caseRef"] == "CASE-SYN-1"
    rationale = [n for n in g.nodes.values() if n["type"] == "StatedRationale"]
    assert [n["props"]["causalStatus"] for n in rationale] == ["unverified"] * len(rationale) == ["unverified"] * 2
    decision = next(n for n in g.nodes.values() if n["type"] == "AgentDecision")
    assert decision["props"]["outcome"] == "escalate"


def test_in_context_and_cites_are_separate_relations():
    g = graph_of(ingest_run.parse_lines(fixture_text()))
    core = "instr:triage-agent-core@3"
    decision_step = next(s for s in g.nodes if s.endswith("-004") and s.startswith("step:"))
    assert (decision_step, core) in edges(g, "inContext")
    assert (decision_step, core) in edges(g, "citesInstruction")
    assert not any(s.endswith("-001") for s, _ in edges(g, "citesInstruction"))
    assert any(s.endswith("-001") for s, _ in edges(g, "inContext"))


def test_citation_outside_context_has_no_in_context_edge():
    recs = ingest_run.parse_lines(fixture_text())
    dec = next(r for r in recs if r["kind"] == "decision")
    dec["payload"]["cited"] = ["instr:triage-agent-other@9"]
    g = graph_of(recs)
    step = next(s for s in g.nodes if s.endswith("-004") and s.startswith("step:"))
    assert (step, "instr:triage-agent-other@9") in edges(g, "citesInstruction")
    assert (step, "instr:triage-agent-other@9") not in edges(g, "inContext")


def test_instructions_record_extends_context_from_that_step():
    recs = ingest_run.parse_lines(fixture_text())
    recs[0]["payload"]["instructions_loaded"] = INSTR[:1]
    extra = copy.deepcopy(recs[1])
    extra.update(kind="instructions", payload={"instructions_loaded": INSTR[1:]})
    recs.insert(1, extra)
    for i, r in enumerate(recs):
        r["step"] = i
    recs[-1]["payload"]["steps_reported"] = len(recs) - 1
    g = graph_of(recs)
    late = "instr:triage-agent-escalation@1"
    steps_with = sorted(s for s, t in edges(g, "inContext") if t == late)
    assert steps_with[0].endswith("-001") and not any(s.endswith("-000") for s in steps_with)


def test_informing_steps_and_evidence():
    g = graph_of(ingest_run.parse_lines(fixture_text()))
    informing = sorted(s for s, _ in edges(g, "informedDecision"))
    assert [s[-3:] for s in informing] == ["001", "002", "003", "004"]
    assert len(edges(g, "usedEvidence")) == 1


def test_no_text_is_held_in_the_graph_or_the_files(tmp_path):
    ingest_run.ingest(fixture_text(), tmp_path)
    blob = "".join(p.read_text(encoding="utf-8") for p in tmp_path.rglob("*") if p.is_file())
    assert "typology X" not in blob and "knowledge base text" not in blob


def test_review_links_to_the_last_decision():
    recs = ingest_run.parse_lines(fixture_text())
    end = recs.pop()
    recs.append({**copy.deepcopy(recs[-1]), "step": 5, "kind": "review", "payload": {
        "reviewer": "person:reviewer-1", "verdict": "agree", "override": False, "time_open_s": 40, "items_viewed": 3}})
    recs.append({**end, "step": 6, "payload": {"steps_reported": 6}})
    g = graph_of(recs)
    assert len(edges(g, "reviewedBy")) == 1
    review = next(n for n in g.nodes.values() if n["type"] == "Review")
    assert review["props"]["override"] is False and review["props"]["timeOpenS"] == 40


@pytest.mark.parametrize("mutate,fragment", [
    (lambda r: r.update(schema="other"), "schema"),
    (lambda r: r.update(ts="2026-10-07 09:00:00"), "ts must be"),
    (lambda r: r.update(kind="mystery"), "kind must be"),
    (lambda r: r["payload"].update(output_hash="sha256:XYZ"), "hash"),
    (lambda r: r["payload"].update(outcome="approve"), "outcome"),
])
def test_bad_record_is_refused_with_its_line_number(mutate, fragment):
    recs = ingest_run.parse_lines(fixture_text())
    mutate(recs[1])
    with pytest.raises(RunFormatError) as exc:
        ingest_run.parse_lines(lines(recs))
    assert exc.value.line == 2 and fragment in str(exc.value)


def test_step_zero_needs_model_prompt_and_params():
    recs = ingest_run.parse_lines(fixture_text())
    del recs[0]["agent"]["params"]
    with pytest.raises(RunFormatError, match="agent.params is required at step 0"):
        ingest_run.parse_lines(lines(recs))


def test_end_needs_steps_reported_and_start_needs_instructions():
    recs = ingest_run.parse_lines(fixture_text())
    del recs[-1]["payload"]["steps_reported"]
    with pytest.raises(RunFormatError, match="steps_reported"):
        ingest_run.parse_lines(lines(recs))
    recs = ingest_run.parse_lines(fixture_text())
    del recs[0]["payload"]["instructions_loaded"]
    with pytest.raises(RunFormatError, match="instructions_loaded"):
        ingest_run.parse_lines(lines(recs))


def test_gap_is_refused():
    recs = ingest_run.parse_lines(fixture_text())
    del recs[2]
    with pytest.raises(RunFormatError, match="gap"):
        ingest_run.parse_lines(lines(recs))


def test_identical_duplicate_is_ignored_and_a_conflicting_one_is_refused():
    recs = ingest_run.parse_lines(fixture_text())
    assert len(ingest_run.parse_lines(lines(recs + [recs[1]]))) == len(recs)
    other = copy.deepcopy(recs[1])
    other["payload"]["tool"] = "other_tool"
    with pytest.raises(RunFormatError, match="repeats line"):
        ingest_run.parse_lines(lines(recs + [other]))


def test_byte_order_mark_and_bad_json_are_refused():
    with pytest.raises(RunFormatError, match="byte order mark"):
        ingest_run.parse_lines("﻿" + fixture_text())
    with pytest.raises(RunFormatError) as exc:
        ingest_run.parse_lines(fixture_text() + "{not json\n")
    assert exc.value.line == 7


def test_refused_run_writes_nothing(tmp_path):
    recs = ingest_run.parse_lines(fixture_text())
    del recs[3]
    with pytest.raises(RunFormatError):
        ingest_run.ingest(lines(recs), tmp_path)
    assert list(tmp_path.rglob("*")) == []


def test_ingest_writes_graph_records_and_ledger_and_is_idempotent(tmp_path):
    first = ingest_run.ingest(fixture_text(), tmp_path)
    assert first["entries_added"] == 6 and first["entries_skipped"] == 0
    again = ingest_run.ingest(fixture_text(), tmp_path)
    assert again["entries_added"] == 0 and again["entries_skipped"] == 6
    assert len(list((tmp_path / "runs").glob("*.json"))) == 1
    assert (tmp_path / "ledger" / "head.json").is_file()


def test_changed_record_for_a_ledgered_step_is_refused(tmp_path):
    ingest_run.ingest(fixture_text(), tmp_path)
    recs = ingest_run.parse_lines(fixture_text())
    recs[1]["payload"]["input_hash"] = "sha256:" + "9" * 64
    with pytest.raises(RunFormatError, match="append only"):
        ingest_run.ingest(lines(recs), tmp_path)


def test_hook_and_gateway_routes_are_not_built():
    for fmt in ("hook", "gateway"):
        with pytest.raises(RunFormatError, match="capture extension"):
            ingest_run.read_records(fixture_text(), fmt)


def test_otlp_without_an_agent_is_refused():
    doc = json.loads((FIX / "otlp.json").read_text(encoding="utf-8"))
    root = doc["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    root["attributes"] = [a for a in root["attributes"] if a["key"] != "gen_ai.agent.id"]
    with pytest.raises(RunFormatError, match="names no agent"):
        ingest_run.read_records(json.dumps(doc), "otlp")


def test_otlp_steps_reported_override_shows_a_dropped_step():
    doc = json.loads((FIX / "otlp.json").read_text(encoding="utf-8"))
    doc["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["attributes"].append(
        {"key": "ranviera.steps_reported", "value": {"intValue": "9"}})
    recs = ingest_run.read_records(json.dumps(doc), "otlp")
    assert recs[-1]["payload"]["steps_reported"] == 9 and recs[-1]["step"] == 5


def test_main_exit_codes(tmp_path, capsys):
    f = tmp_path / "in.jsonl"
    f.write_text(fixture_text(), encoding="utf-8")
    assert ingest_run.main([str(f), "--data-dir", str(tmp_path / "d"), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["entries_added"] == 6
    f.write_text("{bad\n", encoding="utf-8")
    assert ingest_run.main([str(f), "--data-dir", str(tmp_path / "e")]) == 2
    assert ingest_run.main([str(tmp_path / "missing"), "--data-dir", str(tmp_path / "e")]) == 2
