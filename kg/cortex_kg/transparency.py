"""The facts for the agent transparency rules O01 to O14 (ontology/rules/transparency*.rls, docs/REASONING.md).

reason.py runs those rule files as a second program after cortex.rls. This module builds the facts that the second
program reads in addition to node, edge, status and day: the run date, the validity intervals, the hashes, the two ends
of each ratified mapping, the hashes that a running agent reported, the replay inputs of a run, the step counts and the
ledger result, and the monitoring measures with the bounds of the bank.

Nothing here has a default threshold. The bounds come from the file named by the key monitoring_bounds (or the
environment variable CORTEX_MONITORING_BOUNDS), and without that file there are no bound facts, so O13 gives no finding.

A fact is left out where the graph does not hold the data, so that a rule that needs it gives no finding. The module
reads the compiled graph, the mapping store of the profile and, under the data folder, runs/*.records.jsonl and
ledger/verify.json. It never reads an obligation pack from a local folder and holds no pack content.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

from .config import Config

PREFIX = "transparency"        # the rule files that make the second program are named transparency*.rls
KINDS = ("override", "review_seconds")

# the columns of each added predicate, "s" for a string and "i" for an integer
FACT_FORMATS = {
    "today": "i", "valid_from": "si", "valid_to": "si", "hash": "ss", "approved_hash": "ss",
    "mapping_end": "sss", "anchor": "sss", "end_hash": "sss", "loaded_hash": "sss", "prompt_hash": "ss",
    "params_hash": "ss", "snapshot_hash": "ss", "source_hash": "ss", "steps_captured": "si", "steps_reported": "si",
    "ledger_break": "s", "measure": "ssi", "bound_max": "ssi", "bound_min": "ssi",
}
# the base predicates that the second program also reads
BASE_PREDICATES = ("node", "edge", "status", "day")


def is_transparency_file(path: Path) -> bool:
    return path.suffix == ".rls" and path.name.startswith(PREFIX)


def rule_files(cfg: Config, transparency: bool) -> list[Path]:
    """The rule files of the first program (transparency False) or of the second (True), in name order."""
    return [p for p in sorted((cfg.ontology_dir / "rules").glob("*.rls")) if is_transparency_file(p) == transparency]


# ---------------------------------------------------------------- small readers

def _hash(value) -> str | None:
    """A hash in one form: lower case, without the sha256: prefix, and None where empty."""
    if value is None:
        return None
    s = str(value).strip().lower()
    if s.startswith("sha256:"):
        s = s[7:]
    return s or None


def _prop(n: dict, *keys):
    props = n.get("props") or {}
    for k in keys:
        for src in (props, n):
            v = src.get(k)
            if v not in (None, ""):
                return v
    return None


def _day(value) -> int | None:
    from .reason import _day as day
    return day(value)


def graph_resolver(cfg: Config):
    """A function from a node id to the node in <data_dir>/graph.json, or None where the node or the graph is absent. The
    mapping commands use it, and mappings.node_hash leaves out the metrics, so the anchors they record match rule O05."""
    graph = _read_json(cfg.data_dir / "graph.json")
    nodes = {n["id"]: n for n in graph.get("nodes", [])} if isinstance(graph, dict) else {}

    def resolve(node_id: str):
        n = nodes.get(node_id)
        return n
    return resolve


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def _digest(text) -> str:
    if not isinstance(text, str):
        text = json.dumps(text, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------- the bank's bounds

def load_bounds(cfg: Config) -> tuple[dict, str | None, str | None]:
    """The bounds of the bank as {agent: {kind: {"min": n|None, "max": n|None}}}, the path of the file and a problem.
    A key that is unset gives no bound and no problem. A file that cannot be read gives no bound and a problem, so that
    no threshold is ever assumed."""
    path = os.environ.get("CORTEX_MONITORING_BOUNDS") or (cfg.raw or {}).get("monitoring_bounds")
    if not path:
        return {}, None, None
    data = _read_json(Path(path))
    if not isinstance(data, dict) or data.get("v") != 1 or not isinstance(data.get("agents"), dict):
        return {}, str(path), "The bounds file cannot be read as version 1, so O13 has no bound."
    out: dict = {}
    for agent, kinds in data["agents"].items():
        if not isinstance(kinds, dict):
            continue
        for kind, b in kinds.items():
            if kind not in KINDS or not isinstance(b, dict):
                continue
            for end in ("min", "max"):
                v = b.get(end)
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    out.setdefault(str(agent), {}).setdefault(kind, {})[end] = int(round(v))
    return out, str(path), None


# ---------------------------------------------------------------- runs, ledger and mappings

def _run_nodes(cfg: Config, nodes: dict[str, dict]) -> dict[str, str]:
    """The Run node of each run name in the records: the id that ingest-run builds from the agent and the run name, or
    else the node whose label is 'Run <name>'."""
    from .model import slugify
    out: dict[str, str] = {}
    by_label = {str(n.get("label")): i for i, n in nodes.items() if n.get("type") == "Run"}
    for rec in _records(cfg):
        run = rec.get("run")
        if run is None or run in out:
            continue
        agent = (rec.get("agent") or {}).get("id")
        cand = f"run:{slugify(f'{agent}-{run}', 80)}" if agent else None
        if cand in nodes:
            out[run] = cand
        elif f"Run {run}" in by_label:
            out[run] = by_label[f"Run {run}"]
    for label, i in by_label.items():
        out.setdefault(label[4:] if label.startswith("Run ") else label, i)
    return out


def _records(cfg: Config) -> list[dict]:
    out = []
    folder = cfg.data_dir / "runs"
    if not folder.is_dir():
        return out
    for p in sorted(folder.glob("*.records.jsonl")):
        try:
            lines = p.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict):
                out.append(rec)
    return out


def _named(run: str, reason: str) -> bool:
    return re.search(rf"(?<![\w:-]){re.escape(run)}(?![\w-])", reason) is not None


def _ledger_facts(cfg: Config, run_ids: dict[str, str], rows: dict[str, list[tuple]], meta: dict) -> None:
    report = _read_json(cfg.data_dir / "ledger" / "verify.json")
    if not isinstance(report, dict):
        return
    runs = report.get("runs") if isinstance(report.get("runs"), dict) else {}
    breaks = [b for b in (report.get("breaks") or []) if isinstance(b, dict)]
    global_break = False
    hit: set[str] = set()
    for b in breaks:
        reason = str(b.get("reason") or "")
        named = [r for r in runs if _named(str(r), reason)]
        hit.update(named)
        global_break = global_break or not named
    for name, info in runs.items():
        rid = run_ids.get(name)
        if rid is None or not isinstance(info, dict):
            continue
        reported, captured = info.get("reported"), info.get("captured")
        if isinstance(reported, int) and isinstance(captured, int):
            # the ledger holds the opening record as step 0, and the closing record reports the steps after it
            rows["steps_captured"].append((rid, max(0, captured - 1)))
            rows["steps_reported"].append((rid, reported))
        if name in hit or global_break:   # a break in the chain itself puts every run in doubt
            rows["ledger_break"].append((rid,))
    meta["ledger_breaks"] = len(breaks)


def _mapping_facts(cfg: Config, nodes: dict[str, dict], rows: dict[str, list[tuple]]) -> None:
    from . import mappings
    try:
        records = mappings.list_mappings(cfg.profile_dir, status="ratified")
    except (mappings.MappingError, OSError, ValueError, KeyError, TypeError):
        return
    for m in records:
        anchors = m.get("anchors") or {}
        for end, nid, key in (("s", m.get("s"), "s_hash"), ("t", m.get("t"), "t_hash")):
            if not nid:
                continue
            rows["mapping_end"].append((m["id"], end, nid))
            if anchors.get(key):
                rows["anchor"].append((m["id"], end, _hash(anchors[key])))
                if nid in nodes:   # the anchor is the sha256 of the node as the store computes it
                    rows["end_hash"].append((m["id"], end, _hash(mappings.node_hash(nodes[nid]))))


def _measures(nodes: dict[str, dict], edges: list[tuple]) -> dict[str, dict[str, int]]:
    """The override rate in thousandths and the average review time in seconds of each agent, from its reviews.
    The path is agent, run, step, decision, review."""
    out_edges: dict[tuple[str, str], list[str]] = {}
    for s, r, t in edges:
        out_edges.setdefault((s, r), []).append(t)
    reviews: dict[str, set[str]] = {}
    for rid, n in nodes.items():
        if n.get("type") != "Run":
            continue
        for agent in out_edges.get((rid, "performedBy"), []):
            for step in out_edges.get((rid, "contains"), []):
                for dec in out_edges.get((step, "informedDecision"), []):
                    reviews.setdefault(agent, set()).update(out_edges.get((dec, "reviewedBy"), []))
    out: dict[str, dict[str, int]] = {}
    for agent, rv in reviews.items():
        rv_nodes = [nodes[r] for r in rv if r in nodes]
        flagged = [n for n in rv_nodes if _prop(n, "override") is not None]
        if flagged:
            over = sum(1 for n in flagged if _prop(n, "override") in (True, "true", "True", 1))
            out.setdefault(agent, {})["override"] = int(round(1000 * over / len(flagged)))
        times = [float(t) for t in (_prop(n, "timeOpenS", "time_open_s") for n in rv_nodes)
                 if isinstance(t, (int, float)) and not isinstance(t, bool)]
        if times:
            out.setdefault(agent, {})["review_seconds"] = int(round(sum(times) / len(times)))
    return out


# ---------------------------------------------------------------- the facts

def fact_rows(cfg: Config, graph_json: dict, base: dict[str, list[tuple]], today: str) -> tuple[dict, dict]:
    """The rows of the second program and a record of what was read. base holds the rows of reason.fact_rows. The
    result holds the base predicates node, edge, status and day, with the day of a step (its cx:ts) and of an
    obligation (its effective date) added, and every predicate of FACT_FORMATS."""
    rows: dict[str, list[tuple]] = {p: list(base.get(p, [])) for p in BASE_PREDICATES}
    for p in FACT_FORMATS:
        rows[p] = []
    nodes = {n["id"]: n for n in graph_json.get("nodes", [])}
    has_day = {r[0] for r in rows["day"]}
    td = _day(today)
    if td is not None:
        rows["today"].append((td,))
    for i, n in nodes.items():
        d = _day(_prop(n, "ts", "effective_date", "effectiveDate")) if i not in has_day else None
        if d is not None:
            rows["day"].append((i, d))
        for pred, keys in (("valid_from", ("validFrom", "valid_from")), ("valid_to", ("validTo", "valid_to"))):
            v = _day(_prop(n, *keys))
            if v is not None:
                rows[pred].append((i, v))
        h = _hash(_prop(n, "hash", "snapshotHash"))
        if h:
            rows["hash"].append((i, h))
        a = _hash(_prop(n, "approvedHash", "approved_hash"))
        if a:
            rows["approved_hash"].append((i, a))
        if n.get("type") == "KnowledgeSource" and _hash(_prop(n, "snapshotHash")):
            rows["snapshot_hash"].append((i, _hash(_prop(n, "snapshotHash"))))
        if n.get("type") == "Evidence" and _hash(_prop(n, "sourceHash")):
            rows["source_hash"].append((i, _hash(_prop(n, "sourceHash"))))
    edges = [tuple(e) for e in base.get("edge", [])]
    models = {s: t for s, r, t in edges if r == "ranOn"}
    for i, n in nodes.items():       # the replay inputs of a run are on the run or on its pinned model version
        if n.get("type") != "Run":
            continue
        m = nodes.get(models.get(i, ""), {})
        p = _hash(_prop(n, "promptHash", "prompt_hash") or _prop(m, "promptHash", "prompt_hash"))
        if p:
            rows["prompt_hash"].append((i, p))
        q = _prop(n, "parameters", "params") or _prop(m, "parameters", "params")
        if q is not None:
            rows["params_hash"].append((i, _digest(q)))
    meta: dict = {}
    run_ids = _run_nodes(cfg, nodes)
    for rec in _records(cfg):
        rid = run_ids.get(rec.get("run"))
        for item in ((rec.get("payload") or {}).get("instructions_loaded") or []):
            if rid and isinstance(item, dict) and item.get("id") and _hash(item.get("hash")):
                iid = item["id"] if str(item["id"]).startswith("instr:") else "instr:" + str(item["id"])
                row = (rid, iid, _hash(item["hash"]))
                if row not in rows["loaded_hash"]:
                    rows["loaded_hash"].append(row)
    _ledger_facts(cfg, run_ids, rows, meta)
    _mapping_facts(cfg, nodes, rows)
    bounds, path, problem = load_bounds(cfg)
    for agent, kinds in _measures(nodes, edges).items():
        for kind, v in kinds.items():
            rows["measure"].append((agent, kind, v))
    for agent, kinds in bounds.items():
        for kind, b in kinds.items():
            for end, pred in (("max", "bound_max"), ("min", "bound_min")):
                if end in b:
                    rows[pred].append((agent, kind, b[end]))
    meta.update({"bounds_file": path, "bounds_problem": problem, "bounded_agents": len(bounds),
                 "measures": len(rows["measure"])})
    return rows, meta
