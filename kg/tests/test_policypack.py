"""Tests of the policy pack loader (docs/CONTRACTS.md, 'The policy pack'). Every file here is invented."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cortex_kg import compile as comp  # noqa: E402
from cortex_kg import model, policypack  # noqa: E402
from cortex_kg.model import Harvest  # noqa: E402

TEXT = "A firm must keep an invented record of each invented check."


def pack(nodes=None, edges=None, **extra) -> dict:
    base_nodes = [
        {"id": "clause:inv-1", "type": "PolicyClause", "label": "Invented clause", "props": {"text": TEXT}},
        {"id": "control:inv-1", "type": "Control", "label": "Invented control", "status": "active", "props": {"control_type": "preventive"}},
        {"id": "obligation:inv-1", "type": "Obligation", "label": "Invented obligation", "status": "active",
         "props": {"effective_date": "2026-01-01"}},
        {"id": "provision:inv-1", "type": "LegislativeProvision", "label": "Invented provision",
         "props": {"text": "Invented summary.", "source_url": "https://example.test/provision"}},
        {"id": "typology:inv-1", "type": "Typology", "label": "Invented typology", "status": "active",
         "props": {"source_url": "https://example.test/typology"}},
        {"id": "riskind:inv-1", "type": "RiskIndicator", "label": "Invented indicator", "props": {}},
        {"id": "policy:inv-1", "type": "Procedure", "label": "Invented procedure", "props": {}},
    ]
    doc = {"v": 1, "name": "Invented pack", "source": "invented", "licence": "Open Government Licence v3.0",
           "attribution": "Contains public sector information licensed under the Open Government Licence v3.0.",
           "nodes": base_nodes if nodes is None else nodes,
           "edges": [{"s": "obligation:inv-1", "r": "expressedIn", "t": "provision:inv-1"},
                     {"s": "riskind:inv-1", "r": "signals", "t": "typology:inv-1"}] if edges is None else edges}
    doc.update(extra)
    return doc


def write(profile: Path, name: str, doc) -> None:
    d = profile / "policy"
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text(json.dumps(doc), encoding="utf-8")


def test_nodes_take_their_class_from_the_prefix_and_clauses_get_a_hash(tmp_path):
    write(tmp_path, "a.json", pack())
    nodes, edges = policypack.graph_parts(tmp_path)
    by = {n["id"]: n for n in nodes}
    assert {i.split(":")[0] for i in by} == {"clause", "control", "obligation", "provision", "typology", "riskind", "policy"}
    assert all(model.class_of(i)[0] == n["type"] for i, n in by.items())       # a Procedure takes the class of a Policy
    assert by["clause:inv-1"]["props"]["hash"] == policypack.text_hash(TEXT)
    assert by["policy:inv-1"]["props"]["kind"] == "Procedure"
    assert by["control:inv-1"]["props"]["control_type"] == "preventive" and by["obligation:inv-1"]["status"] == "active"
    assert by["provision:inv-1"]["props"]["licence"] == "Open Government Licence v3.0"
    assert by["provision:inv-1"]["evidence"] == "https://example.test/provision"
    assert {(e["s"], e["r"], e["t"]) for e in edges} == {("obligation:inv-1", "expressedIn", "provision:inv-1"),
                                                         ("riskind:inv-1", "signals", "typology:inv-1")}
    assert all(e["provenance"] == "stated" for e in edges)


def test_a_given_hash_is_kept_and_two_files_meet_on_one_id(tmp_path):
    first = pack(nodes=[{"id": "clause:inv-1", "type": "PolicyClause", "label": "One", "props": {"text": TEXT, "hash": "sha256:" + "a" * 64}}], edges=[])
    second = pack(nodes=[{"id": "clause:inv-1", "type": "PolicyClause", "label": "Two", "props": {"text": TEXT, "extra": 1}}], edges=[])
    write(tmp_path, "a.json", first)
    write(tmp_path, "b.json", second)
    nodes, _ = policypack.graph_parts(tmp_path)
    assert len(nodes) == 1 and nodes[0]["label"] == "One"
    assert nodes[0]["props"]["hash"] == "sha256:" + "a" * 64 and nodes[0]["props"]["extra"] == 1


@pytest.mark.parametrize("bad, why", [
    (pack(nodes=[{"id": "case:x", "type": "Case", "label": "x", "props": {}}], edges=[]), "which is not one of"),
    (pack(nodes=[{"id": "control:x", "type": "PolicyClause", "label": "x", "props": {}}], edges=[]), "start clause:"),
    (pack(edges=[{"s": "control:inv-1", "r": "satisfies", "t": "obligation:inv-1"}]), "belongs to the mapping store"),
    (pack(edges=[{"s": "clause:inv-1", "r": "implementsClause", "t": "clause:inv-1"}]), "belongs to the mapping store"),
    (pack(edges=[{"s": "clause:inv-1", "r": "madeUp", "t": "control:inv-1"}]), "not a relation"),
    ({"v": 2, "nodes": []}, "not version 1"),
])
def test_a_file_that_breaks_the_contract_is_refused_whole(tmp_path, bad, why):
    write(tmp_path, "good.json", pack(nodes=[{"id": "clause:ok", "type": "PolicyClause", "label": "Ok", "props": {"text": "Fine."}}], edges=[]))
    write(tmp_path, "bad.json", bad)
    with pytest.raises(policypack.PolicyPackError, match=why):
        policypack.graph_parts(tmp_path)
    problems: list[str] = []
    nodes, _ = policypack.graph_parts(tmp_path, problems)
    assert [n["id"] for n in nodes] == ["clause:ok"] and len(problems) == 1 and why in problems[0]


def test_a_missing_folder_gives_nothing(tmp_path):
    assert policypack.graph_parts(tmp_path) == ([], [])


def test_the_build_adds_pack_nodes_and_reports_a_refused_file_as_b08(tmp_path):
    from types import SimpleNamespace
    profile = tmp_path / "profile"
    write(profile, "a.json", pack())
    write(profile, "bad.json", pack(edges=[{"s": "control:inv-1", "r": "satisfies", "t": "obligation:inv-1"}]))
    h = Harvest("x")
    cfg = SimpleNamespace(profile_dir=profile, data_dir=tmp_path / "data", include_private_graphs=False)
    comp.transparency_stage(h, cfg)
    assert "obligation:inv-1" in h.nodes and h.nodes["clause:inv-1"].props["hash"] == policypack.text_hash(TEXT)
    assert ("obligation:inv-1", "expressedIn", "provision:inv-1") in h.edges
    assert [f.check for f in h.findings] == ["B08"] and "mapping store" in h.findings[0].message
