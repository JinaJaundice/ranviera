"""Build the graph: run the harvesters, resolve references, add vocabulary mentions and assertions, then write the
runtime files (graph.json, graph.ttl, findings.json, index.json and the day's change record) to the data folder."""
from __future__ import annotations

import hashlib
import importlib
import json
import math
import os
import re
import socket
import time
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

from .config import Config, assertion_folders, norm_path, weights_table
from .model import CLASSES, RELATIONS, SENSITIVITY, Edge, Finding, Harvest, Node, class_of, prefix_of, slugify

HARVEST_ORDER = ["vocab", "tasktypes", "harness", "skills", "memory", "projects"]
ALWAYS = ["claudemd:global"]   # the map file, which Claude Code reads in every session; see always_nodes()
FOLDER_PREFIXES = ("folder", "app", "skill")
DEFAULT_WEIGHT = 0.3
PROPOSED_FACTOR = 0.5  # a proposed assertion carries half the weight of its relation until it is ratified


# ---------------------------------------------------------------- helpers

def load_module(name: str):
    """Import cortex_kg.<name>, or return None when that module does not exist yet."""
    full = f"cortex_kg.{name}"
    try:
        return importlib.import_module(full)
    except ImportError as exc:
        if exc.name and (exc.name == full or full.startswith(exc.name + ".") or exc.name == "cortex_kg"):
            return None
        raise


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def write_json(path: Path, data) -> None:
    atomic_write(path, json.dumps(data, ensure_ascii=False, indent=1) + "\n")


def read_json(path: Path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _get(obj, key, default=None):
    return obj.get(key, default) if isinstance(obj, dict) else getattr(obj, key, default)


def _git_head(repo: Path) -> str | None:
    try:
        head = (repo / ".git" / "HEAD").read_text(encoding="utf-8").strip()
        if head.startswith("ref:"):
            return (repo / ".git" / head[5:].strip()).read_text(encoding="utf-8").strip()[:12]
        return head[:12]
    except OSError:
        return None


def _folder_of(node) -> str | None:
    """The folder a folder, app or skill node stands for, as a normalised path."""
    if not node.path:
        return None
    p = Path(node.path)
    if prefix_of(node.id) == "skill" and p.suffix:
        p = p.parent
    return norm_path(p)


# ---------------------------------------------------------------- the pieces of the build

def run_harvesters(cfg: Config, ledger, today: str) -> Harvest:
    merged = Harvest("all")
    for name in HARVEST_ORDER:
        try:
            mod = load_module(f"harvest.{name}")
            if mod is None:
                raise RuntimeError(f"the harvest.{name} module is not available yet")
            if name in ("harness", "skills"):
                h = mod.harvest(cfg, ledger, today)
            else:
                h = mod.harvest(cfg)
            merged.merge(h)
        except Exception as exc:  # a failed harvester must not stop the build
            merged.find("B01", "violation", f"The {name} harvester failed: {type(exc).__name__}: {exc}.", None, name)
    return merged


def seen_file_keys(nodes) -> set[str]:
    keys = set()
    for nid in nodes:
        if prefix_of(nid) == "rule":
            keys.add(nid.split(":", 1)[1].rsplit("-", 1)[0])
    return keys


def resolve_refs(h: Harvest, cfg: Config) -> None:
    exact: dict[str, str] = {}
    folders: dict[str, str] = {}
    for n in h.nodes.values():
        if not n.path:
            continue
        exact.setdefault(norm_path(n.path), n.id)
        if prefix_of(n.id) in FOLDER_PREFIXES:
            f = _folder_of(n)
            if f:
                folders.setdefault(f, n.id)
    ordered = sorted(folders.items(), key=lambda kv: len(kv[0]), reverse=True)
    for ref in h.refs:
        if ref.resolved:
            if ref.source not in h.nodes:
                continue
            p = norm_path(ref.resolved)
            target = exact.get(p)
            if target is None:
                for f, nid in ordered:
                    if p == f or p.startswith(f + "/"):
                        target = nid
                        break
            if target:
                h.add_edge(ref.source, ref.relation, target, ref.evidence)
        else:
            _second_pass(h, cfg, ref, exact, ordered)


def _second_pass(h: Harvest, cfg: Config, ref, exact: dict, ordered: list) -> None:
    """Classify a citation that the fixed candidates did not resolve, using the file index (paths.FileIndex).

    A token that is not a path is ignored. A file found where the citation's own folders say is a live match. A file
    found only by its name elsewhere is stale (moved), and one found only in an archive folder has been archived.
    What remains is missing: a violation when the citation starts at a known root, else a warning, because a bare or
    relative name may live outside the folders Cortex indexes.
    """
    from . import paths as P
    kind = P.classify(ref.raw)
    if kind == "not-a-path" or ref.source not in h.nodes:
        return
    hit, how = P.FileIndex.build(cfg).find(ref.raw)
    if hit and how == "live":
        p = norm_path(hit)
        target = exact.get(p) or next((nid for f, nid in ordered if p == f or p.startswith(f + "/")), None)
        if target:
            h.add_edge(ref.source, ref.relation, target, ref.evidence)
        return
    if hit and how in ("moved", "archive"):
        where = "an archive folder" if how == "archive" else "another folder"
        rel = hit.replace(str(cfg.projects_root).replace("\\", "/"), "Projects")
        rel = rel.replace(str(cfg.claude_home).replace("\\", "/"), "~/.claude")
        h.find("P01", "warning", f"The path {ref.raw} cited in {ref.evidence} has moved to {where}: {rel}.",
               ref.source, ref.evidence)
        return
    if ref.acknowledged_missing:
        sev = "info"
    else:
        sev = "violation" if kind == "anchored" else "warning"
    h.find("P01", sev, f"The path {ref.raw} cited in {ref.evidence} does not exist.", ref.source, ref.evidence)


def _compile_regex(rx):
    """Patterns carry their own case rule ((?i:...) for case-insensitive concepts), so no flag is added here."""
    if hasattr(rx, "search"):
        return rx
    return re.compile(rx)


def add_mentions(h: Harvest, cfg: Config):
    """Add mentions edges from the vocabulary patterns. Returns the pattern list for the index."""
    vocab = load_module("harvest.vocab")
    if vocab is None:
        return []
    concepts = vocab.load(cfg)
    triples = list(vocab.patterns(concepts))
    compiled = []
    for concept, rx, denotes in triples:
        cid = concept if isinstance(concept, str) else _get(concept, "id")
        try:
            compiled.append((cid, _compile_regex(rx), list(denotes or [])))
        except re.error as exc:
            h.find("P03", "violation", f"The vocabulary pattern for {cid} does not compile: {exc}.", cid, None)
    for node_id, text in h.texts.items():
        if node_id not in h.nodes or not text:
            continue
        for cid, rx, denotes in compiled:
            if node_id in denotes or cid == node_id:
                continue
            if rx.search(text):
                h.add_edge(node_id, "mentions", cid, None)
    return compiled


def load_assertions(cfg: Config) -> list[tuple[dict, str]]:
    out = []
    for folder in assertion_folders(cfg):
        if not folder.is_dir():
            continue
        for f in sorted(folder.glob("*.json")):
            data = read_json(f, {})
            items = data.get("assertions", []) if isinstance(data, dict) else []
            out.extend((a, f.name) for a in items)
    return out


def apply_assertions(h: Harvest, cfg: Config) -> None:
    """Add the curated edges. h.assertion_status records "ratified" or "proposed" for each edge that an assertion added,
    and an edge a harvester already stated keeps no assertion status."""
    if not hasattr(h, "assertion_status"):
        h.assertion_status = {}
    if not hasattr(h, "assertion_by"):
        h.assertion_by = {}
    proposed_in: dict[str, list[str]] = defaultdict(list)
    for a, fname in load_assertions(cfg):
        if a.get("status") == "rejected":  # kept in its file as the record of a review, and never applied
            continue
        s, r, t = a.get("s"), a.get("r"), a.get("t")
        ev = a.get("evidence")
        bad = None
        for end in (s, t):
            node = h.nodes.get(end)
            if node is None:
                bad = f"the node {end} does not exist"
            elif prefix_of(end) == "rule" and node.status == "retired":
                bad = f"the rule {end} is retired"
        if r not in RELATIONS:
            bad = f"the relation {r} is not defined"
        if bad:
            h.find("P05", "violation", f"The assertion {s} {r} {t} in {fname} cannot apply because {bad}.", s, ev)
            continue
        is_new = (s, r, t) not in h.edges and s != t
        if a.get("status") != "ratified":
            proposed_in[fname].append(r)  # the file holds the assertion whether or not a harvester stated the edge too
        h.add_edge(s, r, t, ev or f"assertion {a.get('status', 'proposed')} by {a.get('by', 'unknown')} on {a.get('date', '')}".strip())
        if is_new:
            h.assertion_status[(s, r, t)] = "ratified" if a.get("status") == "ratified" else "proposed"
            h.assertion_by[(s, r, t)] = str(a.get("by") or "unknown")
    for fname, rels in sorted(proposed_in.items()):
        kinds = ", ".join(f"{n} {r}" for r, n in sorted(Counter(rels).items()))
        h.find("P10", "warning", f"The assertion file {fname} holds {len(rels)} proposed assertions that nobody has reviewed ({kinds}). "
               f"Each is drawn at half weight and stays out of the rules until it is ratified.", None, fname)


# ---------------------------------------------------------------- the transparency stage

PRIVATE_ORIGIN = "local-pack"


def add_parts(h: Harvest, nodes: list[dict], edges: list[dict], source: str, private: bool = False) -> int:
    """Merge the dict nodes and edges of a transparency module into the harvest as Node and edge objects, and return the
    number of nodes added. A node whose id prefix is unknown or whose sensitivity is not allowed is reported (B08) and left
    out, and so is an edge whose relation is unknown. The class comes from the id prefix, so a different 'type' is reported
    and ignored. A private node carries the origin local-pack and at least the sensitivity internal."""
    added = 0
    for d in nodes:
        nid = str(d.get("id") or "")
        if prefix_of(nid) not in CLASSES:
            h.find("B08", "warning", f"A node of {source} was left out because its identifier {nid} has no known prefix.", None, source)
            continue
        if d.get("type") not in (None, class_of(nid)[0]):
            h.find("B08", "warning", f"The node {nid} of {source} names the class {d.get('type')}, and its prefix gives {class_of(nid)[0]}, so the prefix was used.", nid, source)
        sens = d.get("sensitivity") or "internal"
        if sens not in SENSITIVITY:
            h.find("B08", "warning", f"The node {nid} of {source} has the sensitivity {sens}, which is not allowed, so it was left out.", nid, source)
            continue
        props = dict(d.get("props") or {})
        if private:
            props["origin"] = PRIVATE_ORIGIN
            sens = sens if sens != "public" else "internal"
        h.add_node(Node(nid, str(d.get("label") or nid), d.get("path"), d.get("summary"), d.get("date"),
                        d.get("status"), sens, props, d.get("evidence")))
        added += 1
    for e in edges:
        try:
            h.add_edge(e["s"], e["r"], e["t"], e.get("evidence"))
        except (KeyError, ValueError) as exc:
            h.find("B08", "warning", f"An edge of {source} was left out: {exc}.", None, source)
    return added


def ledger_parts(h: Harvest, cfg: Config, run_ids: dict[str, str]) -> int:
    """One LedgerEntry node for each entry of the run ledger that belongs to a run, with an entryOf edge to the run node
    (shape F14). An entry with no run, such as an instruction approval or a mapping ratification, gets no node. A ledger that
    cannot be read gives B08 and no node."""
    from .runledger import RunLedger
    try:
        entries = RunLedger(cfg.data_dir).entries()
    except (OSError, ValueError, KeyError) as exc:
        h.find("B08", "warning", f"The run ledger could not be read, so no ledger entry was added: {exc}", None, "ledger")
        return 0
    nodes, edges = [], []
    for e in entries:
        rid = run_ids.get(str(e.get("run") or ""))
        if not rid or not isinstance(e.get("seq"), int):
            continue
        lid = f"ledger:{e['seq']:06d}"
        ev = f"ledger/{str(e.get('ts') or '')[:7]}.jsonl"
        nodes.append({"id": lid, "type": "LedgerEntry", "label": f"Ledger entry {e['seq']}", "evidence": ev,
                      "sensitivity": "internal",
                      "props": {"seq": e["seq"], "recordHash": e.get("record_hash"), "prevHash": e.get("prev_hash"),
                                "entryHash": e.get("entry_hash")}})
        edges.append({"s": lid, "r": "entryOf", "t": rid, "evidence": ev})
    return add_parts(h, nodes, edges, "ledger")


def transparency_stage(h: Harvest, cfg: Config) -> dict:
    """Merge the agent transparency parts into the harvest: the mappings of the profile, the runs ingested into
    <data_dir>/runs, the saved legislation provisions (public, Open Government Licence text) and, only where
    include_private_graphs is true and a pack key is set, the nodes of the local obligation packs, which carry the origin
    local-pack and are routed to the private graph by rdf.split_private. A mapping edge takes the provenance of its status
    (proposed or ratified), so that the rules read only the ratified links (rule O01)."""
    from . import mappings
    from .importers import legislation
    if not hasattr(h, "assertion_status"):
        h.assertion_status = {}
    if not hasattr(h, "assertion_by"):
        h.assertion_by = {}
    counts = {"mappings": 0, "instructions": 0, "policy": 0, "runs": 0, "ledger": 0, "provisions": 0, "private": 0}
    try:
        nodes, edges = mappings.graph_parts(cfg.profile_dir)
    except (mappings.MappingError, OSError, ValueError, KeyError) as exc:
        h.find("B08", "warning", f"The mapping files could not be read, so no mapping was added: {exc}", None, "mappings")
        nodes, edges = [], []
    counts["mappings"] = add_parts(h, nodes, [], "mappings")
    by_id = {n["id"]: n for n in nodes}
    mapping_nodes = nodes
    for e in edges:
        key = (e["s"], e["r"], e["t"])
        is_new = key not in h.edges and e["s"] != e["t"]
        add_parts(h, [], [e], "mappings")
        if is_new and key in h.edges:
            m = (by_id.get(e.get("mapping")) or {}).get("props") or {}
            h.assertion_status[key] = e["provenance"]
            h.assertion_by[key] = str((m.get("checker") if e["provenance"] == "ratified" else m.get("maker")) or "unknown")
    # the instruction store of each deployed agent (docs/CONTRACTS.md, "The instruction store"): its versions, approvals,
    # people and approved models are stated content, because each approval already passed the maker and checker test
    people, edges = mappings.person_parts(mapping_nodes)
    counts["mappings"] += add_parts(h, people, edges, "mappings")
    from . import instructions
    try:
        nodes, edges = instructions.graph_parts(cfg.profile_dir)
    except (instructions.InstructionError, OSError, ValueError, KeyError) as exc:
        h.find("B08", "warning", f"The instruction store could not be read, so no instruction version was added: {exc}", None, "instructions")
        nodes, edges = [], []
    counts["instructions"] = add_parts(h, nodes, edges, "instructions")
    # the policy pack of the bank (docs/CONTRACTS.md, "The policy pack"): clauses, controls, obligations, provisions and
    # typologies as stated content. A file that breaks the contract is left out whole and reported as B08.
    from . import policypack
    pack_problems: list[str] = []
    try:
        nodes, edges = policypack.graph_parts(cfg.profile_dir, pack_problems)
    except (OSError, ValueError, KeyError) as exc:
        pack_problems.append(f"The policy pack could not be read, so no pack node was added: {exc}")
        nodes, edges = [], []
    for msg in pack_problems:
        h.find("B08", "warning", msg, None, "policy")
    counts["policy"] = add_parts(h, nodes, edges, "policy")
    runs = cfg.data_dir / "runs"
    run_ids: dict[str, str] = {}   # the run name of the ledger (AT-0001) -> the run node (run:alert-triage-at-0001)
    for f in sorted(runs.glob("*.json")) if runs.is_dir() else []:
        data = read_json(f, None)
        if not isinstance(data, dict):
            h.find("B08", "warning", f"The run file {f.name} could not be read, so it was left out.", None, f.name)
            continue
        counts["runs"] += add_parts(h, data.get("nodes", []), data.get("edges", []), f"runs/{f.name}")
        for n in data.get("nodes", []):
            if n.get("type") == "Run" and str(n.get("evidence") or "").startswith("run:"):
                run_ids[str(n["evidence"])[4:].split("#")[0]] = n["id"]
    counts["ledger"] = ledger_parts(h, cfg, run_ids)
    folder = cfg.data_dir / "imports" / "legislation"
    stems = [p.name[:-len(".provisions.json")] for p in sorted(folder.glob("*.provisions.json"))] if folder.is_dir() else []
    if stems:
        try:
            nodes, edges = legislation.load_saved(cfg, stems)
            counts["provisions"] = add_parts(h, nodes, edges, "imports/legislation")
        except (OSError, ValueError, KeyError) as exc:
            h.find("B08", "warning", f"The saved legislation could not be read: {exc}", None, "imports/legislation")
    if cfg.include_private_graphs:
        try:
            from . import importers
            loader = importers.local_loader()
            if loader is None:
                raise ImportError("no local pack loader")
        except ImportError:   # the public product holds no private pack loader (docs/AGENT_TRANSPARENCY.md, section 10)
            h.find("B08", "info", "The private pack loaders are not part of this installation, so no local pack was loaded.", None, "pack")
            return counts
        res = loader.import_pack(cfg, check=True)   # check mode writes no manifest, so a build never writes into the packs
        for w in res.warnings:
            h.find("B08", "info", f"The local packs report: {w}.", None, "pack")
        counts["private"] = add_parts(h, res.nodes, res.edges, "pack", private=True)
    return counts


def drop_dangling(h: Harvest) -> int:
    dropped: dict[str, list[tuple]] = defaultdict(list)
    for key, e in list(h.edges.items()):
        if e.s not in h.nodes or e.t not in h.nodes:
            dropped[e.r].append(key)
            del h.edges[key]
    total = 0
    for r, keys in sorted(dropped.items()):
        total += len(keys)
        ex = "; ".join(f"{s} to {t}" for s, _r, t in keys[:3])
        h.find("B02", "warning", f"{len(keys)} {r} edges were dropped because an end node is missing, for example {ex}.", None, r)
    return total


def drop_sensitivity(h: Harvest, cfg: Config) -> None:
    allowed = set(cfg.include_sensitivity)
    gone = {nid for nid, n in h.nodes.items() if n.sensitivity not in allowed}
    for nid in gone:
        del h.nodes[nid]
    for key, e in list(h.edges.items()):
        if e.s in gone or e.t in gone:
            del h.edges[key]


def event_metrics(cfg: Config, now: datetime, stats: dict | None = None) -> dict[str, tuple[int, str | None, float | None]]:
    """(uses, last use, base level) for each node the events fired. Event lines that do not match the event shape are
    skipped and counted in stats["invalid"]."""
    events = load_module("events")
    if events is None:
        return {}
    stamps: dict[str, list[datetime]] = defaultdict(list)
    for ev in events.read(cfg, stats=stats):
        try:
            ts = datetime.fromisoformat(str(ev["ts"]).replace("Z", "+00:00"))
        except (KeyError, ValueError):
            continue
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        for nid in set(ev.get("nodes") or []):
            stamps[nid].append(ts)
    act = load_module("activation")
    out = {}
    for nid, ts in stamps.items():
        try:
            b = act.base_level(ts, now) if act else _base_level(ts, now)
        except Exception:
            b = _base_level(ts, now)
        out[nid] = (len(ts), max(ts).strftime("%Y-%m-%dT%H:%M:%SZ"), b)
    return out


def _base_level(stamps, now, d=0.5, min_age_days=0.01):
    total = sum(max((now - t).total_seconds() / 86400, min_age_days) ** -d for t in stamps)
    return math.log(total) if total > 0 else None


def _ttl_classes(cfg: Config) -> dict[str, tuple[str | None, str | None]]:
    """Class labels and descriptions from ontology/cortex.ttl, when the file exists."""
    path = cfg.ontology_dir / "cortex.ttl"
    out: dict[str, tuple[str | None, str | None]] = {}
    if not path.is_file():
        return out
    from rdflib import Graph
    from rdflib.namespace import RDFS, SKOS
    g = Graph()
    g.parse(path, format="turtle")
    base = "https://cortex.local/ont#"
    for s in set(g.subjects()):
        if str(s).startswith(base):
            label = g.value(s, RDFS.label)
            desc = g.value(s, RDFS.comment) or g.value(s, SKOS.definition)
            out[str(s)[len(base):]] = (str(label) if label else None, str(desc) if desc else None)
    return out


def _words(camel: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", " ", camel).lower()


def class_defs(cfg: Config) -> list[dict]:
    ttl = _ttl_classes(cfg)
    defs = [{"id": "InstructionFile", "label": ttl.get("InstructionFile", (None, None))[0] or "Instruction file",
             "parent": None, "family": "instruction",
             "description": ttl.get("InstructionFile", (None, None))[1] or "A file that instructs Claude Code."}]
    for prefix, (cls, parent, family) in CLASSES.items():
        label, desc = ttl.get(cls, (None, None))
        defs.append({"id": cls, "label": label or _words(cls).capitalize(), "parent": parent, "family": family,
                     "description": desc or f"A {_words(cls)} node, with identifiers that start {prefix}:."})
    return defs


def relation_defs(cfg: Config) -> list[dict]:
    # weights.json holds the relations as a list of {id, label, inverse_label, weight, reverse_weight}; the starting
    # file is ontology/defaults/weights.json and a row of the profile's weights.json replaces the starting row
    table = weights_table(cfg)
    out = []
    for r in RELATIONS:
        w = table.get(r, {})
        if isinstance(w, (int, float)):
            w = {"forward": w}
        fwd = w.get("forward", w.get("weight", w.get("fwd", DEFAULT_WEIGHT)))
        back = w.get("backward", w.get("reverse_weight", w.get("back", w.get("reverse", fwd))))
        out.append({"id": r, "label": w.get("label", _words(r)),
                    "inverse_label": w.get("inverse_label", w.get("inverse", f"{_words(r)} (inverse)")),
                    "weight": float(fwd), "reverse_weight": float(back)})
    return out


def _fingerprint(node_json: dict) -> str:
    d = {k: v for k, v in node_json.items() if k != "metrics"}
    return hashlib.sha1(json.dumps(d, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def always_nodes(cfg: Config, nodes: dict) -> list[str]:
    """The nodes that every session reads: the map file, each rule file with no paths (Claude Code loads it at the start of
    every session) and any node that always_nodes in the configuration names, such as an output style."""
    out = [a for a in ALWAYS if a in nodes]
    out += sorted(n.id for n in nodes.values() if prefix_of(n.id) == "rulefile" and not n.props.get("paths"))
    out += [a for a in (cfg.raw.get("always_nodes") or []) if a in nodes and a not in out]
    return out


def build_index(cfg: Config, nodes: dict, edges: list, term_patterns: list, built: str) -> dict:
    paths: dict[str, str] = {}
    prefixes: dict[str, str] = {}
    for n in nodes.values():
        if n.path and os.path.isfile(n.path):
            paths.setdefault(norm_path(n.path), n.id)
        if prefix_of(n.id) in FOLDER_PREFIXES:
            f = _folder_of(n)
            if f:
                prefixes.setdefault(f + "/", n.id)
    fires: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        if e.r == "triggers":
            fires[e.s].append(e.t)
    routes, skills, agents, tools, faults = [], {}, {}, {}, {}
    hooks: dict[str, list[str]] = defaultdict(list)
    for n in nodes.values():
        p = prefix_of(n.id)
        if p == "route":
            pats = []
            for key in ("patterns", "pattern"):
                v = n.props.get(key) or []
                pats += [v] if isinstance(v, str) else list(v)
            routes.append({"id": n.id, "patterns": pats,
                           "fires": [n.id] + fires.get(n.id, [])})
        elif p == "skill":
            folder = Path(n.path).parent.name if n.path else n.id.split(":", 1)[1]
            skills[folder] = n.id
            if n.props.get("name"):
                skills[str(n.props["name"])] = n.id
        elif p == "agent":
            agents[str(n.props.get("name") or n.id.split(":", 1)[1])] = n.id
        elif p == "tool" and n.path:
            tools[Path(n.path).name] = n.id
        elif p == "fault":
            faults[str(n.props.get("key") or n.id.split(":", 1)[1])] = n.id
        elif p == "hook" and n.props.get("event"):
            hooks[str(n.props["event"])].append(n.id)
    terms = []
    for cid, rx, denotes in term_patterns:
        if cid in nodes:
            terms.append({"id": cid, "pattern": rx.pattern, "fires": [cid] + [d for d in denotes if d in nodes]})
    return {
        "v": 1, "built": built, "paths": paths,
        "prefixes": sorted(([k, v] for k, v in prefixes.items()), key=lambda kv: len(kv[0]), reverse=True),
        "routes": routes, "skills": skills, "agents": agents, "tools": tools, "terms": terms,
        "faults": faults, "hooks": dict(hooks), "always": always_nodes(cfg, nodes),
    }


def change_record(cfg: Config, today: str, built: str, prev: dict | None, node_json: list[dict], ledger_changes) -> dict:
    new = {n["id"]: n for n in node_json}
    old = {n["id"]: n for n in (prev or {}).get("nodes", [])}
    added = [{"id": i, "label": new[i]["label"]} for i in new if i not in old]
    removed = [{"id": i, "label": old[i]["label"]} for i in old if i not in new]
    changed = [{"id": i, "label": new[i]["label"]} for i in new if i in old and _fingerprint(new[i]) != _fingerprint(old[i])]
    path = cfg.data_dir / "changes" / f"{today}.json"
    earlier = read_json(path, None)
    if earlier and prev is not None:
        def merge(a, b):
            return {x["id"]: x for x in a + b}
        a_all = merge(earlier.get("added", []), added)
        r_all = merge(earlier.get("removed", []), removed)
        for i in set(a_all) & set(r_all):  # added then removed in the same day cancels out
            del a_all[i]
            del r_all[i]
        c_all = merge(earlier.get("changed", []), changed)
        added, removed, changed = list(a_all.values()), list(r_all.values()), [v for k, v in c_all.items() if k not in a_all]
    return {"v": 1, "built": built, "added": added, "removed": removed, "changed": changed,
            "ledger": ledger_changes if ledger_changes is not None else {}}


# ---------------------------------------------------------------- the profile and the pre-checks

def ensure_profile(cfg: Config) -> list[str]:
    """Copy the starting vocabulary and task types into a profile that lacks them, so that a person can ratify and edit
    their own without changing the product. Returns the files written. A profile that has them is left as it is."""
    import shutil
    wrote: list[str] = []
    src_v, dst_v = cfg.defaults_dir / "vocab", cfg.profile_dir / "vocab"
    if src_v.is_dir() and not (dst_v.is_dir() and any(dst_v.glob("*.json"))):
        dst_v.mkdir(parents=True, exist_ok=True)
        for f in sorted(src_v.glob("*.json")):
            shutil.copyfile(f, dst_v / f.name)
            wrote.append(str(dst_v / f.name))
    src_t, dst_t = cfg.defaults_dir / "tasktypes.json", cfg.profile_dir / "tasktypes.json"
    if src_t.is_file() and not dst_t.exists():
        dst_t.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src_t, dst_t)
        wrote.append(str(dst_t))
    return wrote


def precheck(h: Harvest, cfg: Config) -> None:
    """Findings for what a build needs and cannot find: a configured folder that is missing, and an ontology file that
    is missing. None of them stops the build."""
    def fwd(p) -> str:
        return str(p).replace("\\", "/")

    if not cfg.claude_home.is_dir():
        h.find("B06", "warning", f"The Claude folder {fwd(cfg.claude_home)} does not exist, so the graph holds only the starting content.",
               None, fwd(cfg.claude_home))
    if cfg.raw.get("memory_dir") not in (None, "", "auto") and not cfg.memory_dir.is_dir():
        h.find("B06", "warning", f"The memory folder {fwd(cfg.memory_dir)} does not exist, so no memory file was read.",
               None, fwd(cfg.memory_dir))
    if cfg.projects_set and not cfg.projects_root.is_dir():
        h.find("B06", "warning", f"The projects folder {fwd(cfg.projects_root)} does not exist, so no project was read.",
               None, fwd(cfg.projects_root))
    for name in ("cortex.ttl", "shapes.ttl"):
        if not (cfg.ontology_dir / name).is_file():
            h.find("B06", "violation", f"The ontology file {name} is missing from {fwd(cfg.ontology_dir)}, so the checks that need it did not run.",
                   None, fwd(cfg.ontology_dir / name))


# ---------------------------------------------------------------- build

class OutputWriteError(RuntimeError):
    """An output file could not be written, so the command must exit with a non-zero code."""


def provenance_of(key: tuple, computed: set, assertion_status: dict) -> str:
    """stated for an edge a harvester parsed, computed for one that Cortex code derived from file text, and ratified
    or proposed for one that only a curated assertion supplied."""
    if key in computed:
        return "computed"
    return assertion_status.get(key, "stated")


def render_rdf(cfg: Config, nodes, stated_rows, edge_rows, inferred_edges, findings, metrics, today: str,
               generated: dict | None = None) -> tuple[str, str]:
    """(graph.ttl, graph.trig) text. graph.ttl is the stated graph alone, and graph.trig holds the 5 named graphs, with
    generated (build times and the engine) described in its default graph. The sixth graph, private-pack, is written only when
    include_private_graphs is true."""
    from .rdf import to_dataset, to_rdf
    from .rdf import serialize_trig
    from .rdf import split_private
    public_nodes, public_rows, _pn, _pe = split_private(nodes, stated_rows)   # a node of origin local-pack never reaches graph.ttl
    ttl = to_rdf(public_nodes, public_rows, metrics, today).serialize(format="turtle")
    ds = to_dataset(nodes, edge_rows, inferred_edges, findings, cfg.ontology_dir / "cortex.ttl", metrics, today, generated,
                    include_private=cfg.include_private_graphs)
    return ttl, serialize_trig(ds)


def inferred_on_disk(cfg: Config, inferred: dict) -> bool:
    """Whether inferred.json holds the run just made. reason.run swallows a write error, so the build looks for it."""
    return (read_json(cfg.data_dir / "inferred.json", {}) or {}).get("built") == inferred.get("built")


def refresh_dataset(cfg: Config) -> None:
    """Rewrite graph.trig from the files on disk, after the reason command has replaced inferred.json and the rule
    findings. The graph and its metrics come from graph.json, so the stated, ratified and proposed graphs are unchanged."""
    from .model import Node
    from .rdf import serialize_trig, to_dataset
    graph = read_json(cfg.data_dir / "graph.json", None)
    if not graph:
        raise OutputWriteError("graph.trig could not be refreshed because graph.json is missing or unreadable.")
    inferred = read_json(cfg.data_dir / "inferred.json", {}) or {}
    findings = (read_json(cfg.data_dir / "findings.json", {}) or {}).get("findings", [])
    nodes = []
    for n in graph.get("nodes", []):
        props = dict(n.get("props") or {})
        evidence = props.pop("evidence", None)
        nodes.append(Node(n["id"], n.get("label") or n["id"], n.get("path"), n.get("summary"), n.get("date"),
                          n.get("status"), n.get("sensitivity") or "internal", props, evidence))
    metrics = {n["id"]: n.get("metrics") or {} for n in graph.get("nodes", [])}
    inferred_edges = [{"s": f["args"][0], "r": f["args"][1], "t": f["args"][2]}
                      for f in inferred.get("facts", []) if f.get("kind") == "inference"]
    rows = [e for e in graph.get("edges", []) if e.get("provenance") != "inferred" and not e.get("inferred")]
    today = inferred.get("today") or date.today().isoformat()
    generated = {"built": graph.get("built"), "inferred_built": inferred.get("built"), "engine": inferred.get("engine"),
                 "rules_sha256": inferred.get("rules_sha256")}
    ds = to_dataset(nodes, rows, inferred_edges, findings, cfg.ontology_dir / "cortex.ttl", metrics, today, generated,
                    include_private=cfg.include_private_graphs)
    try:
        atomic_write(cfg.data_dir / "graph.trig", serialize_trig(ds))
    except OSError as exc:
        raise OutputWriteError(f"The build could not write graph.trig: {exc}") from exc


def finish_check(cfg: Config) -> dict:
    """Run the check on the files just written, then stamp health.json with the build times of the graph and of the
    inferred file that the check saw, so that a reader can tell whether health.json describes the latest graph."""
    from .validate import check
    return stamp_health(cfg, check(cfg))


def stamp_health(cfg: Config, health: dict) -> dict:
    """Stamp health.json, which the check has just written, with graph_built and inferred_built, so that every command that
    runs the check (build, reason and check) leaves a file that names the graph it describes."""
    graph = read_json(cfg.data_dir / "graph.json", {}) or {}
    inferred = read_json(cfg.data_dir / "inferred.json", {}) or {}
    stamped = read_json(cfg.data_dir / "health.json", None) or {k: v for k, v in health.items() if k != "_timing"}
    stamped["graph_built"] = graph.get("built")
    stamped["inferred_built"] = inferred.get("built")
    write_json(cfg.data_dir / "health.json", stamped)
    health["graph_built"], health["inferred_built"] = stamped["graph_built"], stamped["inferred_built"]
    return health


def build(cfg: Config, today: str | None = None) -> dict:
    t0 = time.time()
    cfg.ensure_data_dirs()
    today = today or date.today().isoformat()
    now = datetime.now(timezone.utc)
    built = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    ensure_profile(cfg)
    ledger, lpath = None, cfg.profile_dir / "ledger" / "rules.json"
    ledger_mod = load_module("ledger")
    ledger_problem = None
    if ledger_mod is not None:
        try:
            ledger = ledger_mod.Ledger.load(lpath)
        except (OSError, ValueError) as exc:
            # a ledger that cannot be read is set aside, never overwritten, and the build starts a new one
            aside = lpath.with_name(f"rules.corrupt-{built.replace(':', '')}.json")
            try:
                os.replace(lpath, aside)
            except OSError:
                aside = lpath
            ledger = ledger_mod.Ledger()
            ledger_problem = f"The rule ledger {str(lpath).replace(chr(92), '/')} could not be read ({exc}), so it was kept as {aside.name} and a new one was started."

    h = run_harvesters(cfg, ledger, today)
    precheck(h, cfg)
    if ledger_problem:
        h.find("B07", "violation", ledger_problem, None, str(lpath).replace(chr(92), "/"))

    ledger_changes = None
    if ledger is not None:
        ledger_changes = ledger.finish(today, seen_file_keys(h.nodes))
        ledger.save(lpath)

    resolve_refs(h, cfg)
    term_patterns = add_mentions(h, cfg)
    # restatements between the rule files and the reference files are computed from the text (cortex_kg.restate)
    from .restate import add_edges as add_restatements
    before = set(h.edges)
    add_restatements(h)
    computed = set(h.edges) - before
    transparency_stage(h, cfg)
    apply_assertions(h, cfg)
    dropped = drop_dangling(h)
    drop_sensitivity(h, cfg)
    for key, e in list(h.edges.items()):  # sensitivity removal can leave no new dangling ends, but keep the check cheap
        if e.s not in h.nodes or e.t not in h.nodes:
            del h.edges[key]

    edges = list(h.edges.values())
    degree: Counter = Counter()
    for e in edges:
        degree[e.s] += 1
        degree[e.t] += 1
    ev_stats: dict = {}
    metrics = event_metrics(cfg, now, ev_stats)
    if ev_stats.get("invalid"):
        n_bad = ev_stats["invalid"]
        h.find("B04", "warning", f"{n_bad} event {'line was' if n_bad == 1 else 'lines were'} skipped because "
               f"{'it does' if n_bad == 1 else 'they do'} not match the event shape in docs/CONTRACTS.md.", None, str(cfg.events_dir))
    assertion_status = getattr(h, "assertion_status", {})
    assertion_by = getattr(h, "assertion_by", {})

    rels = relation_defs(cfg)
    weight = {r["id"]: r["weight"] for r in rels}
    node_json = []
    for n in sorted(h.nodes.values(), key=lambda x: x.id):
        d = n.to_json()
        d.pop("evidence", None)
        d["props"] = {**n.props, **({"evidence": n.evidence} if n.evidence else {})}
        uses, last, base = metrics.get(n.id, (0, None, None))
        d["metrics"] = {"uses": uses, "last_used": last, "base_level": base, "degree": degree.get(n.id, 0)}
        node_json.append(d)
    # Heat is the rank of a node's base level among the nodes that have one, from 0.15 to 1, and 0 for a node never
    # used. Base levels run from about 1 to 10 once months of chats are replayed, so a sigmoid of the raw value would
    # give nearly every used node the same full glow; the rank keeps the spread.
    ranked = sorted((d["metrics"]["base_level"], d["id"]) for d in node_json if d["metrics"]["base_level"] is not None)
    pos = {nid: i for i, (_b, nid) in enumerate(ranked)}
    span = max(1, len(ranked) - 1)
    for d in node_json:
        i = pos.get(d["id"])
        d["metrics"]["heat"] = 0.0 if i is None else round(0.15 + 0.85 * i / span, 4)
    edge_json = []
    for e in sorted(edges, key=lambda x: x.key()):
        prov = provenance_of(e.key(), computed, assertion_status)
        row = {"s": e.s, "r": e.r, "t": e.t, "w": weight.get(e.r, DEFAULT_WEIGHT), "evidence": e.evidence, "provenance": prov}
        if prov in ("ratified", "proposed"):
            row["by"] = assertion_by.get(e.key(), "unknown")  # who made the assertion, as its file records it
        if prov == "proposed":
            row["w"] = round(row["w"] * PROPOSED_FACTOR, 4)  # an unreviewed assertion pulls less activation than a stated link
        edge_json.append(row)

    by_class = dict(sorted(Counter(n["type"] for n in node_json).items()))
    in_scheme = Counter(e.t for e in edges if e.r == "inScheme")
    schemes = [{"id": n.id, "label": n.label, "concept_count": in_scheme.get(n.id, 0)}
               for n in h.nodes.values() if prefix_of(n.id) == "scheme"]

    prev_graph = read_json(cfg.data_dir / "graph.json", None)
    prev_health = read_json(cfg.data_dir / "health.json", None) or {}
    counts = prev_health.get("counts", {})
    health = {"errors": counts.get("violation", 0), "warnings": counts.get("warning", 0),
              "infos": counts.get("info", 0), "checked": prev_health.get("checked", ""),
              # this block is copied from the run before, because the check needs this file first, so it names the
              # graph it describes and a reader should take the current figures from health.json
              "of_graph_built": prev_health.get("graph_built")}

    graph = {
        "v": 1, "built": built,
        "source": {"claude_home": str(cfg.claude_home).replace("\\", "/"),
                   "projects_root": str(cfg.projects_root).replace("\\", "/") if cfg.has_projects else None,
                   "product": cfg.product,
                   "git": _git_head(cfg.repo_root), "host": socket.gethostname()},
        "classes": class_defs(cfg), "relations": rels, "nodes": node_json, "edges": edge_json,
        "schemes": schemes, "health": health,
        "stats": {"nodes": len(node_json), "edges": len(edge_json), "by_class": by_class},
    }

    # The reasoning step runs on the finished graph. An inferred edge whose relation has a weight in weights.json joins
    # the edges with "inferred": true. The degree counted above does not include them, and the rest stay in inferred.json.
    rule_findings: list[dict] = []
    all_inferred: list[dict] = []
    failed_early: list[str] = []
    _inferred: dict | None = None
    reason_mod = load_module("reason")
    if reason_mod is not None:
        try:
            _inferred, inferred_edges, rule_findings = reason_mod.run(cfg, graph, today)
            all_inferred = list(inferred_edges)
            if not inferred_on_disk(cfg, _inferred):
                failed_early.append("inferred.json: the file on disk is not the one the rules just produced")
            known = reason_mod.weights(cfg)
            have = {(e["s"], e["r"], e["t"]) for e in edge_json}
            # restates is symmetric (rule R01) and its relation weights already carry activation both ways, so the mirror
            # edges stay in inferred.json and the live graph keeps one edge per computed pair (cortex_kg.restate)
            for ie in sorted(inferred_edges, key=lambda x: (x["s"], x["r"], x["t"])):
                if ie["r"] in known and ie["r"] != "restates" and (ie["s"], ie["r"], ie["t"]) not in have:
                    edge_json.append({"s": ie["s"], "r": ie["r"], "t": ie["t"], "w": known[ie["r"]],
                                      "evidence": ie.get("evidence"), "provenance": "inferred", "inferred": True})
            # stats.edges keeps its meaning, the edges that the files state, so it does not count inferred edges
        except OSError as exc:  # reason.run raises only where it cannot write inferred.json or inferred.ttl
            failed_early.append(f"inferred.json or inferred.ttl: {exc}")
        except Exception as exc:  # noqa: BLE001 - reasoning is optional and must not stop a build
            rule_findings = [{"check": "B03", "severity": "warning", "node": None, "evidence": str(exc)[:200],
                              "message": "The reasoning step failed, so the graph has no inferred facts and no rule findings."}]

    findings = [vars(f) if isinstance(f, Finding) else f for f in h.findings] + rule_findings
    node_metrics = {d["id"]: d["metrics"] for d in node_json}
    stated_rows = [e for e in edge_json if e["provenance"] in ("stated", "computed")]
    generated = {"built": built, "inferred_built": (_inferred or {}).get("built"), "engine": (_inferred or {}).get("engine"),
                 "rules_sha256": (_inferred or {}).get("rules_sha256")}
    ttl, trig = render_rdf(cfg, h.nodes, stated_rows, edge_json, all_inferred, findings, node_metrics, today, generated)
    index = build_index(cfg, h.nodes, edges, term_patterns, built)
    changes = change_record(cfg, today, built, prev_graph, node_json, ledger_changes)

    d = cfg.data_dir
    failed: list[str] = list(failed_early)

    def put(name: str, fn, *args) -> None:
        try:
            fn(d / name, *args)
        except OSError as exc:
            failed.append(f"{name}: {exc}")

    put("graph.json", write_json, graph)
    put("graph.ttl", atomic_write, ttl)
    put("graph.trig", atomic_write, trig)
    put("index.json", write_json, index)
    put(f"changes/{today}.json", write_json, changes)
    for item in failed:
        findings.append({"check": "B05", "severity": "violation", "node": None, "evidence": item,
                         "message": f"The output file {item.split(':', 1)[0]} could not be written, so the data folder is not in step with the build."})
    fcounts = Counter(f["severity"] for f in findings)
    findings_file = {"v": 1, "checked": built,
                     "counts": {k: fcounts.get(k, 0) for k in ("violation", "warning", "info")},
                     "findings": findings, "drift": None}
    put("findings.json", write_json, findings_file)
    if failed:
        raise OutputWriteError("The build could not write " + "; ".join(failed))
    finish_check(cfg)

    return {"nodes": len(node_json), "edges": graph["stats"]["edges"], "findings": len(findings), "by_class": by_class,
            "dropped_edges": dropped, "seconds": round(time.time() - t0, 2)}
