"""Run capture: ranviera.run.v1 records to the nodes and edges of a run, with ledger entries.

The record format is in docs/CONTRACTS.md and docs/TRACE.md. A run becomes cx: Run, Step, ToolCall, Evidence,
StatedRationale, AgentDecision and Review nodes. `inContext` (what was loaded, recorded) and `citesInstruction` (what
the agent says it followed, a claim) are separate relations, so that rule O04 can compare them. A stated rationale is
held as a hash and carries causalStatus "unverified": the record shows what the agent wrote and does not show that the
text caused the decision.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import trace_map
from .fileio import write_atomic
from .model import slugify
from .runledger import RunLedger, canonical, record_hash

SCHEMA = "ranviera.run.v1"
KINDS = ("start", "instructions", "retrieval", "tool", "evidence", "rationale", "decision", "review", "end")
OUTCOMES = ("close", "escalate", "request-information")
FORMATS = ("run.v1", "otlp", "hook", "gateway")
HASH = re.compile(r"^sha256:[0-9a-f]{64}$")
TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
INFORMING = ("retrieval", "tool", "evidence", "rationale", "decision")

# classes of the nodes this module writes, by id prefix (docs/ONTOLOGY.md, agent side classes)
RUN_CLASSES = {
    "run": "Run", "step": "Step", "call": "ToolCall", "evid": "Evidence", "rationale": "StatedRationale",
    "adec": "AgentDecision", "review": "Review", "dagent": "DeployedAgent", "instr": "InstructionVersion",
    "model": "ModelVersion", "ksrc": "KnowledgeSource",
}
CAUSAL_STATUS = "unverified"


class RunFormatError(ValueError):
    """A record breaks the format. line is the 1 based line number, or 0 where no line applies."""

    def __init__(self, message: str, line: int = 0):
        super().__init__(f"line {line}: {message}" if line else message)
        self.line = line
        self.message = message


# validation

def _need(cond: bool, msg: str, line: int) -> None:
    if not cond:
        raise RunFormatError(msg, line)


def _hashes(values, what: str, line: int) -> None:
    for v in values:
        _need(isinstance(v, str) and HASH.match(v) is not None, f"{what} must be sha256: and 64 lower case hexadecimal "
                                                                f"characters", line)


def validate_record(r, line: int = 0) -> None:
    _need(isinstance(r, dict), "the record is not a JSON object", line)
    _need(r.get("schema") == SCHEMA, f"schema must be {SCHEMA}", line)
    _need(isinstance(r.get("run"), str) and r["run"], "run must be a non-empty string", line)
    _need(isinstance(r.get("step"), int) and not isinstance(r["step"], bool) and r["step"] >= 0,
          "step must be an integer of 0 or more", line)
    _need(isinstance(r.get("ts"), str) and TS.match(r["ts"]) is not None,
          "ts must be ISO 8601 UTC with milliseconds, such as 2026-10-07T09:30:00.000Z", line)
    _need(r.get("kind") in KINDS, f"kind must be one of {', '.join(KINDS)}", line)
    ag = r.get("agent")
    _need(isinstance(ag, dict) and isinstance(ag.get("id"), str) and ag["id"], "agent.id is required", line)
    p = r.get("payload")
    _need(isinstance(p, dict), "payload must be an object", line)
    if r["step"] == 0:
        _need(r["kind"] == "start", "step 0 must be of kind start", line)
        for k in ("model_version", "prompt_hash", "params"):
            _need(ag.get(k) not in (None, ""), f"agent.{k} is required at step 0", line)
        _need(isinstance(ag["params"], dict), "agent.params must be an object", line)
    else:
        _need(r["kind"] != "start", "only step 0 may be of kind start", line)
    if ag.get("prompt_hash") is not None:
        _hashes([ag["prompt_hash"]], "agent.prompt_hash", line)
    if r["kind"] == "start":
        _need(isinstance(p.get("instructions_loaded"), list), "payload.instructions_loaded is required on start", line)
    for item in p.get("instructions_loaded", []):
        _need(isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"], "an instruction needs an id", line)
        _hashes([item.get("hash")], "instructions_loaded hash", line)
    for item in p.get("evidence", []):
        _need(isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"], "an evidence item needs an id", line)
        _hashes([item.get("hash")] + ([item["source_hash"]] if item.get("source_hash") else []), "evidence hash", line)
    _hashes([p[k] for k in ("input_hash", "output_hash", "rationale_hash") if k in p], "a payload hash", line)
    if "cited" in p:
        _need(isinstance(p["cited"], list) and all(isinstance(c, str) and c for c in p["cited"]),
              "payload.cited must be a list of identifiers", line)
    if "outcome" in p:
        _need(p["outcome"] in OUTCOMES, f"outcome must be one of {', '.join(OUTCOMES)}", line)
    if r["kind"] == "decision":
        _need("outcome" in p, "a decision record needs an outcome", line)
    if r["kind"] == "end":
        _need(isinstance(p.get("steps_reported"), int) and p["steps_reported"] >= 0,
              "payload.steps_reported is required on end", line)
    if "override" in p:
        _need(isinstance(p["override"], bool), "payload.override must be true or false", line)
    if "trace" in r:
        t = r["trace"]
        _need(isinstance(t, dict) and isinstance(t.get("trace_id"), str) and isinstance(t.get("span_id"), str),
              "trace needs trace_id and span_id", line)


def check_runs(records: list[tuple[int, dict]]) -> list[dict]:
    """Drop an exact duplicate, refuse a conflicting one and a gap, and return the records in run and step order."""
    seen: dict[tuple[str, int], tuple[int, str]] = {}
    keep: list[dict] = []
    for line, r in records:
        key = (r["run"], r["step"])
        text = canonical(r)
        if key in seen:
            _need(seen[key][1] == text, f"run {r['run']} step {r['step']} repeats line {seen[key][0]} with other content",
                  line)
            continue
        seen[key] = (line, text)
        keep.append(r)
    by_run: dict[str, list[int]] = {}
    for r in keep:
        by_run.setdefault(r["run"], []).append(r["step"])
    for run, steps in by_run.items():
        steps.sort()
        _need(steps == list(range(len(steps))), f"run {run} has a gap in its steps, so none of it was written", 0)
        agents = {r["agent"]["id"] for r in keep if r["run"] == run}
        _need(len(agents) == 1, f"run {run} names more than one agent", 0)
    keep.sort(key=lambda r: (r["run"], r["step"]))
    return keep


def parse_lines(text: str) -> list[dict]:
    """Read ranviera.run.v1 lines. Raises RunFormatError with the line number of the first fault."""
    if text.startswith("﻿"):
        raise RunFormatError("the file starts with a byte order mark", 1)
    items: list[tuple[int, dict]] = []
    for n, raw in enumerate(text.splitlines(), 1):
        if not raw.strip():
            continue
        try:
            rec = json.loads(raw)
        except ValueError:
            raise RunFormatError("the line is not valid JSON", n) from None
        validate_record(rec, n)
        items.append((n, rec))
    _need(bool(items), "the input holds no records", 0)
    return check_runs(items)


def read_records(text: str, fmt: str = "run.v1") -> list[dict]:
    if fmt == "run.v1":
        return parse_lines(text)
    if fmt == "otlp":
        try:
            doc = json.loads(text)
        except ValueError:
            raise RunFormatError("the OpenTelemetry export is not valid JSON") from None
        try:
            recs = trace_map.from_otlp(doc)
        except trace_map.MapError as exc:
            raise RunFormatError(str(exc)) from None
        items = []
        for i, r in enumerate(recs, 1):
            validate_record(r, i)
            items.append((i, r))
        return check_runs(items)
    if fmt in ("hook", "gateway"):
        raise RunFormatError(f"the {fmt} route waits for its capture extension, which is outside this build")
    raise RunFormatError(f"unknown format {fmt}")


# graph

@dataclass
class RunGraph:
    run_id: str = ""
    nodes: dict[str, dict] = field(default_factory=dict)
    edges: dict[tuple[str, str, str], dict] = field(default_factory=dict)

    def node(self, nid: str, label: str, evidence: str | None = None, **props) -> dict:
        cls = RUN_CLASSES[nid.split(":", 1)[0]]
        n = self.nodes.setdefault(nid, {"id": nid, "type": cls, "label": label, "props": {}, "evidence": evidence})
        for k, v in props.items():
            if v is not None:
                n["props"].setdefault(k, v)
        return n

    def edge(self, s: str, r: str, t: str, evidence: str | None = None) -> None:
        self.edges.setdefault((s, r, t), {"s": s, "r": r, "t": t, "evidence": evidence})

    def to_json(self) -> dict:
        return {"v": 1, "run": self.run_id, "nodes": sorted(self.nodes.values(), key=lambda n: n["id"]),
                "edges": sorted(self.edges.values(), key=lambda e: (e["s"], e["r"], e["t"]))}


def instr_id(raw: str) -> str:
    return raw if raw.startswith("instr:") else "instr:" + raw


def build_graph(records: list[dict]) -> list[RunGraph]:
    """One RunGraph for each run in the records, which must have passed check_runs."""
    runs: dict[str, list[dict]] = {}
    for r in records:
        runs.setdefault(r["run"], []).append(r)
    return [_build_run(rs) for rs in runs.values()]


def _build_run(recs: list[dict]) -> RunGraph:
    g = RunGraph()
    first = recs[0]
    agent = first["agent"]
    key = slugify(f"{agent['id']}-{first['run']}", 80)
    run_id = f"run:{key}"
    g.run_id = run_id
    ev = lambda r: f"run:{r['run']}#{r['step']}"                                   # noqa: E731
    replayable = all(agent.get(k) not in (None, "") for k in ("model_version", "prompt_hash")) and isinstance(
        agent.get("params"), dict)
    end = next((r for r in recs if r["kind"] == "end"), None)
    g.node(run_id, f"Run {first['run']}", ev(first), startedAt=first["ts"], endedAt=end["ts"] if end else None,
           replayStatus="replayable" if replayable else "not-replayable", caseRef=first.get("case_ref"),
           stepsReported=end["payload"]["steps_reported"] if end else None, ended=bool(end),
           promptHash=agent.get("prompt_hash"))
    aid = f"dagent:{slugify(agent['id'])}"
    g.node(aid, agent["id"], ev(first))
    g.edge(run_id, "performedBy", aid, ev(first))
    mid = f"model:{slugify(agent['model_version'])}"
    g.node(mid, agent["model_version"], ev(first), modelId=agent["model_version"],
           parameters=canonical(agent.get("params", {})), promptHash=agent.get("prompt_hash"))
    g.edge(run_id, "ranOn", mid, ev(first))

    in_context: list[str] = []                 # recorded context, grown by start and instructions records
    since_decision: list[str] = []             # informing steps after the last decision
    last_decision: str | None = None
    last_rationale: str | None = None
    for r in recs:
        p = r["payload"]
        sid = f"step:{key}-{r['step']:03d}"
        g.node(sid, f"{r['kind']} {r['step']}", ev(r), ordinal=r["step"], stepKind=r["kind"], ts=r["ts"])
        g.edge(run_id, "contains", sid, ev(r))
        for item in p.get("instructions_loaded", []):
            iid = instr_id(item["id"])
            g.node(iid, item["id"], ev(r), hash=item["hash"], path=item.get("path"))
            if iid not in in_context:
                in_context.append(iid)
        for iid in in_context:
            g.edge(sid, "inContext", iid, ev(r))
        for c in p.get("cited", []):
            iid = instr_id(c)
            g.node(iid, c, ev(r))
            g.edge(sid, "citesInstruction", iid, ev(r))
        if "tool" in p:
            cid = f"call:{key}-{r['step']:03d}"
            g.node(cid, p["tool"], ev(r), tool=p["tool"], inputHash=p.get("input_hash"),
                   outputHash=p.get("output_hash"))
            g.edge(sid, "contains", cid, ev(r))
        for item in p.get("evidence", []):
            eid = f"evid:{slugify(item['id'], 48)}-{item['hash'][7:15]}"
            g.node(eid, item["id"], ev(r), hash=item["hash"], sourceHash=item.get("source_hash"),
                   sourceRef=item.get("source"))
            g.edge(sid, "usedEvidence", eid, ev(r))
            if item.get("source"):
                kid = f"ksrc:{slugify(item['source'], 48)}"
                g.node(kid, item["source"], ev(r), snapshotHash=item.get("source_hash"))
                g.edge(eid, "sourcedFrom", kid, ev(r))
        if "rationale_hash" in p:
            rid = f"rationale:{key}-{r['step']:03d}"
            g.node(rid, f"Stated rationale {r['step']}", ev(r), hash=p["rationale_hash"], contentRef=p.get("content_ref"),
                   causalStatus=CAUSAL_STATUS)
            g.edge(sid, "contains", rid, ev(r))
            last_rationale = rid
        if r["kind"] in INFORMING and r["kind"] != "decision":
            since_decision.append(sid)
        if r["kind"] == "decision":
            did = f"adec:{key}-{r['step']:03d}"
            g.node(did, f"Decision {r['step']}", ev(r), outcome=p["outcome"],
                   statedRationale=last_rationale, caseRef=r.get("case_ref"))
            if last_rationale:
                g.edge(did, "statesRationale", last_rationale, ev(r))
                last_rationale = None   # a later decision must not borrow this rationale
            for s in since_decision + [sid]:
                g.edge(s, "informedDecision", did, ev(r))
            since_decision, last_decision = [], did
        if r["kind"] == "review":
            vid = f"review:{key}-{r['step']:03d}"
            g.node(vid, f"Review {r['step']}", ev(r), reviewer=p.get("reviewer"), verdict=p.get("verdict"),
                   override=p.get("override"), overrideReason=p.get("override_reason"), timeOpenS=p.get("time_open_s"),
                   itemsViewed=p.get("items_viewed"), checksTicked=p.get("checks_ticked"))
            if last_decision:
                g.edge(last_decision, "reviewedBy", vid, ev(r))
    return g


def graph_signature(g: RunGraph) -> str:
    """The graph without timestamps and evidence strings, for the conformance test of the 3 routes."""
    j = g.to_json()
    for n in j["nodes"]:
        n["props"] = {k: v for k, v in n["props"].items() if k not in ("ts", "startedAt", "endedAt")}
        n["evidence"] = None
    for e in j["edges"]:
        e["evidence"] = None
    return canonical(j)


# ingest

def ingest(text: str, data_dir: str | Path, fmt: str = "run.v1", actor: str = "system", key: bytes | None = None,
           key_id: str | None = None) -> dict:
    """Validate, then write the graph, the records and the ledger entries of each run. A run that fails validation writes
    nothing. A record already in the ledger is skipped where its hash matches and refused where it differs."""
    records = read_records(text, fmt)
    ledger = RunLedger(data_dir)
    known = ledger.known()
    for r in records:
        old = known.get((r["run"], r["step"]))
        if old is not None and old != record_hash(r):
            raise RunFormatError(f"run {r['run']} step {r['step']} is in the ledger with other content, and the "
                                 f"ledger is append only")
    graphs = build_graph(records)
    added = skipped = 0
    runs_dir = Path(data_dir) / "runs"
    for g in graphs:
        mine = [r for r in records if f"run:{slugify(r['agent']['id'] + '-' + r['run'], 80)}" == g.run_id]
        for r in mine:
            if (r["run"], r["step"]) in known:
                skipped += 1
                continue
            ledger.append("run.record", r, run=r["run"], step=r["step"], actor=actor, key=key, key_id=key_id)
            added += 1
        stem = g.run_id.split(":", 1)[1]
        write_atomic(runs_dir / f"{stem}.json", json.dumps(g.to_json(), indent=1) + "\n")
        write_atomic(runs_dir / f"{stem}.records.jsonl", "".join(canonical(r) + "\n" for r in mine))
    return {"runs": [g.run_id for g in graphs], "nodes": sum(len(g.nodes) for g in graphs),
            "edges": sum(len(g.edges) for g in graphs), "entries_added": added, "entries_skipped": skipped}


def main(argv: list[str] | None = None) -> int:
    """ingest-run FILE|- [--format run.v1|otlp|hook|gateway] --data-dir DIR [--actor A] [--key-file F] [--json].
    Exit 0 on success, 2 on a refused or invalid request."""
    import argparse
    import sys
    ap = argparse.ArgumentParser(prog="ingest-run")
    ap.add_argument("file")
    ap.add_argument("--format", default="run.v1", choices=FORMATS)
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--actor", default="system")
    ap.add_argument("--key-file")
    ap.add_argument("--json", action="store_true")
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    try:
        text = sys.stdin.read() if a.file == "-" else Path(a.file).read_text(encoding="utf-8")
        key = Path(a.key_file).read_bytes().strip() if a.key_file else None
        out = ingest(text, a.data_dir, a.format, a.actor, key)
    except (RunFormatError, OSError) as exc:
        print(f"The run was refused: {exc}")
        return 2
    print(json.dumps(out, indent=2) if a.json else
          f"Ingested {len(out['runs'])} run(s): {out['nodes']} nodes, {out['edges']} edges, "
          f"{out['entries_added']} ledger entries added, {out['entries_skipped']} already present.")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:]))
