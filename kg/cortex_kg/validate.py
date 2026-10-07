"""Validate the compiled graph: SHACL shapes through pySHACL, then the Python checks that SHACL cannot express.

The result is written to health.json in the shape of HealthFile in docs/CONTRACTS.md.
"""
from __future__ import annotations

import os
import re
import time
import warnings
from collections import Counter
from pathlib import Path

from .compile import atomic_write, load_module, read_json, write_json, _now_iso
from .config import Config, norm_path
from .md import normalise
from .model import Finding, slugify
from .rdf import CX, GRAPH_BASE, iri_to_id

SEVERITY_BY_IRI = {"Violation": "violation", "Warning": "warning", "Info": "info"}
FILE_CLASSES = {"MapFile", "RuleFile", "OutputStyle", "Skill", "ReferenceFile", "GuideFile"}
SCRIPT_RE = re.compile(r"""[^\s"'=;|&<>]+\.(?:py|js|mjs|cjs|sh|cmd|bat|ps1)\b""", re.IGNORECASE)


def _f(check, severity, message, node=None, evidence=None) -> dict:
    return {"check": check, "severity": severity, "message": message, "node": node, "evidence": evidence}


def _check_id(shapes, shape) -> str | None:
    """The cx:checkId of a shape, or of the node shape that holds it as a property shape."""
    val = shapes.value(shape, CX.checkId)
    if val is not None:
        return str(val)
    from rdflib.namespace import SH
    for parent in shapes.subjects(SH.property, shape):
        val = shapes.value(parent, CX.checkId)
        if val is not None:
            return str(val)
    return None


def load_asserted(cfg: Config):
    """The graph that the shapes read: the union of the stated and ratified graphs of graph.trig, so that a shape over a
    relation sees a ratified edge, which graph.ttl no longer holds. A proposed edge and an inferred edge are left out,
    because neither is asserted. Where graph.trig is missing the stated graph alone, graph.ttl, is read."""
    from rdflib import Dataset, Graph, URIRef
    trig, ttl = cfg.data_dir / "graph.trig", cfg.data_dir / "graph.ttl"
    if trig.is_file():
        ds = Dataset()
        with warnings.catch_warnings():  # the TriG parser of rdflib 7.6 builds a ConjunctiveGraph, which the library deprecated itself
            warnings.simplefilter("ignore", DeprecationWarning)
            ds.parse(trig, format="trig")
        data = Graph()
        for name in ("stated", "ratified"):
            for triple in ds.graph(URIRef(GRAPH_BASE + name)):
                data.add(triple)
        return data
    return Graph().parse(ttl, format="turtle") if ttl.is_file() else None


def _members(g, expr) -> set:
    """The classes named by a domain or a range: one class, or the members of an owl:unionOf."""
    from rdflib import BNode
    from rdflib.collection import Collection
    from rdflib.namespace import OWL
    if not isinstance(expr, BNode):
        return {expr}
    lst = g.value(expr, OWL.unionOf)
    return set(Collection(g, lst)) if lst is not None else set()


def _range_shaped(shapes) -> set:
    """The relations whose range a shape checks for every subject. A node shape with sh:targetSubjectsOf for the relation
    reaches every subject, and one of its property shapes, at any depth, must have the relation as its sh:path and a
    constraint on the class or node of the target (sh:class, sh:node, sh:or or sh:qualifiedValueShape)."""
    from rdflib import BNode
    from rdflib.namespace import SH
    kinds = (SH["class"], SH.node, SH["or"], SH.qualifiedValueShape)
    out = set()
    for shape in set(shapes.subjects(SH.targetSubjectsOf, None)):
        seen, todo = set(), [shape]
        while todo:
            node = todo.pop()
            if node in seen:
                continue
            seen.add(node)
            for _s, pred, obj in shapes.triples((node, None, None)):
                if isinstance(obj, BNode) or pred == SH.property:
                    todo.append(obj)
            path = shapes.value(node, SH.path)
            if path is not None and any((node, k, None) in shapes for k in kinds):
                if (shape, SH.targetSubjectsOf, path) in shapes:
                    out.add(path)
    return out


def check_domains_and_ranges(data, onto, shapes) -> list[dict]:
    """P09. A stated or ratified edge whose subject or object has a class outside the domain or range that cortex.ttl
    declares for its relation. OWL reads a domain as an inference, so a reasoner would give the node that class and hide the
    error, and this check reports it instead. The domain is always checked. The range is left out only for a relation
    whose shape constrains the class of its target for every subject (see _range_shaped), because a shape that only
    counts, such as S06 for invokes, does not check what the edge reaches."""
    from rdflib import Literal, URIRef
    from rdflib.namespace import OWL, RDF, RDFS
    if onto is None:
        return []
    range_shaped = _range_shaped(shapes) if shapes is not None else set()
    parents: dict = {}
    for child, parent in onto.subject_objects(RDFS.subClassOf):
        parents.setdefault(child, set()).add(parent)
    cache: dict = {}

    def classes_of(node):
        if node not in cache:
            seen, todo = set(), list(data.objects(node, RDF.type))
            while todo:
                c = todo.pop()
                if c not in seen:
                    seen.add(c)
                    todo.extend(parents.get(c, ()))
            cache[node] = seen
        return cache[node]

    def name(c):
        return str(c).rsplit("#", 1)[-1]

    out, seen_keys = [], set()
    props = [p for p in set(onto.subjects(RDF.type, OWL.ObjectProperty)) | set(onto.subjects(RDF.type, OWL.DatatypeProperty))
             if isinstance(p, URIRef)]
    for prop in sorted(props):
        doms = {c for e in onto.objects(prop, RDFS.domain) for c in _members(onto, e)}
        rngs = {c for e in onto.objects(prop, RDFS.range) for c in _members(onto, e)} if (prop, RDF.type, OWL.ObjectProperty) in onto else set()
        if not doms and not rngs:
            continue
        for s, _p, o in data.triples((None, prop, None)):
            if doms and not (classes_of(s) & doms):
                held = ", ".join(sorted(name(c) for c in classes_of(s) if str(c).startswith(str(CX)))) or "no class"
                key = (s, prop, "domain")
                if key not in seen_keys:
                    seen_keys.add(key)
                    out.append(_f("P09", "warning", f"The node {iri_to_id(s)} has the relation {name(prop)}, whose domain is "
                                  f"{' or '.join(sorted(name(c) for c in doms))}, but its class is {held}.", iri_to_id(s), name(prop)))
            if rngs and prop not in range_shaped and not isinstance(o, Literal) and not (classes_of(o) & rngs):
                held = ", ".join(sorted(name(c) for c in classes_of(o) if str(c).startswith(str(CX)))) or "no class"
                out.append(_f("P09", "warning", f"The relation {name(prop)} from {iri_to_id(s)} reaches {iri_to_id(o)}, whose class "
                              f"is {held}, but its range is {' or '.join(sorted(name(c) for c in rngs))}.", iri_to_id(s), name(prop)))
    return out


def run_shacl(cfg: Config, timing: dict) -> list[dict]:
    from rdflib import Graph
    from rdflib.namespace import RDF, SH
    ttl, shapes_path, onto_path = cfg.data_dir / "graph.ttl", cfg.ontology_dir / "shapes.ttl", cfg.ontology_dir / "cortex.ttl"
    if not ttl.is_file() and not (cfg.data_dir / "graph.trig").is_file():
        return [_f("B03", "violation", "The graph file graph.ttl does not exist, so run the build first.")]
    if not shapes_path.is_file():
        return [_f("B03", "warning", "The shapes file ontology/shapes.ttl does not exist, so the SHACL checks did not run.")]
    import pyshacl
    t0 = time.time()
    data = load_asserted(cfg)
    shapes = Graph().parse(shapes_path, format="turtle")
    onto = Graph().parse(onto_path, format="turtle") if onto_path.is_file() else None
    timing["load"] = time.time() - t0
    t1 = time.time()
    _conforms, report, _text = pyshacl.validate(data, shacl_graph=shapes, ont_graph=onto, inference="none",
                                                advanced=True, allow_warnings=True)
    timing["pyshacl"] = time.time() - t1
    out = []
    for res in report.subjects(RDF.type, SH.ValidationResult):
        sev_iri = report.value(res, SH.resultSeverity)
        severity = SEVERITY_BY_IRI.get(str(sev_iri).rsplit("#", 1)[-1], "violation")
        shape = report.value(res, SH.sourceShape)
        check = (_check_id(shapes, shape) if shape is not None else None) or "SHACL"
        focus = report.value(res, SH.focusNode)
        msg = report.value(res, SH.resultMessage)
        out.append(_f(check, severity, str(msg) if msg else "The node does not meet the shape.",
                      iri_to_id(focus) if focus is not None else None, str(report.value(res, SH.resultPath) or "") or None))
    out += check_domains_and_ranges(data, onto, shapes)
    out += check_s03(data, cfg.agent_model)
    return out


def check_s03(data, model: str | None) -> list[dict]:
    """S03. Every agent names exactly 1 model, and it is the model that the configuration key agent_model gives. The
    check is a Python check, because a SHACL shape cannot read the configuration. A null agent_model runs no check."""
    if not model or data is None:
        return []
    from rdflib.namespace import RDF
    out = []
    for agent in sorted(set(data.subjects(RDF.type, CX.Agent))):
        models = [str(m) for m in data.objects(agent, CX.model)]
        if len(models) != 1 or models[0] != model:
            out.append(_f("S03", "violation", f"Every agent must run on {model.capitalize()}.", iri_to_id(agent), str(CX.model)))
    return out


def _node_files(nodes):
    for n in nodes:
        if n.get("type") in FILE_CLASSES and n.get("path") and os.path.isfile(n["path"]):
            yield n


def check_p02(cfg: Config) -> list[dict]:
    """P02. Size limits on the map file, the memory index and each rule file, from the configuration key size_limits.
    A null size_limits runs no check, and a limit left out of the table is not checked."""
    limits = cfg.size_limits
    if not limits:
        return []
    out = []

    def lines(p):
        return len(p.read_text(encoding="utf-8", errors="replace").splitlines())

    cm = cfg.claude_home / "CLAUDE.md"
    lim = limits.get("claude_md_lines")
    if lim is not None and cm.is_file() and lines(cm) > lim:
        out.append(_f("P02", "warning", f"CLAUDE.md has {lines(cm)} lines, and the limit is {lim:,}.", "claudemd:global", str(cm)))
    mi = cfg.memory_dir / "MEMORY.md"
    if mi.is_file():
        size, n = mi.stat().st_size, lines(mi)
        lim = limits.get("memory_index_bytes")
        if lim is not None and size > lim:
            out.append(_f("P02", "warning", f"MEMORY.md is {size} bytes, and the limit is {lim:,}.", "record:memory-index", str(mi)))
        lim = limits.get("memory_index_lines")
        if lim is not None and n > lim:
            out.append(_f("P02", "warning", f"MEMORY.md has {n} lines, and the limit is {lim:,}.", "record:memory-index", str(mi)))
    rules = cfg.claude_home / "rules"
    lim = limits.get("rule_file_chars")
    if lim is not None and rules.is_dir():
        for p in sorted(rules.glob("*.md")):
            n = len(p.read_text(encoding="utf-8", errors="replace"))
            if n > lim:
                out.append(_f("P02", "warning", f"The rule file {p.name} has {n} characters, and the limit is {lim:,}.",
                              f"rulefile:{slugify(p.stem)}", str(p)))
    return out


def check_p03(nodes) -> list[dict]:
    out = []
    for n in nodes:
        if n.get("type") != "Route":
            continue
        props = n.get("props", {})
        pats = []
        for key in ("patterns", "pattern"):
            v = props.get(key) or []
            pats += [v] if isinstance(v, str) else list(v)
        for pat in pats:
            try:
                re.compile(pat)
            except re.error as exc:
                out.append(_f("P03", "violation", f"The route pattern {pat} does not compile: {exc}.", n["id"]))
    return out


def check_p04(nodes) -> list[dict]:
    # Rule files quote the forms they ban ('Status: done', "robust"), so code and quotations are removed first,
    # with the same cleaner the vocabulary check uses.
    try:
        from .lexicon import strip_text
    except Exception:  # noqa: BLE001
        def strip_text(t):
            return t
    texts = {}
    for n in _node_files(nodes):
        texts[n["id"]] = strip_text(Path(n["path"]).read_text(encoding="utf-8", errors="replace"))
    out = []
    for c in nodes:
        if c.get("type") != "Concept":
            continue
        props = c.get("props", {})
        ratified = (props.get("termStatus") or props.get("status") or c.get("status")) == "ratified"
        if not ratified:
            continue
        flags = 0 if props.get("case") == "sensitive" else re.IGNORECASE
        for hidden in props.get("hiddenLabels") or []:
            rx = re.compile(r"(?<!\w)" + re.escape(hidden) + r"(?!\w)", flags)
            hits = {nid: len(rx.findall(t)) for nid, t in texts.items()}
            hits = {k: v for k, v in hits.items() if v}
            if hits:
                total = sum(hits.values())
                out.append(_f("P04", "warning",
                              f"The form '{hidden}' of the term {c['label']} appears {total} times in {len(hits)} instruction files.",
                              c["id"], ", ".join(sorted(hits)[:5])))
    return out


def check_p06(cfg: Config, nodes) -> list[dict]:
    repo = norm_path(cfg.repo_root) + "/"
    return [_f("P06", "violation", f"The client-confidential node {n['id']} comes from a file inside the repository.", n["id"], n["path"])
            for n in nodes if n.get("sensitivity") == "client-confidential" and n.get("path")
            and norm_path(n["path"]).startswith(repo)]


def check_p07(cfg: Config, nodes, existing: list[dict]) -> list[dict]:
    reported = {f["node"] for f in existing if f["check"] == "P07"}
    home = os.path.expanduser("~")
    out = []
    for n in nodes:
        if n.get("type") != "Hook" or n["id"] in reported:
            continue
        cmd = n.get("props", {}).get("command") or ""
        for m in SCRIPT_RE.finditer(cmd):
            raw = m.group(0).replace("$HOME", home).replace("${HOME}", home).replace("%USERPROFILE%", home)
            raw = raw.replace("$CLAUDE_HOME", str(cfg.claude_home))
            p = Path(os.path.expanduser(raw))
            if not p.is_absolute():
                p = cfg.claude_home / p
            if not p.exists():
                out.append(_f("P07", "violation", f"The hook command names the script {m.group(0)}, which does not exist.", n["id"], cmd[:120]))
    return out


_EVIDENCE_LINE = re.compile(r"^(?P<path>.+?):(?P<start>\d+)(?:-(?P<end>\d+))?$")


def _evidence_roots(cfg: Config, node_id: str | None) -> list[Path]:
    """The folders that a relative evidence path may be counted from: the harvesters write it relative to the root of
    the file they read (the Claude folder, the Projects folder, the memory folder, the ontology and its vocabulary)."""
    roots = [cfg.claude_home, cfg.projects_root, cfg.memory_dir, cfg.repo_root, cfg.ontology_dir, cfg.ontology_dir / "vocab",
             cfg.memory_dir.parent, cfg.projects_root.parent, cfg.overlay_dir / "vocab"]
    if node_id and node_id.startswith("app:"):
        roots.insert(0, cfg.projects_root / (cfg.raw.get("apps_folder") or "apps") / node_id.split(":", 1)[1])
    return roots


def _exists(p: Path) -> bool:
    try:
        return p.exists()
    except (OSError, ValueError):  # free text that is not a legal path on this system
        return False


def _resolve_evidence(cfg: Config, raw: str, node_id: str | None) -> Path | None:
    p = Path(os.path.expanduser(raw))
    if p.is_absolute():
        return p if _exists(p) else None
    named = {"memory": cfg.memory_dir, "claude": cfg.claude_home, "projects": cfg.projects_root}
    if p.parts and p.parts[0] in named:  # the evidence format of md.evidence names its root as the first part
        rooted = named[p.parts[0]].joinpath(*p.parts[1:])
        if _exists(rooted):
            return rooted
    for root in _evidence_roots(cfg, node_id):
        if _exists(root / p):
            return root / p
    if len(p.parts) == 1:  # a curated assertion may name a file by its name alone
        for sub in ("rules", "skills", "agents", "tools", "output-styles"):
            base = cfg.claude_home / sub
            if base.is_dir():
                for hit in base.rglob(p.name):
                    return hit
        for hit in cfg.memory_dir.glob(p.name):
            return hit
    return None


def _alnum(text: str) -> str:
    return re.sub(r"[^0-9a-z]", "", normalise(text))


def check_p08(cfg: Config, nodes, edges) -> list[dict]:
    """The evidence of each node and of each edge names a file that exists and a line within it, and for a rule the
    line holds the text of the rule. An edge computed from file text (evidence beginning 'computed:') names no line."""
    cache: dict[Path, list[str]] = {}

    def lines_of(path: Path) -> list[str]:
        if path not in cache:
            cache[path] = path.read_bytes().decode("utf-8", errors="replace").splitlines()
        return cache[path]

    def problem(evidence: str, node_id: str | None, text: str | None) -> str | None:
        if evidence.startswith("computed"):
            return None
        if _resolve_evidence(cfg, evidence.strip(), node_id) is not None:  # a file name may hold a comma
            return None
        # a curated assertion may hold several sources, separated by 'and', a semicolon or a comma, with a note in brackets
        for part in re.split(r"\s*[;,]\s*|\s+and\s+",re.sub(r"\s\([^)]*\)(?=\s|[;,]|$)", " ", evidence)):
            part = part.strip()
            if not part or part.startswith("computed"):
                continue
            part = re.sub(r"^disk listing\s+|\s+[A-Z]\d+$", "", part)
            if not re.search(r"[/\\]|\.\w{1,5}(:\d|$)", part):  # a source such as 'Claude Code' is not a file
                continue
            m = _EVIDENCE_LINE.match(part)
            raw = m.group("path") if m else part
            found = _resolve_evidence(cfg, raw, node_id)
            if found is None:
                return f"names the file {raw}, which does not exist"
            if not m or not found.is_file():
                continue
            lines, start = lines_of(found), int(m.group("start"))
            if not 1 <= start <= len(lines):
                return f"names line {start} of {raw}, which has {len(lines)} lines"
            if text is not None:
                want, line = _alnum(text)[:15], _alnum(lines[start - 1])
                if want and not (line and (want in line or line[:15] in _alnum(text))):
                    return f"names line {start} of {raw}, which does not hold the text of the rule"
        return None

    out, seen = [], set()
    for n in nodes:
        ev = (n.get("props") or {}).get("evidence")
        if not ev:
            continue
        text = (n.get("props") or {}).get("text") if n.get("type") == "Rule" else None
        msg = problem(str(ev), n["id"], text)
        if msg:
            out.append(_f("P08", "warning", f"The evidence of the node {n['id']} {msg}.", n["id"], str(ev)))
    for e in edges or []:
        ev = e.get("evidence")
        if not ev:
            continue
        msg = problem(str(ev), e.get("s"), None)
        key = (e.get("s"), e.get("r"), e.get("t"), msg)
        if msg and key not in seen:
            seen.add(key)
            out.append(_f("P08", "warning", f"The evidence of the edge {e['s']} {e['r']} {e['t']} {msg}.", e.get("s"), str(ev)))
    return out


def _outside_home(cfg: Config, node: dict | None) -> bool:
    if not node or not node.get("path"):
        return False
    return not norm_path(node["path"]).startswith(norm_path(cfg.claude_home) + "/")


# In CI (python cortex.py check --ci --strict) only these checks fail the run. They cover what the repository
# itself holds: the ontology, the shapes, the harness mirror and its hooks. Findings about the content of the rules,
# such as a conflict between 2 rules (R04), are reported but are the owner's to settle and do not fail the run.
# B03 (the reasoning engine Nemo is missing) is a warning on a developer machine and a violation in CI, because a CI run
# that skips the rules would pass a graph that the rules never read (6 October 2026). S12 (the family of the class) and S23
# (a node with no class) block because the compiler guarantees them and a failure means that the graph is malformed.
CI_BLOCKING = {"S01", "S02", "S03", "S04", "S06", "S09", "S12", "S23", "P03", "P05", "P06", "P07", "B01", "B03"}

# the roots under ~/.claude that a CI machine has, through the installed harness mirror
_HOME_ROOTS = ("~/.claude", ".claude/", "rules/", "agents/", "skills/", "tools/", "output-styles/", "references/")
_RAW = re.compile(r"^The path (.+?) cited in ")
_CI_PREFIXES = ("claudemd", "rulefile", "outputstyle", "skill", "reference", "guide", "section", "rule", "route",
                "task", "scope", "agent", "hook", "tool", "gate", "fault", "schedule", "builtin", "term", "scheme")


def _counts_in_ci(f: dict) -> bool:
    """Whether a harvest finding concerns what a CI machine holds."""
    if f.get("check") == "P01":
        m = _RAW.match(f.get("message", ""))
        raw = m.group(1) if m else ""
        return raw.startswith(_HOME_ROOTS)
    if f.get("check") == "P05":
        # an assertion that names a project, client or app cannot apply without the memory and Projects folder
        missing = re.findall(r"the node ([\w:.-]+) does not exist", f.get("message", ""))
        return all(m.split(":", 1)[0] in _CI_PREFIXES for m in missing)
    return f.get("check") not in ("M01", "M02", "M03", "M04", "M05", "L01")


def ci_blocking(findings: list[dict]) -> list[dict]:
    """The violations that fail a CI run."""
    return [f for f in findings if f.get("severity") == "violation" and f.get("check") in CI_BLOCKING]


def check(cfg: Config, strict: bool = False, ci: bool = False) -> dict:
    cfg.ensure_data_dirs()
    timing: dict = {}
    t0 = time.time()
    graph = read_json(cfg.data_dir / "graph.json", {}) or {}
    nodes = graph.get("nodes", [])
    by_id = {n["id"]: n for n in nodes}

    findings = run_shacl(cfg, timing)
    harvest = read_json(cfg.data_dir / "findings.json", {}) or {}
    harvest_findings = harvest.get("findings", []) if isinstance(harvest, dict) else harvest
    if ci:  # a CI machine has no Projects folder and no memory, so findings about them are left out
        harvest_findings = [f for f in harvest_findings if _counts_in_ci(f)]
    findings += harvest_findings
    findings += check_p02(cfg) + check_p03(nodes) + check_p04(nodes)
    if ci:
        findings += check_p06(cfg, nodes)
        for f in findings:
            if f.get("check") == "B03":
                f["severity"] = "violation"
    else:  # the files that the evidence names are not in a CI checkout
        findings += check_p08(cfg, nodes, graph.get("edges", []))
    findings += check_p07(cfg, nodes, harvest_findings)

    counts = Counter(f["severity"] for f in findings)
    drift = None
    sync = load_module("sync")
    if sync is not None:
        try:
            drift = sync.doctor(cfg)
        except Exception:
            drift = None
    health = {"v": 1, "checked": _now_iso(),
              "counts": {k: counts.get(k, 0) for k in ("violation", "warning", "info")},
              "findings": findings, "drift": drift}
    write_json(cfg.data_dir / "health.json", health)
    timing["total"] = time.time() - t0
    health["_timing"] = {k: round(v, 2) for k, v in timing.items()}  # in the return value only, not in the file
    return health
