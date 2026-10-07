"""The node, edge and finding model shared by every harvester, the compiler and the validator.

The class and relation tables mirror docs/ONTOLOGY.md. A harvester returns one Harvest. The compiler merges the
harvests: where 2 harvests add the same node id, the first non-empty value of each field is kept and the props are
merged, so a harvester that knows more about a node should run first (see compile.HARVEST_ORDER).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict

# prefix -> (class, parent class, family)
CLASSES: dict[str, tuple[str, str | None, str]] = {
    "claudemd": ("MapFile", "InstructionFile", "instruction"),
    "rulefile": ("RuleFile", "InstructionFile", "instruction"),
    "outputstyle": ("OutputStyle", "InstructionFile", "instruction"),
    "skill": ("Skill", "InstructionFile", "instruction"),
    "reference": ("ReferenceFile", "InstructionFile", "instruction"),
    "guide": ("GuideFile", "InstructionFile", "instruction"),
    "section": ("Section", None, "instruction"),
    "rule": ("Rule", None, "instruction"),
    "route": ("Route", None, "instruction"),
    "task": ("TaskType", None, "instruction"),
    "scope": ("PathScope", None, "instruction"),
    "agent": ("Agent", None, "machinery"),
    "hook": ("Hook", None, "machinery"),
    "tool": ("Tool", None, "machinery"),
    "gate": ("Gate", None, "machinery"),
    "fault": ("FaultCheck", None, "machinery"),
    "schedule": ("ScheduledTask", None, "machinery"),
    "builtin": ("BuiltinTool", None, "machinery"),
    "launch": ("LaunchConfig", None, "machinery"),
    "record": ("RecordStore", None, "record"),
    "memory": ("MemoryFile", None, "record"),
    "backlog": ("BacklogSection", None, "record"),
    "openitem": ("OpenItem", None, "record"),
    "history": ("HistoryFile", None, "record"),
    "decision": ("Decision", None, "record"),
    "project": ("Project", None, "work"),
    "app": ("App", None, "work"),
    "deliverable": ("Deliverable", None, "work"),
    "template": ("Template", None, "work"),
    "folder": ("Folder", None, "work"),
    "org": ("Organisation", None, "world"),
    "client": ("Client", "Organisation", "world"),
    "person": ("Person", None, "world"),
    "instrument": ("Instrument", None, "world"),
    "scheme": ("ConceptScheme", None, "language"),
    "term": ("Concept", None, "language"),
}

CLASS_TO_PREFIX = {cls: prefix for prefix, (cls, _p, _f) in CLASSES.items()}

RELATIONS = (
    "contains", "triggers", "readsFirst", "handledBy", "checkedBy", "appliesTo", "loads", "invokes",
    "enforces", "restates", "supersedes", "conflictsWith", "governs", "refersTo", "mentions",
    "documentedIn", "belongsTo", "deliveredTo", "builtWith", "dependsOn", "locatedAt", "usesTemplate",
    "ownedBy", "linksTo", "indexes", "launches", "denotes", "inScheme",
    # inferred by the rules in ontology/rules/cortex.rls (docs/REASONING.md, 6 October 2026)
    "overrides", "supersedesChain", "appliesToTask",
)

SENSITIVITY = ("public", "internal", "client-confidential")
STATUS = ("active", "maintained", "parked", "blocked", "superseded", "archived", "retired")
MODALS = ("must", "should", "may", "will", "imperative", "none")
SEVERITY = ("violation", "warning", "info")

_SLUG = re.compile(r"[^a-z0-9]+")


def slugify(text: str, max_len: int = 64) -> str:
    """Lower case, every run of other characters becomes one hyphen, trimmed at a hyphen boundary."""
    s = _SLUG.sub("-", text.lower().replace("&", " and ")).strip("-")
    if len(s) > max_len:
        s = s[:max_len].rsplit("-", 1)[0]
    return s or "x"


def make_id(prefix: str, name: str) -> str:
    if prefix not in CLASSES:
        raise ValueError(f"unknown id prefix {prefix!r}")
    return f"{prefix}:{slugify(name)}"


def prefix_of(node_id: str) -> str:
    return node_id.split(":", 1)[0]


def class_of(node_id: str) -> tuple[str, str]:
    """Return (class, family) for an id from its prefix."""
    cls, _parent, family = CLASSES[prefix_of(node_id)]
    return cls, family


@dataclass
class Node:
    id: str
    label: str
    path: str | None = None
    summary: str | None = None
    date: str | None = None
    status: str | None = None
    sensitivity: str = "internal"
    props: dict = field(default_factory=dict)
    evidence: str | None = None

    @property
    def type(self) -> str:
        return class_of(self.id)[0]

    @property
    def family(self) -> str:
        return class_of(self.id)[1]

    def to_json(self) -> dict:
        d = asdict(self)
        d["type"] = self.type
        d["family"] = self.family
        return d


@dataclass
class Edge:
    s: str
    r: str
    t: str
    evidence: str | None = None

    def key(self) -> tuple[str, str, str]:
        return (self.s, self.r, self.t)


@dataclass
class Finding:
    check: str          # eg "P01" or "S03"
    severity: str       # violation, warning or info
    message: str        # one sentence in the house register
    node: str | None = None
    evidence: str | None = None


class Harvest:
    """What one harvester found. Node ids are unique within a harvest; edges are de-duplicated by key."""

    def __init__(self, area: str):
        self.area = area
        self.nodes: dict[str, Node] = {}
        self.edges: dict[tuple[str, str, str], Edge] = {}
        self.findings: list[Finding] = []
        # cited paths, resolved by the compiler into refersTo edges or P01 findings once every harvest is merged
        self.refs: list[Ref] = []
        # the text of each file a harvester read, keyed by node id, for vocabulary matching (mentions edges)
        self.texts: dict[str, str] = {}

    def add_node(self, node: Node) -> Node:
        if prefix_of(node.id) not in CLASSES:
            raise ValueError(f"unknown id prefix in {node.id!r}")
        if node.sensitivity not in SENSITIVITY:
            raise ValueError(f"bad sensitivity {node.sensitivity!r} on {node.id}")
        existing = self.nodes.get(node.id)
        if existing is None:
            self.nodes[node.id] = node
            return node
        merge_node(existing, node)
        return existing

    def add_edge(self, s: str, r: str, t: str, evidence: str | None = None) -> None:
        if r not in RELATIONS:
            raise ValueError(f"unknown relation {r!r}")
        if s == t:
            return
        self.edges.setdefault((s, r, t), Edge(s, r, t, evidence))

    def find(self, check: str, severity: str, message: str, node: str | None = None,
             evidence: str | None = None) -> None:
        if severity not in SEVERITY:
            raise ValueError(f"bad severity {severity!r}")
        self.findings.append(Finding(check, severity, message, node, evidence))

    def ref(self, source: str, raw: str, resolved: str | None, evidence: str | None,
            acknowledged_missing: bool = False, relation: str = "refersTo") -> None:
        """Record a cited path. resolved is the absolute path that exists, or None when no candidate exists."""
        self.refs.append(Ref(source, raw, resolved, evidence, acknowledged_missing, relation))

    def merge(self, other: "Harvest") -> None:
        for n in other.nodes.values():
            self.add_node(n)
        for e in other.edges.values():
            self.edges.setdefault(e.key(), e)
        self.findings.extend(other.findings)
        self.refs.extend(other.refs)
        for k, v in other.texts.items():
            self.texts.setdefault(k, v)


@dataclass
class Ref:
    source: str                 # the node id of the citing file, section or rule
    raw: str                    # the path as written
    resolved: str | None        # absolute path with forward slashes, or None when it does not exist
    evidence: str | None        # file:line
    acknowledged_missing: bool  # the text marks it [path not found]
    relation: str = "refersTo"   # the edge a resolved citation becomes (readsFirst for a routing table row)


_RANK = {s: i for i, s in enumerate(SENSITIVITY)}


def merge_node(into: Node, other: Node) -> None:
    """Keep the first non-empty value of each field, merge props, and keep the higher sensitivity."""
    for f in ("label", "path", "summary", "date", "status", "evidence"):
        if not getattr(into, f) and getattr(other, f):
            setattr(into, f, getattr(other, f))
    for k, v in other.props.items():
        into.props.setdefault(k, v)
    if _RANK[other.sensitivity] > _RANK[into.sensitivity]:
        into.sensitivity = other.sensitivity
