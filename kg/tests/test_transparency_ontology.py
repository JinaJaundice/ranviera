"""Tests for the agent transparency ontology (WP1): the classes, relations, weights, shapes F01 to F14 and the local pack loader.

Only the invented fixtures of tests/fixtures/packs are read. A fixture checks that no test reads a real pack folder."""
from __future__ import annotations

import builtins
import json
import sys
from pathlib import Path

import pytest
from pyshacl import validate
from rdflib import Graph, Namespace
from rdflib.namespace import OWL, RDF, RDFS, SH

KG = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KG))
from cortex_kg import config, packs  # noqa: E402

ONT = KG.parent / "ontology"
FX = Path(__file__).resolve().parent / "fixtures" / "packs"
CX = Namespace("https://cortex.local/ont#")
REAL_MARKER = "ontology files"   # the folder that holds real pack modules

NEW_CLASSES = {
    "DeployedAgent": "agent", "InstructionVersion": "agent", "ModelVersion": "agent", "KnowledgeSource": "agent",
    "PolicyClause": "obligation", "Mapping": "agent", "Run": "agent", "Step": "agent", "ToolCall": "agent",
    "Evidence": "agent", "StatedRationale": "agent", "AgentDecision": "agent", "Review": "agent", "Sample": "agent",
    "BackTest": "agent", "LedgerEntry": "agent", "TestScript": "obligation", "TestStep": "obligation",
    "Requirement": "obligation",
}
NEW_RELATIONS = ("implementsClause realises satisfies expressedIn notDischargedBy detects signals operatesUnder drawsOn "
                 "performedBy ranOn inContext citesInstruction usedEvidence sourcedFrom informedDecision reviewedBy "
                 "sampledFrom testedAgainst approvedBy proposedBy statesRationale entryOf").split()


@pytest.fixture(autouse=True)
def no_real_pack(monkeypatch):
    """Clear the pack keys and record every file that a test opens, so that a read of the real folder fails the test."""
    for key in ("CORTEX_PACK_DIR", "CORTEX_PACK_REGISTER", "CORTEX_PACK_PROFILE"):
        monkeypatch.delenv(key, raising=False)
    opened: list[str] = []
    real_open = builtins.open

    def spy(file, *a, **k):
        if isinstance(file, (str, Path)):
            opened.append(str(file))
        return real_open(file, *a, **k)

    monkeypatch.setattr(builtins, "open", spy)
    yield
    assert not [p for p in opened if REAL_MARKER in p.replace("\\", "/")], "a test read a real pack folder"


@pytest.fixture(scope="module")
def cortex() -> Graph:
    return Graph().parse(ONT / "cortex.ttl", format="turtle")


@pytest.fixture(scope="module")
def shapes() -> Graph:
    return Graph().parse(ONT / "shapes.ttl", format="turtle")


def check_ids(data: Graph, shapes: Graph, cortex: Graph) -> set[str]:
    _ok, report, _text = validate(data, shacl_graph=shapes, ont_graph=cortex, inference="none", advanced=True)
    found: set[str] = set()
    for source in report.objects(None, SH.sourceShape):
        found.update(str(v) for v in shapes.objects(source, CX.checkId))
    return found


def good_text() -> str:
    return (FX / "agent_good.ttl").read_text(encoding="utf-8")


def ids_for(text: str, shapes, cortex, extra: str = "") -> set[str]:
    g = Graph().parse(data=text, format="turtle")
    if extra:
        g.parse(data=extra, format="turtle")
    return check_ids(g, shapes, cortex)


# ---- the ontology ----

def test_new_classes_are_declared_with_a_family(cortex):
    for name, family in NEW_CLASSES.items():
        assert (CX[name], RDF.type, OWL.Class) in cortex, name
        assert str(next(cortex.objects(CX[name], CX.family))) == family, name
        assert list(cortex.objects(CX[name], RDFS.comment)), name


def test_new_relations_are_declared(cortex):
    for rel in NEW_RELATIONS:
        assert (CX[rel], RDF.type, OWL.ObjectProperty) in cortex, rel
        assert list(cortex.objects(CX[rel], CX.inverseLabel)), rel


def test_prov_alignments(cortex):
    prov = "http://www.w3.org/ns/prov#"
    from rdflib import URIRef
    assert (CX.Run, RDFS.subClassOf, URIRef(prov + "Activity")) in cortex
    assert (CX.Step, RDFS.subClassOf, URIRef(prov + "Activity")) in cortex
    assert (CX.DeployedAgent, RDFS.subClassOf, URIRef(prov + "Agent")) in cortex
    assert (CX.InstructionVersion, RDFS.subClassOf, URIRef(prov + "Entity")) in cortex


def test_conflicts_and_overrides_accept_an_instruction_version(cortex):
    from rdflib.collection import Collection
    for rel in (CX.conflictsWith, CX.overrides):
        for axiom in (RDFS.domain, RDFS.range):
            expr = next(cortex.objects(rel, axiom))
            members = set(Collection(cortex, next(cortex.objects(expr, OWL.unionOf))))
            assert CX.InstructionVersion in members and CX.Rule in members


def test_status_and_family_enumerations_grow(cortex):
    from rdflib.collection import Collection
    for prop, wanted in ((CX.status, {"draft", "approved", "proposed", "ratified", "rejected"}),
                         (CX.family, {"agent", "obligation"})):
        rng = next(cortex.objects(prop, RDFS.range))
        values = {str(v) for v in Collection(cortex, next(cortex.objects(rng, OWL.oneOf)))}
        assert wanted <= values, prop


def test_agent_relation_weights():
    doc = json.loads((ONT / "defaults" / "weights.json").read_text(encoding="utf-8"))
    rows = {r["id"]: r for r in doc["relations"] if r["id"] in NEW_RELATIONS}
    assert sorted(rows) == sorted(NEW_RELATIONS)
    assert "agent_relations" not in doc
    for r in rows.values():
        assert set(r) == {"id", "label", "inverse_label", "weight", "reverse_weight"}
        assert 0 < r["weight"] <= 1 and 0 < r["reverse_weight"] <= 1
    assert (rows["implementsClause"]["weight"], rows["implementsClause"]["reverse_weight"]) == (0.85, 0.55)
    assert (rows["expressedIn"]["weight"], rows["expressedIn"]["reverse_weight"]) == (0.70, 0.50)
    assert (rows["notDischargedBy"]["weight"], rows["notDischargedBy"]["reverse_weight"]) == (0.20, 0.20)
    assert (rows["approvedBy"]["weight"], rows["proposedBy"]["weight"]) == (0.30, 0.20)
    ids = [r["id"] for r in doc["relations"]]
    assert len(ids) == len(set(ids))


# ---- the shapes ----

def test_every_f_shape_exists_with_id_and_severity(shapes):
    ids = {str(o) for o in shapes.objects(None, CX.checkId)}
    for n in range(1, 15):
        assert f"F{n:02d}" in ids
    for shape in shapes.subjects(RDF.type, SH.NodeShape):
        assert list(shapes.objects(shape, CX.checkId)), shape
        assert list(shapes.objects(shape, SH.severity)), shape


def test_the_good_fixtures_pass_every_f_shape(shapes, cortex):
    found = ids_for(good_text(), shapes, cortex, (FX / "mini_pack.ttl").read_text(encoding="utf-8"))
    assert not {i for i in found if i.startswith(("F", "S"))}, found


def test_the_register_fixture_passes_f01(shapes, cortex):
    assert ids_for((FX / "mini_register.ttl").read_text(encoding="utf-8"), shapes, cortex) == set()


def test_f01_reports_the_defects(shapes, cortex):
    g = Graph().parse(FX / "mini_pack_defects.ttl", format="turtle")
    _ok, report, _t = validate(g, shacl_graph=shapes, ont_graph=cortex, inference="none", advanced=True)
    focus = {str(f).rsplit("#", 1)[-1] for f in report.objects(None, SH.focusNode)}
    assert focus == {"obl-no-provision", "obl-no-date", "stmt-bare"}


MUTATIONS = {
    "F02": ('cx:status "ratified" ; cx:ownedBy cxi:person_pat ; cx:proposedBy cxi:person_pat ;',
            'cx:status "weird" ; cx:ownedBy cxi:person_pat ; cx:proposedBy cxi:person_pat ;'),
    "F03": ("cx:approvedBy cxi:person_sam ;\n    cx:sourceAnchor", "cx:approvedBy cxi:person_pat ;\n    cx:sourceAnchor"),
    "F04": ('cx:sourceAnchor "h-s" ; ', ""),
    "F05": ('cx:hash "h-instr-1" ; ', ""),
    "F06": ('cx:promptHash "h-prompt" ;', ""),
    "F07": ("cx:ordinal 1 ;", "cx:ordinal 0 ;"),
    "F08": ("cx:statesRationale cxi:rationale_q1 ; ", ""),
    "F09": ('cx:causalStatus "unverified"', 'cx:causalStatus "verified"'),
    "F11": ('cx:riskTier "medium" ; ', ""),
    "F12": ("cx:override false .", "cx:override true ."),
    "F13": ('cx:replayStatus "replayable"', 'cx:replayStatus "not-replayable"'),
    "F14": ("cx:entryOf cxi:run_r1", "cx:entryOf cxi:run_other"),
}


@pytest.mark.parametrize("check", sorted(MUTATIONS))
def test_each_f_shape_reports_its_defect(check, shapes, cortex):
    old, new = MUTATIONS[check]
    text = good_text()
    assert text.count(old) == 1, check
    assert check in ids_for(text.replace(old, new), shapes, cortex)


def test_f10_requires_a_sensitivity_for_a_private_origin(shapes, cortex):
    bad = ('@prefix cx: <https://cortex.local/ont#> . <https://cortex.local/id/x> cx:origin "local-pack" ; '
           'cx:sensitivity "public" .')
    ok = bad.replace('"public"', '"internal"')
    assert "F10" in ids_for(bad, shapes, cortex)
    assert "F10" not in ids_for(ok, shapes, cortex)


def test_f10_covers_the_financial_crime_namespace(shapes, cortex):
    text = ('@prefix cx: <https://cortex.local/ont#> . @prefix fc: <https://ranviera.local/fc#> . '
            '<https://cortex.local/id/case1> a fc:Case ; cx:sensitivity "public" .')
    assert "F10" in ids_for(text, shapes, cortex)


def test_s20_allows_the_run_record_and_s22_an_instruction_version(shapes, cortex):
    assert "S20" not in ids_for(good_text(), shapes, cortex)
    text = ('@prefix cx: <https://cortex.local/ont#> . @prefix cxi: <https://cortex.local/id/> . '
            '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . '
            'cxi:i1 a cx:InstructionVersion ; rdfs:label "i1" ; cx:family "agent" ; cx:sensitivity "internal" ; '
            'cx:conflictsWith cxi:i2 . '
            'cxi:i2 a cx:InstructionVersion ; rdfs:label "i2" ; cx:family "agent" ; cx:sensitivity "internal" .')
    assert "S22" not in ids_for(text, shapes, cortex)


def test_s01_and_s12_cover_the_new_families(shapes, cortex):
    text = ('@prefix cx: <https://cortex.local/ont#> . @prefix cxi: <https://cortex.local/id/> . '
            '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> . '
            'cxi:r1 a cx:Run ; rdfs:label "r1" ; cx:family "record" ; cx:sensitivity "internal" .')
    assert "S12" in ids_for(text, shapes, cortex)


# ---- the pack loader ----

def make_cfg(tmp_path: Path, **raw):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"data_dir": str(tmp_path / "data"), **raw}), encoding="utf-8")
    return config.load_config(path)


def test_no_keys_reads_nothing(tmp_path):
    cfg = make_cfg(tmp_path)
    called: list = []
    orig = packs._parse
    packs._parse = lambda *a, **k: called.append(a)  # type: ignore[assignment]
    try:
        result = packs.load(cfg)
    finally:
        packs._parse = orig
    assert result.loaded is False and result.graph is None and result.nodes == [] and called == []


def test_a_missing_folder_is_a_warning_and_not_an_error(tmp_path):
    result = packs.load(make_cfg(tmp_path, pack_dir=str(tmp_path / "absent")))
    assert result.loaded is False and result.warnings


def test_loads_the_fixtures(tmp_path):
    folder = tmp_path / "pack"
    folder.mkdir()
    (folder / "a-core.ttl").write_text((FX / "mini_pack.ttl").read_text(encoding="utf-8"), encoding="utf-8")
    (folder / "a-shacl.ttl").write_text("# a shapes file is skipped\n", encoding="utf-8")
    cfg = make_cfg(tmp_path, pack_dir=str(folder), pack_register=str(FX / "mini_register.ttl"))
    from rdflib import Dataset
    ds = Dataset()
    result = packs.load(cfg, ds)
    assert result.loaded and [s["file"] for s in result.sources] == ["a-core.ttl", "mini_register.ttl"]
    total = result.counts["total"]
    assert total["classes"] == 13 and total["by_type"]["Obligation"] == 3
    assert len(ds.graph(packs.URIRef(packs.PRIVATE_GRAPH))) == total["triples"]
    roles: dict[str, int] = {}
    for n in result.nodes:
        role = n["id"].split(":", 1)[0]
        roles[role] = roles.get(role, 0) + 1
        assert n["props"]["origin"] == "local-pack" and n["sensitivity"] == "internal" and n["family"] == "obligation"
    assert roles == {"provision": 4, "obligation": 4, "policy": 2, "control": 2, "exception": 1, "role": 1}
    assert {e["r"] for e in result.edges} == {"expressedIn", "satisfies", "ownedBy"}
    man = packs.manifest(result, "2026-10-07")
    assert man["loaded"]["obligations"] == 4 and all(len(s["sha256"]) == 64 for s in man["sources"])


def test_the_environment_variable_overrides_the_key(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path, pack_register=str(tmp_path / "absent.ttl"))
    monkeypatch.setenv("CORTEX_PACK_REGISTER", str(FX / "mini_register.ttl"))
    assert packs.load(cfg).loaded


def test_retargeting_the_shapes_follows_the_profile(shapes, cortex):
    other = "https://example.test/other#"
    profile = {"base": other, "classes": {}, "relations": {}}
    retargeted = packs.retarget_shapes(shapes, profile)
    targets = {str(t) for t in retargeted.objects(CX.F01Shape, SH.targetClass)}
    assert targets == {other + n for n in ("Obligation", "Permission", "Prohibition", "DeonticStatement")}
    text = (FX / "mini_pack_defects.ttl").read_text(encoding="utf-8").replace(packs.DEFAULT_BASE, other)
    g = Graph().parse(data=text, format="turtle")
    assert "F01" in check_ids(g, retargeted, cortex)
    assert "F01" not in check_ids(g, shapes, cortex)   # the default shapes read the invented base only


def test_a_profile_can_be_derived_from_a_graph():
    g = Graph().parse(FX / "mini_pack.ttl", format="turtle")
    profile = packs.profile_from_graph(g)
    assert profile["classes"]["Obligation"] == packs.DEFAULT_BASE + "Obligation"


def test_the_committed_files_hold_no_real_iri_or_hub_text():
    needle = "regulatory" + "-mapping." + "org"
    files = [KG / "cortex_kg" / "packs.py", Path(__file__), ONT / "cortex.ttl", ONT / "shapes.ttl",
             ONT / "defaults" / "weights.json", *FX.glob("*")]
    for f in files:
        assert needle not in f.read_text(encoding="utf-8"), f
