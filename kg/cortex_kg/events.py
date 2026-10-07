"""Cortex events: one JSON line each, appended to a file for the month of the event.

The shape is fixed in docs/CONTRACTS.md. This module uses the standard library only, so that the event hook can
import it cheaply. append writes the whole line with a single write call, so that 2 writers do not interleave.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Iterator

V = 1


def canon_ts(value) -> str:
    """The canonical UTC form with milliseconds, from a datetime or an ISO 8601 string."""
    if isinstance(value, str):
        text = value.strip()
        if text.endswith(("Z", "z")):
            text = text[:-1] + "+00:00"
        value = datetime.fromisoformat(text)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    value = value.astimezone(timezone.utc)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def now_ts() -> str:
    return canon_ts(datetime.now(timezone.utc))


def make(kind: str, nodes, session: str, source: str, label: str, weight: float = 1.0,
         key: str | None = None, meta: dict | None = None) -> dict:
    """Build a CortexEvent with its version and timestamp set."""
    return {
        "v": V,
        "ts": now_ts(),
        "session": session,
        "source": source,
        "kind": kind,
        "nodes": list(nodes),
        "weight": float(weight),
        "label": label[:120],
        "key": key,
        "meta": dict(meta or {}),
    }


def month_file(cfg, ts: str):
    return cfg.events_dir / f"{ts[:7]}.jsonl"


def append(cfg, event: dict) -> None:
    """Append one line to the month file chosen by the event's ts. The file is opened in append mode."""
    path = month_file(cfg, event["ts"])
    path.parent.mkdir(parents=True, exist_ok=True)
    line = (json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    fd = os.open(str(path), os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o666)
    try:
        os.write(fd, line)
    finally:
        os.close(fd)


def valid(ev) -> bool:
    """Whether a parsed line has the shape of docs/CONTRACTS.md: version 1, a readable timestamp, text for the session,
    source, kind and label, a list of node ids, a numeric weight, a key that is null or text, and a meta object."""
    if not isinstance(ev, dict) or ev.get("v") != V:
        return False
    for name in ("ts", "session", "source", "kind", "label"):
        if not isinstance(ev.get(name), str):
            return False
    try:
        canon_ts(ev["ts"])
    except ValueError:
        return False
    nodes = ev.get("nodes")
    if not isinstance(nodes, list) or not all(isinstance(n, str) for n in nodes):
        return False
    weight = ev.get("weight")
    if isinstance(weight, bool) or not isinstance(weight, (int, float)):
        return False
    return (ev.get("key") is None or isinstance(ev["key"], str)) and isinstance(ev.get("meta"), dict)


def read(cfg, since=None, until=None, stats: dict | None = None) -> Iterator[dict]:
    """Yield events in file order, from the first month file to the last, between since and until. A line that is not
    JSON or does not match the event shape is skipped, and counted in stats["invalid"] when a stats dict is given."""
    lo = canon_ts(since) if since is not None else None
    hi = canon_ts(until) if until is not None else None
    d = cfg.events_dir
    if not d.is_dir():
        return
    for f in sorted(d.glob("*.jsonl")):
        month = f.stem
        if lo is not None and month < lo[:7]:
            continue
        if hi is not None and month > hi[:7]:
            continue
        with f.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    ev = None
                if not valid(ev):
                    if stats is not None:
                        stats["invalid"] = stats.get("invalid", 0) + 1
                    continue
                ts = ev.get("ts")
                if (lo is not None or hi is not None) and isinstance(ts, str):
                    try:
                        c = canon_ts(ts)
                    except ValueError:  # unreachable once valid() has passed, kept for safety
                        continue
                    if (lo is not None and c < lo) or (hi is not None and c > hi):
                        continue
                yield ev
