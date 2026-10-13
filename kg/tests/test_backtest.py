"""Tests of the back-test comparison. Ranviera runs no model, so the replays are records that the fixtures supply."""
from __future__ import annotations

import json

import pytest
from oversight_support import FIXTURES, make_env

from cortex_kg import backtest as bt

REPLAYS = (FIXTURES / "backtest" / "replays.jsonl").read_text(encoding="utf-8")
DISPOSITIONS = (FIXTURES / "backtest" / "dispositions.json").read_text(encoding="utf-8")


def test_counts_and_the_file(tmp_path):
    cfg, _ = make_env(tmp_path)
    out = bt.compare(cfg, "alert-triage", "instr:alert-triage-escalate-match-v1 on model-a", REPLAYS, DISPOSITIONS)
    assert out["id"] == "bt-001"                                          # taken from ext.backtest
    assert (out["n"], out["agree"], out["agreement"]) == (4, 2, 0.5)
    assert (out["false_closures"], out["false_escalations"]) == (1, 1)
    assert out["unmatched_replays"] == ["h5"] and out["alerts_without_replay"] == ["H-6"]
    kinds = {c["case_ref"]: c["result"] for c in out["cases"]}
    assert kinds == {"H-1": "agree", "H-2": "agree", "H-3": "false_closure", "H-4": "false_escalation"}
    assert out["inputs"]["replays"].startswith("sha256:")
    on_disk = json.loads((cfg.data_dir / "backtests" / "bt-001.json").read_text(encoding="utf-8"))
    assert on_disk == out
    assert bt.summaries(cfg, "alert-triage") == [{"id": "bt-001", "version": out["version"], "n": 4, "agreement": 0.5,
                                                  "false_closures": 1, "false_escalations": 1}]
    assert bt.summaries(cfg, "other-agent") == []


def test_refusals(tmp_path):
    cfg, _ = make_env(tmp_path)
    bt.compare(cfg, "alert-triage", "v1", REPLAYS, DISPOSITIONS)
    with pytest.raises(bt.BacktestError, match="exists"):
        bt.compare(cfg, "alert-triage", "v1", REPLAYS, DISPOSITIONS)
    assert bt.compare(cfg, "alert-triage", "v1", REPLAYS, DISPOSITIONS, bt_id="bt-002")["id"] == "bt-002"
    with pytest.raises(bt.BacktestError, match="not of"):
        bt.compare(cfg, "other-agent", "v1", REPLAYS, DISPOSITIONS, bt_id="bt-003")
    with pytest.raises(bt.BacktestError, match="refused"):
        bt.compare(cfg, "alert-triage", "v1", "not json\n", DISPOSITIONS, bt_id="bt-004")
    with pytest.raises(bt.BacktestError, match="version 1"):
        bt.compare(cfg, "alert-triage", "v1", REPLAYS, '{"v": 2}', bt_id="bt-005")
    with pytest.raises(bt.BacktestError, match="nothing was compared"):
        bt.compare(cfg, "alert-triage", "v1", REPLAYS, json.dumps({"v": 1, "alerts": [{"case_ref": "Z", "final": "close"}]}), bt_id="bt-006")
    with pytest.raises(bt.BacktestError, match="names the version"):
        bt.compare(cfg, "alert-triage", " ", REPLAYS, DISPOSITIONS, bt_id="bt-007")


def test_main(tmp_path, capsys):
    _cfg, cfgfile = make_env(tmp_path)
    args = ["compare", "--agent", "alert-triage", "--version", "v1", "--replays", str(FIXTURES / "backtest" / "replays.jsonl"),
            "--dispositions", str(FIXTURES / "backtest" / "dispositions.json"), "--config", str(cfgfile), "--json"]
    assert bt.main(args) == 0 and json.loads(capsys.readouterr().out)["n"] == 4
    assert bt.main(args) == 2          # the same id again is refused
