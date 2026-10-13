"""Mappers from OpenTelemetry generative AI spans and Claude Agent SDK events to ranviera.run.v1 records.

Each mapper returns a list of record dicts, which ingest_run validates exactly as it validates a run.v1 file, so a
mapper cannot bypass the format. Prompt, tool and rationale text is hashed here and never copied into a record.
The attribute names are set out in docs/TRACE.md.
"""
from __future__ import annotations

import json

from .runledger import canonical, sha256_hex

SCHEMA = "ranviera.run.v1"
_PAYLOAD_JSON = ("instructions_loaded", "evidence", "cited", "checks_ticked")
_PAYLOAD_PLAIN = ("tool", "input_hash", "output_hash", "outcome", "rationale_hash", "content_ref", "override",
                  "override_reason", "reviewer", "verdict", "time_open_s", "items_viewed", "thinking_tokens")


class MapError(ValueError):
    """The source cannot be turned into a run record."""


def hash_of(value) -> str:
    """sha256 of the canonical JSON of a structure, of a JSON text parsed first, or of other text as it stands. A tool
    argument therefore has one hash whether a route holds it as an object or as a JSON string."""
    if isinstance(value, str):
        s = value.strip()
        if s[:1] in ("{", "["):
            try:
                return "sha256:" + sha256_hex(canonical(json.loads(s)))
            except ValueError:
                pass
        return "sha256:" + sha256_hex(value)
    return "sha256:" + sha256_hex(canonical(value))


def iso_from_nanos(ns: int) -> str:
    from datetime import datetime, timezone
    sec, rem = divmod(int(ns), 10 ** 9)
    t = datetime.fromtimestamp(sec, timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{rem // 10 ** 6:03d}Z"


def _record(run, step, ts, kind, agent, payload, trace=None, case_ref=None) -> dict:
    rec = {"schema": SCHEMA, "run": run, "step": step, "ts": ts, "kind": kind, "agent": agent, "payload": payload}
    if trace:
        rec["trace"] = trace
    if case_ref:
        rec["case_ref"] = case_ref
    return rec


# OpenTelemetry

def _attr_value(v: dict):
    for k in ("stringValue", "boolValue", "doubleValue"):
        if k in v:
            return v[k]
    if "intValue" in v:
        return int(v["intValue"])
    if "arrayValue" in v:
        return [_attr_value(x) for x in v["arrayValue"].get("values", [])]
    return None


def _attrs(span: dict) -> dict:
    return {a["key"]: _attr_value(a.get("value", {})) for a in span.get("attributes", [])}


def _json_attr(value, name):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError as exc:
            raise MapError(f"attribute {name} is not valid JSON") from exc
    return value


def _payload_from(attrs: dict) -> dict:
    p: dict = {}
    for f in _PAYLOAD_JSON:
        if f"ranviera.{f}" in attrs:
            p[f] = _json_attr(attrs[f"ranviera.{f}"], f"ranviera.{f}")
    for f in _PAYLOAD_PLAIN:
        if f"ranviera.{f}" in attrs:
            p[f] = attrs[f"ranviera.{f}"]
    if "ranviera.rationale" in attrs and "rationale_hash" not in p:
        p["rationale_hash"] = hash_of(attrs["ranviera.rationale"])
    return p


def from_otlp(doc: dict) -> list[dict]:
    """Records for every trace in an OTLP JSON export. The run is the attribute ranviera.run, then
    gen_ai.conversation.id, then the trace identifier."""
    spans = [s for rs in doc.get("resourceSpans", []) for ss in rs.get("scopeSpans", []) for s in ss.get("spans", [])]
    if not spans:
        raise MapError("the export holds no spans")
    traces: dict[str, list[dict]] = {}
    for s in spans:
        traces.setdefault(s.get("traceId", ""), []).append(s)
    out: list[dict] = []
    for tid, group in traces.items():
        out.extend(_map_trace(tid, group))
    return out


def _map_trace(tid: str, spans: list[dict]) -> list[dict]:
    spans = sorted(spans, key=lambda s: (int(s.get("startTimeUnixNano", 0)), s.get("spanId", "")))
    root = next((s for s in spans if _attrs(s).get("gen_ai.operation.name") == "invoke_agent"), None)
    ra = _attrs(root) if root else {}
    run = next((str(a[k]) for a in (_attrs(s) for s in spans) for k in ("ranviera.run", "gen_ai.conversation.id")
                if k in a), tid)
    agent_id = ra.get("ranviera.agent") or ra.get("gen_ai.agent.id") or ra.get("gen_ai.agent.name")
    if not agent_id:
        raise MapError(f"trace {tid} names no agent (gen_ai.agent.id or ranviera.agent)")
    prompt_hash = ra.get("ranviera.prompt_hash") or (
        hash_of(ra["gen_ai.system_instructions"]) if "gen_ai.system_instructions" in ra else None)
    params = {k.rsplit(".", 1)[1]: v for k, v in ra.items() if k.startswith("gen_ai.request.") and k not in
              ("gen_ai.request.model",)}
    agent = {"id": str(agent_id), "model_version": ra.get("gen_ai.response.model") or ra.get("gen_ai.request.model"),
             "prompt_hash": prompt_hash, "params": params}
    for k in ("model_version", "prompt_hash"):
        if not agent[k]:
            raise MapError(f"trace {tid} gives no {k} for step 0")
    case_ref = ra.get("ranviera.case_ref")
    start_span = root or spans[0]
    start_payload = {"instructions_loaded": _json_attr(ra.get("ranviera.instructions_loaded", "[]"),
                                                      "ranviera.instructions_loaded")}
    recs = [_record(run, 0, iso_from_nanos(start_span["startTimeUnixNano"]), "start", agent, start_payload,
                    _trace(start_span), case_ref)]
    last_end = int(start_span.get("endTimeUnixNano", start_span["startTimeUnixNano"]))
    for s in spans:
        if s is root:
            continue
        a = _attrs(s)
        op = a.get("gen_ai.operation.name")
        payload = _payload_from(a)
        kind = a.get("ranviera.kind")
        if op in ("execute_tool", "retrieval"):
            kind = kind or ("tool" if op == "execute_tool" else "retrieval")
            if a.get("gen_ai.tool.name"):
                payload.setdefault("tool", a["gen_ai.tool.name"])
            if "gen_ai.tool.call.arguments" in a:
                payload.setdefault("input_hash", hash_of(a["gen_ai.tool.call.arguments"]))
            if "gen_ai.tool.call.result" in a:
                payload.setdefault("output_hash", hash_of(a["gen_ai.tool.call.result"]))
        if kind is None:
            if "outcome" in payload:
                kind = "decision"
            elif "rationale_hash" in payload:
                kind = "rationale"
            else:
                continue        # a model call with no Ranviera marker has no run step
        if kind in ("start", "end"):
            continue
        recs.append(_record(run, len(recs), iso_from_nanos(s["startTimeUnixNano"]), kind, agent, payload,
                            _trace(s), case_ref))
        last_end = max(last_end, int(s.get("endTimeUnixNano", s["startTimeUnixNano"])))
    reported = ra.get("ranviera.steps_reported", len(recs))
    recs.append(_record(run, len(recs), iso_from_nanos(last_end), "end", agent, {"steps_reported": int(reported)},
                        None, case_ref))
    return recs


def _trace(span: dict) -> dict | None:
    if not span.get("traceId") or not span.get("spanId"):
        return None
    return {"trace_id": span["traceId"], "span_id": span["spanId"], "parent_span_id": span.get("parentSpanId") or None}


# Claude Agent SDK

def _iso_plus(base: str, i: int) -> str:
    from datetime import datetime, timedelta, timezone
    t = datetime.strptime(base, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc) + timedelta(milliseconds=i)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def from_sdk_events(events: list[dict], run: str, agent_id: str, *, prompt_hash: str, params: dict | None = None,
                    model_version: str | None = None, instructions_loaded: list[dict] | None = None,
                    case_ref: str | None = None, decision_tool: str = "submit_decision",
                    evidence_tools: tuple[str, ...] = (), base_ts: str = "1970-01-01T00:00:00.000Z") -> list[dict]:
    """Records for the messages of one Claude Agent SDK query. An event with a ts key keeps it, and any other event takes
    base_ts plus its position in milliseconds. A tool_use of decision_tool becomes the decision record, with the outcome,
    cited and rationale fields of its input. A tool_use of a tool in evidence_tools becomes a retrieval record whose
    evidence item takes the tool_use id and the hash of the result. Assistant text becomes a rationale record, held as a
    hash. The instructions in context are not in the message stream, so the caller passes them."""
    init = next((e for e in events if e.get("type") == "system" and e.get("subtype") == "init"), None)
    model_version = model_version or (init or {}).get("model")
    if not model_version:
        raise MapError("no model version, so give model_version or an init event with a model")
    agent = {"id": agent_id, "model_version": model_version, "prompt_hash": prompt_hash, "params": params or {}}
    ts0 = (init or {}).get("ts") or events[0].get("ts") or base_ts if events else base_ts
    recs = [_record(run, 0, ts0, "start", agent, {"instructions_loaded": instructions_loaded or []}, None, case_ref)]
    pending: dict[str, dict] = {}
    last_ts = ts0
    for i, ev in enumerate(events):
        ts = ev.get("ts") or _iso_plus(base_ts, i)
        last_ts = ts
        content = (ev.get("message") or {}).get("content", [])
        if not isinstance(content, list):
            content = []
        if ev.get("type") == "assistant":
            for block in content:
                bt = block.get("type")
                if bt == "tool_use":
                    inp = block.get("input", {})
                    if block.get("name") == decision_tool:
                        payload = {"outcome": inp.get("outcome"), "cited": inp.get("cited", [])}
                        if inp.get("rationale"):
                            payload["rationale_hash"] = hash_of(inp["rationale"])
                        recs.append(_record(run, len(recs), ts, "decision", agent, payload, None, case_ref))
                    else:
                        kind = "retrieval" if block.get("name") in evidence_tools else "tool"
                        rec = _record(run, len(recs), ts, kind, agent,
                                      {"tool": block.get("name"), "input_hash": hash_of(inp)}, None, case_ref)
                        recs.append(rec)
                        pending[block.get("id", "")] = rec
                elif bt == "text" and block.get("text", "").strip():
                    recs.append(_record(run, len(recs), ts, "rationale", agent,
                                        {"rationale_hash": hash_of(block["text"])}, None, case_ref))
        elif ev.get("type") == "user":
            for block in content:
                if block.get("type") == "tool_result" and block.get("tool_use_id") in pending:
                    rec = pending[block["tool_use_id"]]
                    rec["payload"]["output_hash"] = hash_of(block.get("content"))
                    if rec["kind"] == "retrieval":
                        rec["payload"]["evidence"] = [{"id": block["tool_use_id"],
                                                       "hash": rec["payload"]["output_hash"]}]
    recs.append(_record(run, len(recs), last_ts, "end", agent, {"steps_reported": len(recs)}, None, case_ref))
    return recs


def records_to_lines(records: list[dict]) -> str:
    return "".join(canonical(r) + "\n" for r in records)


