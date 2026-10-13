"""The local packs: a bank's obligation pack, loaded from a local folder that the configuration names.

The files belong to the bank. This module reads them from where they are kept, never copies them and holds none of their
content. The keys are pack_dir (a folder of .ttl modules) and pack_register (one .ttl file), each overridden by the environment
variables CORTEX_PACK_DIR and CORTEX_PACK_REGISTER (docs/CONTRACTS.md, 7 October 2026). With neither key set, load() reads
nothing and returns a result with loaded false.

The graph names a class by its local name, so the code reads a module under any base IRI. The chain profile gives each role
a class or relation, either as a local name under its base or as a full IRI. The committed default profile uses an invented
base, and a private profile points the same roles at the real IRIs.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from rdflib import BNode, Dataset, Graph, Literal, URIRef
from rdflib.namespace import OWL, RDF, RDFS

from . import model

PRIVATE_GRAPH = "https://cortex.local/graph/private-pack"
ORIGIN = "local-pack"
DEFAULT_BASE = "https://example.test/pack#"
CX = "https://cortex.local/ont#"

# The default profile of docs/CONTRACTS.md. ontology/defaults/pack_profile.json holds the same content when it exists.
DEFAULT_PROFILE: dict = {
    "v": 1, "name": "default", "base": DEFAULT_BASE,
    "classes": {"LegislativeProvision": "LegislativeProvision", "Obligation": "Obligation", "Permission": "Permission",
                "Prohibition": "Prohibition", "DeonticStatement": "DeonticStatement", "Policy": "Policy",
                "Standard": "Standard", "Procedure": "Procedure", "Guideline": "Guideline", "Control": "Control",
                "PolicyException": "PolicyException", "Role": "OrganisationalRole"},
    "relations": {"expressedIn": "expressedIn", "satisfies": "satisfies", "implementsClause": "implements",
                  "bearer": "bearer", "owner": "hasOwner", "effective_date": "effectiveDate"},
    "alignments": [["cx:Run", "Activity"], ["cx:Evidence", "Evidence"], ["cx:DeployedAgent", "Party"]],
}

# the role of a node, by the local name of its class, in the order that a node is classified. The id prefix is the role.
ROLES: list[tuple[str, tuple[str, ...]]] = [
    ("obligation", ("Obligation", "Permission", "Prohibition", "DeonticStatement", "RemediationObligation")),
    ("exception", ("PolicyException", "NormativeException")),
    ("control", ("Control",)),
    ("framework", ("ControlFramework", "FrameworkActivity")),
    ("policy", ("Policy", "Standard", "Procedure", "Guideline", "OrganisationalPolicy", "OrganisationalInstrument")),
    ("role", ("OrganisationalRole",)),
    ("provision", ("LegislativeProvision", "Regulation", "Article", "Paragraph", "RegulatoryGuidance", "GuidanceNote",
                   "Statute", "Directive", "Recital", "SupervisoryGuideline")),
]
ROLE_CLASS = {"obligation": "Obligation", "exception": "PolicyException", "control": "Control", "framework": "ControlFramework",
              "policy": "Policy", "role": "OrganisationalRole", "provision": "LegislativeProvision"}

# the properties that become props of a node, by local name
PROPS = {"nodeId": "node_id", "description": "description", "sourceRef": "source_ref", "partOf": "part_of",
         "eliUri": "eli_uri", "effectiveDate": "effective_date", "bearer": "bearer", "action": "action",
         "condition": "condition", "temporalWithin": "within", "deonticModality": "modality",
         "controlType": "control_type", "status": "pack_status"}
# the properties that become edges, by local name, when both ends are loaded
EDGES = {"expressedIn": "expressedIn", "satisfies": "satisfies", "hasOwner": "ownedBy", "policyOwner": "ownedBy"}

SKIP_MARKERS = ("shacl",)   # a shapes file is not instance data


def local_name(term) -> str:
    s = str(term)
    return re.split(r"[#/]", s.rstrip("#/"))[-1] if s else ""


# ---- the configuration keys ---------------------------------------------------------------------------------------------

@dataclass
class PackConfig:
    pack_dir: Path | None = None
    pack_register: Path | None = None
    pack_profile: Path | None = None

    @property
    def any(self) -> bool:
        return self.pack_dir is not None or self.pack_register is not None


def _opt(value) -> Path | None:
    return Path(str(value)).expanduser() if isinstance(value, (str, os.PathLike)) and str(value).strip() else None


def pack_config(cfg) -> PackConfig:
    """The keys of the local packs. An environment variable overrides the key, and a null or absent key means no pack."""
    raw = getattr(cfg, "raw", None) or {}
    env = os.environ
    return PackConfig(
        pack_dir=_opt(env.get("CORTEX_PACK_DIR") or raw.get("pack_dir")),
        pack_register=_opt(env.get("CORTEX_PACK_REGISTER") or raw.get("pack_register")),
        pack_profile=_opt(env.get("CORTEX_PACK_PROFILE") or raw.get("pack_profile")),
    )


# ---- the chain profile --------------------------------------------------------------------------------------------------

def load_profile(path: Path | None = None) -> dict:
    """The profile at path, or the committed default. The default file is read when it exists, else the embedded copy."""
    if path is not None and Path(path).is_file():
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    default = Path(__file__).resolve().parents[2] / "ontology" / "defaults" / "pack_profile.json"
    if default.is_file():
        return json.loads(default.read_text(encoding="utf-8-sig"))
    return json.loads(json.dumps(DEFAULT_PROFILE))


def resolve(profile: dict, value: str) -> str:
    """A profile value holds a full IRI or a local name under the base."""
    return value if ":" in value else str(profile.get("base", DEFAULT_BASE)) + value


def profile_from_graph(g: Graph, name: str = "derived") -> dict:
    """A profile whose roles point at the IRIs that g really uses, found by local name. It lets a private run retarget the
    shapes to a module set whose terms sit under several bases, and it names no IRI in this file."""
    seen: dict[str, str] = {}
    for s in set(g.subjects(RDF.type, OWL.Class)) | set(g.subjects(RDF.type, OWL.ObjectProperty)) | set(g.subjects(RDF.type, OWL.DatatypeProperty)):
        if isinstance(s, URIRef):
            seen.setdefault(local_name(s), str(s))
    classes = {k: seen.get(v, v) for k, v in DEFAULT_PROFILE["classes"].items()}
    relations = {k: seen.get(v, v) for k, v in DEFAULT_PROFILE["relations"].items()}
    return {"v": 1, "name": name, "base": DEFAULT_BASE, "classes": classes, "relations": relations,
            "alignments": DEFAULT_PROFILE["alignments"]}


def retarget_shapes(shapes: Graph, profile: dict) -> Graph:
    """A copy of the shapes with every term of the default base replaced by the IRI that the profile gives it. Shapes F01 name
    the bank side classes under the invented base, and this makes them read the real terms."""
    mapping: dict[str, str] = {}
    for table in ("classes", "relations"):
        for role, default_value in DEFAULT_PROFILE[table].items():
            target = profile.get(table, {}).get(role, default_value)
            mapping[DEFAULT_BASE + default_value] = resolve(profile, target)
    out = Graph()
    for prefix, ns in shapes.namespaces():
        out.bind(prefix, ns)
    for s, p, o in shapes:
        out.add((_swap(s, mapping), _swap(p, mapping), _swap(o, mapping)))
    # a list of sh:or members is made of blank nodes, which a triple by triple copy keeps as they are
    return out


def _swap(term, mapping: dict):
    return URIRef(mapping[str(term)]) if isinstance(term, URIRef) and str(term) in mapping else term


# ---- reading ------------------------------------------------------------------------------------------------------------

def _parse(g: Graph, path: Path) -> None:
    g.parse(str(path), format="turtle")


def _digest(path: Path) -> tuple[str, int]:
    data = Path(path).read_bytes()
    return hashlib.sha256(data).hexdigest(), len(data)


def _files(pc: PackConfig) -> tuple[list[tuple[str, Path]], list[str]]:
    files: list[tuple[str, Path]] = []
    warnings: list[str] = []
    if pc.pack_dir is not None:
        if pc.pack_dir.is_dir():
            for p in sorted(pc.pack_dir.glob("*.ttl")):
                if any(m in p.name.lower() for m in SKIP_MARKERS):
                    continue
                files.append(("pack_dir", p))
        else:
            warnings.append("pack_dir is not a folder")
    if pc.pack_register is not None:
        if pc.pack_register.is_file():
            files.append(("pack_register", pc.pack_register))
        else:
            warnings.append("pack_register is not a file")
    return files, warnings


def count_graph(g: Graph) -> dict:
    """The counts of a loaded graph: classes, properties, individuals, triples and the individuals of each class."""
    meta = (str(OWL), str(RDFS), "http://www.w3.org/ns/shacl#", "http://www.w3.org/1999/02/22-rdf-syntax-ns#")
    classes = {s for s in g.subjects(RDF.type, OWL.Class) if isinstance(s, URIRef)}
    props = {s for k in (OWL.ObjectProperty, OWL.DatatypeProperty, OWL.AnnotationProperty) for s in g.subjects(RDF.type, k)}
    by_type: dict[str, int] = {}
    individuals: set = set()
    for s, _p, o in g.triples((None, RDF.type, None)):
        if isinstance(s, BNode) or not isinstance(o, URIRef) or str(o).startswith(meta):
            continue
        individuals.add(s)
        name = local_name(o)
        by_type[name] = by_type.get(name, 0) + 1
    return {"triples": len(g), "classes": len(classes), "properties": len(props), "individuals": len(individuals),
            "by_type": dict(sorted(by_type.items(), key=lambda kv: (-kv[1], kv[0])))}


# ---- the nodes and edges ------------------------------------------------------------------------------------------------

def _role_of(g: Graph, s) -> tuple[str, str] | None:
    names = {local_name(o) for o in g.objects(s, RDF.type) if isinstance(o, URIRef)}
    for role, members in ROLES:
        for m in members:
            if m in names:
                return role, m
    return None


def _slug(iri: str) -> str:
    base = model.slugify(local_name(iri), 56) or "node"
    return f"{base}-{hashlib.sha1(iri.encode('utf-8')).hexdigest()[:6]}"


def to_nodes(g: Graph, source: str = "local-pack") -> tuple[list[dict], list[dict]]:
    """The graph as nodes and edges. Each node has the family obligation, the sensitivity internal and the origin local-pack, and
    its id is <role>:<slug>. An edge is kept when both ends are nodes. The nodes carry no text beyond what the pack holds."""
    ids: dict = {}
    nodes: list[dict] = []
    for s in sorted({s for s in g.subjects(RDF.type, None) if isinstance(s, URIRef)}, key=str):
        found = _role_of(g, s)
        if found is None:
            continue
        role, cls = found
        nid = f"{role}:{_slug(str(s))}"
        ids[s] = nid
        label = next((str(o) for o in g.objects(s, RDFS.label)), local_name(s))
        props: dict = {"origin": ORIGIN, "kind": cls, "iri": str(s)}
        for p, o in g.predicate_objects(s):
            key = PROPS.get(local_name(p)) if isinstance(p, URIRef) else None
            if key and isinstance(o, (Literal, URIRef)) and key not in props:
                props[key] = str(o) if isinstance(o, Literal) else local_name(o)
        nodes.append({"id": nid, "type": ROLE_CLASS[role], "label": label, "family": "obligation", "sensitivity": "internal",
                      "evidence": source, "props": props})
    edges: list[dict] = []
    for s, nid in ids.items():
        for p, o in g.predicate_objects(s):
            rel = EDGES.get(local_name(p)) if isinstance(p, URIRef) else None
            if rel and o in ids:
                edges.append({"s": nid, "r": rel, "t": ids[o], "status": "stated", "evidence": source})
    return nodes, edges


# ---- the load -----------------------------------------------------------------------------------------------------------

@dataclass
class PackResult:
    loaded: bool = False
    graph: Graph | None = None
    counts: dict = field(default_factory=dict)         # file name to its counts, and "total"
    sources: list[dict] = field(default_factory=list)  # key, file, sha256, bytes, counts (the manifest of CONTRACTS.md)
    nodes: list[dict] = field(default_factory=list)
    edges: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def load(cfg, dataset: Dataset | None = None, with_nodes: bool = True) -> PackResult:
    """Load the obligation pack modules and the register file into one private graph. With no key set, nothing is read. When a dataset is
    given the triples are also added to its named graph PRIVATE_GRAPH, which graph.trig keeps only when
    include_private_graphs is true."""
    pc = pack_config(cfg)
    if not pc.any:
        return PackResult()
    files, warnings = _files(pc)
    if not files:
        return PackResult(warnings=warnings or ["no pack file found"])
    g = Graph()
    sources: list[dict] = []
    for key, path in files:
        one = Graph()
        try:
            _parse(one, path)
        except Exception as exc:  # a file that does not parse is reported and the others still load
            warnings.append(f"{path.name} did not parse: {type(exc).__name__}")
            continue
        sha, size = _digest(path)
        sources.append({"key": key, "file": path.name, "sha256": sha, "bytes": size, "counts": count_graph(one)})
        g += one
    result = PackResult(loaded=bool(sources), graph=g, sources=sources, warnings=warnings,
                        counts={s["file"]: s["counts"] for s in sources})
    result.counts["total"] = count_graph(g)
    if dataset is not None:
        target = dataset.graph(URIRef(PRIVATE_GRAPH))
        target += g
    if with_nodes:
        result.nodes, result.edges = to_nodes(g)
    return result


def manifest(result: PackResult, built: str) -> dict:
    """The PackManifest of docs/CONTRACTS.md for the loaded sources. The reconciliation with the hub is left to the importer."""
    by_role: dict[str, int] = {}
    for n in result.nodes:
        role = n["id"].split(":", 1)[0]
        by_role[role] = by_role.get(role, 0) + 1
    return {"v": 1, "built": built, "sources": result.sources,
            "loaded": {"provisions": by_role.get("provision", 0), "obligations": by_role.get("obligation", 0),
                       "policies": by_role.get("policy", 0), "controls": by_role.get("control", 0), "terms": 0},
            "reconcile": {"matched": 0, "hub_only": 0, "register_only": 0, "row_count_differences": []},
            "warnings": list(result.warnings)}
