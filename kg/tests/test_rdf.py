"""The RDF output: SKOS typing and language tags, the datatype properties of a node, and the named graphs of the dataset."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rdflib import Literal, URIRef  # noqa: E402
from rdflib.namespace import RDF, SKOS, XSD  # noqa: E402

from cortex_kg.model import Edge, Node  # noqa: E402
from cortex_kg.rdf import CX, GRAPH_BASE, GRAPH_NAMES, LANG, node_iri, serialize_trig, to_dataset, to_rdf  # noqa: E402


def sample_nodes():
    return [
        Node("scheme:house", "House vocabulary"),
        Node("term:answer-first", "Answer first", status="active",
             props={"termStatus": "ratified", "altLabels": ["lead with the answer"], "hiddenLabels": ["bottom line up front"],
                    "definition": "State the answer before the evidence."}),
        Node("agent:builder", "Builder", status="active", date="2026-09-01", props={"model": "sonnet"}),
    ]


def test_skos_is_typed_and_tagged_en_gb():
    g = to_rdf(sample_nodes(), [Edge("term:answer-first", "inScheme", "scheme:house")])
    term, scheme = node_iri("term:answer-first"), node_iri("scheme:house")
    assert (term, RDF.type, SKOS.Concept) in g and (scheme, RDF.type, SKOS.ConceptScheme) in g
    assert (term, SKOS.inScheme, scheme) in g
    assert LANG == "en-GB"
    for pred, text in ((SKOS.prefLabel, "Answer first"), (SKOS.altLabel, "lead with the answer"),
                       (SKOS.hiddenLabel, "bottom line up front"), (SKOS.definition, "State the answer before the evidence.")):
        assert (term, pred, Literal(text, lang="en-GB")) in g, pred
    assert (term, CX.termStatus, Literal("ratified")) in g
    assert (node_iri("agent:builder"), CX.status, Literal("active")) in g
    assert (node_iri("agent:builder"), CX.date, Literal("2026-09-01", datatype=XSD.date)) in g


def test_usage_properties_come_from_the_metrics_and_today():
    metrics = {"agent:builder": {"uses": 4, "last_used": "2026-10-01T09:30:00Z"}}
    g = to_rdf(sample_nodes(), [], metrics, "2026-10-06")
    s = node_iri("agent:builder")
    assert (s, CX.uses, Literal(4, datatype=XSD.integer)) in g
    assert (s, CX.lastUsed, Literal("2026-10-01T09:30:00Z", datatype=XSD.dateTime)) in g
    assert (s, CX.idleDays, Literal(5, datatype=XSD.integer)) in g
    # a node never used has zero uses and no last use
    t = node_iri("scheme:house")
    assert (t, CX.uses, Literal(0, datatype=XSD.integer)) in g
    assert not list(g.objects(t, CX.lastUsed)) and not list(g.objects(t, CX.idleDays))
    # without metrics no usage triple is written
    assert not list(to_rdf(sample_nodes(), []).objects(s, CX.uses))


def test_dataset_separates_the_provenance_of_each_edge(tmp_path):
    onto = tmp_path / "cortex.ttl"
    onto.write_text("@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<https://cortex.local/ont> a owl:Ontology .\n", encoding="utf-8")
    nodes = sample_nodes()
    rows = [
        {"s": "agent:builder", "r": "governs", "t": "scheme:house", "provenance": "stated"},
        {"s": "term:answer-first", "r": "restates", "t": "scheme:house", "provenance": "computed"},
        {"s": "term:answer-first", "r": "refersTo", "t": "agent:builder", "provenance": "ratified"},
        {"s": "scheme:house", "r": "refersTo", "t": "agent:builder", "provenance": "proposed"},
        {"s": "agent:builder", "r": "overrides", "t": "term:answer-first", "provenance": "inferred", "inferred": True},
    ]
    findings = [{"check": "R05", "severity": "warning", "message": "A rule has no source.", "node": "agent:builder"}]
    ds = to_dataset(nodes, rows, [{"s": "agent:builder", "r": "overrides", "t": "term:answer-first"}], findings, onto)
    graph = {n: ds.graph(URIRef(GRAPH_BASE + n)) for n in GRAPH_NAMES}
    b, t, s = node_iri("agent:builder"), node_iri("term:answer-first"), node_iri("scheme:house")
    assert (b, CX.governs, s) in graph["stated"] and (t, CX.restates, s) in graph["stated"]
    assert (t, CX.refersTo, b) in graph["ratified"] and (t, CX.refersTo, b) not in graph["stated"]
    assert (s, CX.refersTo, b) in graph["proposed"] and (s, CX.refersTo, b) not in graph["stated"]
    assert (b, CX.overrides, t) in graph["inferred"] and (b, CX.overrides, t) not in graph["stated"]
    assert (URIRef("https://cortex.local/ont"), RDF.type, URIRef("http://www.w3.org/2002/07/owl#Ontology")) in graph["ontology"]
    found = list(graph["inferred"].subjects(RDF.type, CX.Finding))
    assert len(found) == 1
    assert (found[0], CX.checkId, Literal("R05")) in graph["inferred"]
    assert (found[0], CX.findingSeverity, Literal("warning")) in graph["inferred"]
    assert (found[0], CX.message, Literal("A rule has no source.")) in graph["inferred"]
    assert (found[0], CX.onNode, b) in graph["inferred"]


def test_a_concept_state_kept_under_props_status_becomes_term_status():
    nodes = [Node("term:proposed-one", "Proposed one", props={"status": "proposed"}),
             Node("term:ratified-one", "Ratified one", props={"status": "ratified"}),
             Node("agent:builder", "Builder", status="active", props={"status": "ignored"})]
    g = to_rdf(nodes, [])
    assert list(g.objects(node_iri("term:ratified-one"), CX.termStatus)) == [Literal("ratified")]
    assert list(g.objects(node_iri("term:proposed-one"), CX.termStatus)) == [Literal("proposed")]
    # the node field cx:status is not borrowed for a concept, and a non-concept gets no termStatus
    assert not list(g.objects(node_iri("term:ratified-one"), CX.status))
    assert not list(g.objects(node_iri("agent:builder"), CX.termStatus))
    assert list(g.objects(node_iri("agent:builder"), CX.status)) == [Literal("active")]


def test_each_concept_is_a_top_concept_of_its_scheme():
    g = to_rdf(sample_nodes(), [Edge("term:answer-first", "inScheme", "scheme:house")])
    term, scheme = node_iri("term:answer-first"), node_iri("scheme:house")
    assert (scheme, SKOS.hasTopConcept, term) in g and (term, SKOS.topConceptOf, scheme) in g


ONTOLOGY = """@prefix cx: <https://cortex.local/ont#> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
cx:RuleFile rdfs:subClassOf cx:InstructionFile . cx:InstructionFile rdfs:subClassOf cx:File .
cx:overrides rdfs:subPropertyOf cx:conflictsWith .
"""


def test_the_inferred_graph_holds_the_subclass_and_subproperty_closure(tmp_path):
    onto = tmp_path / "cortex.ttl"
    onto.write_text(ONTOLOGY, encoding="utf-8")
    nodes = [Node("rulefile:a", "A"), Node("rulefile:b", "B")]
    rows = [{"s": "rulefile:a", "r": "overrides", "t": "rulefile:b", "provenance": "stated"},
            {"s": "rulefile:b", "r": "overrides", "t": "rulefile:a", "provenance": "proposed"}]
    ds = to_dataset(nodes, rows, [], [], onto)
    inferred = ds.graph(URIRef(GRAPH_BASE + "inferred"))
    a, b = node_iri("rulefile:a"), node_iri("rulefile:b")
    assert (a, RDF.type, CX.InstructionFile) in inferred and (a, RDF.type, CX.File) in inferred
    assert (a, CX.conflictsWith, b) in inferred
    # a proposed edge entails nothing, and the stated graph still holds only the leaf class
    assert (b, CX.conflictsWith, a) not in inferred
    assert (a, RDF.type, CX.InstructionFile) not in ds.graph(URIRef(GRAPH_BASE + "stated"))


def test_the_graphs_are_described_with_prov_and_trig_raises_no_deprecation_warning(tmp_path):
    import warnings
    from rdflib.namespace import PROV
    from cortex_kg.rdf import serialize_trig
    gen = {"built": "2026-10-06T10:00:00Z", "inferred_built": "2026-10-06T10:01:00Z", "rules_sha256": "abc"}
    ds = to_dataset(sample_nodes(), [], [], [], None, None, None, gen)
    inferred = URIRef(GRAPH_BASE + "inferred")
    assert (inferred, RDF.type, PROV.Entity) in ds.default_graph
    assert (inferred, PROV.generatedAtTime, Literal("2026-10-06T10:01:00Z", datatype=XSD.dateTime)) in ds.default_graph
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        assert "prov:generatedAtTime" in serialize_trig(ds)


def test_trig_lists_all_five_graphs_when_some_are_empty():
    """rdflib leaves out a graph with no triple, and the file must still name each of the 5 graphs."""
    text = serialize_trig(to_dataset(sample_nodes(), []))
    for name in GRAPH_NAMES:
        assert f"<{GRAPH_BASE}{name}> {{" in text
    assert text.count("<" + GRAPH_BASE + "ratified> {") == 1
