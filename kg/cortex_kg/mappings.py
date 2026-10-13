"""The mapping store: design time links between two nodes, kept by the person or the bank.

The file is <profile_dir>/mappings/<scope>.json and its format is set out in docs/CONTRACTS.md, in the section
'Mapping file'. A mapping is proposed by a maker, then ratified or rejected by a checker who is a different person
(F03). The history of each mapping only grows. Both ends are anchored by a sha256 of the node at ratification, so a
later change to either end makes the mapping stale (O05).

The store never reads the graph itself. Callers pass `resolve`, a function from a node id to the node as a dict, or
None where the node is absent.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from .fileio import write_atomic

RELATIONS = ("implementsClause", "realises", "satisfies", "notDischargedBy", "detects", "appliesTo")
STATUSES = ("proposed", "ratified", "rejected", "superseded")
ORIGINS = ("reviewer", "suggested", "imported")
DEFAULT_SCOPE = "default"
PROPOSED_WEIGHT = 0.5

Resolver = Callable[[str], "dict | None"]


class MappingError(ValueError):
    """A refused change. The message is one sentence that names the reason."""


def mappings_dir(profile_dir: str | Path) -> Path:
    return Path(profile_dir) / "mappings"


def scope_path(profile_dir: str | Path, scope: str = DEFAULT_SCOPE) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", scope):
        raise MappingError(f"The scope '{scope}' is not a plain file name.")
    return mappings_dir(profile_dir) / f"{scope}.json"


def node_hash(node: dict) -> str:
    """The sha256 of a node as canonical JSON, so that key order does not matter. The metrics of a compiled node (uses, last
    used, degree and heat) change on every build, so they are left out, and an anchor stays valid until the node itself changes."""
    node = {k: v for k, v in node.items() if k != "metrics"}
    text = json.dumps(node, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _stamp(now: datetime | None) -> datetime:
    return now or datetime.now(timezone.utc)


def _ts(now: datetime | None) -> str:
    return _stamp(now).strftime("%Y-%m-%dT%H:%M:%SZ")


def _actor(by: str | None, what: str) -> str:
    """The person who acts, stripped. A blank actor is refused, because the history and the ledger must name a person."""
    if by is None or not str(by).strip():
        raise MappingError(f"{what} needs the person who acts.")
    return str(by).strip()


def _same_person(a: str | None, b: str | None) -> bool:
    """Whether 2 names are the same person, ignoring case and surrounding spaces, for the check of F03."""
    return (a or "").strip().lower() == (b or "").strip().lower()


def _entry(now: datetime | None, action: str, by: str, note: str | None) -> dict:
    return {"ts": _ts(now), "action": action, "by": by, "note": note}


def load(profile_dir: str | Path, scope: str = DEFAULT_SCOPE) -> dict:
    p = scope_path(profile_dir, scope)
    if not p.is_file():
        return {"v": 1, "scope": scope, "mappings": []}
    data = json.loads(p.read_text(encoding="utf-8"))
    if data.get("v") != 1 or not isinstance(data.get("mappings"), list):
        raise MappingError(f"The mapping file {p.name} is not version 1.")
    return data


def save(profile_dir: str | Path, data: dict) -> Path:
    p = scope_path(profile_dir, data["scope"])
    write_atomic(p, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return p


def scopes(profile_dir: str | Path) -> list[str]:
    d = mappings_dir(profile_dir)
    return sorted(f.stem for f in d.glob("*.json")) if d.is_dir() else []


def _find(data: dict, mapping_id: str) -> dict:
    for m in data["mappings"]:
        if m["id"] == mapping_id:
            return m
    raise MappingError(f"No mapping has the id {mapping_id}.")


def _locate(profile_dir: str | Path, mapping_id: str, scope: str | None) -> tuple[dict, dict]:
    for sc in ([scope] if scope else scopes(profile_dir)):
        data = load(profile_dir, sc)
        for m in data["mappings"]:
            if m["id"] == mapping_id:
                return data, m
    raise MappingError(f"No mapping has the id {mapping_id}.")


def _next_id(profile_dir: str | Path, data: dict, day: str) -> str:
    """The counter restarts each day and runs across every scope, so an id is unique in the whole store."""
    n = 0
    pools = [data["mappings"]] + [load(profile_dir, sc)["mappings"] for sc in scopes(profile_dir) if sc != data["scope"]]
    for pool in pools:
        for m in pool:
            mm = re.fullmatch(rf"map:{day}-(\d+)", m["id"])
            if mm:
                n = max(n, int(mm.group(1)))
    return f"map:{day}-{n + 1:03d}"


def propose(profile_dir: str | Path, *, relation: str, s: str, t: str, basis: str, owner: str, maker: str,
            origin: str = "reviewer", scope: str = DEFAULT_SCOPE, now: datetime | None = None) -> dict:
    """Add a proposed mapping and return it. A suggestion never starts as ratified."""
    if relation not in RELATIONS:
        raise MappingError(f"The relation '{relation}' is not one of the six relations of the contract.")
    if origin not in ORIGINS:
        raise MappingError(f"The origin '{origin}' is not reviewer, suggested or imported.")
    for label, value in (("source", s), ("target", t), ("basis", basis), ("owner", owner), ("maker", maker)):
        if not value or not value.strip():
            raise MappingError(f"A mapping needs a {label}.")
    data = load(profile_dir, scope)
    for m in data["mappings"]:
        if (m["relation"], m["s"], m["t"]) == (relation, s, t) and m["status"] in ("proposed", "ratified"):
            raise MappingError(f"{m['id']} already links these two nodes by {relation}.")
    day = _stamp(now).strftime("%Y%m%d")
    rec = {
        "id": _next_id(profile_dir, data, day), "relation": relation, "s": s, "t": t, "status": "proposed",
        "basis": basis, "origin": origin, "owner": owner, "maker": maker, "checker": None,
        "valid_from": None, "valid_to": None, "anchors": {"s_hash": None, "t_hash": None},
        "reason": None, "superseded_by": None,
        "history": [_entry(now, "propose", maker, None)],
    }
    data["mappings"].append(rec)
    save(profile_dir, data)
    return rec


def ledger_entry(rec: dict, kind: str) -> dict:
    """The body of the run ledger entry that ratification, rejection or reassignment must also write."""
    last = rec["history"][-1]
    return {"kind": kind, "actor": last["by"], "ts": last["ts"], "mapping": rec["id"], "status": rec["status"],
            "note": last["note"]}


def ratify(profile_dir: str | Path, mapping_id: str, *, by: str, resolve: Resolver, note: str | None = None,
           scope: str | None = None, now: datetime | None = None) -> dict:
    data, rec = _locate(profile_dir, mapping_id, scope)
    if rec["status"] != "proposed":
        raise MappingError(f"{mapping_id} is {rec['status']} and only a proposed mapping can be ratified.")
    by = _actor(by, "A ratification")
    if _same_person(by, rec["maker"]):
        raise MappingError(f"{mapping_id} cannot be ratified by its maker, because the checker must be a different person.")
    ends = {}
    for label, nid in (("source", rec["s"]), ("target", rec["t"])):
        node = resolve(nid)
        if node is None:
            raise MappingError(f"The {label} {nid} is absent from the graph, so {mapping_id} cannot be ratified.")
        ends[label] = node_hash(node)
    rec["status"] = "ratified"
    rec["checker"] = by
    rec["valid_from"] = _stamp(now).strftime("%Y-%m-%d")
    rec["anchors"] = {"s_hash": ends["source"], "t_hash": ends["target"]}
    rec["history"].append(_entry(now, "ratify", by, note))
    save(profile_dir, data)
    return rec


def reject(profile_dir: str | Path, mapping_id: str, *, by: str, reason: str, scope: str | None = None,
           now: datetime | None = None) -> dict:
    data, rec = _locate(profile_dir, mapping_id, scope)
    if not reason or not reason.strip():
        raise MappingError("A rejection needs a reason.")
    if rec["status"] not in ("proposed", "ratified"):
        raise MappingError(f"{mapping_id} is {rec['status']} and cannot be rejected.")
    by = _actor(by, "A rejection")
    if _same_person(by, rec["maker"]):
        raise MappingError(f"{mapping_id} cannot be rejected by its maker, because the checker must be a different person.")
    rec["status"] = "rejected"
    rec["checker"] = by
    rec["reason"] = reason
    # a rejected mapping no longer holds from any date and no longer vouches for the ends it was anchored to
    rec["valid_from"] = None
    rec["anchors"] = {"s_hash": None, "t_hash": None}
    rec["history"].append(_entry(now, "reject", by, reason))
    save(profile_dir, data)
    return rec


def edit(profile_dir: str | Path, mapping_id: str, *, by: str, basis: str | None = None, owner: str | None = None,
         scope: str | None = None, now: datetime | None = None) -> dict:
    """Change the basis or owner. A ratified mapping returns to proposed with no checker and no anchors."""
    data, rec = _locate(profile_dir, mapping_id, scope)
    by = _actor(by, "An edit")
    if rec["status"] in ("rejected", "superseded"):
        raise MappingError(f"{mapping_id} is {rec['status']} and cannot be edited.")
    if basis is not None:
        rec["basis"] = basis
    if owner is not None:
        rec["owner"] = owner
    if rec["status"] == "ratified":
        rec["status"] = "proposed"
        rec["checker"] = None
        rec["valid_from"] = None
        rec["anchors"] = {"s_hash": None, "t_hash": None}
    rec["history"].append(_entry(now, "edit", by, None))
    save(profile_dir, data)
    return rec


def reassign(profile_dir: str | Path, mapping_id: str, *, by: str, owner: str, scope: str | None = None,
             now: datetime | None = None) -> dict:
    """Move the mapping to a new owner without changing its status."""
    data, rec = _locate(profile_dir, mapping_id, scope)
    by = _actor(by, "A reassignment")
    if rec["status"] in ("rejected", "superseded"):
        raise MappingError(f"{mapping_id} is {rec['status']} and cannot be reassigned.")
    if not owner or not owner.strip():
        raise MappingError("A reassignment needs the new owner.")
    previous = rec["owner"]
    rec["owner"] = owner
    rec["history"].append(_entry(now, "reassign", by, f"from {previous} to {owner}"))
    save(profile_dir, data)
    return rec


def supersede(profile_dir: str | Path, mapping_id: str, *, by: str, replacement_id: str, scope: str | None = None,
              now: datetime | None = None) -> dict:
    data, rec = _locate(profile_dir, mapping_id, scope)
    by = _actor(by, "A supersession")
    if rec["status"] == "superseded":
        raise MappingError(f"{mapping_id} is already superseded.")
    if replacement_id == mapping_id:
        raise MappingError(f"{mapping_id} cannot be superseded by itself.")
    _data, new = _locate(profile_dir, replacement_id, None)
    if new["status"] not in ("proposed", "ratified"):
        raise MappingError(f"{replacement_id} is {new['status']}, so it cannot replace {mapping_id}. "
                           "A replacement must be proposed or ratified.")
    rec["status"] = "superseded"
    rec["superseded_by"] = replacement_id
    rec["valid_to"] = _stamp(now).strftime("%Y-%m-%d")
    rec["history"].append(_entry(now, "supersede", by, replacement_id))
    save(profile_dir, data)
    return rec


def list_mappings(profile_dir: str | Path, *, status: str | None = None, owner: str | None = None,
                  scope: str | None = None) -> list[dict]:
    out = []
    for sc in ([scope] if scope else scopes(profile_dir)):
        for m in load(profile_dir, sc)["mappings"]:
            if status and m["status"] != status:
                continue
            if owner and m["owner"] != owner:
                continue
            out.append({**m, "scope": sc})
    return out


def stale_reasons(rec: dict, resolve: Resolver) -> list[str]:
    """Why a ratified mapping no longer matches the graph: an end that changed or is absent, or a ratification that
    recorded no anchor for an end, which leaves nothing to compare with."""
    if rec["status"] != "ratified":
        return []
    why = []
    for label, nid, anchor in (("source", rec["s"], rec["anchors"]["s_hash"]), ("target", rec["t"], rec["anchors"]["t_hash"])):
        node = resolve(nid)
        if node is None:
            why.append(f"The {label} {nid} is absent from the graph.")
        elif anchor is None:
            why.append(f"The {label} {nid} has no anchor, so the ratification cannot be compared with the graph.")
        elif node_hash(node) != anchor:
            why.append(f"The {label} {nid} has changed since ratification.")
    return why


def list_stale(profile_dir: str | Path, resolve: Resolver, *, scope: str | None = None) -> list[dict]:
    out = []
    for m in list_mappings(profile_dir, status="ratified", scope=scope):
        why = stale_reasons(m, resolve)
        if why:
            out.append({**m, "stale": why})
    return out


def graph_parts(profile_dir: str | Path, scope: str | None = None) -> tuple[list[dict], list[dict]]:
    """The cx:Mapping nodes and the edges for the graph. A proposed mapping gives an edge of provenance proposed at
    half weight, a ratified one gives an edge of provenance ratified, and a rejected or superseded one gives no edge.
    The evidence is <file>#<id>, the form that check P08 resolves."""
    nodes, edges = [], []
    for m in list_mappings(profile_dir, scope=scope):
        evidence = f"mappings/{m['scope']}.json#{m['id']}"
        props = {"relation": m["relation"], "s": m["s"], "t": m["t"], "owner": m["owner"], "maker": m["maker"],
                 "checker": m["checker"], "origin": m["origin"], "valid_from": m["valid_from"]}
        if m["status"] == "ratified":   # the anchors and the date that shape F04 reads; an absent value writes no triple
            anchors = m.get("anchors") or {}
            props.update(sourceAnchor=anchors.get("s_hash"), targetAnchor=anchors.get("t_hash"), ratifiedOn=m["valid_from"])
        nodes.append({
            "id": m["id"], "type": "Mapping", "label": f"{m['relation']}: {m['s']} to {m['t']}",
            "status": m["status"], "evidence": evidence, "sensitivity": "internal", "props": props,
        })
        if m["status"] == "proposed":
            edges.append({"s": m["s"], "r": m["relation"], "t": m["t"], "evidence": evidence,
                          "provenance": "proposed", "weight": PROPOSED_WEIGHT, "mapping": m["id"]})
        elif m["status"] == "ratified":
            edges.append({"s": m["s"], "r": m["relation"], "t": m["t"], "evidence": evidence,
                          "provenance": "ratified", "weight": 1.0, "mapping": m["id"]})
    return nodes, edges


def person_parts(nodes: list[dict]) -> tuple[list[dict], list[dict]]:
    """The Person nodes and the ownedBy, proposedBy and approvedBy edges of the mapping nodes of graph_parts, which
    shapes F02 and F03 read. An owner or maker that the record leaves empty gives no edge, so that F02 still fires, and
    only a ratified mapping gives an approvedBy edge from its checker."""
    from .instructions import person_node
    people: dict[str, dict] = {}
    edges: list[dict] = []
    for n in nodes:
        p = n.get("props") or {}
        for rel, who in (("ownedBy", p.get("owner")), ("proposedBy", p.get("maker")),
                         ("approvedBy", p.get("checker") if n.get("status") == "ratified" else None)):
            if not who or not str(who).strip():
                continue
            pid = person_node(str(who))
            people.setdefault(pid, {"id": pid, "type": "Person", "label": str(who), "status": None, "evidence": None,
                                    "sensitivity": "internal", "props": {}})
            edges.append({"s": n["id"], "r": rel, "t": pid, "evidence": n["evidence"], "provenance": "stated", "weight": 1.0})
    return list(people.values()), edges
