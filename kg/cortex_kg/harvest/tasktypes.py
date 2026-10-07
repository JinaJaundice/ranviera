"""Harvest the task types and gates: the starting set in ontology/defaults/tasktypes.json, then the person's own in
the profile's tasktypes.json, where an entry with the same id replaces the starting one.

A person's CLAUDE.md may hold a routing table, which is a Markdown table with a column whose header names a task and a
column whose header names the files to read first. Each row whose task matches a task type adds readsFirst edges
from that type to the files the row cites.

Targets are not checked here, because the compiler checks every edge target once the harvests are merged.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from .. import md
from ..config import Config, tasktype_files
from ..model import Harvest, Node, slugify
from ..paths import resolve_cited

_STOP = {"a", "an", "and", "or", "of", "the", "to", "for", "in", "on", "with"}
_TASK_HEADER = re.compile(r"\btask|\bwork\b|\brequest|\bjob\b", re.I)
_FILES_HEADER = re.compile(r"read|files?\b|load|\bfirst\b|\bsources?\b", re.I)


def evidence_path(cfg: Config, path: Path) -> str:
    """The evidence of an entry that came from a file of the ontology or the profile: relative to the repository where
    the file is inside it, else the full path."""
    p = path.resolve()
    try:
        return p.relative_to(cfg.repo_root.resolve()).as_posix()
    except ValueError:
        return p.as_posix()


def _tokens(text: str) -> set[str]:
    words = re.findall(r"[a-z0-9]+", text.lower())
    return {w[:-1] if len(w) > 3 and w.endswith("s") else w for w in words if w not in _STOP}


def match_task(cell: str, types: dict[str, dict]) -> str | None:
    """The id of the task type that a routing table row names, or None. An exact match of the label or of table_row wins,
    and otherwise the type with the best word overlap wins, provided the best is not tied."""
    want = _tokens(cell)
    if not want:
        return None
    scored: list[tuple[float, str]] = []
    for tid, t in types.items():
        for name in {t.get("label") or "", t.get("table_row") or ""}:
            have = _tokens(name)
            if not have:
                continue
            if have == want:
                return tid
            inter = want & have
            if inter and len(inter) / min(len(want), len(have)) >= 0.5:
                scored.append((len(inter) / len(want | have), tid))
    if not scored:
        return None
    scored.sort(reverse=True)
    best = scored[0]
    tied = {tid for s, tid in scored if s == best[0]}
    return best[1] if len(tied) == 1 else None


def routing_rows(text: str) -> list[tuple[str, str, int]]:
    """(task cell, files cell, line) for each data row of each table whose header names a task and the files to read."""
    out: list[tuple[str, str, int]] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        if not lines[i].lstrip().startswith("|") or i + 1 >= len(lines) or not re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1]):
            i += 1
            continue
        head = [c.strip() for c in lines[i].strip().strip("|").split("|")]
        task_col = next((k for k, c in enumerate(head) if _TASK_HEADER.search(c)), None)
        files_col = next((k for k, c in enumerate(head) if k != task_col and _FILES_HEADER.search(c)), None)
        j = i + 2
        while j < len(lines) and lines[j].lstrip().startswith("|"):
            if task_col is not None and files_col is not None:
                cells = [c.strip() for c in lines[j].strip().strip("|").split("|")]
                if len(cells) > max(task_col, files_col):
                    out.append((cells[task_col], cells[files_col], j + 1))
            j += 1
        i = j
    return out


def _load(h: Harvest, cfg: Config) -> tuple[dict, dict]:
    """The merged task types and gates by id, each with the file it came from."""
    types: dict[str, dict] = {}
    gates: dict[str, dict] = {}
    for path in tasktype_files(cfg):
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            if not isinstance(data, dict):
                raise ValueError("the top level is not an object")
        except (OSError, ValueError) as exc:
            h.find("B07", "warning", f"The task type file {path.name} could not be read: {exc}.", None, evidence_path(cfg, path))
            continue
        ev = evidence_path(cfg, path)
        for t in data.get("task_types", []):
            if isinstance(t, dict) and t.get("id") and t.get("label"):
                types[t["id"]] = {**t, "_ev": ev}
        for g in data.get("gates", []):
            if isinstance(g, dict) and g.get("id") and g.get("label"):
                gates[g["id"]] = {**g, "_ev": ev}
    return types, gates


def harvest(cfg: Config) -> Harvest:
    h = Harvest("tasktypes")
    types, gates = _load(h, cfg)
    for tid, t in types.items():
        ev = t["_ev"]
        props = {"label": t["label"], "table_row": t.get("table_row"), "family_files": t.get("family_files") or {},
                 "always": bool(t.get("always", False))}
        props.update({k: t[k] for k in ("condition", "routing_note") if t.get(k)})
        h.add_node(Node(tid, t["label"], sensitivity="internal", evidence=ev, props=props))
        for route in t.get("routes", []):
            h.add_edge(f"route:{slugify(route)}", "triggers", tid, ev)
        patterns = [p for p in t.get("route_patterns", []) if isinstance(p, str)]
        if patterns:
            # the plain patterns of a starting task type make one route, so that the hook can fire the type
            rid = f"route:{slugify(t['label'])}"
            h.add_node(Node(rid, t["label"], sensitivity="internal", evidence=ev,
                            props={"patterns": patterns, "load": ""}))
            h.add_edge(rid, "triggers", tid, ev)
        for target in t.get("reads_first", []):
            h.add_edge(tid, "readsFirst", target, ev)
        for target in t.get("agents", []):
            h.add_edge(tid, "handledBy", target, ev)
        for target in t.get("gates", []):
            h.add_edge(tid, "checkedBy", target, ev)
        for target in t.get("templates", []):
            h.add_edge(tid, "usesTemplate", target, ev)
    for gid, g in gates.items():
        h.add_node(Node(gid, g["label"], sensitivity="internal", evidence=g["_ev"],
                        props={"command": g.get("command"), "kind": g.get("kind"), "label": g["label"]}))
        if g.get("tool"):
            h.add_edge(gid, "invokes", g["tool"], g["_ev"])
    _routing_table(h, cfg, types)
    return h


def _routing_table(h: Harvest, cfg: Config, types: dict) -> None:
    """readsFirst from the person's CLAUDE.md, where its routing table names a task and the files to read first."""
    path = cfg.claude_home / "CLAUDE.md"
    try:
        text = path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return
    for task_cell, files_cell, line in routing_rows(text):
        tid = match_task(re.sub(r"[`*_]", "", task_cell), types)
        if tid is None:
            continue
        ev = md.evidence(cfg, path, line)
        for cp in md.cited_paths(md.parse(files_cell)):
            h.ref(tid, cp.raw, resolve_cited(cp.raw, path, cfg), ev, cp.acknowledged_missing, "readsFirst")
