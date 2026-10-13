"""Tests of the instruction store, the people file and the oversight views, on the invented Northgate fixtures."""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from oversight_support import AGENT, NAR, V1, V2, make_env

from cortex_kg import instructions as ins
from cortex_kg import people as ppl
from cortex_kg.runledger import RunLedger

NOW = datetime(2026, 10, 7, 9, 0, tzinfo=timezone.utc)


def test_hash_is_recomputed_from_the_text_file(tmp_path):
    cfg, _ = make_env(tmp_path)
    before = ins.load(cfg.profile_dir, "alert-triage")["instructions"][0]["versions"][0]
    assert before["hash"] == before["approved_hash"]
    (cfg.profile_dir / "instructions" / "alert-triage" / before["text"]).write_text("Edited outside Ranviera.\n", encoding="utf-8")
    after = ins.load(cfg.profile_dir, "alert-triage")["instructions"][0]["versions"][0]
    assert after["hash"] != after["approved_hash"] and after["approved_hash"] == before["approved_hash"]


def test_draft_takes_the_next_number_and_writes_text(tmp_path):
    cfg, _ = make_env(tmp_path)
    rec = ins.draft(cfg.profile_dir, "instr:alert-triage-narrative", text="A new narrative rule.", by="ana-reyes", now=NOW)
    assert rec["id"] == "instr:alert-triage-narrative-v2" and rec["status"] == "draft" and rec["approver"] is None
    assert (cfg.profile_dir / "instructions" / "alert-triage" / rec["text"]).read_text(encoding="utf-8") == "A new narrative rule.\n"
    with pytest.raises(ins.InstructionError):
        ins.draft(cfg.profile_dir, "instr:alert-triage-unknown", text="x", by="ana-reyes")
    new = ins.draft(cfg.profile_dir, "instr:alert-triage-freeze", text="Freeze on a match.", by="ana-reyes",
                    agent="alert-triage", label="Freeze", file="freeze.md")
    assert new["id"] == "instr:alert-triage-freeze-v1"


@pytest.mark.parametrize("by", ["ana-reyes", "  ANA-REYES ", "Ana-Reyes"])
def test_approve_refuses_the_maker(tmp_path, by):
    cfg, _ = make_env(tmp_path)
    with pytest.raises(ins.InstructionError, match="maker"):
        ins.approve(cfg.profile_dir, V2, by=by)
    assert ins.load(cfg.profile_dir, "alert-triage")["instructions"][0]["versions"][1]["status"] == "draft"


@pytest.mark.parametrize("by", [None, "", "   "])
def test_approve_refuses_a_blank_actor(tmp_path, by):
    cfg, _ = make_env(tmp_path)
    with pytest.raises(ins.InstructionError, match="person who acts"):
        ins.approve(cfg.profile_dir, V2, by=by)


def test_approve_sets_the_hash_dates_and_closes_the_old_version(tmp_path):
    cfg, _ = make_env(tmp_path)
    rec = ins.approve(cfg.profile_dir, V2, by="bob-chen", now=NOW)
    assert rec["status"] == "approved" and rec["approver"] == "bob-chen" and rec["valid_from"] == "2026-10-07"
    assert rec["approved_hash"] == rec["hash"]
    versions = ins.load(cfg.profile_dir, "alert-triage")["instructions"][0]["versions"]
    assert versions[0]["valid_to"] == "2026-10-07"
    assert not ins.in_force(versions[0], "2026-10-07") and ins.in_force(versions[0], "2026-10-06")
    body = ins.ledger_entry(rec, "instruction.approve")
    assert body["kind"] == "instruction.approve" and body["actor"] == "bob-chen" and body["version"] == V2
    with pytest.raises(ins.InstructionError, match="only a draft"):
        ins.approve(cfg.profile_dir, V2, by="carla-diaz")


def test_withdraw_closes_the_interval(tmp_path):
    cfg, _ = make_env(tmp_path)
    rec = ins.withdraw(cfg.profile_dir, NAR, by="bob-chen", note="Replaced", now=NOW)
    assert rec["status"] == "withdrawn" and rec["valid_to"] == "2026-10-07"
    with pytest.raises(ins.InstructionError):
        ins.withdraw(cfg.profile_dir, NAR, by="bob-chen")


def test_graph_parts(tmp_path):
    cfg, _ = make_env(tmp_path)
    nodes, edges = ins.graph_parts(cfg.profile_dir)
    by = {n["id"]: n for n in nodes}
    assert by[AGENT]["type"] == "DeployedAgent" and by[AGENT]["props"]["riskTier"] == "high"
    assert by["model:model-a"]["status"] == "approved"
    v1 = by[V1]
    assert v1["type"] == "InstructionVersion" and v1["status"] == "approved"
    assert v1["props"]["approvedHash"] == v1["props"]["hash"] and v1["props"]["validFrom"] == "2026-09-01"
    assert by[V2]["status"] == "draft" and by[V2]["props"]["approvedHash"] is None
    rels = {(e["s"], e["r"], e["t"]) for e in edges}
    assert (AGENT, "operatesUnder", V1) in rels and (AGENT, "operatesUnder", V2) not in rels
    assert (V1, "approvedBy", "person:bob-chen") in rels and (V1, "proposedBy", "person:ana-reyes") in rels
    assert (AGENT, "drawsOn", "model:model-a") in rels and (AGENT, "ownedBy", "person:ana-reyes") in rels


def test_people_roles(tmp_path):
    cfg, _ = make_env(tmp_path)
    p = ppl.load_people(cfg)
    assert ppl.can(p, "ana-reyes", "propose")[0] and ppl.can(p, "ana-reyes", "draft")[0]
    assert not ppl.can(p, "carla-diaz", "draft")[0]
    assert ppl.can(p, "bob-chen", "ratify", {"maker": "ana-reyes"})[0]
    ok, why = ppl.can(p, "bob-chen", "ratify", {"maker": " BOB-CHEN"})
    assert not ok and "other than the maker" in why
    assert not ppl.can(p, "ana-reyes", "ratify", {"maker": "dan-ng"})[0]
    assert ppl.can(p, "bob-chen", "reject", {"maker": "ana-reyes"})[0] and ppl.can(p, "bob-chen", "reassign")[0]
    assert ppl.can(p, "bob-chen", "approve", {"maker": "ana-reyes"})[0]
    assert not ppl.can(p, "dan-ng", "approve", {"maker": "dan-ng"})[0]      # holds both roles and is the maker
    assert not ppl.can(p, "ana-reyes", "approve", {"maker": "dan-ng"})[0]   # lacks the role
    assert ppl.can(p, "carla-diaz", "verdict")[0] and not ppl.can(p, "ana-reyes", "verdict")[0]
    assert not ppl.can(p, "nobody", "draft")[0] and not ppl.can(p, "", "draft")[0]
    assert not ppl.can(None, "bob-chen", "approve")[0]
    assert ppl.actor(cfg) is None


def test_cli_draft_and_approve_with_the_ledger(tmp_path, capsys):
    cfg, cfgfile = make_env(tmp_path)
    text = tmp_path / "t.md"
    text.write_text("A third version.\n", encoding="utf-8")
    c = ["--config", str(cfgfile)]
    assert ins.main(["draft", "instr:alert-triage-narrative", "--text-file", str(text), "--by", "carla-diaz", *c]) == 2
    assert ins.main(["draft", "instr:alert-triage-narrative", "--text-file", str(text), "--by", "ana-reyes", *c]) == 0
    assert ins.main(["approve", "instr:alert-triage-narrative-v2", "--by", "ana-reyes", *c]) == 2
    before = len(RunLedger(cfg.data_dir).entries())
    assert ins.main(["approve", "instr:alert-triage-narrative-v2", "--by", "bob-chen", "--json", *c]) == 0
    entries = RunLedger(cfg.data_dir).entries()
    assert len(entries) == before + 1 and entries[-1]["kind"] == "instruction.approve" and entries[-1]["actor"] == "bob-chen"
    assert ins.main(["list", "--json", *c]) == 0


def test_cli_refuses_every_write_without_a_people_file(tmp_path):
    _cfg, cfgfile = make_env(tmp_path, people=False)
    assert ins.main(["approve", V2, "--by", "bob-chen", "--config", str(cfgfile)]) == 2
