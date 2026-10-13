"""Tests of the mapping store, on invented nodes only."""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from cortex_kg import mappings as mp

NOW = datetime(2026, 10, 7, 9, 0, tzinfo=timezone.utc)
GRAPH = {
    "clause:a": {"id": "clause:a", "text": "Screen every customer."},
    "control:b": {"id": "control:b", "text": "Screening runs at onboarding."},
}


def resolve(nid):
    return GRAPH.get(nid)


def make(tmp_path, **kw):
    args = dict(relation="implementsClause", s="control:b", t="clause:a", basis="Screen every customer.",
                owner="role:mlro", maker="ana", now=NOW)
    args.update(kw)
    return mp.propose(tmp_path, **args)


def test_propose_defaults(tmp_path):
    rec = make(tmp_path)
    assert rec["id"] == "map:20261007-001"
    assert rec["status"] == "proposed" and rec["checker"] is None
    assert rec["anchors"] == {"s_hash": None, "t_hash": None}
    assert rec["history"][0]["action"] == "propose"
    assert (tmp_path / "mappings" / "default.json").is_file()
    assert make(tmp_path, relation="satisfies")["id"] == "map:20261007-002"


def test_expressed_in_runs_from_an_obligation_to_a_provision_only(tmp_path):
    rec = make(tmp_path, relation="expressedIn", s="obligation:inv-a", t="provision:inv-a")
    assert rec["relation"] == "expressedIn" and rec["status"] == "proposed"
    for s, t in (("control:b", "provision:inv-a"), ("obligation:inv-a", "clause:a"), ("provision:inv-a", "obligation:inv-a")):
        with pytest.raises(mp.MappingError):
            make(tmp_path, relation="expressedIn", s=s, t=t)
    nodes, edges = mp.graph_parts(tmp_path)
    assert [e["r"] for e in edges] == ["expressedIn"] and nodes[0]["props"]["relation"] == "expressedIn"


def test_propose_refuses_bad_input_and_duplicates(tmp_path):
    with pytest.raises(mp.MappingError):
        make(tmp_path, relation="likes")
    with pytest.raises(mp.MappingError):
        make(tmp_path, origin="guess")
    with pytest.raises(mp.MappingError):
        make(tmp_path, owner="")
    make(tmp_path)
    with pytest.raises(mp.MappingError):
        make(tmp_path)


def test_ratify_separation_of_duties(tmp_path):
    rec = make(tmp_path)
    with pytest.raises(mp.MappingError, match="maker"):
        mp.ratify(tmp_path, rec["id"], by="ana", resolve=resolve, now=NOW)
    assert mp.list_mappings(tmp_path)[0]["status"] == "proposed"
    out = mp.ratify(tmp_path, rec["id"], by="ben", resolve=resolve, note="checked", now=NOW)
    assert out["status"] == "ratified" and out["checker"] == "ben"
    assert out["valid_from"] == "2026-10-07"
    assert out["anchors"]["s_hash"] == mp.node_hash(GRAPH["control:b"])
    assert out["anchors"]["t_hash"] == mp.node_hash(GRAPH["clause:a"])
    assert [h["action"] for h in out["history"]] == ["propose", "ratify"]
    with pytest.raises(mp.MappingError):
        mp.ratify(tmp_path, rec["id"], by="cat", resolve=resolve)


def test_ratify_refuses_absent_end(tmp_path):
    rec = make(tmp_path, t="clause:missing")
    with pytest.raises(mp.MappingError, match="absent"):
        mp.ratify(tmp_path, rec["id"], by="ben", resolve=resolve)


def test_reject_needs_reason_and_keeps_record(tmp_path):
    rec = make(tmp_path)
    with pytest.raises(mp.MappingError):
        mp.reject(tmp_path, rec["id"], by="ben", reason=" ")
    with pytest.raises(mp.MappingError):
        mp.reject(tmp_path, rec["id"], by="ana", reason="wrong")
    out = mp.reject(tmp_path, rec["id"], by="ben", reason="The clause does not apply.")
    assert out["status"] == "rejected" and out["reason"] == "The clause does not apply."
    assert len(mp.list_mappings(tmp_path)) == 1
    assert mp.graph_parts(tmp_path)[1] == []


def test_stale_detection(tmp_path):
    rec = make(tmp_path)
    mp.ratify(tmp_path, rec["id"], by="ben", resolve=resolve, now=NOW)
    assert mp.list_stale(tmp_path, resolve) == []
    changed = {**GRAPH, "clause:a": {"id": "clause:a", "text": "Screen every customer and owner."}}
    stale = mp.list_stale(tmp_path, changed.get)
    assert len(stale) == 1 and "has changed" in stale[0]["stale"][0]
    gone = {k: v for k, v in GRAPH.items() if k != "control:b"}
    assert "absent" in mp.list_stale(tmp_path, gone.get)[0]["stale"][0]


def test_edit_returns_ratified_to_proposed(tmp_path):
    rec = make(tmp_path)
    mp.ratify(tmp_path, rec["id"], by="ben", resolve=resolve, now=NOW)
    out = mp.edit(tmp_path, rec["id"], by="ana", basis="New words.", now=NOW)
    assert out["status"] == "proposed" and out["checker"] is None and out["valid_from"] is None
    assert out["anchors"] == {"s_hash": None, "t_hash": None}
    assert out["history"][-1]["action"] == "edit" and len(out["history"]) == 3


def test_reassign_and_supersede_append_history(tmp_path):
    a = make(tmp_path)
    b = make(tmp_path, relation="satisfies")
    mp.reassign(tmp_path, a["id"], by="ana", owner="role:deputy", now=NOW)
    out = mp.supersede(tmp_path, a["id"], by="ana", replacement_id=b["id"], now=NOW)
    assert out["status"] == "superseded" and out["superseded_by"] == b["id"]
    assert [h["action"] for h in out["history"]] == ["propose", "reassign", "supersede"]
    assert mp.ledger_entry(out, "mapping.reassign")["kind"] == "mapping.reassign"


def test_list_filters_and_scopes(tmp_path):
    make(tmp_path)
    make(tmp_path, scope="bank", owner="role:head", s="control:x")
    assert len(mp.list_mappings(tmp_path)) == 2
    assert len({m["id"] for m in mp.list_mappings(tmp_path)}) == 2
    assert len(mp.list_mappings(tmp_path, scope="bank")) == 1
    assert len(mp.list_mappings(tmp_path, owner="role:head")) == 1
    assert mp.list_mappings(tmp_path, status="ratified") == []
    with pytest.raises(mp.MappingError):
        mp.scope_path(tmp_path, "../x")


def test_graph_parts_provenance(tmp_path):
    a = make(tmp_path)
    b = make(tmp_path, relation="satisfies")
    mp.ratify(tmp_path, b["id"], by="ben", resolve=resolve, now=NOW)
    nodes, edges = mp.graph_parts(tmp_path)
    assert len(nodes) == 2
    by = {e["mapping"]: e for e in edges}
    assert by[a["id"]]["provenance"] == "proposed" and by[a["id"]]["weight"] == 0.5
    assert by[b["id"]]["provenance"] == "ratified"
    assert by[a["id"]]["evidence"] == f"mappings/default.json#{a['id']}"


def test_file_is_contract_shape(tmp_path):
    make(tmp_path)
    data = json.loads((tmp_path / "mappings" / "default.json").read_text(encoding="utf-8"))
    assert data["v"] == 1 and data["scope"] == "default" and len(data["mappings"]) == 1


# ---- hardening of 7 October 2026 ----

def test_supersede_refuses_its_own_id(tmp_path):
    a = make(tmp_path)
    with pytest.raises(mp.MappingError, match="itself"):
        mp.supersede(tmp_path, a["id"], by="ana", replacement_id=a["id"], now=NOW)
    assert mp.list_mappings(tmp_path)[0]["status"] == "proposed"


def test_supersede_needs_a_proposed_or_ratified_replacement(tmp_path):
    a = make(tmp_path)
    b = make(tmp_path, relation="satisfies")
    mp.reject(tmp_path, b["id"], by="ben", reason="Wrong clause.", now=NOW)
    with pytest.raises(mp.MappingError, match="must be proposed or ratified"):
        mp.supersede(tmp_path, a["id"], by="ana", replacement_id=b["id"], now=NOW)
    c = make(tmp_path, relation="realises")
    assert mp.supersede(tmp_path, a["id"], by="ana", replacement_id=c["id"], now=NOW)["status"] == "superseded"
    with pytest.raises(mp.MappingError, match="must be proposed or ratified"):
        mp.supersede(tmp_path, c["id"], by="ana", replacement_id=a["id"], now=NOW)


def test_maker_and_checker_compare_without_case_or_spaces(tmp_path):
    rec = make(tmp_path)
    with pytest.raises(mp.MappingError, match="maker"):
        mp.ratify(tmp_path, rec["id"], by="  ANA ", resolve=resolve, now=NOW)
    with pytest.raises(mp.MappingError, match="maker"):
        mp.reject(tmp_path, rec["id"], by="Ana", reason="no", now=NOW)
    out = mp.ratify(tmp_path, rec["id"], by=" Ben ", resolve=resolve, now=NOW)
    assert out["checker"] == "Ben"


def test_a_blank_actor_is_refused(tmp_path):
    rec = make(tmp_path)
    for blank in ("", "   ", None):
        with pytest.raises(mp.MappingError, match="person"):
            mp.ratify(tmp_path, rec["id"], by=blank, resolve=resolve, now=NOW)
        with pytest.raises(mp.MappingError, match="person"):
            mp.reject(tmp_path, rec["id"], by=blank, reason="no", now=NOW)
        with pytest.raises(mp.MappingError, match="person"):
            mp.reassign(tmp_path, rec["id"], by=blank, owner="role:x", now=NOW)
    assert len(mp.list_mappings(tmp_path)[0]["history"]) == 1


def test_reassign_refuses_a_rejected_or_superseded_mapping(tmp_path):
    a = make(tmp_path)
    b = make(tmp_path, relation="satisfies")
    mp.reject(tmp_path, a["id"], by="ben", reason="Wrong.", now=NOW)
    with pytest.raises(mp.MappingError, match="rejected"):
        mp.reassign(tmp_path, a["id"], by="ana", owner="role:x", now=NOW)
    c = make(tmp_path, relation="realises")
    mp.supersede(tmp_path, b["id"], by="ana", replacement_id=c["id"], now=NOW)
    with pytest.raises(mp.MappingError, match="superseded"):
        mp.reassign(tmp_path, b["id"], by="ana", owner="role:x", now=NOW)


def test_reject_of_a_ratified_mapping_clears_its_date_and_anchors(tmp_path):
    rec = make(tmp_path)
    mp.ratify(tmp_path, rec["id"], by="ben", resolve=resolve, now=NOW)
    out = mp.reject(tmp_path, rec["id"], by="cat", reason="Withdrawn after review.", now=NOW)
    assert out["status"] == "rejected" and out["valid_from"] is None
    assert out["anchors"] == {"s_hash": None, "t_hash": None}
    assert mp.list_stale(tmp_path, resolve) == []


def test_a_ratified_mapping_with_a_null_anchor_is_stale(tmp_path):
    rec = make(tmp_path)
    mp.ratify(tmp_path, rec["id"], by="ben", resolve=resolve, now=NOW)
    data = mp.load(tmp_path)
    data["mappings"][0]["anchors"]["t_hash"] = None
    mp.save(tmp_path, data)
    stale = mp.list_stale(tmp_path, resolve)
    assert len(stale) == 1 and "no anchor" in stale[0]["stale"][0] and "clause:a" in stale[0]["stale"][0]


def test_node_hash_ignores_the_metrics_of_a_build():
    node = {"id": "clause:a", "text": "Screen every customer."}
    assert mp.node_hash({**node, "metrics": {"uses": 3, "heat": 0.5}}) == mp.node_hash(node)
    assert mp.node_hash({**node, "text": "Other."}) != mp.node_hash(node)
