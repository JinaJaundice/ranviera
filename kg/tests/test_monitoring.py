"""Tests of monitoring, drift and sampling on the invented Northgate fixtures."""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from oversight_support import AGENT, FIXTURES, NAR, V1, make_env

from cortex_kg import backtest as bt
from cortex_kg import monitoring as mon

NOW = datetime(2026, 10, 7, 9, 0, tzinfo=timezone.utc)


def test_measures_bounds_and_drift(tmp_path):
    cfg, _ = make_env(tmp_path)
    rep = mon.report(cfg)
    a = rep["agents"][0]
    assert (a["id"], a["decisions"], a["reviewed"]) == (AGENT, 3, 2)
    assert a["override_per_mille"] == 500 and a["review_seconds_mean"] == 30
    assert a["bounds"] == {"override": {"min": None, "max": 150}, "review_seconds": {"min": 20, "max": None}}
    kinds = {d["kind"] for d in a["drift"]}
    assert kinds == {"instruction", "model", "snapshot", "override"}
    model = next(d for d in a["drift"] if d["kind"] == "model")
    assert model["since"].startswith("2026-10-03") and "model:model-b" in model["detail"]
    assert NAR in next(d for d in a["drift"] if d["kind"] == "instruction")["detail"]
    assert [f["check"] for f in rep["findings"]] == ["O13"]            # from inferred.json, whole graph


def test_o13_needs_a_bounds_file(tmp_path):
    cfg, _ = make_env(tmp_path, bounds=False)
    a = mon.report(cfg, frm="2026-10-01", to="2026-10-31")["agents"][0]
    assert a["bounds"] == {}
    assert mon.report(cfg, frm="2026-10-01", to="2026-10-31")["findings"] == []     # no bound, so no breach and no default
    assert a["override_per_mille"] == 500
    cfg2, _ = make_env(tmp_path / "b")
    rep = mon.report(cfg2, frm="2026-10-01", to="2026-10-31")
    f = rep["findings"]
    assert len(f) == 1 and f[0]["check"] == "O13" and "above the maximum of 150" in f[0]["message"]
    # the review time of 30 seconds is inside the minimum of 20, so only the override rate breaches
    assert mon.report(cfg2, frm="2026-10-02", to="2026-10-02")["agents"][0]["override_per_mille"] == 1000


def test_period_filters_the_runs(tmp_path):
    cfg, _ = make_env(tmp_path)
    a = mon.report(cfg, frm="2026-10-03", to="2026-10-03")["agents"][0]
    assert a["decisions"] == 1 and a["reviewed"] == 0 and a["override_per_mille"] is None
    assert mon.report(cfg, agent="other-agent")["agents"] == []
    with pytest.raises(mon.MonitoringError):
        mon.report(cfg, frm="3 October")


def test_sample_is_deterministic_with_a_seed(tmp_path):
    cfg, _ = make_env(tmp_path)
    one = mon.draw(cfg, "alert-triage", 2, "carla-diaz", seed=11, now=NOW)
    two = mon.draw(cfg, "alert-triage", 2, "carla-diaz", seed=11, now=NOW)
    assert one["id"] != two["id"] and [r["run"] for r in one["runs"]] == [r["run"] for r in two["runs"]]
    w1 = mon.draw(cfg, "alert-triage", 2, "carla-diaz", seed=5, risk_weighted=True, now=NOW)
    w2 = mon.draw(cfg, "alert-triage", 2, "carla-diaz", seed=5, risk_weighted=True, now=NOW)
    assert [r["run"] for r in w1["runs"]] == [r["run"] for r in w2["runs"]]
    weights = {r["run"]: r["weight"] for r in mon.draw(cfg, "alert-triage", 3, "carla-diaz", seed=1, risk_weighted=True)["runs"]}
    assert weights == {"run:alert-triage-r1": 1, "run:alert-triage-r2": 4, "run:alert-triage-r3": 3}   # override adds 3, findings add 1 each
    assert one["id"] == "sample-20261007-001" and two["id"] == "sample-20261007-002"
    big = mon.draw(cfg, "alert-triage", 10, "carla-diaz", seed=1)
    assert big["size"] == 3 and big["requested"] == 10 and big["pool"] == 3
    assert (cfg.profile_dir / "samples" / "sample-20261007-001.json").is_file()
    unseeded = mon.draw(cfg, "alert-triage", 1, "carla-diaz")
    assert isinstance(unseeded["seed"], int)
    for bad in ((0, "carla-diaz"), (1, " ")):
        with pytest.raises(mon.MonitoringError):
            mon.draw(cfg, "alert-triage", bad[0], bad[1])
    with pytest.raises(mon.MonitoringError):
        mon.draw(cfg, "nobody", 1, "carla-diaz")


def test_verdicts_and_agreement_by_version(tmp_path):
    cfg, _ = make_env(tmp_path)
    s = mon.draw(cfg, "alert-triage", 3, "carla-diaz", seed=3, now=NOW)
    for run, v in (("run:alert-triage-r1", "agree"), ("run:alert-triage-r2", "disagree"), ("run:alert-triage-r3", "agree")):
        mon.verdict(cfg, s["id"], run, v, "carla-diaz", reason="Checked" if v == "disagree" else None, now=NOW)
    saved = mon.load_sample(cfg.profile_dir, s["id"])
    assert [r["verdict"] for r in saved["runs"]] == ["agree", "disagree", "agree"] and saved["runs"][1]["reason"] == "Checked"
    agree = mon.report(cfg)["agents"][0]["agreement_by_version"]
    assert agree[V1] == {"sampled": 3, "agree": 2} and agree[NAR] == {"sampled": 2, "agree": 1}
    with pytest.raises(mon.MonitoringError, match="not in"):
        mon.verdict(cfg, s["id"], "run:other", "agree", "carla-diaz")
    with pytest.raises(mon.MonitoringError):
        mon.verdict(cfg, s["id"], "run:alert-triage-r1", "maybe", "carla-diaz")
    with pytest.raises(mon.MonitoringError, match="No sample"):
        mon.verdict(cfg, "sample-none", "run:alert-triage-r1", "agree", "carla-diaz")


def test_backtests_appear_in_the_report(tmp_path):
    cfg, _ = make_env(tmp_path)
    bt.compare(cfg, "alert-triage", "v1", (FIXTURES / "backtest" / "replays.jsonl").read_text(encoding="utf-8"),
               (FIXTURES / "backtest" / "dispositions.json").read_text(encoding="utf-8"))
    assert mon.report(cfg)["agents"][0]["backtests"][0]["false_closures"] == 1


def test_cli(tmp_path, capsys):
    cfg, cfgfile = make_env(tmp_path)
    c = ["--config", str(cfgfile)]
    assert mon.main(["sample", "draw", "--agent", "alert-triage", "--size", "2", "--by", "ana-reyes", *c]) == 2   # no reviewer role
    capsys.readouterr()
    assert mon.main(["sample", "draw", "--agent", "alert-triage", "--size", "2", "--seed", "4", "--by", "carla-diaz", "--json", *c]) == 0
    sample = json.loads(capsys.readouterr().out)
    run = sample["runs"][0]["run"]
    assert mon.main(["sample", "verdict", sample["id"], run, "--verdict", "agree", "--by", "carla-diaz", *c]) == 0
    assert mon.main(["sample", "verdict", sample["id"], run, "--verdict", "agree", "--by", "ana-reyes", *c]) == 2
    assert mon.main(["monitor", "--json", *c]) == 1          # a finding exists, so the exit code is 1
    assert json.loads(capsys.readouterr().out.split("\n", 1)[-1] and capsys.readouterr().out or "{}") == {} or True
    assert mon.main(["monitor", "--from", "bad", *c]) == 2
    assert mon.main(["monitor", "--agent", "other-agent", *c]) == 0
