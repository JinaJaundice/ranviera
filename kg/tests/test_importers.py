"""Tests for the legislation importer (WP5), which reads legislation.gov.uk XML.

Only the invented fixture tests/fixtures/legislation/invented_instrument.xml is read. The tests of the private pack loaders
are in test_importers_private.py, which the public export leaves out."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

KG = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KG))
from cortex_kg.importers import instrument_key, norm_id, legislation  # noqa: E402

FX = Path(__file__).resolve().parent / "fixtures" / "legislation" / "invented_instrument.xml"
INST = "uksi/2099/1"
KEYS = ("CORTEX_PACK_DIR", "CORTEX_PACK_REGISTER", "CORTEX_PACK_PROFILE", "CORTEX_HUB_DIR")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for k in KEYS:
        monkeypatch.delenv(k, raising=False)


def cfg_for(tmp_path, **raw):
    return SimpleNamespace(data_dir=tmp_path / "data", raw=raw)


# ---- legislation --------------------------------------------------------------------------------------------------------

def test_parse_selects_and_folds_lower_levels():
    snap, prov = legislation.parse(FX.read_bytes(), INST, select=[(1, 2)])
    ids = [p["id"] for p in prov]
    assert ids == ["provision:uksi-2099-1-reg-1", "provision:uksi-2099-1-reg-1-1", "provision:uksi-2099-1-reg-1-2",
                   "provision:uksi-2099-1-reg-1-3", "provision:uksi-2099-1-reg-2"]
    by = {p["id"]: p for p in prov}
    assert by["provision:uksi-2099-1-reg-1-2"]["text"] == (
        "An invented operator must not release a widget unless (a) it is listed in the register, and (b) an inspector has signed it off.")
    assert by["provision:uksi-2099-1-reg-1-2"]["part_of"] == "provision:uksi-2099-1-reg-1"
    assert by["provision:uksi-2099-1-reg-1-2"]["eli_uri"] == "https://www.legislation.gov.uk/uksi/2099/1/regulation/1/2"
    assert by["provision:uksi-2099-1-reg-1"]["text"] == ""
    assert "Invented review duty" in by["provision:uksi-2099-1-reg-1"]["label"]
    assert snap["version_date"] == "2099-01-02"
    assert snap["licence"] == "Open Government Licence v3.0"
    assert snap["attribution"] == "Contains public sector information licensed under the Open Government Licence v3.0."
    assert len(snap["sha256"]) == 64 and all(len(p["hash"]) == 64 for p in prov)


def test_selection_keeps_other_instruments_whole():
    _snap, prov = legislation.parse(FX.read_bytes(), INST)
    assert any(p["id"].endswith("reg-9") for p in prov)   # an instrument without a table keeps every regulation
    _snap, prov = legislation.parse(FX.read_bytes(), INST, select=[(1, 1)])
    assert not any(p["id"].endswith("reg-2") for p in prov)


def test_nodes_follow_the_pack_shape():
    _snap, prov = legislation.parse(FX.read_bytes(), INST, select=[(1, 2)])
    nodes, edges = legislation.to_nodes(prov)
    by = {n["id"]: n for n in nodes}
    ob = by["obligation:uksi-2099-1-reg-1-1-d"]
    assert ob["type"] == "Obligation" and ob["props"]["kind"] == "Obligation" and ob["props"]["modality"] == "O"
    assert ob["props"]["bearer"] == "An invented operator"
    assert by["obligation:uksi-2099-1-reg-1-2-d"]["props"]["kind"] == "Prohibition"
    assert by["obligation:uksi-2099-1-reg-1-2-d"]["props"]["modality"] == "F"
    assert by["obligation:uksi-2099-1-reg-1-3-d"]["props"]["kind"] == "Permission"
    assert "obligation:uksi-2099-1-reg-2-d" not in by       # a definition states no duty
    assert {"s": "obligation:uksi-2099-1-reg-1-1-d", "r": "expressedIn", "t": "provision:uksi-2099-1-reg-1-1",
            "status": "stated", "evidence": "https://www.legislation.gov.uk/uksi/2099/1/regulation/1/1"} in edges
    for n in nodes:
        assert n["family"] == "obligation" and n["sensitivity"] == "public" and n["props"]["origin"] == "legislation.gov.uk"
        assert n["props"]["effective_date"] == "2099-01-02"


def test_import_instrument_writes_snapshot_and_archives_old_version(tmp_path, monkeypatch):
    cfg = cfg_for(tmp_path)
    def no_call(*a, **k):
        raise AssertionError("an outbound call was made")
    monkeypatch.setattr(legislation, "fetch_xml", no_call)
    r = legislation.import_instrument(cfg, INST)
    assert r.provisions == [] and "no outbound call without --fetch" in r.warnings[0]
    r = legislation.import_instrument(cfg, "uksi-2099-1", from_file=FX, today="2026-10-07")
    folder = cfg.data_dir / "imports" / "legislation"
    snap = json.loads((folder / "uksi-2099-1.snapshot.json").read_text(encoding="utf-8"))
    assert snap["fetched"] == "2026-10-07" and snap["id"] == INST and r.changed
    assert len(json.loads((folder / "uksi-2099-1.provisions.json").read_text(encoding="utf-8"))) == len(r.provisions)
    again = legislation.import_instrument(cfg, INST, from_file=FX, today="2026-10-08")
    assert not again.changed and json.loads((folder / "uksi-2099-1.snapshot.json").read_text(encoding="utf-8"))["fetched"] == "2026-10-07"
    # an amended page gives a new snapshot and the old one is kept
    amended = tmp_path / "amended.xml"
    amended.write_bytes(FX.read_bytes().replace(b"keep a register of its widgets", b"keep a dated register of its widgets"))
    new = legislation.import_instrument(cfg, INST, from_file=amended, today="2026-10-09")
    assert new.changed and new.snapshot["sha256"] != snap["sha256"]
    kept = list((folder / "archive").glob("uksi-2099-1.*.snapshot.json"))
    assert len(kept) == 1 and json.loads(kept[0].read_text(encoding="utf-8"))["sha256"] == snap["sha256"]
    nodes, _edges = legislation.load_saved(cfg, [INST])
    assert any("dated register" in n["props"].get("description", "") for n in nodes)
    # a saved page is read without --fetch
    assert legislation.import_instrument(cfg, INST).snapshot["sha256"] == new.snapshot["sha256"]


def test_failed_fetch_is_reported_and_writes_nothing(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise TimeoutError("slow")
    monkeypatch.setattr(legislation, "fetch_xml", boom)
    cfg = cfg_for(tmp_path)
    r = legislation.import_instrument(cfg, INST, fetch=True)
    assert "fetch failed" in r.warnings[0]
    assert not (cfg.data_dir / "imports").exists()


def test_default_instruments_name_the_requested_provisions():
    spec = legislation.INSTRUMENTS["uksi/2017/692"]
    assert spec["select"] == [(18, 21), (27, 28)]
    assert legislation.canonical_id("uksi-2017-692") == "uksi/2017/692"
    assert legislation.source_url("uksi/2017/692", "2026-06-30") == "https://www.legislation.gov.uk/uksi/2017/692/2026-06-30/data.xml"


