"""Spreading activation and base-level activation.

This is the reference implementation. server/src/activation.ts must give the same result to 6 decimal places on
the fixtures in kg/tests/fixtures/activation/. The rules are fixed in docs/CONTRACTS.md.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone

DEFAULT_PARAMS = {"decay": 0.6, "max_hops": 2, "threshold": 0.05, "fan_exponent": 0.5}


def weights_table(weights) -> dict:
    """Accept the relation weights as {relation: {weight, reverse_weight}}, as the list in ontology/weights.json
    ({"relations": [{id, weight, reverse_weight}]}) or as the relations list of graph.json."""
    if isinstance(weights, dict) and isinstance(weights.get("relations"), list):
        weights = weights["relations"]
    if isinstance(weights, list):
        return {row["id"]: row for row in weights if isinstance(row, dict) and "id" in row}
    return weights or {}


def adjacency_from_graph(graph_json: dict, weights) -> dict[str, list[tuple[str, float]]]:
    """Each edge {s, r, t} gives s to t at the relation's weight and t to s at its reverse weight.

    An edge whose relation has no entry in weights is left out. Each list is sorted by neighbour id, and the
    degree of a node is the length of its list.
    """
    weights = weights_table(weights)
    adj: dict[str, list[tuple[str, float]]] = {}
    for e in graph_json.get("edges", []):
        w = weights.get(e["r"])
        if not w:
            continue
        adj.setdefault(e["s"], []).append((e["t"], float(w["weight"])))
        adj.setdefault(e["t"], []).append((e["s"], float(w["reverse_weight"])))
    for lst in adj.values():
        lst.sort(key=lambda x: x[0])
    return adj


def spread(adjacency: dict, fired, weights: dict | None = None, params: dict | None = None) -> list[dict]:
    """Spread activation from the fired nodes. fired is a list of (id, a) pairs.

    The weights argument is kept for the call signature, because the adjacency already holds them.
    Returns a list of {id, a, hop, via} sorted by a descending and then id.
    """
    p = {**DEFAULT_PARAMS, **(params or {})}
    decay, max_hops = float(p["decay"]), int(p["max_hops"])
    threshold, fan = float(p["threshold"]), float(p["fan_exponent"])
    best: dict[str, tuple[float, int, str | None]] = {}
    for nid, a in fired:
        a = float(a)
        if nid not in best or a > best[nid][0]:
            best[nid] = (a, 0, None)
    for hop in range(1, max_hops + 1):
        # the frontier is a snapshot, so that a node improved during this hop does not change the others
        frontier = sorted(((n, a) for n, (a, h, _v) in best.items() if h == hop - 1), key=lambda x: (-x[1], x[0]))
        for u, a_u in frontier:
            entries = adjacency.get(u, [])
            if not entries:
                continue
            scale = decay / (len(entries) ** fan)
            for v, w in sorted(entries, key=lambda x: x[0]):
                a_v = a_u * w * scale
                if a_v >= threshold and (v not in best or a_v > best[v][0]):
                    best[v] = (a_v, hop, u)
    out = [{"id": n, "a": a, "hop": h, "via": via} for n, (a, h, via) in best.items()]
    out.sort(key=lambda r: (-r["a"], r["id"]))
    return out


def _dt(value) -> datetime:
    if isinstance(value, datetime):
        d = value
    else:
        s = str(value).strip()
        d = datetime.fromisoformat(s[:-1] + "+00:00" if s.endswith(("Z", "z")) else s)
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def base_level(timestamps, now, d: float = 0.5, min_age_days: float = 0.01):
    """ACT-R base-level activation, ln of the sum of age_days ** -d, or None when there is no use."""
    now_dt = _dt(now)
    total = 0.0
    n = 0
    for t in timestamps:
        age = (now_dt - _dt(t)).total_seconds() / 86400.0
        total += max(age, min_age_days) ** -d
        n += 1
    return math.log(total) if n else None
