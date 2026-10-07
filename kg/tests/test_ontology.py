"""Tests for the ontology files: classes, relations, weights, SHACL shapes and the vocabulary schemes."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest
from pyshacl import validate
from rdflib import Graph, Literal, Namespace, URIRef
from rdflib.namespace import OWL, RDF, RDFS, SH, SKOS

KG = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KG))
from cortex_kg import model  # noqa: E402

ONT = KG.parent / "ontology"
PROFILE = KG.parent / "profile"
CX = Namespace("https://cortex.local/ont#")
OVERLAY = Path.home() / ".claude" / "cortex" / "overlay" / "vocab"

PREFIXES = """@prefix cx: <https://cortex.local/ont#> .
@prefix cxi: <https://cortex.local/id/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
"""


@pytest.fixture(scope="module")
def cortex() -> Graph:
    return Graph().parse(ONT / "cortex.ttl", format="turtle")


@pytest.fixture(scope="module")
def shapes() -> Graph:
    return Graph().parse(ONT / "shapes.ttl", format="turtle")


def check_ids(data_ttl: str, shapes: Graph, cortex: Graph) -> set[str]:
    """Validate a tiny data graph and return the cx:checkId of every shape that produced a result."""
    # a prefixed name cannot hold a slash, so cxi:<prefix>/<slug> is written out as a full IRI
    data_ttl = re.sub(r"cxi:([a-z]+)/([\w-]+)", r"<https://cortex.local/id/\1/\2>", data_ttl)
    data = Graph().parse(data=PREFIXES + data_ttl, format="turtle")
    _conforms, report, _text = validate(data, shacl_graph=shapes, ont_graph=cortex, inference="none", advanced=True)
    found: set[str] = set()
    for source in report.objects(None, SH.sourceShape):
        found.update(str(v) for v in shapes.objects(source, CX.checkId))
    return found


def node(slug: str, cls: str, family: str, extra: str = "") -> str:
    prefix = {v[0]: k for k, v in model.CLASSES.items()}[cls]
    return (f'cxi:{prefix}/{slug} a cx:{cls} ; rdfs:label "{slug}" ; cx:family "{family}" ; '
            f'cx:sensitivity "internal" {extra} .\n')


# ---- the classes, relations and weights ----

def test_files_parse(cortex, shapes):
    assert len(cortex) > 0 and len(shapes) > 0


def test_every_class_is_declared(cortex):
    for prefix, (cls, parent, family) in model.CLASSES.items():
        iri = CX[cls]
        assert (iri, RDF.type, OWL.Class) in cortex, cls
        assert list(cortex.objects(iri, RDFS.label)), cls
        assert list(cortex.objects(iri, RDFS.comment)), cls
        assert str(next(cortex.objects(iri, CX.family))) == family, cls
        if parent:
            assert (iri, RDFS.subClassOf, CX[parent]) in cortex, cls
    assert (CX.InstructionFile, RDF.type, OWL.Class) in cortex
    assert (CX.Organisation, RDF.type, OWL.Class) in cortex
    assert (CX.Concept, RDFS.subClassOf, SKOS.Concept) in cortex
    assert (CX.ConceptScheme, RDFS.subClassOf, SKOS.ConceptScheme) in cortex


def test_every_relation_is_declared(cortex):
    for rel in model.RELATIONS:
        iri = CX[rel]
        assert (iri, RDF.type, OWL.ObjectProperty) in cortex, rel
        assert list(cortex.objects(iri, RDFS.label)), rel
        assert list(cortex.objects(iri, CX.inverseLabel)), rel


def test_datatype_properties_are_declared(cortex):
    names = ("path summary date status sensitivity family evidence text modal givenOn fingerprint section model effort "
             "tools event matcher command async pattern memoryType bytes indexed termStatus severity uses lastUsed "
             "baseLevel checkId").split()
    for name in names:
        assert (CX[name], RDF.type, OWL.DatatypeProperty) in cortex, name
    xsd = "http://www.w3.org/2001/XMLSchema#"
    ranges = {"date": "date", "givenOn": "date", "async": "boolean", "bytes": "integer", "indexed": "boolean",
              "uses": "integer", "lastUsed": "dateTime", "baseLevel": "decimal"}
    for name, rng in ranges.items():
        assert (CX[name], RDFS.range, URIRef(xsd + rng)) in cortex, name


def test_weights_cover_every_relation():
    doc = json.loads((ONT / "defaults" / "weights.json").read_text(encoding="utf-8"))
    ids = [r["id"] for r in doc["relations"]]
    # a relation listed under "unweighted" is kept for queries only and carries no activation (6 October 2026)
    assert sorted(ids + doc.get("unweighted", [])) == sorted(model.RELATIONS) and len(ids) == len(set(ids))
    for r in doc["relations"]:
        assert set(r) == {"id", "label", "inverse_label", "weight", "reverse_weight"}
        assert 0 < r["weight"] <= 1 and 0 < r["reverse_weight"] <= 1
        assert r["label"] and r["inverse_label"]
    assert doc["activation"] == {"decay": 0.6, "max_hops": 2, "threshold": 0.05, "fan_exponent": 0.5,
                                 "base_level_d": 0.5, "min_age_days": 0.01}
    by_id = {r["id"]: r for r in doc["relations"]}
    assert (by_id["triggers"]["weight"], by_id["triggers"]["reverse_weight"]) == (0.95, 0.50)
    assert (by_id["ownedBy"]["weight"], by_id["ownedBy"]["reverse_weight"]) == (0.20, 0.10)


# ---- the shapes ----

def test_every_shape_has_id_severity_and_message(shapes):
    ids = sorted(str(o) for o in shapes.objects(None, CX.checkId))
    # S10 was removed on 6 October 2026, because rule R04 does its job, and its identifier is not reused
    # S03 is a Python check (validate.check_s03), because the model it requires comes from the configuration
    for n in [1, 2, *range(4, 10), *range(11, 23)]:
        assert f"S{n:02d}" in ids
    assert "S10" not in ids and "S03" not in ids
    for shape in shapes.subjects(RDF.type, SH.NodeShape):
        assert list(shapes.objects(shape, CX.checkId)), shape
        assert list(shapes.objects(shape, SH.severity)), shape


GOOD_RULE = ('cxi:rulefile/writing a cx:RuleFile ; rdfs:label "writing" ; cx:family "instruction" ; '
             'cx:sensitivity "internal" ; cx:contains cxi:rule/writing-001 .\n')

CASES = {
    "S01": (
        node("writing", "RuleFile", "instruction"),
        'cxi:rulefile/bad a cx:RuleFile ; rdfs:label "bad" ; cx:family "instruction" .\n',
    ),
    "S02": (
        GOOD_RULE + node("writing-001", "Rule", "instruction",
                         '; cx:text "Do not use dashes." ; cx:modal "must" ; cx:givenOn "2026-09-29"^^xsd:date'),
        node("writing-001", "Rule", "instruction", '; cx:text "Do not use dashes." ; cx:modal "must"'),
    ),
    "S04": (
        node("decks", "Route", "instruction", '; cx:pattern "deck|slide" ; cx:triggers cxi:task/deck'),
        node("decks", "Route", "instruction", '; cx:triggers cxi:task/deck'),
    ),
    "S05": (
        node("deck", "TaskType", "instruction", '; cx:readsFirst cxi:rulefile/decks'),
        node("deck", "TaskType", "instruction"),
    ),
    "S06": (
        node("stop", "Hook", "machinery", '; cx:invokes cxi:tool/register-hook'),
        node("stop", "Hook", "machinery"),
    ),
    "S07": (
        node("user-role", "MemoryFile", "record", '; cx:memoryType "user" ; cx:summary "Jordan." ; '
             'cx:bytes 100 ; cx:indexed true') + 'cxi:record/memory-index cx:indexes cxi:memory/user-role .\n',
        node("user-role", "MemoryFile", "record", '; cx:summary "Jordan."'),
    ),
    "S08": (
        node("falcon", "Project", "work", '; cx:documentedIn cxi:memory/project-falcon') +
        node("project-falcon", "MemoryFile", "record"),
        node("falcon", "Project", "work"),
    ),
    "S09": (
        node("engine", "Concept", "language", '; skos:prefLabel "the engine" ; skos:altLabel "compliance engine" ; '
             'skos:hiddenLabel "the platform"'),
        node("engine", "Concept", "language", '; skos:prefLabel "the engine" ; skos:altLabel "compliance engine" ; '
             'skos:hiddenLabel "compliance engine"'),
    ),
    "S12": (
        node("x", "Rule", "instruction"),
        'cxi:rule/x a cx:Rule ; rdfs:label "x" ; cx:sensitivity "internal" .\n',
    ),
    "S13": (
        node("deck", "TaskType", "instruction", '; cx:readsFirst cxi:rulefile/decks') + node("decks", "RuleFile", "instruction"),
        node("deck", "TaskType", "instruction", '; cx:readsFirst cxi:agent/builder') + node("builder", "Agent", "machinery"),
    ),
    "S14": (
        node("deck", "TaskType", "instruction", '; cx:handledBy cxi:agent/builder') + node("builder", "Agent", "machinery"),
        node("deck", "TaskType", "instruction", '; cx:handledBy cxi:tool/lint') + node("lint", "Tool", "machinery"),
    ),
    "S15": (
        node("deck", "TaskType", "instruction", '; cx:checkedBy cxi:gate/export') + node("export", "Gate", "machinery"),
        node("deck", "TaskType", "instruction", '; cx:checkedBy cxi:agent/builder') + node("builder", "Agent", "machinery"),
    ),
    "S16": (
        node("decks", "Route", "instruction", '; cx:triggers cxi:task/deck') + node("deck", "TaskType", "instruction"),
        node("stop", "Hook", "machinery", '; cx:triggers cxi:task/deck') + node("deck", "TaskType", "instruction"),
    ),
    "S17": (
        node("falcon", "Project", "work", '; cx:documentedIn cxi:backlog/falcon') + node("falcon", "BacklogSection", "record"),
        node("falcon", "Project", "work", '; cx:documentedIn cxi:agent/builder') + node("builder", "Agent", "machinery"),
    ),
    "S18": (
        node("a", "OpenItem", "record", '; cx:belongsTo cxi:backlog/falcon') + node("falcon", "BacklogSection", "record",
                                                                                      '; cx:belongsTo cxi:project/falcon') +
        node("falcon", "Project", "work"),
        node("a", "OpenItem", "record", '; cx:belongsTo cxi:project/falcon') + node("falcon", "Project", "work"),
    ),
    "S19": (
        node("falcon", "Concept", "language", '; cx:denotes cxi:project/falcon') + node("falcon", "Project", "work"),
        node("falcon", "Concept", "language", '; cx:denotes cxi:term/other') + node("other", "Concept", "language"),
    ),
    "S20": (
        node("decks", "RuleFile", "instruction", '; cx:contains cxi:section/decks-a') +
        node("decks-a", "Section", "instruction", '; cx:contains cxi:rule/decks-001') + node("decks-001", "Rule", "instruction"),
        node("lint", "Tool", "machinery", '; cx:contains cxi:rule/decks-001') + node("decks-001", "Rule", "instruction"),
    ),
    "S21": (
        node("d1", "Decision", "record", '; cx:governs cxi:rule/a') + node("a", "Rule", "instruction"),
        node("lint", "Tool", "machinery", '; cx:governs cxi:agent/builder') + node("builder", "Agent", "machinery"),
    ),
    "S22": (
        node("a", "Rule", "instruction", '; cx:conflictsWith cxi:rule/b') + node("b", "Rule", "instruction"),
        node("a", "GuideFile", "instruction", '; cx:conflictsWith cxi:guide/b') + node("b", "GuideFile", "instruction"),
    ),
    "S23": (
        node("a", "Rule", "instruction"),
        'cxi:rule/ghost cx:text "A node with no class." .\n',
    ),
    "S24": (
        node("d1", "Decision", "record", '; cx:date "2026-10-05"^^xsd:date ; cx:governs cxi:rule/a') + node("a", "Rule", "instruction"),
        node("d1", "Decision", "record", '; cx:governs cxi:rule/a') + node("a", "Rule", "instruction"),
    ),
    "S25": (
        node("c1", "Concept", "language", '; cx:inScheme cxi:scheme/s ; skos:definition "A definition."') + node("s", "ConceptScheme", "language"),
        node("c1", "Concept", "language", '; skos:definition "A definition."'),
    ),
    "S26": (
        node("i1", "OpenItem", "record", '; cx:belongsTo cxi:backlog/b ; cx:text "Do it."') + node("b", "BacklogSection", "record"),
        node("i1", "OpenItem", "record", '; cx:text "Do it."'),
    ),
}


@pytest.mark.parametrize("check", sorted(CASES))
def test_shape_passes_good_data_and_fails_bad_data(check, shapes, cortex):
    good, bad = CASES[check]
    assert check not in check_ids(good, shapes, cortex), f"{check} fired on the conforming graph"
    assert check in check_ids(bad, shapes, cortex), f"{check} did not fire on the failing graph"


def test_s02_checks_each_part(shapes, cortex):
    base = GOOD_RULE + node("writing-001", "Rule", "instruction", '; cx:text "A." ; cx:modal "must"')
    assert "S02" not in check_ids(base, shapes, cortex)
    blank = GOOD_RULE + node("writing-001", "Rule", "instruction", '; cx:text " " ; cx:modal "must"')
    assert "S02" in check_ids(blank, shapes, cortex)
    odd = GOOD_RULE + node("writing-001", "Rule", "instruction", '; cx:text "A." ; cx:modal "shall"')
    assert "S02" in check_ids(odd, shapes, cortex)
    twice = GOOD_RULE + node("other", "RuleFile", "instruction",
                                                                '; cx:contains cxi:rule/writing-001') + base
    assert "S02" in check_ids(twice, shapes, cortex)


def test_s01_rejects_a_sensitivity_outside_the_three(shapes, cortex):
    bad = ('cxi:rulefile/x a cx:RuleFile ; rdfs:label "x" ; cx:family "instruction" ; cx:sensitivity "secret" .\n')
    assert "S01" in check_ids(bad, shapes, cortex)


def test_s09_needs_one_preferred_label(shapes, cortex):
    none = node("x", "Concept", "language")
    assert "S09" in check_ids(none, shapes, cortex)


def test_s11_reports_a_rule_with_no_date(shapes, cortex):
    undated = node("a", "Rule", "instruction", '; cx:text "A." ; cx:modal "must"')
    dated = node("a", "Rule", "instruction", '; cx:text "A." ; cx:modal "must" ; cx:givenOn "2026-09-29"^^xsd:date')
    assert "S11" in check_ids(undated, shapes, cortex)
    assert "S11" not in check_ids(dated, shapes, cortex)


def test_s12_reports_a_node_with_no_family_or_the_wrong_one(shapes, cortex):
    none = 'cxi:rule/x a cx:Rule ; rdfs:label "x" ; cx:sensitivity "internal" .\n'
    assert "S12" in check_ids(none, shapes, cortex)
    assert "S01" in check_ids(none, shapes, cortex)  # S01 now targets every class, so it reaches a node that lost its family
    wrong = node("x", "Rule", "work")
    assert "S12" in check_ids(wrong, shapes, cortex)
    # a subclass is reached through its parent: MapFile belongs to the instruction family
    assert "S12" in check_ids(node("global", "MapFile", "record"), shapes, cortex)
    assert "S12" not in check_ids(node("global", "MapFile", "instruction"), shapes, cortex)


def test_s12_names_every_class(shapes, cortex):
    targets = {t for shape in shapes.subjects(CX.checkId, Literal("S12")) for t in shapes.objects(shape, SH.targetClass)}
    for cls in cortex.subjects(RDF.type, OWL.Class):
        if str(cls).startswith(str(CX)) and cls != CX.Finding:
            top = cls
            while (parent := next(cortex.objects(top, RDFS.subClassOf), None)) is not None and str(parent).startswith(str(CX)):
                top = parent
            assert top in targets, cls


def test_a_relation_shape_accepts_the_model_and_rejects_a_wrong_class(shapes, cortex):
    # a memory file is allowed as the first read of a task type, an open item belongs to a backlog section, and a gate invokes a tool
    ok = node("t", "TaskType", "instruction", '; cx:readsFirst cxi:memory/m') + node("m", "MemoryFile", "record")
    assert "S13" not in check_ids(ok, shapes, cortex)
    subject = node("t", "Agent", "machinery", '; cx:readsFirst cxi:memory/m') + node("m", "MemoryFile", "record")
    assert "S13" in check_ids(subject, shapes, cortex)  # the subject must be a task type
    inst = node("t", "TaskType", "instruction", '; cx:readsFirst cxi:skill/s') + node("s", "Skill", "instruction")
    assert "S13" not in check_ids(inst, shapes, cortex)  # a Skill is an instruction file through its parent class


def test_s01_does_not_target_the_ontology(shapes, cortex):
    _c, report, _t = validate(cortex, shacl_graph=shapes, ont_graph=cortex, inference="none", advanced=True)
    found = {str(v) for s in report.objects(None, SH.sourceShape) for v in shapes.objects(s, CX.checkId)}
    assert "S01" not in found


# ---- the vocabulary ----

REQUIRED = {"id", "prefLabel", "altLabels", "hiddenLabels", "definition", "denotes", "status", "ratified", "severity",
            "case", "source", "variant_counts"}
SCHEMES = {"entities", "house-phrases", "banned-words", "domain-terms"}


def load_vocab(folder: Path) -> dict[str, dict]:
    return {p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted(folder.glob("*.json"))}


@pytest.fixture(scope="module")
def vocab() -> dict[str, dict]:
    if not (PROFILE / "vocab").is_dir():
        pytest.skip("the owner's profile is not in this tree (the public export leaves it out)")
    return load_vocab(PROFILE / "vocab")


def test_the_four_schemes_load(vocab):
    assert set(vocab) == SCHEMES
    for stem, doc in vocab.items():
        assert doc["scheme"]["id"] == f"scheme:{stem}"
        assert doc["scheme"]["label"] and doc["scheme"]["description"]
        assert doc["concepts"], stem


def check_concept(c: dict) -> None:
    assert REQUIRED <= set(c), (c.get("id"), REQUIRED - set(c))
    assert c["id"].startswith("term:") and c["prefLabel"].strip()
    assert isinstance(c["altLabels"], list) and isinstance(c["hiddenLabels"], list) and isinstance(c["denotes"], list)
    assert all(isinstance(x, str) and x for x in c["altLabels"] + c["hiddenLabels"]), c["id"]
    assert c["definition"].strip() and c["source"]
    assert c["status"] in ("ratified", "proposed")
    # a ratified concept carries the date of ratification: 5 October 2026 for terms that restate an existing rule,
    # and a later date with a decided_by record for terms ratified by decision (6 October 2026 onwards)
    if c["status"] == "ratified":
        assert c["ratified"] == "2026-10-05" or (c["ratified"] >= "2026-10-06" and c.get("decided_by")), c["id"]
    else:
        assert c["ratified"] is None
    assert c["severity"] in ("warn", "fail") and c["case"] in ("sensitive", "insensitive")
    assert isinstance(c["variant_counts"], dict)
    assert c["severity"] != "fail" or c["status"] == "ratified", c["id"]


def test_every_concept_has_the_required_keys(vocab):
    for doc in vocab.values():
        for c in doc["concepts"]:
            check_concept(c)


def test_ids_are_unique_across_schemes(vocab):
    ids = [c["id"] for doc in vocab.values() for c in doc["concepts"]]
    assert len(ids) == len(set(ids)), sorted(i for i in set(ids) if ids.count(i) > 1)


def test_no_hidden_label_equals_a_preferred_or_accepted_label(vocab):
    accepted = {}
    for doc in vocab.values():
        for c in doc["concepts"]:
            for label in [c["prefLabel"], *c["altLabels"]]:
                accepted[label] = c["id"]
    clashes = [(c["id"], h, accepted[h]) for doc in vocab.values() for c in doc["concepts"]
               for h in c["hiddenLabels"] if h in accepted]
    assert not clashes, clashes


def test_ratified_concepts_name_their_rule(vocab):
    for doc in vocab.values():
        for c in doc["concepts"]:
            if c["status"] == "ratified":
                assert c.get("decided_by") or any(k in c["source"] for k in ("rules/", "output-styles/", "FCA_REGISTER", "hook.py")), c["id"]


def test_committed_vocabulary_holds_no_person(vocab):
    for doc in vocab.values():
        for c in doc["concepts"]:
            assert not any(d.startswith("person:") for d in c["denotes"]), c["id"]


def test_vocabulary_passes_s09_as_a_graph(vocab, shapes, cortex):
    g = Graph()
    for doc in vocab.values():
        for c in doc["concepts"]:
            s = URIRef("https://cortex.local/id/term/" + c["id"].split(":", 1)[1])
            g.add((s, RDF.type, CX.Concept))
            g.add((s, RDFS.label, Literal(c["prefLabel"])))
            g.add((s, CX.family, Literal("language")))
            g.add((s, CX.sensitivity, Literal("internal")))
            g.add((s, SKOS.prefLabel, Literal(c["prefLabel"])))
            for a in c["altLabels"]:
                g.add((s, SKOS.altLabel, Literal(a)))
            for h in c["hiddenLabels"]:
                g.add((s, SKOS.hiddenLabel, Literal(h)))
    _c, report, _t = validate(g, shacl_graph=shapes, ont_graph=cortex, inference="none", advanced=True)
    found = {str(v) for s in report.objects(None, SH.sourceShape) for v in shapes.objects(s, CX.checkId)}
    assert "S09" not in found and "S01" not in found


@pytest.mark.skipif(not (OVERLAY / "entities-private.json").is_file(), reason="the private overlay is machine-local")
def test_private_overlay_keeps_the_format_and_stays_distinct(vocab):
    private = json.loads((OVERLAY / "entities-private.json").read_text(encoding="utf-8"))
    assert private["scheme"]["id"] == "scheme:entities-private"
    committed_ids = {c["id"] for doc in vocab.values() for c in doc["concepts"]}
    accepted = {x for doc in vocab.values() for c in doc["concepts"] for x in [c["prefLabel"], *c["altLabels"]]}
    for c in private["concepts"]:
        check_concept(c)
        assert c["id"] not in committed_ids
        assert not set(c["hiddenLabels"]) & accepted


# ---- the ontology file against the restrictions of OWL 2 DL (6 October 2026) ----

OWL_KINDS = (OWL.Class, OWL.ObjectProperty, OWL.DatatypeProperty, OWL.AnnotationProperty)
RESTRICTED_TO_SIMPLE = (OWL.AsymmetricProperty, OWL.IrreflexiveProperty, OWL.FunctionalProperty, OWL.InverseFunctionalProperty)


def dl_problems(g: Graph) -> list[str]:
    """The structural restrictions of OWL 2 DL that apply to this file. It is not a classification by a reasoner."""
    from rdflib import BNode
    from rdflib.collection import Collection
    problems: list[str] = []
    kinds: dict = {}
    for kind in OWL_KINDS:
        for e in g.subjects(RDF.type, kind):
            if isinstance(e, URIRef):
                kinds.setdefault(e, set()).add(kind)
    for e, ks in kinds.items():
        if len(ks) > 1:
            problems.append(f"{e} is declared as more than one kind of entity")
    classes = {e for e, ks in kinds.items() if OWL.Class in ks} | {RDFS.Literal}

    def members(expr):
        yield expr
        if isinstance(expr, BNode):
            for lst in g.objects(expr, OWL.unionOf):
                yield from Collection(g, lst)

    # every predicate in the cx namespace is declared, and so is every class that a class axiom names
    for p in set(g.predicates()):
        if str(p).startswith(str(CX)) and p not in kinds:
            problems.append(f"the property {p} is used and not declared")
    for prop, kind in ((p, ks) for p, ks in kinds.items() if OWL.ObjectProperty in ks or OWL.DatatypeProperty in ks):
        for axiom in (RDFS.domain, RDFS.range):
            for expr in g.objects(prop, axiom):
                for part in members(expr):
                    if isinstance(part, URIRef):
                        if OWL.ObjectProperty in kind or axiom == RDFS.domain:
                            if part not in classes:
                                problems.append(f"{prop} {axiom} {part}, which is not a declared class")
                        elif not (str(part).startswith("http://www.w3.org/2001/XMLSchema#") or part in classes):
                            problems.append(f"{prop} has the range {part}, which is not a datatype")
                    elif OWL.Class not in set(g.objects(part, RDF.type)) and RDFS.Datatype not in set(g.objects(part, RDF.type)):
                        problems.append(f"{prop} {axiom} holds an expression that is not typed")
    for cls in [c for c in kinds if OWL.Class in kinds[c]]:
        for parent in g.objects(cls, RDFS.subClassOf):
            if isinstance(parent, URIRef) and parent not in classes:
                problems.append(f"{cls} is a subclass of {parent}, which is not a declared class")
    for dis in g.subjects(RDF.type, OWL.AllDisjointClasses):
        for lst in g.objects(dis, OWL.members):
            for member in Collection(g, lst):
                if member not in classes:
                    problems.append(f"{member} is disjoint and not a declared class")
    # the kind of a sub-property matches the kind of its parent
    for sub, sup in g.subject_objects(RDFS.subPropertyOf):
        if kinds.get(sub, set()) != kinds.get(sup, set()):
            problems.append(f"{sub} is a sub-property of {sup} of another kind")
    # a property that is transitive, or has a sub-property that is, is not simple, and the characteristics that need a
    # simple property are not allowed on it
    non_simple = set(g.subjects(RDF.type, OWL.TransitiveProperty)) | set(g.subjects(OWL.propertyChainAxiom, None))
    changed = True
    while changed:
        changed = False
        for sub, sup in g.subject_objects(RDFS.subPropertyOf):
            if sub in non_simple and sup not in non_simple:
                non_simple.add(sup)
                changed = True
    for kind in RESTRICTED_TO_SIMPLE:
        for prop in g.subjects(RDF.type, kind):
            if prop in non_simple:
                problems.append(f"{prop} is {kind} and not simple")
    return problems


def test_cortex_ttl_is_within_owl2_dl(cortex):
    assert dl_problems(cortex) == []


def test_the_dl_check_finds_what_it_is_meant_to_find(cortex):
    broken = Graph()
    broken += cortex
    broken.add((CX.family, RDF.type, OWL.AnnotationProperty))  # a property declared as 2 kinds, which was the fault of 5 October
    broken.add((CX.contains, RDFS.range, CX.Missing))
    broken.add((CX.supersedesChain, RDF.type, OWL.AsymmetricProperty))
    problems = " ".join(dl_problems(broken))
    assert "more than one kind" in problems and "Missing" in problems and "not simple" in problems


def test_the_ontology_has_a_version(cortex):
    ont = URIRef("https://cortex.local/ont")
    assert str(next(cortex.objects(ont, OWL.versionInfo))) == "0.2.0"
    assert str(next(cortex.objects(ont, OWL.versionIRI))) == "https://cortex.local/ont/0.2.0"


def test_the_classes_are_disjoint_except_parent_and_child(cortex):
    declared = {c for c in cortex.subjects(RDF.type, OWL.Class) if str(c).startswith(str(CX))}
    listed = set()
    from rdflib.collection import Collection
    for dis in cortex.subjects(RDF.type, OWL.AllDisjointClasses):
        for lst in cortex.objects(dis, OWL.members):
            listed |= set(Collection(cortex, lst))
    assert declared - listed == {CX.InstructionFile, CX.Client}


def _union_members(g, expr):
    from rdflib.collection import Collection
    if isinstance(expr, URIRef):
        return {expr}
    return set(Collection(g, next(g.objects(expr, OWL.unionOf))))


def test_domains_and_ranges_cover_the_relations_of_the_model(cortex):
    """The pairs of classes that the compiled graph held on 6 October 2026 (the rigour audit) all fall inside the axioms."""
    held = {
        "contains": [("Section", "Rule"), ("ReferenceFile", "Section"), ("Agent", "Section"), ("RecordStore", "Decision"),
                     ("Tool", "FaultCheck"), ("Skill", "ReferenceFile"), ("Skill", "GuideFile")],
        "readsFirst": [("TaskType", "MemoryFile"), ("TaskType", "Skill"), ("TaskType", "GuideFile")],
        "invokes": [("Hook", "Tool"), ("Gate", "Tool")],
        "belongsTo": [("OpenItem", "BacklogSection"), ("BacklogSection", "Project"), ("Deliverable", "Project")],
        "deliveredTo": [("Deliverable", "Client"), ("Project", "Organisation")],
        "documentedIn": [("Project", "MemoryFile"), ("Project", "HistoryFile")],
        "governs": [("Decision", "Rule"), ("Decision", "ReferenceFile"), ("Decision", "MemoryFile")],
        "checkedBy": [("TaskType", "Gate")],
        "appliesTo": [("RuleFile", "PathScope")],
    }
    subclass = {c: p for c, p in cortex.subject_objects(RDFS.subClassOf)}

    def covered(cls, allowed):
        node = CX[cls]
        while node is not None:
            if node in allowed:
                return True
            node = subclass.get(node)
        return False

    for rel, pairs in held.items():
        doms = {d for expr in cortex.objects(CX[rel], RDFS.domain) for d in _union_members(cortex, expr)}
        rngs = {r for expr in cortex.objects(CX[rel], RDFS.range) for r in _union_members(cortex, expr)}
        for dom, rng in pairs:
            assert covered(dom, doms), (rel, dom)
            assert covered(rng, rngs), (rel, rng)


def test_a_conflict_is_symmetric_and_a_supersession_is_asymmetric(cortex):
    assert (CX.conflictsWith, RDF.type, OWL.SymmetricProperty) in cortex
    assert (CX.supersedes, RDF.type, OWL.AsymmetricProperty) in cortex
    assert (CX.supersedes, RDFS.subPropertyOf, CX.supersedesChain) in cortex
    assert (CX.supersedesChain, RDF.type, OWL.TransitiveProperty) in cortex
    assert (CX.overrides, RDFS.subPropertyOf, CX.conflictsWith) in cortex


# ---- the saved queries and the named graphs of graph.trig ----

QUERIES = sorted((ONT / "queries").glob("*.rq"))
GRAPH = "https://cortex.local/graph/"


def test_every_saved_query_parses_and_uses_no_escaped_iri():
    from rdflib.plugins.sparql import prepareQuery
    assert len(QUERIES) == 10
    for q in QUERIES:
        text = q.read_text(encoding="utf-8")
        prepareQuery(text)
        assert "\\/" not in text, q.name


def _dataset(stated: str, ratified: str = "", proposed: str = "", inferred: str = ""):
    from rdflib import Dataset
    ds = Dataset(default_union=True)
    for name, ttl in (("stated", stated), ("ratified", ratified), ("proposed", proposed), ("inferred", inferred)):
        if ttl:
            ds.graph(URIRef(GRAPH + name)).parse(data=PREFIXES + ttl, format="turtle")
    return ds


def _rows(ds, name: str, var: str) -> set[str]:
    text = (ONT / "queries" / f"{name}.rq").read_text(encoding="utf-8")
    return {str(row[var]).rsplit("/id/", 1)[-1] for row in ds.query(text)}


def test_deck_query_leaves_out_superseded_retired_and_replaced_rules():
    stated = """
    <https://cortex.local/id/task/deck> a cx:TaskType ; cx:readsFirst <https://cortex.local/id/rulefile/decks> .
    <https://cortex.local/id/rulefile/decks> a cx:RuleFile ; cx:contains <https://cortex.local/id/rule/active> ,
        <https://cortex.local/id/rule/old> , <https://cortex.local/id/rule/gone> , <https://cortex.local/id/rule/replaced> ,
        <https://cortex.local/id/rule/pending> , <https://cortex.local/id/rule/newer> .
    <https://cortex.local/id/rule/active> a cx:Rule ; cx:text "Active." .
    <https://cortex.local/id/rule/old> a cx:Rule ; cx:text "Old." ; cx:status "superseded" .
    <https://cortex.local/id/rule/gone> a cx:Rule ; cx:text "Gone." ; cx:status "retired" .
    <https://cortex.local/id/rule/replaced> a cx:Rule ; cx:text "Replaced." .
    <https://cortex.local/id/rule/pending> a cx:Rule ; cx:text "Pending." .
    <https://cortex.local/id/rule/newer> a cx:Rule ; cx:text "Newer." ; cx:supersedes <https://cortex.local/id/rule/replaced> .
    """
    # a proposed supersession has not been reviewed, so it does not remove the rule
    proposed = "<https://cortex.local/id/rule/active> cx:supersedes <https://cortex.local/id/rule/pending> ."
    rows = _rows(_dataset(stated, proposed=proposed), "rules-for-deck-task", "rule")
    assert rows == {"rule/active", "rule/pending", "rule/newer"}


def test_deck_query_reads_the_inferred_graph():
    stated = '<https://cortex.local/id/rule/x> a cx:Rule ; cx:text "X." .'
    inferred = "<https://cortex.local/id/rule/x> cx:appliesToTask <https://cortex.local/id/task/deck> ."
    assert _rows(_dataset(stated, inferred=inferred), "rules-for-deck-task", "rule") == {"rule/x"}


def test_conflict_query_ignores_a_proposed_conflict_and_a_superseded_rule():
    stated = """
    <https://cortex.local/id/rule/a> a cx:Rule ; cx:text "A." ; cx:givenOn "2026-01-01"^^xsd:date .
    <https://cortex.local/id/rule/b> a cx:Rule ; cx:text "B." ; cx:givenOn "2026-02-01"^^xsd:date .
    <https://cortex.local/id/rule/c> a cx:Rule ; cx:text "C." ; cx:status "superseded" .
    <https://cortex.local/id/rule/d> a cx:Rule ; cx:text "D." .
    <https://cortex.local/id/rule/a> cx:conflictsWith <https://cortex.local/id/rule/b> , <https://cortex.local/id/rule/c> .
    """
    proposed = "<https://cortex.local/id/rule/a> cx:conflictsWith <https://cortex.local/id/rule/d> ."
    inferred = "<https://cortex.local/id/rule/b> cx:overrides <https://cortex.local/id/rule/a> ."
    ds = _dataset(stated, proposed=proposed, inferred=inferred)
    text = (ONT / "queries" / "conflicts-and-overrides.rq").read_text(encoding="utf-8")
    rows = [(str(r["ruleA"]).rsplit("/", 1)[-1], str(r["ruleB"]).rsplit("/", 1)[-1], str(r["overrides"]).rsplit("/", 1)[-1])
            for r in ds.query(text)]
    assert rows == [("a", "b", "b")]


def test_conflict_query_keeps_a_pair_of_guides_that_have_no_text():
    """standards-F06. A guide file has no cx:text, so a required text pattern dropped its pair."""
    stated = """
    <https://cortex.local/id/guide/a> a cx:GuideFile .
    <https://cortex.local/id/guide/b> a cx:GuideFile .
    <https://cortex.local/id/guide/a> cx:conflictsWith <https://cortex.local/id/guide/b> .
    """
    text = (ONT / "queries" / "conflicts-and-overrides.rq").read_text(encoding="utf-8")
    rows = [(str(r["ruleA"]).rsplit("/", 1)[-1], str(r["ruleB"]).rsplit("/", 1)[-1], r["textA"]) for r in _dataset(stated).query(text)]
    assert rows == [("a", "b", None)]


def test_deck_query_leaves_out_a_superseded_rule_that_the_inferred_graph_names():
    """standards-F05. The inferred branch has no status test of its own, so the filter after the union must reach it."""
    stated = """
    <https://cortex.local/id/rule/old> a cx:Rule ; cx:text "Old." ; cx:status "superseded" .
    <https://cortex.local/id/rule/live> a cx:Rule ; cx:text "Live." .
    """
    inferred = """
    <https://cortex.local/id/rule/old> cx:appliesToTask <https://cortex.local/id/task/deck> .
    <https://cortex.local/id/rule/live> cx:appliesToTask <https://cortex.local/id/task/deck> .
    """
    assert _rows(_dataset(stated, inferred=inferred), "rules-for-deck-task", "rule") == {"rule/live"}


# ---- shapes that reach a node that lost a property (rigour audit, standards-F02) ----

@pytest.mark.parametrize("missing", ["family", "sensitivity", "label"])
def test_s01_reports_a_typed_node_that_lost_one_of_its_three_properties(missing, shapes, cortex):
    parts = {"label": 'rdfs:label "scout"', "family": 'cx:family "machinery"', "sensitivity": 'cx:sensitivity "internal"'}
    kept = " ; ".join(v for k, v in parts.items() if k != missing)
    assert "S01" in check_ids(f"cxi:agent/scout a cx:Agent ; {kept} .\n", shapes, cortex)
    assert "S01" not in check_ids(node("scout", "Agent", "machinery"), shapes, cortex)


def test_s01_reaches_a_node_of_a_subclass(shapes, cortex):
    bare = 'cxi:mapfile/global a cx:MapFile ; rdfs:label "global" ; cx:sensitivity "internal" .\n'
    assert "S01" in check_ids(bare, shapes, cortex)


def test_relation_shapes_reject_the_audit_mutations(shapes, cortex):
    """A task that reads an organisation first, is handled by a hook and a belongsTo edge to a person all fail a shape."""
    bad = (node("deck", "TaskType", "instruction", '; cx:readsFirst cxi:org/orbit ; cx:handledBy cxi:hook/stop')
           + node("orbit", "Organisation", "world") + node("stop", "Hook", "machinery"))
    found = check_ids(bad, shapes, cortex)
    assert {"S13", "S14"} <= found
    item = node("i", "OpenItem", "record", '; cx:belongsTo cxi:person/p ; cx:text "x"') + node("p", "Person", "world")
    assert "S18" in check_ids(item, shapes, cortex)


def test_shapes_carry_a_version(shapes):
    ont = URIRef("https://cortex.local/shapes")
    assert str(next(shapes.objects(ont, OWL.versionInfo))) == "0.3.0"
    assert str(next(shapes.objects(ont, OWL.versionIRI))) == "https://cortex.local/shapes/0.3.0"


# ---- the axioms under a reasoner (rigour audit, standards-F01 and F08) ----

AGENT_ERROR = URIRef("http://www.daml.org/2002/03/agents/agent-ont#error")
ID = Namespace("https://cortex.local/id/")


def reasoner_errors(cortex: Graph, edges: list[tuple[str, str, str, str, str]]) -> list[str]:
    """Expand the ontology and the given edges under OWL 2 RL, and return the inconsistencies that owlrl reports.
    Each edge is (subject class, subject slug, relation, object class, object slug)."""
    import owlrl
    g = Graph()
    g += cortex
    for sc, ss, rel, oc, os_ in edges:
        g.add((ID[ss], RDF.type, CX[sc]))
        g.add((ID[os_], RDF.type, CX[oc]))
        g.add((ID[ss], CX[rel], ID[os_]))
    owlrl.DeductiveClosure(owlrl.OWLRL_Semantics).expand(g)
    return [str(o) for o in g.objects(None, AGENT_ERROR)]


# one edge for each relation, taken from the pairs of classes that the compiled graph held on 6 October 2026
HELD_EDGES = [
    ("Section", "s/a", "contains", "Rule", "r/a"), ("Skill", "k/a", "contains", "ReferenceFile", "f/a"),
    ("TaskType", "t/a", "readsFirst", "MemoryFile", "m/a"), ("TaskType", "t/b", "handledBy", "Agent", "a/a"),
    ("TaskType", "t/c", "checkedBy", "Gate", "g/a"), ("Route", "ro/a", "triggers", "TaskType", "t/d"),
    ("Hook", "h/a", "invokes", "Tool", "to/a"), ("Gate", "g/b", "invokes", "Tool", "to/b"),
    ("Decision", "d/a", "governs", "Rule", "r/b"), ("Project", "p/a", "documentedIn", "MemoryFile", "m/b"),
    ("OpenItem", "i/a", "belongsTo", "BacklogSection", "b/a"), ("BacklogSection", "b/b", "belongsTo", "Project", "p/b"),
    ("Deliverable", "dl/a", "deliveredTo", "Organisation", "o/a"), ("Project", "p/c", "deliveredTo", "Client", "c/a"),
    ("Rule", "r/c", "conflictsWith", "Rule", "r/d"), ("Rule", "r/e", "restates", "Rule", "r/f"),
    ("Concept", "c/b", "inScheme", "ConceptScheme", "sc/a"),
]


def test_the_held_edges_are_consistent_under_a_reasoner(cortex):
    assert reasoner_errors(cortex, HELD_EDGES) == []


def test_a_range_clash_is_an_inconsistency_under_a_reasoner(cortex):
    """A route that triggers a person gives the person the class TaskType, which the disjointness axiom forbids."""
    errors = reasoner_errors(cortex, [("Route", "ro/x", "triggers", "Person", "pe/x")])
    assert errors and "TaskType" in errors[0] and "Person" in errors[0]
    # org:orbit is an Organisation, so the delivery range Client would have clashed with the class Person or Project
    assert reasoner_errors(cortex, [("Deliverable", "dl/x", "deliveredTo", "Organisation", "o/orbit")]) == []


# ---- every saved query returns rows on a graph that holds what it asks for (rigour audit, standards-F12) ----

QUERY_FIXTURE = """
<https://cortex.local/id/task/deck> a cx:TaskType ; rdfs:label "deck" ; cx:readsFirst <https://cortex.local/id/rulefile/decks> ,
    <https://cortex.local/id/guide/read> ; cx:handledBy <https://cortex.local/id/agent/writer> .
<https://cortex.local/id/rulefile/decks> a cx:RuleFile ; rdfs:label "decks" ; cx:uses 3 ;
    cx:contains <https://cortex.local/id/section/decks-a> .
<https://cortex.local/id/section/decks-a> a cx:Section ; rdfs:label "A" ; cx:contains <https://cortex.local/id/rule/a> ,
    <https://cortex.local/id/rule/b> .
<https://cortex.local/id/rule/a> a cx:Rule ; rdfs:label "a" ; cx:text "A." ; cx:givenOn "2026-01-01"^^xsd:date ;
    cx:conflictsWith <https://cortex.local/id/rule/b> .
<https://cortex.local/id/rule/b> a cx:Rule ; rdfs:label "b" ; cx:text "B." ; cx:givenOn "2026-02-01"^^xsd:date .
<https://cortex.local/id/guide/read> a cx:GuideFile ; rdfs:label "read" .
<https://cortex.local/id/guide/lost> a cx:GuideFile ; rdfs:label "lost" .
<https://cortex.local/id/agent/writer> a cx:Agent ; rdfs:label "writer" ; cx:model "sonnet" .
<https://cortex.local/id/hook/stop> a cx:Hook ; rdfs:label "stop" ; cx:event "Stop" ; cx:invokes <https://cortex.local/id/tool/hook> .
<https://cortex.local/id/tool/hook> a cx:Tool ; rdfs:label "hook.py" .
<https://cortex.local/id/decision/d1> a cx:Decision ; rdfs:label "d1" ; cx:date "2026-10-05"^^xsd:date ;
    cx:governs <https://cortex.local/id/rule/a> .
<https://cortex.local/id/project/p> a cx:Project ; rdfs:label "p" ; cx:status "active" .
<https://cortex.local/id/term/t> a cx:Concept ; skos:prefLabel "robust" ; skos:hiddenLabel "strong" ; cx:severity "warn" .
"""
QUERY_INFERRED = "<https://cortex.local/id/rule/b> cx:overrides <https://cortex.local/id/rule/a> ; cx:appliesToTask <https://cortex.local/id/task/deck> ."


def test_every_saved_query_returns_rows_on_a_graph_that_holds_what_it_asks_for():
    """A query that returns nothing on data built for it is broken, whatever the real graph holds. The one exception is
    superseded-but-read-first, which lists a problem and has its own tests below."""
    ds = _dataset(QUERY_FIXTURE, inferred=QUERY_INFERRED)
    for q in QUERIES:
        rows = list(ds.query(q.read_text(encoding="utf-8")))
        if q.stem == "superseded-but-read-first":
            assert rows == []
        else:
            assert rows, f"{q.name} returned no row on a graph built for it"


SUPERSEDED = """
<https://cortex.local/id/task/deck> a cx:TaskType ; cx:readsFirst <https://cortex.local/id/rulefile/decks> .
<https://cortex.local/id/rulefile/decks> a cx:RuleFile ; cx:contains <https://cortex.local/id/section/decks-live> ,
    <https://cortex.local/id/section/decks-old> .
<https://cortex.local/id/section/decks-live> a cx:Section ; rdfs:label "Live rules" ; cx:contains <https://cortex.local/id/rule/stale> .
<https://cortex.local/id/section/decks-old> a cx:Section ; rdfs:label "Superseded rules" ; cx:contains <https://cortex.local/id/rule/kept> .
<https://cortex.local/id/rule/stale> a cx:Rule ; rdfs:label "stale" ; cx:status "superseded" .
<https://cortex.local/id/rule/kept> a cx:Rule ; rdfs:label "kept" ; cx:status "superseded" .
"""


def test_superseded_query_lists_a_stale_rule_and_leaves_out_the_archive_section():
    """Rule R09 and the audit agree that a superseded rule filed under a heading for superseded rules is kept on purpose."""
    assert _rows(_dataset(SUPERSEDED), "superseded-but-read-first", "superseded") == {"rule/stale"}


def test_saved_queries_write_every_iri_in_full():
    for q in QUERIES:
        text = q.read_text(encoding="utf-8")
        assert not re.search(r"\bcxi:[\w-]+\\?/", text), q.name
