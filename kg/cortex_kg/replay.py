"""Replay past Claude Code chats and the register log into Cortex events.

Each tool call in a transcript is mapped as a synthetic PreToolUse payload, so that a replayed event matches the
event the live hook would have written. Prompt text is never stored. The transcript shapes were checked against
_work/scripts/usage_scan.py (the logic is copied, not imported).
"""
from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone

from . import events, hookmap
from .model import slugify

_ROUTE_BLOCK = "Rules for this task"
_ROUTE_LINE = re.compile(r"^- ([^:\n]+?):\s", re.M)
_SYSTEM_MARKS = ("<task-notification>", "<command-name>", "<system-reminder>", "<local-command", "SYSTEM NOTIFICATION")


def _texts(entry: dict) -> list[str]:
    """The text strings of a transcript entry: message content, and the content of an attached hook context."""
    out: list[str] = []

    def take(c):
        if isinstance(c, str):
            out.append(c)
        elif isinstance(c, list):
            for b in c:
                if isinstance(b, str):
                    out.append(b)
                elif isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str):
                    out.append(b["text"])

    m = entry.get("message")
    if isinstance(m, dict):
        take(m.get("content"))
    a = entry.get("attachment")
    if isinstance(a, dict):
        take(a.get("content"))
    return out


def _route_names(text: str) -> list[str]:
    i = text.find(_ROUTE_BLOCK)
    if i < 0:
        return []
    block = text[i + len(_ROUTE_BLOCK):]
    names = []
    for m in _ROUTE_LINE.finditer(block):
        names.append(m.group(1).strip())
    return names


def _ts(value) -> str | None:
    try:
        return events.canon_ts(value) if value else None
    except ValueError:
        return None


def _local_ts(value) -> str | None:
    """The register log writes local naive times, so they are read as local and converted to UTC."""
    try:
        d = datetime.fromisoformat(str(value))
        return events.canon_ts(d.astimezone(timezone.utc) if d.tzinfo is None else d)
    except ValueError:
        return None


def _load_index(cfg) -> dict:
    try:
        return json.loads((cfg.data_dir / "index.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"v": 1, "paths": {}, "prefixes": [], "routes": [], "skills": {}, "agents": {}, "tools": {},
                "terms": [], "faults": {}, "hooks": {}, "always": []}


def _transcript_events(f, index, stats, subagent: bool):
    """Yield events from one transcript file, counting its lines."""
    with f.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            stats["lines"] += 1
            if '"tool_use"' not in line and _ROUTE_BLOCK not in line and '"type":"user"' not in line \
                    and '"type": "user"' not in line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(e, dict):
                continue
            ts = _ts(e.get("timestamp"))
            if not ts:
                continue
            sid = e.get("sessionId") or f.stem
            uuid = e.get("uuid")
            m = e.get("message") if isinstance(e.get("message"), dict) else {}
            c = m.get("content")
            t = e.get("type")
            if t == "assistant" and isinstance(c, list):
                for b in c:
                    if not isinstance(b, dict) or b.get("type") != "tool_use":
                        continue
                    payload = {"session_id": sid, "hook_event_name": "PreToolUse", "tool_name": b.get("name") or "",
                               "tool_input": b.get("input") if isinstance(b.get("input"), dict) else {},
                               "tool_use_id": b.get("id")}
                    if e.get("cwd"):
                        payload["cwd"] = e["cwd"]
                    ev = hookmap.map_hook(payload, index)
                    if ev:
                        ev["key"] = b.get("id") or uuid
                        yield ev, ts, sid
            if t in ("user", "attachment"):
                texts = _texts(e)
                names: list[str] = []
                for tx in texts:
                    names += _route_names(tx)
                if names:
                    ids = ["route:" + slugify(n) for n in dict.fromkeys(names)]
                    ev = events.make("route", ids, sid, "replay", "Prompt routed to " + ", ".join(dict.fromkeys(names)),
                                     hookmap.WEIGHTS["route"], f"route:{uuid}" if uuid else None,
                                     {"matched_routes": ids})
                    yield ev, ts, sid
                if t == "user" and not subagent and not e.get("isSidechain") and not e.get("isMeta") \
                        and isinstance(c, str) and c.strip() and not any(s in c for s in _SYSTEM_MARKS):
                    payload = {"session_id": sid, "hook_event_name": "UserPromptSubmit", "prompt": c}
                    ev = hookmap.map_hook(payload, index, log_snippets=False)
                    if ev:
                        ev["key"] = uuid
                        yield ev, ts, sid


def _register_events(cfg, since_ts):
    d = cfg.claude_home / "register-log"
    if not d.is_dir():
        return
    for f in sorted(d.glob("*.jsonl")):
        with f.open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(r, dict) or not r.get("faults") or r.get("kind") not in ("file", "reply", "stop"):
                    continue
                ts = _local_ts(r.get("t"))
                if not ts:
                    continue
                keys = [str(k) for k in r["faults"]]
                sid = r.get("session") or "unknown"
                ev = events.make("fault", ["fault:" + k for k in keys], sid, "replay",
                                 "Register fault: " + ", ".join(keys), 0.6,
                                 f"register:{r.get('t')}:{sid}:{r.get('path', '')}",
                                 {"faults": keys, "path": r.get("path", ""), "record": r.get("kind")})
                yield ev, ts, sid


def replay(cfg, since=None, dry_run: bool = False) -> dict:
    """Stream every transcript and register record into events. Returns the counts and the time taken."""
    t0 = time.time()
    since_ts = events.canon_ts(since) if since is not None else None
    index = _load_index(cfg)
    existing = {ev.get("key") for ev in events.read(cfg) if ev.get("key")}
    stats = {"files": 0, "lines": 0}
    by_kind: dict[str, int] = {}
    pending: list[tuple[str, int, dict]] = []
    new = skipped = 0
    seq = 0

    def accept(ev, ts):
        nonlocal new, skipped, seq
        if since_ts and ts < since_ts:
            return
        key = ev.get("key")
        if key and key in existing:
            skipped += 1
            return
        if key:
            existing.add(key)
        ev["ts"] = ts
        ev["source"] = "replay"
        new += 1
        by_kind[ev["kind"]] = by_kind.get(ev["kind"], 0) + 1
        if not dry_run:
            seq += 1
            pending.append((ts, seq, ev))

    root = cfg.claude_home / "projects"
    if root.is_dir():
        for f in sorted(root.rglob("*.jsonl")):
            stats["files"] += 1
            sub = "subagents" in f.parts
            for ev, ts, _sid in _transcript_events(f, index, stats, sub):
                accept(ev, ts)
    for ev, ts, _sid in _register_events(cfg, since_ts):
        accept(ev, ts)
    written = 0
    if not dry_run:
        pending.sort(key=lambda x: (x[0], x[1]))
        for _ts_, _n, ev in pending:
            events.append(cfg, ev)
            written += 1
    return {"files": stats["files"], "lines": stats["lines"], "events_written": written,
            "events_new": new, "skipped_duplicates": skipped, "by_kind": by_kind,
            "dry_run": dry_run, "seconds": round(time.time() - t0, 2)}
