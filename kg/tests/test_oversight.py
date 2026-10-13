"""Tests of the oversight views on the invented Northgate fixtures."""
from __future__ import annotations

import json

import pytest
from oversight_support import AGENT, NAR, V1, V2, make_env

from cortex_kg import oversight as ov

R1, R2, R3 = "run:alert-triage-r1", "run:alert-triage-r2", "run:alert-triage-r3"


def test_runs(tmp_path):
    cfg, _ = make_env(tmp_path)
    rows = {r["run"]: r for r in ov.runs(cfg)}
    assert set(rows) == {R1, R2, R3}
    assert rows[R1]["outcome"] == "close" and rows[R1]["reviewed"] and not rows[R1]["override"] and rows[R1]["findings"] == 0
    assert rows[R2]["override"] and rows[R2]["outcome"] == "escalate" and rows[R2]["case_ref"] == "A-101"
    assert not rows[R3]["reviewed"] and rows[R3]["findings"] == 2 and rows[R3]["replayable"]
    assert [r["run"] for r in ov.runs(cfg, outcome="escalate")] == [R2]
    assert ov.runs(cfg, agent="other-agent") == []
    assert len(ov.runs(cfg, agent="dagent:alert-triage")) == 3


def test_trace_labels_steps_and_chains(tmp_path):
    cfg, _ = make_env(tmp_path)
    t = ov.trace(cfg, R3)
    assert t["labels"] == {"recorded": "recorded", "loaded": "loaded", "stated": "stated by the agent, cause unverified"}
    assert t["model"] == {"id": "model:model-b", "status": "pending", "approved": False}
    assert t["decision"]["outcome"] == "close" and t["review"] is None
    decision_step = next(s for s in t["steps"] if s["kind"] == "decision")
    assert [c["id"] for c in decision_step["cited"]] == [NAR]
    assert NAR not in [c["id"] for c in decision_step["in_context"]]        # cited and not loaded, which is rule O04
    assert [c["id"] for c in decision_step["in_context"]] == [V1] and decision_step["in_context"][0]["in_force"]
    assert {f["check"] for f in t["findings"]} == {"O04", "O12"}
    assert all(f["proof"] for f in t["findings"]) and {f["check"] for f in decision_step["findings"]} == {"O04"}
    evidence_step = t["steps"][1]
    assert evidence_step["tool"] == "screening-lookup" and evidence_step["evidence"][0]["source"] == "watchlist-snapshot"
    # the chain of the loaded version is ratified and ends at the provision, the cited version has a missing first link
    links = {(l["relation"], l["status"]) for l in t["chains"][V1]}
    assert links == {("implementsClause", "ratified"), ("realises", "ratified"), ("satisfies", "ratified"),
                     ("expressedIn", "stated")}
    assert t["chains"][NAR] == [{"mapping": None, "relation": "implementsClause", "from": NAR, "to": "", "to_label": "",
                                 "to_type": "PolicyClause", "status": "missing"}]
    assert t["ledger"]["entries"] == 5 and t["ledger"]["verified"] is True


def test_trace_of_a_reviewed_run_and_references(tmp_path):
    cfg, _ = make_env(tmp_path)
    t = ov.trace(cfg, "r2")                                   # the run name is accepted
    assert t["run"] == R2 and t["model"]["approved"] is True and t["agent"]["id"] == AGENT
    assert t["review"]["override"] is True and t["review"]["override_reason"] == "The date of birth differs."
    assert t["review"]["checks_ticked"] == ["name", "dob"] and t["review"]["time_open_s"] == 15
    assert t["steps"][2]["rationale"]["hash"].startswith("sha256:") and t["steps"][2]["rationale"]["content_ref"]
    with pytest.raises(ov.OversightError):
        ov.trace(cfg, "no-such-run")


def test_ledger_break_is_reported_for_the_run(tmp_path):
    cfg, _ = make_env(tmp_path)
    p = cfg.data_dir / "ledger" / "verify.json"
    rep = json.loads(p.read_text(encoding="utf-8"))
    rep["ok"] = False
    rep["breaks"] = [{"seq": 9, "reason": "r2 is missing step 3 of the ledger"}]
    p.write_text(json.dumps(rep), encoding="utf-8")
    assert ov.trace(cfg, R2)["ledger"]["breaks"] == 1 and ov.trace(cfg, R2)["ledger"]["verified"] is False
    assert ov.trace(cfg, R1)["ledger"]["verified"] is True
    p.unlink()
    assert ov.trace(cfg, R1)["ledger"] == {"entries": 0, "verified": None, "breaks": 0}


def test_coverage_states(tmp_path):
    cfg, _ = make_env(tmp_path)
    m = ov.coverage(cfg, "alert-triage")
    rows = {r["obligation"]: r for r in m["rows"]}
    assert {k: r["state"] for k, r in rows.items()} == {"obligation:o1": "covered", "obligation:o2": "partial",
                                                        "obligation:o3": "gap", "obligation:o4": "exempt"}
    assert rows["obligation:o1"]["provision"] == {"id": "provision:p1", "label": "Invented provision 1"}
    assert rows["obligation:o1"]["cells"] == {"control:screen-1": "ratified", "clause:escalate-1": "ratified", V1: "ratified"}
    assert rows["obligation:o2"]["cells"] == {"control:review-1": "proposed"} and rows["obligation:o3"]["cells"] == {}
    assert [(c["type"], c["id"]) for c in m["columns"]] == [("Control", "control:review-1"), ("Control", "control:screen-1"),
                                                            ("PolicyClause", "clause:escalate-1"), ("InstructionVersion", V1)]
    assert {f["check"] for f in m["findings"]} == {"O01", "O02"}
    assert m["agent"] == AGENT
    assert ov.coverage(cfg, "another-agent")["rows"] == []
    assert len(ov.coverage(cfg)["rows"]) == 4


def test_instruction_list_and_detail(tmp_path):
    cfg, _ = make_env(tmp_path)
    summaries = {i["id"]: i for i in ov.instruction_summaries(cfg)}
    assert summaries["instr:alert-triage-escalate-match"]["in_force"] == V1 and summaries["instr:alert-triage-escalate-match"]["latest"] == V2
    assert summaries["instr:alert-triage-narrative"]["findings"] == 1
    d = ov.instruction_detail(cfg, "instr:alert-triage-escalate-match")
    assert [(v["id"], v["in_force"]) for v in d["versions"]] == [(V1, True), (V2, False)]
    assert d["diff"]["from"] == V1 and d["diff"]["to"] == V2
    ops = [(l["op"], l["text"]) for l in d["diff"]["lines"]]
    assert ("add", "Request information where only the name matches.") in ops and not any(op == "remove" for op, _ in ops)
    assert ops[0] == ("same", "Escalate an alert where the name and the date of birth both match.")
    assert [m["id"] for m in d["mappings"]] == ["map:20260901-001"]
    assert d["impact"]["stale_mappings"] == ["map:20260901-001"]
    assert sorted(x["run"] for x in d["impact"]["decisions"]) == [R1, R2, R3]
    assert ov.instruction_detail(cfg, V1)["id"] == "instr:alert-triage-escalate-match"       # a version id also resolves
    # a narrative with no draft has no impact to show
    assert ov.instruction_detail(cfg, "instr:alert-triage-narrative")["impact"] == {"stale_mappings": [], "decisions": []}
    assert ov.instruction_detail(cfg, "instr:alert-triage-narrative")["diff"] is None
    with pytest.raises(ov.OversightError):
        ov.instruction_detail(cfg, "instr:nothing")


def test_the_graph_is_needed_for_a_trace(tmp_path):
    cfg, _ = make_env(tmp_path)
    (cfg.data_dir / "graph.json").unlink()
    with pytest.raises(ov.OversightError, match="graph is absent"):
        ov.trace(cfg, R1)
    assert ov.runs(cfg) == []


def test_main_json_and_exit_codes(tmp_path, capsys):
    cfg, cfgfile = make_env(tmp_path)
    c = ["--config", str(cfgfile), "--json"]
    assert ov.main(["runs", *c]) == 0
    assert len(json.loads(capsys.readouterr().out)) == 3
    assert ov.main(["oversight", "trace", R3, *c]) == 0
    assert json.loads(capsys.readouterr().out)["run"] == R3
    assert ov.main(["coverage", "--agent", "alert-triage", *c]) == 0
    capsys.readouterr()
    assert ov.main(["instruction", V1, *c]) == 0
    assert ov.main(["trace", "unknown", *c]) == 2
    assert ov.main(["trace", R1, "--config", str(cfgfile)]) == 0 and "recorded" in capsys.readouterr().out
    assert ov.main(["bogus"]) == 2


def test_trace_names_approvers_ledger_breaks_and_stated_text(tmp_path):
    cfg, _ = make_env(tmp_path)
    t = ov.trace(cfg, R2)
    refs = [i for st in t["steps"] for i in st["in_context"]]
    assert refs and all({"maker", "approver", "approved_on", "self_approved"} <= set(i) for i in refs)
    v1 = next(i for i in refs if i["id"] == V1)
    assert v1["maker"] and v1["approver"] and v1["self_approved"] is False
    ratified = [l for l in t["chains"][V1] if l["status"] == "ratified"]
    assert ratified and all("checker" in l and "maker" in l for l in ratified)
    # the stated text is read from the content store by its hash, and a reference that is not a hash gives none
    digest = "ab" * 32
    (cfg.data_dir / "store").mkdir()
    (cfg.data_dir / "store" / digest).write_text("The names match and the dates differ.\n", encoding="utf-8")
    assert ov._stored_text(cfg, f"store:{digest}") == "The names match and the dates differ."
    assert ov._stored_text(cfg, "store:5") is None and ov._stored_text(cfg, "store:../graph") is None and ov._stored_text(cfg, None) is None
    # a ledger that misses a step says which step
    p = cfg.data_dir / "ledger" / "verify.json"
    rep = json.loads(p.read_text(encoding="utf-8"))
    rep["ok"] = False
    rep["breaks"] = [{"seq": 9, "reason": "r2 is missing step 3 of the ledger"}]
    p.write_text(json.dumps(rep), encoding="utf-8")
    led = ov.trace(cfg, R2)["ledger"]
    assert led["breaks"] == 1 and led["notes"][0]["step"] == 3
