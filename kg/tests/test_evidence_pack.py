"""Tests of the evidence pack on the invented Northgate fixtures."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

import pytest
from oversight_support import make_env

from cortex_kg import evidence_pack as ep

NOW = datetime(2026, 10, 7, 10, 30, 0, tzinfo=timezone.utc)


def test_manifest_hashes_match_the_files(tmp_path):
    cfg, _ = make_env(tmp_path)
    folder, manifest = ep.export(cfg, "run:r3", tmp_path / "out", NOW)
    assert folder.name == "pack-run-r3-20261007-103000"
    assert sorted(p.name for p in folder.iterdir()) == ["manifest.json", "pack.html", "pack.json"]
    assert [f["path"] for f in manifest["files"]] == ["pack.json", "pack.html"]
    on_disk = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    assert on_disk == manifest and manifest["v"] == 1
    for f in manifest["files"]:
        raw = (folder / f["path"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == f["sha256"] and len(raw) == f["bytes"]
    # a changed file no longer matches the manifest
    (folder / "pack.html").write_text("changed", encoding="utf-8")
    assert hashlib.sha256((folder / "pack.html").read_bytes()).hexdigest() != manifest["files"][1]["sha256"]


def test_pack_content_for_a_run(tmp_path):
    cfg, _ = make_env(tmp_path)
    folder, _m = ep.export(cfg, "run:r3", tmp_path / "out", NOW)
    pack = json.loads((folder / "pack.json").read_text(encoding="utf-8"))
    assert pack["scope"]["kind"] == "run" and pack["created"] == "2026-10-07T10:30:00Z" and len(pack["graph_sha256"]) == 64
    assert [t["run"] for t in pack["traces"]] == ["run:alert-triage-r3"] and pack["coverage"] is None
    assert {f["check"] for f in pack["findings"]} == {"O04", "O12"} and all(f["proof"] for f in pack["findings"])
    assert [v["id"] for v in pack["instruction_versions"]] == ["instr:alert-triage-escalate-match-v1",
                                                                       "instr:alert-triage-narrative-v1"]      # loaded and cited
    assert pack["ledger"]["head"]["seq"] > 0
    assert pack["ledger"]["completeness"]["ok"] is True and list(pack["ledger"]["completeness"]["runs"]) == ["r3"]
    assert pack["monitoring"]["agents"][0]["id"] == "dagent:alert-triage"
    # no text of the controlled store enters the pack: instruction text, only hashes
    text = (folder / "pack.json").read_text(encoding="utf-8")
    assert "name and the date of birth" not in text and "sha256:" in text


def test_html_labels_and_limits(tmp_path):
    cfg, _ = make_env(tmp_path)
    folder, _m = ep.export(cfg, "run:r1", tmp_path / "out", NOW)
    html = (folder / "pack.html").read_text(encoding="utf-8")
    assert html.startswith("<!doctype html>") and 'lang="en-GB"' in html and "<style>" in html and "@media print" in html
    for label in ("recorded", "loaded", "stated by the agent, cause unverified"):
        assert label in html
    assert "does not show the internal computation of the model" in html
    assert "unverified as the cause of the decision" in html
    assert "A complete trace does not show that a decision was correct." in html
    assert "name and the date of birth" not in html


def test_scopes(tmp_path):
    cfg, _ = make_env(tmp_path)
    p = ep.build_pack(cfg, "alert:A-101", NOW)
    assert [t["run"] for t in p["traces"]] == ["run:alert-triage-r2"]
    a = ep.build_pack(cfg, "agent:alert-triage", NOW)
    assert len(a["traces"]) == 3 and a["coverage"]["agent"] == "dagent:alert-triage"
    assert {v["id"] for v in a["instruction_versions"]} == {"instr:alert-triage-escalate-match-v1",
                                                             "instr:alert-triage-escalate-match-v2",
                                                             "instr:alert-triage-narrative-v1"}
    assert {f["check"] for f in a["findings"]} >= {"O01", "O02", "O04", "O12"}
    period = ep.build_pack(cfg, "period:2026-10-02..2026-10-03", NOW)
    assert len(period["traces"]) == 2 and len(period["coverage"]["rows"]) == 4
    assert period["monitoring"]["from"] == "2026-10-02"
    html = ep.render_html(period)
    assert html.index("Coverage matrix") < html.index("Decision traces")       # a period pack leads with coverage


@pytest.mark.parametrize("scope", ["alert:NONE", "run:none", "agent:unknown", "period:x",
                                   "team:a", "run:"])
def test_refused_scopes(tmp_path, scope):
    cfg, _ = make_env(tmp_path)
    with pytest.raises(ep.PackError):
        ep.build_pack(cfg, scope, NOW)


def test_an_empty_period_gives_a_pack_with_no_trace(tmp_path):
    cfg, _ = make_env(tmp_path)
    p = ep.build_pack(cfg, "period:2026-01-01..2026-01-31", NOW)
    assert p["traces"] == [] and len(p["coverage"]["rows"]) == 4


def test_existing_folder_and_cli(tmp_path, capsys):
    cfg, cfgfile = make_env(tmp_path)
    ep.export(cfg, "run:r1", tmp_path / "out", NOW)
    with pytest.raises(ep.PackError, match="exists"):
        ep.export(cfg, "run:r1", tmp_path / "out", NOW)
    assert ep.main(["export", "--scope", "alert:A-100", "--out", str(tmp_path / "o2"), "--json", "--config", str(cfgfile)]) == 0
    assert json.loads(capsys.readouterr().out)["manifest"]["files"][0]["path"] == "pack.json"
    assert ep.main(["--scope", "run:none", "--config", str(cfgfile)]) == 2


def test_html_shows_names_and_dates_not_identifiers(tmp_path):
    import re
    cfg, _ = make_env(tmp_path)
    folder, _m = ep.export(cfg, "agent:alert-triage", tmp_path / "out", NOW)
    html = (folder / "pack.html").read_text(encoding="utf-8")
    text = re.sub(r"<[^>]+>", " ", html)
    assert not re.search(r"\b(?:instr|obligation|clause|control|dagent|person|model|adec|run):[\w.-]", text)
    assert "Created on 7 October 2026 at 10:30 (UTC)" in text
    assert "Evidence pack for the agent Alert triage" in html
    assert "table-layout:fixed" in html
    pack = json.loads((folder / "pack.json").read_text(encoding="utf-8"))
    assert pack["names"]["dagent:alert-triage"] == "Alert triage"


def test_coverage_lists_earlier_versions_as_a_list(tmp_path):
    from cortex_kg import oversight
    cfg, _ = make_env(tmp_path)
    assert isinstance(oversight.coverage(cfg)["earlier_versions"], list)


def test_monitoring_summary_gives_the_runs_it_covers_and_the_result(tmp_path):
    cfg, _ = make_env(tmp_path)
    period = ep.build_pack(cfg, "period:2026-10-02..2026-10-03", NOW)
    a = period["monitoring"]["agents"][0]
    assert a["runs"] == 2 and a["runs_recorded"] == 3
    html = ep.render_html(period)
    summary = html[html.index("Monitoring summary"):html.index("Decision traces")]
    assert "cover 2 of the 3 runs recorded for the agent" in summary
    assert "Bound of the bank for the override rate" in summary and "Result" in summary
