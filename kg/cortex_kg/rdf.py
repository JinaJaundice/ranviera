"""Turn the compiled nodes and edges into an rdflib graph or dataset, and read an instance IRI back to a node id."""
from __future__ import annotations

import warnings
from datetime import date
from pathlib import Path
from urllib.parse import quote, unquote

from rdflib import Dataset, Graph, Literal, Namespace, URIRef
from rdflib.namespace import PROV, RDF, RDFS, SKOS, XSD

from .model import CLASSES, Edge, Node, class_of, prefix_of

CX = Namespace("https://cortex.local/ont#")
CXI = Namespace("https://cortex.local/id/")
GRAPH_BASE = "https://cortex.local/graph/"
FINDING_BASE = "https://cortex.local/finding/"
ACTIVITY_BASE = "https://cortex.local/activity/"
GRAPH_NAMES = ("ontology", "stated", "ratified", "proposed", "inferred")
PRIVATE_GRAPH = "private-pack"   # the sixth named graph, written only when include_private_graphs is true
PRIVATE_ORIGIN = "local-pack"       # the origin of a node loaded from the local packs, which never reaches graph.ttl
LANG = "en-GB"  # the language tag on every SKOS label and definition

# datatype properties taken from the props of a node, with the kind of literal each one holds
PROP_KINDS = {
    "text": "string", "modal": "string", "givenOn": "date", "model": "string", "effort": "string",
    "event": "string", "matcher": "string", "command": "string", "pattern": "string",
    "memoryType": "string", "bytes": "integer", "indexed": "boolean", "async": "boolean",
    "fingerprint": "string", "tools": "string", "termStatus": "string", "severity": "string",
    # the agent side properties of docs/ONTOLOGY.md (7 October 2026)
    "caseRef": "string", "causalStatus": "string", "checksTicked": "string", "endedAt": "dateTime", "hash": "string",
    "inputHash": "string", "intendedUse": "string", "itemsViewed": "integer", "licence": "string", "modelId": "string",
    "ordinal": "integer", "outcome": "string", "outputHash": "string", "override": "boolean", "overrideReason": "string",
    "parameters": "string", "promptHash": "string", "provider": "string", "replayStatus": "string", "reviewer": "string",
    "riskTier": "string", "snapshotDate": "date", "snapshotHash": "string", "sourceHash": "string", "sourceRef": "string",
    "startedAt": "dateTime", "stepKind": "string", "ts": "dateTime", "validFrom": "date", "validTo": "date",
    "verdict": "string", "version": "string", "versionDate": "date",
    # the mapping and ledger properties of shapes F04 and F14 (12 October 2026)
    "sourceAnchor": "string", "targetAnchor": "string", "ratifiedOn": "date", "seq": "integer",
    "recordHash": "string", "prevHash": "string", "entryHash": "string",
}
# datatype properties taken from the fields of a node
FIELD_KINDS = {"status": "string", "path": "string", "date": "date", "summary": "string", "evidence": "string"}


def node_iri(node_id: str) -> URIRef:
    prefix, _, slug = node_id.partition(":")
    return URIRef(f"{CXI}{prefix}/{quote(slug, safe='-._~')}")


def iri_to_id(iri) -> str | None:
    """The inverse of node_iri, or None when the IRI is not an instance IRI."""
    s = str(iri)
    base = str(CXI)
    if not s.startswith(base):
        return None
    prefix, _, slug = s[len(base):].partition("/")
    return f"{prefix}:{unquote(slug)}"


def _literal(value, kind: str) -> Literal | None:
    if value is None or value == "":
        return None
    if kind == "integer":
        try:
            return Literal(int(value), datatype=XSD.integer)
        except (TypeError, ValueError):
            return Literal(str(value))
    if kind == "boolean":
        return Literal(bool(value), datatype=XSD.boolean)
    if kind == "dateTime":
        return Literal(str(value), datatype=XSD.dateTime)
    if kind == "date":
        s = str(value)
        if len(s) == 10 and s[4] == "-" and s[7] == "-":
            return Literal(s, datatype=XSD.date)
        return Literal(s)
    return Literal(str(value))


def _values(value) -> list:
    if isinstance(value, (list, tuple, set)):
        return list(value)
    return [value]


def _idle_days(last_used, today: str | None) -> int | None:
    """Whole days from the date of the last use to today, never below 0, or None when either date is unreadable."""
    try:
        last = date.fromisoformat(str(last_used)[:10])
        return max(0, (date.fromisoformat(today) - last).days) if today else None
    except (TypeError, ValueError):
        return None


def _edge_parts(e) -> tuple[str, str, str, str]:
    """(s, r, t, provenance) of an Edge object or of an edge row of graph.json. An Edge has no provenance, so it is stated."""
    if isinstance(e, dict):
        return e["s"], e["r"], e["t"], e.get("provenance") or ("inferred" if e.get("inferred") else "stated")
    return e.s, e.r, e.t, "stated"


def _origin(n) -> str | None:
    props = n.props if isinstance(n, Node) else (n.get("props") or {})
    return props.get("origin")


def split_private(nodes, edges) -> tuple[list, list, list, list]:
    """(public nodes, public edges, private nodes, private edges). A node whose origin is local-pack is private, and so is any
    edge with a private end. The nodes may be a dict by id or a list, and the edges Edge objects or edge rows."""
    node_list = list(nodes.values()) if isinstance(nodes, dict) else list(nodes)
    edge_list = list(edges.values()) if isinstance(edges, dict) else list(edges)
    hidden = {n.id for n in node_list if _origin(n) == PRIVATE_ORIGIN}
    pub_n = [n for n in node_list if n.id not in hidden]
    priv_n = [n for n in node_list if n.id in hidden]
    pub_e, priv_e = [], []
    for e in edge_list:
        s, _r, t, _p = _edge_parts(e)
        (priv_e if s in hidden or t in hidden else pub_e).append(e)
    return pub_n, pub_e, priv_n, priv_e


def _add_nodes(g: Graph, node_list: list[Node], metrics: dict | None, today: str | None) -> None:
    for n in node_list:
        s = node_iri(n.id)
        cls, family = class_of(n.id)
        g.add((s, RDF.type, CX[cls]))
        g.add((s, RDFS.label, Literal(n.label or n.id)))
        g.add((s, CX.family, Literal(family)))
        g.add((s, CX.sensitivity, Literal(n.sensitivity)))
        for field_name, kind in FIELD_KINDS.items():
            for v in _values(getattr(n, field_name, None)):
                lit = _literal(v, kind)
                if lit is not None:
                    g.add((s, CX[field_name], lit))
        for key, kind in PROP_KINDS.items():
            # the harvester stores route patterns under "patterns"; both keys give cx:pattern
            values = []
            aliases = (key, "patterns") if key == "pattern" else (key,)
            if key == "termStatus" and prefix_of(n.id) == "term":
                # the harvester keeps a concept's ratified or proposed state under props.status, and cx:status is the
                # node field, so the concept state is written as cx:termStatus
                aliases = ("termStatus", "status")
            for src in aliases:
                if src in n.props:
                    values += _values(n.props[src])
                    if key == "termStatus":
                        break
            for v in values:
                lit = _literal(v, kind)
                if lit is not None:
                    g.add((s, CX[key], lit))
        if prefix_of(n.id) == "rule" and n.date:
            # a rule's node date is the date the rule states it was given (md.given_date), which S11 reads as givenOn
            lit = _literal(n.date, "date")
            if lit is not None:
                g.add((s, CX.givenOn, lit))
        if metrics is not None:
            m = metrics.get(n.id) or {}
            g.add((s, CX.uses, Literal(int(m.get("uses") or 0), datatype=XSD.integer)))
            last = m.get("last_used")
            if last:
                g.add((s, CX.lastUsed, Literal(str(last), datatype=XSD.dateTime)))
                idle = _idle_days(last, today)
                if idle is not None:
                    g.add((s, CX.idleDays, Literal(idle, datatype=XSD.integer)))
        if prefix_of(n.id) == "scheme":
            g.add((s, RDF.type, SKOS.ConceptScheme))
        if prefix_of(n.id) == "term":
            g.add((s, RDF.type, SKOS.Concept))
            g.add((s, SKOS.prefLabel, Literal(n.label, lang=LANG)))
            for key, pred in (("altLabels", SKOS.altLabel), ("hiddenLabels", SKOS.hiddenLabel)):
                for v in n.props.get(key) or []:
                    g.add((s, pred, Literal(str(v), lang=LANG)))
            if n.props.get("definition"):
                g.add((s, SKOS.definition, Literal(str(n.props["definition"]), lang=LANG)))


def to_rdf(nodes: dict[str, Node] | list[Node], edges: list | dict, metrics: dict | None = None,
           today: str | None = None) -> Graph:
    """Build the stated graph: the nodes with their datatype properties, and the edges given. The nodes may be a dict
    by id or a list, and the edges a list or a dict, of Edge objects or edge rows. metrics maps a node id to
    {"uses", "last_used"} and, with today, gives each node cx:uses, cx:lastUsed and cx:idleDays."""
    g = Graph()
    g.bind("cx", CX)
    g.bind("cxi", CXI)
    g.bind("skos", SKOS)
    node_list = list(nodes.values()) if isinstance(nodes, dict) else list(nodes)
    edge_list = list(edges.values()) if isinstance(edges, dict) else list(edges)
    _add_nodes(g, node_list, metrics, today)
    for e in edge_list:
        s_id, r, t_id, _prov = _edge_parts(e)
        s, t = node_iri(s_id), node_iri(t_id)
        g.add((s, CX[r], t))
        if r == "inScheme":
            g.add((s, SKOS.inScheme, t))
            if prefix_of(s_id) == "term":
                # the vocabulary is flat, so each concept is a top concept of its scheme
                g.add((t, SKOS.hasTopConcept, s))
                g.add((s, SKOS.topConceptOf, t))
    return g


def finding_iri(f: dict, index: int) -> URIRef:
    return URIRef(f"{FINDING_BASE}{index:05d}-{quote(str(f.get('check') or 'x'), safe='')}")


def serialize_trig(ds: Dataset) -> str:
    """The TriG text of a dataset. rdflib 7.6 serialises through Dataset.contexts and default_context, which it has
    deprecated itself, so the warning is hidden here because the call is inside the library and cannot be changed.
    rdflib leaves out a named graph that holds no triple, so an empty block is written for each of the 5 graphs that
    is missing, and graph.trig lists all of them even when nothing has been ratified."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        text = ds.serialize(format="trig")
    for name in GRAPH_NAMES:
        iri = GRAPH_BASE + name
        if f"<{iri}> {{" not in text:
            text = text.rstrip("\n") + f"\n\n<{iri}> {{\n}}\n"
    return text


def _closure(ontology: Graph, predicate, start) -> set:
    """Every node reachable from start by repeated predicate steps in the ontology, start excluded."""
    seen, todo = set(), [start]
    while todo:
        for nxt in ontology.objects(todo.pop(), predicate):
            if isinstance(nxt, URIRef) and nxt not in seen and nxt != start:
                seen.add(nxt)
                todo.append(nxt)
    return seen


def entail(ontology: Graph, data: list, target: Graph) -> int:
    """Write the RDFS subclass and subproperty closure of the data into target, so that a query for a class such as
    cx:InstructionFile finds its subclasses and one for a relation finds its subproperties. Only supers in the cx and
    skos namespaces are added, and a triple that the data already holds is not repeated. Returns the number added."""
    keep = (str(CX), str(SKOS))
    sup_class: dict = {}
    sup_prop: dict = {}
    added = 0
    for g in data:
        for s, p, o in list(g):
            if p == RDF.type and isinstance(o, URIRef):
                if o not in sup_class:
                    sup_class[o] = _closure(ontology, RDFS.subClassOf, o)
                for sup in sup_class[o]:
                    if str(sup).startswith(keep) and (s, RDF.type, sup) not in target:
                        target.add((s, RDF.type, sup))
                        added += 1
            elif isinstance(o, URIRef) and str(o).startswith(str(CXI)):
                if p not in sup_prop:
                    sup_prop[p] = _closure(ontology, RDFS.subPropertyOf, p)
                for sup in sup_prop[p]:
                    if str(sup).startswith(keep) and (s, sup, o) not in target:
                        target.add((s, sup, o))
                        added += 1
    return added


def _describe_graphs(ds: Dataset, generated: dict) -> None:
    """Describe each named graph in the default graph with PROV-O: when it was generated and by which activity."""
    built, reasoned = generated.get("built"), generated.get("inferred_built")
    d = ds.default_graph
    build, reason = URIRef(ACTIVITY_BASE + "build"), URIRef(ACTIVITY_BASE + "reason")
    d.add((build, RDF.type, PROV.Activity))
    d.add((build, RDFS.label, Literal("Cortex build: harvest, resolve, restate and assert")))
    d.add((reason, RDF.type, PROV.Activity))
    d.add((reason, RDFS.label, Literal(str(generated.get("engine") or "Nemo rules over the stated and ratified graphs"))))
    if built:
        d.add((build, PROV.endedAtTime, Literal(str(built), datatype=XSD.dateTime)))
    if reasoned:
        d.add((reason, PROV.endedAtTime, Literal(str(reasoned), datatype=XSD.dateTime)))
    if generated.get("rules_sha256"):
        d.add((reason, RDFS.comment, Literal("The rule files have the SHA-256 hash " + str(generated["rules_sha256"]) + ".")))
    for name in GRAPH_NAMES:
        iri = URIRef(GRAPH_BASE + name)
        d.add((iri, RDF.type, PROV.Entity))
        d.add((iri, RDFS.label, Literal(name)))
        if name == "ontology":
            continue
        d.add((iri, PROV.wasGeneratedBy, reason if name == "inferred" else build))
        stamp = reasoned if name == "inferred" else built
        if stamp:
            d.add((iri, PROV.generatedAtTime, Literal(str(stamp), datatype=XSD.dateTime)))


def to_dataset(nodes: dict[str, Node] | list[Node], edges: list, inferred_edges: list | None = None,
               findings: list | None = None, ontology_path: Path | None = None, metrics: dict | None = None,
               today: str | None = None, generated: dict | None = None, include_private: bool = False) -> Dataset:
    """Build the RDF 1.1 dataset behind graph.trig, with the 5 named graphs of docs/CONTRACTS.md, and a sixth, private-pack,
    where include_private is true and the nodes hold any with the origin local-pack. Those nodes, the edges that touch them and
    the findings and inferred edges about them never enter the 5 public graphs, and are dropped when include_private is false. edges are edge rows
    with a provenance: stated and computed go to the stated graph, ratified and proposed to their own graphs. The rows
    marked inferred are ignored, because inferred_edges (the full output of the rules) fills the inferred graph, with
    one cx:Finding for each finding. The inferred graph also holds the RDFS subclass and subproperty closure of the
    stated, ratified and inferred graphs under the ontology, so that a query for a superclass finds its instances.
    generated (built, inferred_built, engine, rules_sha256) describes each graph in the default graph with PROV-O."""
    ds = Dataset()
    for prefix, ns in (("cx", CX), ("cxi", CXI), ("skos", SKOS), ("rdfs", RDFS), ("xsd", XSD), ("prov", PROV)):
        ds.bind(prefix, ns)
    graphs = {name: ds.graph(URIRef(GRAPH_BASE + name)) for name in GRAPH_NAMES}
    if ontology_path is not None and Path(ontology_path).is_file():
        graphs["ontology"].parse(str(ontology_path), format="turtle")
    nodes, edges, private_nodes, private_edges = split_private(nodes, edges)
    hidden = {n.id for n in private_nodes}
    private_inferred = [e for e in (inferred_edges or []) if _edge_parts(e)[0] in hidden or _edge_parts(e)[2] in hidden]
    inferred_edges = [e for e in (inferred_edges or []) if e not in private_inferred]
    private_findings = [f for f in (findings or []) if f.get("node") in hidden]
    findings = [f for f in (findings or []) if f.get("node") not in hidden]
    by_prov: dict[str, list] = {"stated": [], "ratified": [], "proposed": []}
    for e in edges:
        prov = _edge_parts(e)[3]
        if prov == "inferred":
            continue
        by_prov[prov if prov in ("ratified", "proposed") else "stated"].append(e)
    for t in to_rdf(nodes, by_prov["stated"], metrics, today):
        graphs["stated"].add(t)
    for name in ("ratified", "proposed"):
        for e in by_prov[name]:
            s, r, t, _p = _edge_parts(e)
            graphs[name].add((node_iri(s), CX[r], node_iri(t)))
    inferred = graphs["inferred"]
    for e in inferred_edges or []:
        s, r, t, _p = _edge_parts(e)
        inferred.add((node_iri(s), CX[r], node_iri(t)))
    for i, f in enumerate(findings or []):
        fi = finding_iri(f, i)
        inferred.add((fi, RDF.type, CX.Finding))
        inferred.add((fi, CX.checkId, Literal(str(f.get("check")))))
        inferred.add((fi, CX.findingSeverity, Literal(str(f.get("severity")))))
        inferred.add((fi, CX.message, Literal(str(f.get("message")))))
        if f.get("node"):
            inferred.add((fi, CX.onNode, node_iri(str(f["node"]))))
    if include_private and private_nodes:
        private = ds.graph(URIRef(GRAPH_BASE + PRIVATE_GRAPH))
        for t in to_rdf(private_nodes, private_edges, metrics, today):
            private.add(t)
        for n in private_nodes:
            private.add((node_iri(n.id), CX.origin, Literal(PRIVATE_ORIGIN)))
        for e in private_inferred:
            s, r, t, _p = _edge_parts(e)
            private.add((node_iri(s), CX[r], node_iri(t)))
        for i, f in enumerate(private_findings):
            fi = finding_iri(f, 100000 + i)
            private.add((fi, RDF.type, CX.Finding))
            private.add((fi, CX.checkId, Literal(str(f.get("check")))))
            private.add((fi, CX.findingSeverity, Literal(str(f.get("severity")))))
            private.add((fi, CX.message, Literal(str(f.get("message")))))
            private.add((fi, CX.onNode, node_iri(str(f["node"]))))
    if len(graphs["ontology"]):
        # proposed edges stay out of the closure, as they stay out of the rules
        entail(graphs["ontology"], [graphs["stated"], graphs["ratified"], graphs["inferred"]], inferred)
    if generated:
        _describe_graphs(ds, generated)
    return ds


__all__ = ["CX", "CXI", "GRAPH_BASE", "GRAPH_NAMES", "PRIVATE_GRAPH", "PRIVATE_ORIGIN", "split_private", "node_iri", "iri_to_id", "to_rdf", "to_dataset", "serialize_trig", "entail", "CLASSES"]
