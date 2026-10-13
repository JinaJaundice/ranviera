"""The read only oversight views: runs, the decision trace, the coverage matrix and the instruction detail.

The shapes (RunSummary, DecisionTrace, CoverageMatrix, InstructionDetail) are in docs/CONTRACTS.md, in the section
'View shapes'. The views read <data_dir>/graph.json, <data_dir>/inferred.json (the findings and proofs of rules O01 to
O14), the run records, the mapping and instruction stores of the profile and <data_dir>/ledger/verify.json. They write
nothing.

The trace keeps three labels apart, as section 7.1 of the specification requires: 'recorded' for tools and evidence,
'loaded' for the instructions that were in context, and 'stated by the agent, cause unverified' for the rationale and
the citations. A stated rationale is held as a hash and a content reference, never as text.

Commands: oversight runs [--agent A] [--outcome O], trace RUN, coverage [--agent A], instructions [--agent A] and
instruction ID. Exit 0 on success and 2 on a refused or invalid request.
"""
from __future__ import annotations

import difflib
import json
import re
from datetime import date
from pathlib import Path

from . import instructions as instr
from . import mappings
from .config import Config

LABELS = {"recorded": "recorded", "loaded": "loaded", "stated": "stated by the agent, cause unverified"}
OBLIGATION_TYPES = ("Obligation", "Permission", "Prohibition", "DeonticStatement")
COVERAGE_CHECKS = ("O01", "O02", "O08")
ESTABLISHED = ("ratified", "stated")
RANK = {"ratified": 3, "stated": 2, "proposed": 1}


class OversightError(ValueError):
    """A request that cannot be answered. The message is one sentence that names the reason."""


def read_json(path: Path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def link_status(edge: dict) -> str:
    """The status of a link in the chain: ratified, proposed, or stated for every other provenance."""
    p = edge.get("provenance") or "stated"
    return p if p in ("ratified", "proposed") else "stated"


class View:
    """The graph, the findings and the ledger result, loaded once and indexed for the views."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        graph = read_json(cfg.data_dir / "graph.json")
        graph = graph if isinstance(graph, dict) else {}
        self.graph_present = bool(graph)
        self.nodes: dict[str, dict] = {n["id"]: n for n in graph.get("nodes", []) if isinstance(n, dict) and "id" in n}
        self.edges = [e for e in graph.get("edges", [])
                      if isinstance(e, dict) and not e.get("inferred") and e.get("provenance") != "inferred"]
        self._out: dict[tuple[str, str], list[dict]] = {}
        self._in: dict[tuple[str, str], list[dict]] = {}
        for e in self.edges:
            self._out.setdefault((e["s"], e["r"]), []).append(e)
            self._in.setdefault((e["t"], e["r"]), []).append(e)
        inferred = read_json(cfg.data_dir / "inferred.json")
        inferred = inferred if isinstance(inferred, dict) else {}
        self.inferred_present = bool(inferred)
        self.rule_messages = {r.get("id"): r.get("message") for r in inferred.get("rules", []) if isinstance(r, dict)}
        self.findings: list[dict] = []
        for f in inferred.get("facts", []):
            if f.get("kind") in ("violation", "warning", "info") and f.get("args"):
                a = f["args"]
                self.findings.append({"check": a[0], "severity": f["kind"], "node": a[1] if len(a) > 1 else None,
                                      "message": self.rule_messages.get(a[0]) or a[0], "proof": f.get("proof"),
                                      "_args": list(a)})
        self.verify = read_json(cfg.data_dir / "ledger" / "verify.json")
        self.verify = self.verify if isinstance(self.verify, dict) else None
        # the instruction versions and the mappings, so that the trace can name who made and who approved each
        try:
            self.versions: dict[str, dict] = {x["id"]: x for x in instr.list_versions(cfg.profile_dir)}
        except (OSError, ValueError, KeyError, instr.InstructionError):
            self.versions = {}
        try:
            self.mapping_records: dict[str, dict] = {m["id"]: m for m in mappings.list_mappings(cfg.profile_dir)}
        except (OSError, ValueError, KeyError, mappings.MappingError):
            self.mapping_records = {}

    # ---- the graph

    def out(self, s: str, r: str) -> list[str]:
        return [e["t"] for e in self._out.get((s, r), [])]

    def inn(self, t: str, r: str) -> list[str]:
        return [e["s"] for e in self._in.get((t, r), [])]

    def out_edges(self, s: str, r: str) -> list[dict]:
        return self._out.get((s, r), [])

    def in_edges(self, t: str, r: str) -> list[dict]:
        return self._in.get((t, r), [])

    def prop(self, nid: str, *keys):
        n = self.nodes.get(nid) or {}
        props = n.get("props") or {}
        for k in keys:
            if props.get(k) not in (None, ""):
                return props[k]
        return None

    def label(self, nid: str) -> str:
        return (self.nodes.get(nid) or {}).get("label") or nid

    def type_of(self, nid: str) -> str:
        return (self.nodes.get(nid) or {}).get("type") or ""

    def runs(self) -> list[str]:
        return sorted((i for i, n in self.nodes.items() if n.get("type") == "Run"),
                      key=lambda i: (str(self.prop(i, "startedAt") or ""), i))

    def run_name(self, rid: str) -> str:
        label = self.label(rid)
        return label[4:] if label.startswith("Run ") else label

    def resolve_run(self, ref: str) -> str:
        if self.type_of(ref) == "Run":
            return ref
        for rid in self.runs():
            if self.run_name(rid) == ref or rid == f"run:{ref}":
                return rid
        raise OversightError(f"No run matches {ref}.")

    def steps(self, rid: str) -> list[str]:
        ids = [s for s in self.out(rid, "contains") if self.type_of(s) == "Step"]
        return sorted(ids, key=lambda s: (self.prop(s, "ordinal") or 0, s))

    def agent_of(self, rid: str) -> str | None:
        a = self.out(rid, "performedBy")
        return a[0] if a else None

    def decisions(self, rid: str) -> list[tuple[str, str]]:
        """(decision id, id of the step of kind decision) in step order."""
        out = []
        for s in self.steps(rid):
            if self.prop(s, "stepKind") != "decision":
                continue
            for d in self.out(s, "informedDecision"):
                if self.type_of(d) == "AgentDecision" and (d, s) not in out:
                    out.append((d, s))
        return out

    def run_nodes(self, rid: str) -> set[str]:
        ids = {rid}
        for s in self.steps(rid):
            ids.add(s)
            ids.update(self.out(s, "contains"))
            ids.update(self.out(s, "usedEvidence"))
            for d in self.out(s, "informedDecision"):
                ids.add(d)
                ids.update(self.out(d, "reviewedBy"))
        return ids

    def findings_for(self, ids: set[str], checks: tuple[str, ...] | None = None) -> list[dict]:
        out = []
        for f in self.findings:
            if checks is not None and f["check"] not in checks:
                continue
            if any(a in ids for a in f["_args"][1:]):
                out.append(_public_finding(f))
        return out

    def node_in_force(self, nid: str, day: str) -> bool:
        n = self.nodes.get(nid) or {}
        if n.get("status") != "approved":
            return False
        vf, vt = self.prop(nid, "validFrom", "valid_from"), self.prop(nid, "validTo", "valid_to")
        if vf and str(vf)[:10] > day:
            return False
        return not vt or str(vt)[:10] > day

    def ledger_for(self, rid: str) -> dict:
        rep = self.verify
        if rep is None:
            return {"entries": 0, "verified": None, "breaks": 0}
        from .transparency import _named
        name = self.run_name(rid)
        info = (rep.get("runs") or {}).get(name) or {}
        runs = list((rep.get("runs") or {}).keys())
        breaks = 0
        notes: list[dict] = []
        for b in rep.get("breaks") or []:
            reason = str(b.get("reason") or "")
            named = [r for r in runs if _named(str(r), reason)]
            if name in named or not named:
                breaks += 1
                m = re.search(r"missing step (\d+)", reason)
                notes.append({"seq": b.get("seq"), "step": int(m.group(1)) if m else None, "reason": reason})
        return {"entries": int(info.get("captured") or 0), "verified": breaks == 0, "breaks": breaks,
                "reported": int(info.get("reported") or 0), "notes": notes}


def _public_finding(f: dict) -> dict:
    return {k: v for k, v in f.items() if not k.startswith("_")}


def _instr_ref(v: View, iid: str, day: str) -> dict:
    n = v.nodes.get(iid) or {}
    ver = v.prop(iid, "version")
    rec = v.versions.get(iid) or {}
    maker = rec.get("maker")
    approver = rec.get("approver")
    if not rec:
        maker = next(iter(v.out(iid, "proposedBy")), None)
        approver = next(iter(v.out(iid, "approvedBy")), None)
    approved_on = next((h.get("ts") for h in reversed(rec.get("history") or []) if h.get("action") == "approve"), None)
    same = bool(maker and approver and str(maker).replace("person:", "") == str(approver).replace("person:", ""))
    return {"id": iid, "label": n.get("label") or iid, "version": int(ver) if isinstance(ver, (int, float)) else None,
            "status": n.get("status"), "in_force": v.node_in_force(iid, day), "maker": maker, "approver": approver,
            "approved_on": approved_on, "self_approved": same}


# ---------------------------------------------------------------- runs

def _decision_of(v: View, rid: str):
    ds = v.decisions(rid)
    return ds[-1] if ds else None


def _review_of(v: View, did: str) -> str | None:
    r = v.out(did, "reviewedBy")
    return r[0] if r else None


def run_summary(v: View, rid: str) -> dict:
    d = _decision_of(v, rid)
    rv = _review_of(v, d[0]) if d else None
    ids = v.run_nodes(rid)
    return {
        "run": rid, "agent": v.agent_of(rid) or "", "case_ref": v.prop(rid, "caseRef"),
        "ts": v.prop(rid, "startedAt") or "", "outcome": v.prop(d[0], "outcome") if d else None,
        "reviewed": rv is not None, "override": bool(rv and v.prop(rv, "override") is True),
        "findings": len(v.findings_for(ids)), "replayable": v.prop(rid, "replayStatus") == "replayable",
    }


def runs(cfg: Config, agent: str | None = None, outcome: str | None = None, view: View | None = None) -> list[dict]:
    v = view or View(cfg)
    aid = instr.agent_node(agent) if agent else None
    out = []
    for rid in v.runs():
        s = run_summary(v, rid)
        if aid and s["agent"] != aid:
            continue
        if outcome and s["outcome"] != outcome:
            continue
        out.append(s)
    return out


# ---------------------------------------------------------------- the decision trace

def chain(v: View, vid: str) -> list[dict]:
    """The links from an instruction version to clause, control, obligation and provision. Where a node stops short of the
    next class the chain holds one link of status missing, which names the relation that would close it."""
    links: list[dict] = []

    def link(e: dict, frm: str, to: str) -> dict:
        rec = v.mapping_records.get(e.get("mapping") or "") or {}
        out = {"mapping": e.get("mapping"), "relation": e["r"], "from": frm, "to": to, "to_label": v.label(to),
               "to_type": v.type_of(to), "status": link_status(e), "maker": rec.get("maker"),
               "checker": rec.get("checker"), "since": rec.get("valid_from")}
        if v.type_of(to) == "PolicyClause":   # the policy document and the clause number, for a reader who holds the policy
            out["clause_ref"] = v.prop(to, "section")
            out["policy"] = v.prop(to, "pack")
        return out

    def missing(rel: str, frm: str, to_type: str) -> dict:
        return {"mapping": None, "relation": rel, "from": frm, "to": "", "to_label": "", "to_type": to_type,
                "status": "missing"}

    clauses = v.out_edges(vid, "implementsClause")
    if not clauses:
        return [missing("implementsClause", vid, "PolicyClause")]
    for ce in clauses:
        links.append(link(ce, vid, ce["t"]))
        reals = v.out_edges(ce["t"], "realises")
        if not reals:
            links.append(missing("realises", ce["t"], "Control"))
        for re_ in reals:
            links.append(link(re_, ce["t"], re_["t"]))
            sats = v.out_edges(re_["t"], "satisfies")
            if not sats:
                links.append(missing("satisfies", re_["t"], "Obligation"))
            for se in sats:
                links.append(link(se, re_["t"], se["t"]))
                for pe in v.out_edges(se["t"], "expressedIn"):
                    links.append(link(pe, se["t"], pe["t"]))
    return links


def _stored_text(cfg: Config, ref) -> str | None:
    """The text that the agent wrote, read from the content store by its reference, or None where it is not held. The
    reference names a file of <data_dir>/store by its hash, so anything else is refused."""
    m = re.fullmatch(r"store:([0-9a-f]{16,128})", str(ref or ""))
    if not m:
        return None
    try:
        return (cfg.data_dir / "store" / m.group(1)).read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def trace(cfg: Config, run_ref: str, view: View | None = None) -> dict:
    v = view or View(cfg)
    if not v.graph_present:
        raise OversightError("The graph is absent, so no trace can be built. Run the build first.")
    rid = v.resolve_run(run_ref)
    agent = v.agent_of(rid) or ""
    models = v.out(rid, "ranOn")
    mid = models[0] if models else None
    approved = bool(mid and mid in v.out(agent, "drawsOn") and (v.nodes.get(mid) or {}).get("status") == "approved")
    d = _decision_of(v, rid)
    rv = _review_of(v, d[0]) if d else None
    steps = []
    chain_ids: list[str] = []
    for s in v.steps(rid):
        day = str(v.prop(s, "ts") or "")[:10]
        kids = v.out(s, "contains")
        tool_node = next((k for k in kids if v.type_of(k) == "ToolCall"), None)
        tool = v.prop(tool_node, "tool") if tool_node else None
        rat = next((k for k in kids if v.type_of(k) == "StatedRationale"), None)
        evidence = [{"id": e, "label": v.label(e), "hash": v.prop(e, "hash"), "source": v.prop(e, "sourceRef")}
                    for e in v.out(s, "usedEvidence")]
        ctx = v.out(s, "inContext")
        cited = v.out(s, "citesInstruction")
        for i in ctx + cited:
            if i not in chain_ids and v.type_of(i) == "InstructionVersion":
                chain_ids.append(i)
        steps.append({
            "id": s, "step": int(v.prop(s, "ordinal") or 0), "kind": v.prop(s, "stepKind") or "", "ts": v.prop(s, "ts") or "",
            "tool": tool, "tool_id": tool_node, "evidence": evidence,
            "in_context": [_instr_ref(v, i, day) for i in ctx], "cited": [_instr_ref(v, i, day) for i in cited],
            "rationale": {"id": rat, "hash": v.prop(rat, "hash"), "content_ref": v.prop(rat, "contentRef"),
                          "text": _stored_text(v.cfg, v.prop(rat, "contentRef"))} if rat else None,
            "findings": v.findings_for({s, *kids, *(v.out(s, "informedDecision") if v.prop(s, "stepKind") == "decision" else [])}),
        })
    review = None
    if rv:
        review = {"id": rv, "reviewer": v.prop(rv, "reviewer") or "", "verdict": v.prop(rv, "verdict"),
                  "override": v.prop(rv, "override") is True, "override_reason": v.prop(rv, "overrideReason"),
                  "time_open_s": v.prop(rv, "timeOpenS"), "items_viewed": v.prop(rv, "itemsViewed"),
                  "checks_ticked": list(v.prop(rv, "checksTicked") or [])}
    return {
        "run": rid, "agent": {"id": agent, "label": v.label(agent) if agent else ""},
        "model": {"id": mid or "", "status": (v.nodes.get(mid) or {}).get("status") if mid else None, "approved": approved,
                  "approver": (v.prop(mid, "approvedBy") if approved else None) if mid else None,
                  "approved_on": (v.prop(mid, "approvedOn") if approved else None) if mid else None},
        "case_ref": v.prop(rid, "caseRef"),
        "decision": {"id": d[0], "outcome": v.prop(d[0], "outcome"), "step": int(v.prop(d[1], "ordinal") or 0),
                     "ts": v.prop(d[1], "ts") or ""} if d else None,
        "review": review, "steps": steps,
        "chains": {i: chain(v, i) for i in chain_ids},
        "findings": v.findings_for(v.run_nodes(rid)),
        "ledger": v.ledger_for(rid),
        "replayable": v.prop(rid, "replayStatus") == "replayable",
        "labels": dict(LABELS),
    }


# ---------------------------------------------------------------- the coverage matrix

def coverage(cfg: Config, agent: str | None = None, view: View | None = None) -> dict:
    """Rows are obligations. covered: a chain of established links (ratified or stated) from an in-force instruction
    version of the agent. exempt: a ratified notDischargedBy edge. partial: some link exists but no complete chain.
    gap: no link at all."""
    v = view or View(cfg)
    aid = instr.agent_node(agent) if agent else None
    today = date.today().isoformat()
    rows, cols = [], {}

    def col(nid: str) -> None:
        cols.setdefault(nid, {"id": nid, "label": v.label(nid), "type": v.type_of(nid)})

    def best(cells: dict, nid: str, st: str) -> None:
        if RANK[st] > RANK.get(cells.get(nid, ""), 0):
            cells[nid] = st

    for oid in sorted(i for i, n in v.nodes.items() if n.get("type") in OBLIGATION_TYPES):
        applies = v.out(oid, "appliesTo")
        if aid and aid not in applies:
            continue
        exempt = any(link_status(e) == "ratified" and (not aid or e["t"] == aid)
                     for e in v.out_edges(oid, "notDischargedBy"))
        cells: dict[str, str] = {}
        complete = False
        for se in v.in_edges(oid, "satisfies"):
            c = se["s"]
            best(cells, c, link_status(se))
            for re_ in v.in_edges(c, "realises"):
                k = re_["s"]
                best(cells, k, link_status(re_))
                for ie in v.in_edges(k, "implementsClause"):
                    i = ie["s"]
                    if aid and i not in v.out(aid, "operatesUnder"):
                        continue
                    if not v.node_in_force(i, today):
                        continue
                    best(cells, i, link_status(ie))
                    if all(link_status(x) in ESTABLISHED for x in (se, re_, ie)):
                        complete = True
        state = "exempt" if exempt else "covered" if complete else "partial" if cells else "gap"
        for nid in cells:
            col(nid)
        prov = next(iter(v.out(oid, "expressedIn")), None)
        rows.append({"obligation": oid, "label": v.label(oid),
                     "provision": {"id": prov, "label": v.label(prov)} if prov else None,
                     "state": state, "cells": cells})
    row_ids = {r["obligation"] for r in rows}
    agent_versions = {i for i, n in v.nodes.items() if n.get("type") == "InstructionVersion"
                      and (not aid or i in v.out(aid, "operatesUnder"))}
    scope = row_ids | agent_versions | ({aid} if aid else set())
    findings = [_public_finding(f) for f in v.findings
                if f["check"] in COVERAGE_CHECKS and (not aid or any(a in scope for a in f["_args"][1:]))]
    order = {"Control": 0, "PolicyClause": 1, "InstructionVersion": 2}
    return {"agent": aid, "columns": sorted(cols.values(), key=lambda c: (order.get(c["type"], 9), c["id"])),
            "rows": rows, "findings": findings, "earlier_versions": _earlier_versions(v, aid, today)}


def _earlier_versions(v: View, aid: str | None, today: str) -> list[dict]:
    """Approved instruction versions that are no longer in force, that no ratified clause covers and that a past decision
    cited. Rule O02 reads the versions in force today, so these gaps are listed here and not as findings."""
    out = []
    for i, n in sorted(v.nodes.items()):
        if n.get("type") != "InstructionVersion" or n.get("status") != "approved" or v.node_in_force(i, today):
            continue
        if any(link_status(e) == "ratified" for e in v.out_edges(i, "implementsClause")):
            continue
        runs = {r for s in v.inn(i, "citesInstruction") for r in v.inn(s, "contains") if v.type_of(r) == "Run"}
        if aid:
            runs = {r for r in runs if v.agent_of(r) == aid}
        if runs:
            out.append({"id": i, "label": v.label(i), "runs": len(runs)})
    return out


# ---------------------------------------------------------------- instructions

def line_diff(old: str, new: str) -> list[dict]:
    a, b = old.splitlines(), new.splitlines()
    out = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if tag == "equal":
            out += [{"op": "same", "text": t} for t in a[i1:i2]]
        else:
            out += [{"op": "remove", "text": t} for t in a[i1:i2]]
            out += [{"op": "add", "text": t} for t in b[j1:j2]]
    return out


def _read_text(cfg: Config, agent: str, version: dict) -> str | None:
    try:
        return (instr.instructions_dir(cfg.profile_dir) / instr.agent_slug(agent) / version["text"]).read_text(encoding="utf-8")
    except OSError:
        return None


def instruction_summaries(cfg: Config, agent: str | None = None, view: View | None = None) -> list[dict]:
    v = view or View(cfg)
    out = []
    for a in ([instr.agent_slug(agent)] if agent else instr.agents(cfg.profile_dir)):
        data = instr.load(cfg.profile_dir, a)
        for ins in data["instructions"]:
            vids = {x["id"] for x in ins["versions"]}
            forced = next((x for x in reversed(ins["versions"]) if instr.in_force(x)), None)
            out.append({"id": ins["id"], "label": ins["label"], "agent": data["agent"], "file": ins["file"],
                        "versions": len(ins["versions"]), "latest": ins["versions"][-1]["id"] if ins["versions"] else None,
                        "in_force": forced["id"] if forced else None,
                        "findings": len(v.findings_for(vids))})
    return out


def instruction_detail(cfg: Config, ident: str, view: View | None = None) -> dict:
    v = view or View(cfg)
    hit = instr.find_instruction(cfg.profile_dir, ident)
    if hit is None:
        raise OversightError(f"No instruction has the id {ident}.")
    data, ins = hit
    versions = [{**x, "in_force": instr.in_force(x)} for x in ins["versions"]]
    vids = {x["id"] for x in ins["versions"]}
    diff = None
    if len(ins["versions"]) >= 2:
        old, new = ins["versions"][-2], ins["versions"][-1]
        t_old, t_new = _read_text(cfg, data["agent"], old), _read_text(cfg, data["agent"], new)
        if t_old is not None and t_new is not None:
            diff = {"from": old["id"], "to": new["id"], "lines": line_diff(t_old, t_new)}
    maps = [m for m in mappings.list_mappings(cfg.profile_dir) if m["s"] in vids or m["t"] in vids]
    impact: dict = {"stale_mappings": [], "decisions": []}
    latest = ins["versions"][-1] if ins["versions"] else None
    forced = next((x for x in reversed(ins["versions"]) if instr.in_force(x)), None)
    if latest and latest["status"] == "draft" and forced:
        impact["stale_mappings"] = sorted(m["id"] for m in maps if m["status"] == "ratified"
                                          and forced["id"] in (m["s"], m["t"]))
        seen = set()
        for did, n in sorted(v.nodes.items()):
            if n.get("type") != "AgentDecision":
                continue
            steps = v.inn(did, "informedDecision")
            if not any(forced["id"] in v.out(s, "inContext") for s in steps):
                continue
            dstep = next((s for s in steps if v.prop(s, "stepKind") == "decision"), steps[0] if steps else None)
            run = next((r for r in v.inn(dstep, "contains") if v.type_of(r) == "Run"), None) if dstep else None
            if (run, did) in seen:
                continue
            seen.add((run, did))
            impact["decisions"].append({"run": run or "", "decision": did, "ts": v.prop(dstep, "ts") or "" if dstep else ""})
        impact["decisions"].sort(key=lambda d: (d["ts"], d["decision"]))
    return {"id": ins["id"], "label": ins["label"], "agent": data["agent"], "file": ins["file"], "versions": versions,
            "diff": diff, "mappings": maps, "findings": v.findings_for(vids), "impact": impact}


# ---------------------------------------------------------------- command line

def _render(cmd: str, out) -> str:
    if cmd == "runs":
        return "\n".join(f"{r['run']}  {r['ts']}  {r['outcome'] or 'no decision'}  "
                         f"{'reviewed' if r['reviewed'] else 'not reviewed'}  {r['findings']} finding(s)" for r in out) \
            or "No runs are recorded."
    if cmd == "coverage":
        lines = [f"{r['state']:8} {r['obligation']}  {r['label']}" for r in out["rows"]]
        lines += [f"{f['check']} {f['severity']} {f['node']}: {f['message']}" for f in out["findings"]]
        return "\n".join(lines) or "No obligations are in scope."
    if cmd == "instructions":
        return "\n".join(f"{i['id']}  latest {i['latest']}  in force {i['in_force'] or 'none'}  {i['findings']} finding(s)"
                         for i in out) or "No instructions are stored."
    if cmd == "instruction":
        lines = [f"{out['id']}  {out['label']}"]
        lines += [f"  {x['id']}  {x['status']}{'  in force' if x['in_force'] else ''}" for x in out["versions"]]
        if out["diff"]:
            lines.append(f"Changes from {out['diff']['from']} to {out['diff']['to']}:")
            lines += [f"  {'+' if x['op'] == 'add' else '-' if x['op'] == 'remove' else ' '} {x['text']}"
                      for x in out["diff"]["lines"]]
        return "\n".join(lines)
    lines = [f"Run {out['run']} of {out['agent']['id']}, case {out['case_ref'] or 'none'}",
             f"Model {out['model']['id']}, approved {out['model']['approved']}"]
    for s in out["steps"]:
        lines.append(f"  step {s['step']} {s['kind']}")
        if s["tool"] or s["evidence"]:
            lines.append(f"    {LABELS['recorded']}: tool {s['tool']}, {len(s['evidence'])} evidence item(s)")
        if s["in_context"]:
            lines.append(f"    {LABELS['loaded']}: " + ", ".join(i["id"] for i in s["in_context"]))
        if s["cited"] or s["rationale"]:
            lines.append(f"    {LABELS['stated']}: cites " + (", ".join(i["id"] for i in s["cited"]) or "nothing"))
    if out["decision"]:
        lines.append(f"Decision {out['decision']['outcome']} at step {out['decision']['step']}")
    lines += [f"{f['check']} {f['severity']}: {f['message']}" for f in out["findings"]]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """oversight runs|trace|coverage|instructions|instruction. Exit 0 on success, 2 on a refused or invalid request."""
    import argparse
    argv = list(argv or [])
    if argv and argv[0] == "oversight":
        argv = argv[1:]
    ap = argparse.ArgumentParser(prog="oversight")
    ap.add_argument("--config")
    ap.add_argument("--json", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("runs")
    r.add_argument("--agent")
    r.add_argument("--outcome", choices=("close", "escalate", "request-information"))
    t = sub.add_parser("trace")
    t.add_argument("run")
    c = sub.add_parser("coverage")
    c.add_argument("--agent")
    i = sub.add_parser("instructions")
    i.add_argument("--agent")
    one = sub.add_parser("instruction")
    one.add_argument("id")
    for p in (r, t, c, i, one):
        p.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        p.add_argument("--config", default=argparse.SUPPRESS)
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    from .config import load_config
    cfg = load_config(a.config)
    try:
        if a.cmd == "runs":
            out = runs(cfg, a.agent, a.outcome)
        elif a.cmd == "trace":
            out = trace(cfg, a.run)
        elif a.cmd == "coverage":
            out = coverage(cfg, a.agent)
        elif a.cmd == "instructions":
            out = instruction_summaries(cfg, a.agent)
        else:
            out = instruction_detail(cfg, a.id)
    except (OversightError, instr.InstructionError, mappings.MappingError, OSError, ValueError) as exc:
        print(f"The request was refused: {exc}")
        return 2
    print(json.dumps(out, indent=2, ensure_ascii=False) if a.json else _render(a.cmd, out))
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:]))
