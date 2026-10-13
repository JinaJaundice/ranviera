"""The evidence pack: a dated bundle for one alert, run, agent or period.

`pack export --scope alert:ID|run:ID|agent:ID|period:FROM..TO [--out DIR]` writes <out>/pack-<scope>-<YYYYMMDD-HHMMSS>/
with pack.json (the scope, the build time, the graph hash, the decision traces in scope, the instruction versions with
their approvals, the mapping chain, the findings with proofs, the ledger head and the completeness result, the monitoring
report and the back-tests), pack.html (the same content as a document that prints) and manifest.json (the sha256 and size
of each of the other 2 files). A period pack leads with the coverage matrix and the monitoring summary.

The pack holds hashes and content references only. It reads nothing from the controlled store, so no instruction text, no
rationale text and no evidence text enters it. The document states the limits of section 8 of the specification beside
the 3 labels of the trace.

Exit 0 on success and 2 on a refused or invalid request.
"""
from __future__ import annotations

import hashlib
import json
from datetime import date, datetime, timezone
from html import escape
from pathlib import Path

from . import backtest, mappings, monitoring
from . import pack_words as pw
from . import instructions as instr
from . import oversight
from .config import Config
from .fileio import write_atomic
from .model import slugify
from .oversight import LABELS, View

LIMITS = (
    "The graph shows the context the agent had, the tools it called, the evidence it read, the text it wrote and the "
    "decision it reached. It does not show the internal computation of the model.",
    "The stated rationale is what the agent wrote. It is unverified as the cause of the decision, and the record of loaded "
    "instructions shows which instruction was loaded and does not show that the model weighed it.",
    "A complete trace does not show that a decision was correct.",
    "The checks in this pack test consistency and integrity. A tidy record can give false assurance unless the monitoring "
    "results are read with it.",
    "The maker and checker controls depend on the identity that the bank supplies, and the tool alone cannot show that "
    "two accounts belong to two people.",
)


class PackError(ValueError):
    """A refused request. The message is one sentence that names the reason."""


def parse_scope(scope: str) -> tuple[str, str]:
    kind, _, value = (scope or "").partition(":")
    if kind not in ("alert", "run", "agent", "period") or not value.strip():
        raise PackError("The scope is alert:ID, run:ID, agent:ID or period:FROM..TO.")
    return kind, value.strip()


def _runs_in_scope(v: View, kind: str, value: str) -> tuple[list[str], str | None, str | None]:
    if kind == "alert":
        rids = [r for r in v.runs() if v.prop(r, "caseRef") == value]
    elif kind == "run":
        try:
            rids = [v.resolve_run(value)]
        except oversight.OversightError as exc:
            raise PackError(str(exc)) from None
    elif kind == "agent":
        aid = instr.agent_node(value)
        rids = [r for r in v.runs() if v.agent_of(r) == aid]
        if not rids and aid not in v.nodes:
            raise PackError(f"No agent {value} is in the graph.")
    else:
        frm, _, to = value.partition("..")
        try:
            frm, to = date.fromisoformat(frm).isoformat(), date.fromisoformat(to).isoformat()
        except ValueError:
            raise PackError("A period is written FROM..TO with dates in the form YYYY-MM-DD.") from None
        rids = [r for r in v.runs() if frm <= str(v.prop(r, "startedAt") or "")[:10] <= to]
        return rids, frm, to
    if not rids:
        raise PackError(f"The scope {kind}:{value} holds no run.")
    return rids, None, None


def _dedupe(findings: list[dict]) -> list[dict]:
    seen, out = set(), []
    for f in findings:
        key = (f["check"], f["node"], f["message"])
        if key not in seen:
            seen.add(key)
            out.append(f)
    return out


def _read(path: Path):
    return oversight.read_json(path)


def build_pack(cfg: Config, scope: str, now: datetime | None = None) -> dict:
    kind, value = parse_scope(scope)
    st = now or datetime.now(timezone.utc)
    v = View(cfg)
    if not v.graph_present:
        raise PackError("The graph is absent, so no pack can be built. Run the build first.")
    rids, frm, to = _runs_in_scope(v, kind, value)
    traces = [oversight.trace(cfg, r, view=v) for r in rids]
    agents = sorted({t["agent"]["id"] for t in traces} | ({instr.agent_node(value)} if kind == "agent" else set()))
    one_agent = agents[0] if len(agents) == 1 else None
    store = [i for a in agents for i in (instr.list_versions(cfg.profile_dir, a) if a.split(":", 1)[-1] in
                                          instr.agents(cfg.profile_dir) else [])]
    if kind in ("alert", "run"):
        used = {i for t in traces for s in t["steps"] for i in [x["id"] for x in s["in_context"] + s["cited"]]}
        store = [x for x in store if x["id"] in used]
    vids = [x["id"] for x in store]
    versions = [{k: x[k] for k in ("id", "instruction", "label", "file", "version", "status", "hash", "approved_hash",
                                     "maker", "approver", "valid_from", "valid_to", "history")} for x in store]
    maps = [m for m in mappings.list_mappings(cfg.profile_dir) if m["s"] in vids or m["t"] in vids]
    findings = [f for t in traces for f in t["findings"]]
    coverage = None
    if kind in ("agent", "period"):
        coverage = oversight.coverage(cfg, one_agent, view=v)
        findings += coverage["findings"]
    monitoring_report = monitoring.report(cfg, one_agent, frm, to, view=v)
    head = _read(cfg.data_dir / "ledger" / "head.json")
    verify = v.verify
    graph = _read(cfg.data_dir / "graph.json") or {}
    from .reason import graph_digest
    names = {v.run_name(r) for r in rids}
    pack = {
        "v": 1, "scope": {"kind": kind, "value": value, "text": scope}, "created": st.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "graph_sha256": graph_digest(graph), "graph_built": graph.get("built"), "agents": agents,
        "coverage": coverage, "monitoring": monitoring_report, "traces": traces,
        "instruction_versions": versions,
        "mapping_chain": {"chains": {i: oversight.chain(v, i) for i in vids}, "mappings": maps},
        "findings": _dedupe(findings),
        "ledger": {"head": head,
                   "completeness": None if verify is None else {
                       "ok": verify.get("ok"), "entries": verify.get("entries"), "head_seq": verify.get("head_seq"),
                       "signature": verify.get("signature"), "breaks": verify.get("breaks"),
                       "runs": {n: i for n, i in (verify.get("runs") or {}).items() if n in names}}},
        "backtests": [b for a in agents for b in backtest.summaries(cfg, a)],
        "labels": dict(LABELS), "limits": list(LIMITS),
    }
    pack["names"] = _names(cfg, v, pack)
    return pack


def _names(cfg: Config, v: View, pack: dict) -> dict[str, str]:
    """The name of every record that the pack mentions, for the readable document. The people come from the people file."""
    found = set(pw.ID_RE.findall(json.dumps(pack, ensure_ascii=False)))
    names: dict[str, str] = {}
    for i in found:
        if i in v.nodes:
            label = v.label(i)
            names[i] = pw.model_name(label) if i.startswith("model:") else pw.agent_name(label) if i.startswith("dagent:") else label
    for i in pack.get("agents", []):
        names[i] = pw.agent_name(v.label(i))
    try:
        from . import people as ppl
        for p in (ppl.load_people(cfg) or {}).get("people", []):
            names[p["id"]] = names[f"person:{p['id']}"] = p["name"]
    except (OSError, ValueError, KeyError, ppl.PeopleError):
        pass
    return names


# ---------------------------------------------------------------- the document

def _e(x) -> str:
    return escape("" if x is None else str(x))


class _Raw(str):
    """Markup that is already escaped."""


def _table(head: list[str], rows: list[list], widths: list[int] | None = None) -> str:
    cols = "<colgroup>" + "".join(f"<col style=\"width:{w}%\">" for w in widths) + "</colgroup>" if widths else ""
    th = "".join(f"<th>{_e(h)}</th>" for h in head)
    body = "".join("<tr>" + "".join(f"<td>{c if isinstance(c, _Raw) else _e(c)}</td>" for c in r) + "</tr>" for r in rows)
    return f"<table>{cols}<thead><tr>{th}</tr></thead><tbody>{body}</tbody></table>"


def _proof(p, nm: pw.Namer) -> _Raw:
    if not p:
        return _Raw("No proof recorded.")

    def walk(n: dict) -> str:
        kids = "".join(walk(c) for c in n.get("children", []))
        return f"<li>{_e(pw.fact_words(n.get('fact'), nm))}{'<ul>' + kids + '</ul>' if kids else ''}</li>"
    return _Raw(f"<ul class=\"proof\">{walk(p)}</ul>")


def _findings_table(findings: list[dict], nm: pw.Namer) -> str:
    if not findings:
        return "<p>No finding applies to this scope.</p>"
    return _table(["Check", "Severity", "Concerns", "What the check found", "Proof"],
                  [[pw.CHECK_TITLE.get(f["check"], "Finding"), pw.SEVERITY.get(f["severity"], f["severity"]), nm(f["node"]),
                    nm.text(f["message"]).replace("edges", "links").replace("edge", "link"), _proof(f.get("proof"), nm)]
                   for f in findings], [17, 9, 17, 25, 32])


def _scope_title(sc: dict, nm: pw.Namer, pack: dict) -> str:
    kind, value = sc["kind"], sc["value"]
    if kind == "alert":
        return f"alert {value}"
    if kind == "run":
        t = pack["traces"][0] if pack["traces"] else None
        return f"the run of {t['case_ref']}" if t and t["case_ref"] else "one run"
    if kind == "agent":
        return f"the agent {nm(instr.agent_node(value))}"
    frm, _, to = value.partition("..")
    return f"the period {pw.long_date(frm)} to {pw.long_date(to)}"


def render_html(pack: dict) -> str:
    sc = pack["scope"]
    nm = pw.Namer(pack.get("names") or {})
    title = _scope_title(sc, nm, pack)
    agents = ", ".join(nm(a) for a in pack["agents"]) or "none"
    out = [f"<!doctype html><html lang=\"en-GB\"><head><meta charset=\"utf-8\"><title>Evidence pack for {_e(title)}</title>",
           "<style>body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.4;max-width:190mm;margin:0 auto;"
           "padding:12mm;color:#111}h1{font-size:20pt}h2{font-size:14pt;margin-top:1.6em;border-bottom:1px solid #999}"
           "h3{font-size:12pt}table{border-collapse:collapse;width:100%;table-layout:fixed;margin:.6em 0}th,td{border:1px solid #999;"
           "padding:3px 6px;text-align:left;vertical-align:top;font-size:9.5pt;overflow-wrap:break-word}th{background:#eee}"
           "code,.hash{font-family:Consolas,monospace;font-size:9pt;overflow-wrap:anywhere}ul.proof{margin:0;padding-left:1.1em}"
           ".limits{border:1px solid #333;padding:.4em 1em}@media print{h2{break-after:avoid}table{break-inside:auto}"
           "tr{break-inside:avoid}}</style></head><body>",
           f"<h1>Evidence pack for {_e(title)}</h1>",
           f"<p>Created on {_e(pw.long_time(pack['created']))}. The agents in scope are {_e(agents)}. The pack holds references to "
           "records and the fingerprints of records. It holds no text from the controlled store. The data file pack.json holds "
           "the same content with the identifiers of the records, for audit tools.</p>",
           "<h2>Limits of this evidence</h2><div class=\"limits\"><ul>" + "".join(f"<li>{_e(t)}</li>" for t in pack["limits"])
           + "</ul></div>",
           "<h2>Labels used in the traces</h2>",
           _table(["Label", "Meaning"], [
               [LABELS["recorded"], "Tools called and evidence read, as the records of the run show them."],
               [LABELS["loaded"], "Instruction versions that were in the context of the step, as the opening record of the run lists them."],
               [LABELS["stated"], "The rationale and the instructions that the agent names. The text was written by the agent "
                                  "and is not shown to have caused the decision."]], [30, 70])]
    if pack["coverage"] is not None:
        cov = pack["coverage"]
        state_word = {"covered": "Covered", "partial": "Partly covered", "gap": "Not covered", "exempt": "Exempt"}
        out.append("<h2>Coverage matrix</h2>")
        out.append("<p>Each obligation is listed with the controls, policy clauses and instruction versions linked to it. "
                   "Ratified means that a checker other than the maker approved the link. Proposed means that no checker has "
                   "approved it yet. Stated means that the source record gives it.</p>")
        out.append(_table(["Coverage", "Obligation", "Provision", "Linked controls, clauses and instructions"], [
            [state_word.get(r["state"], r["state"]), r["label"], (r["provision"] or {}).get("label") or "none",
             "; ".join(f"{nm(c)} ({s})" for c, s in sorted(r["cells"].items(), key=lambda kv: nm(kv[0]))) or "none"]
            for r in cov["rows"]], [15, 25, 18, 42]))
    out.append("<h2>Monitoring summary</h2>")
    mon = pack["monitoring"]
    def bound_words(b: dict | None, unit: str) -> str:
        b = b or {}
        parts = ([f"at least {b['min']}{unit}"] if b.get("min") is not None else []) + (
            [f"at most {b['max']}{unit}"] if b.get("max") is not None else [])
        return " and ".join(parts) or "No bound set by the bank"

    def result_words(val, b: dict | None) -> str:
        b = b or {}
        if b.get("min") is None and b.get("max") is None:
            return "Not checked"
        if val is None:
            return "No value"
        return "Outside" if (b.get("min") is not None and val < b["min"]) or (b.get("max") is not None and val > b["max"]) else "Within"

    out.append(_table(["Agent", "Decisions", "Reviewed by a person", "Overridden in every 1,000 reviewed decisions",
                       "Bound of the bank for the override rate", "Result", "Mean review time in seconds",
                       "Bound of the bank for review time", "Result", "Changes recorded"],
                      [[nm(a["id"]), a["decisions"], a["reviewed"], a["override_per_mille"],
                        bound_words(a["bounds"].get("override"), " in 1,000"), result_words(a["override_per_mille"], a["bounds"].get("override")),
                        a["review_seconds_mean"], bound_words(a["bounds"].get("review_seconds"), " seconds"),
                        result_words(a["review_seconds_mean"], a["bounds"].get("review_seconds")), len(a["drift"])]
                       for a in mon["agents"]], [14, 8, 10, 12, 12, 8, 10, 12, 8, 6]))
    for a in mon["agents"]:
        if a.get("runs") is not None and a.get("runs_recorded") is not None:
            window = ""
            if mon.get("from") or mon.get("to"):
                window = ", being the runs started" + (f" from {pw.long_date(mon['from'])}" if mon.get("from") else "") + (
                    f" to {pw.long_date(mon['to'])}" if mon.get("to") else "")
            out.append(f"<p>The figures for {_e(nm(a['id']))} cover {a['runs']} of the {a['runs_recorded']} runs recorded for the agent"
                       f"{_e(window)}. The Monitoring tab of the window reads every recorded run unless a period is set, so its figures can differ from these.</p>")
    for a in mon["agents"]:
        for d in a["drift"]:
            out.append(f"<p>{_e(pw.DRIFT_KIND.get(d['kind'], d['kind']))}, from {_e(pw.long_date(d['since']))}. "
                       f"{_e(nm.text(d['detail']).replace(' in thousandths of reviewed decisions', ' in every 1,000 reviewed decisions'))}</p>")
    out.append("<h2>Decision traces</h2>")
    out.append("<p>The ledger of a run is the list of its recorded steps, each linked to the one before it.</p>")
    for t in pack["traces"]:
        dec = t["decision"]
        out.append(f"<h3>{_e(t['case_ref'] or nm(t['run']))}</h3><p>Agent {_e(nm(t['agent']['id']))}. Model version "
                   f"{_e(nm(t['model']['id']))}, {'approved' if t['model']['approved'] else 'not approved'}. "
                   f"Decision {_e(pw.OUTCOME.get(dec['outcome'], dec['outcome'])) if dec else 'none'}"
                   f"{(' on ' + pw.long_time(dec['ts'])) if dec else ''}. The run can be replayed: "
                   f"{'yes' if t['replayable'] else 'no'}.</p>")
        if t["review"]:
            r = t["review"]
            out.append(f"<p>Human review by {_e(nm(r['reviewer']))}. Verdict {_e(r['verdict'] or 'none')}. Override "
                       f"{'yes' if r['override'] else 'no'}. Time open {_e(r['time_open_s'])} seconds. Items viewed "
                       f"{_e(r['items_viewed'])}. The review records activity and not what the reviewer thought.</p>")
        rows = []
        for s in t["steps"]:
            rec = [pw.tool_name(s["tool"]) if s["tool"] else "", *[
                f"{pw.evidence_name(e['label'])} (fingerprint {(e['hash'] or 'none').replace('sha256:', '')[:12]})" for e in s["evidence"]]]
            stated = []
            if s["rationale"]:
                stated.append("Rationale written (fingerprint " + str(s["rationale"]["hash"] or "none").replace("sha256:", "")[:12] + ")")
            if s["cited"]:
                stated.append("Cites " + ", ".join(nm(i["id"]) for i in s["cited"]))
            rows.append([s["step"], pw.STEP_KIND.get(s["kind"], s["kind"]), "; ".join(filter(None, rec)) or "none",
                         f"{len(s['in_context'])} instruction versions" if s["in_context"] else "none",
                         "; ".join(stated) or "none"])
        out.append(_table(["Step", "Kind", f"Recorded ({LABELS['recorded']})", f"Instructions ({LABELS['loaded']})",
                           f"Stated ({LABELS['stated']})"], rows, [7, 15, 30, 16, 32]))
        led = t["ledger"]
        out.append(f"<p>Ledger: {led['entries']} entries, verified {'yes' if led['verified'] else 'no'}, "
                   f"{led['breaks']} break{'' if led['breaks'] == 1 else 's'}.</p>")
    out.append("<h2>Findings with proofs</h2>" + _findings_table(pack["findings"], nm))
    out.append("<h2>Instruction versions and approvals</h2>")
    out.append(_table(["Instruction version", "Status", "Made by", "Approved by", "Valid from", "Valid to",
                       "Text matches the approved text"],
                      [[x["label"] or nm(x["id"]), (x["status"] or "").capitalize(), nm(x["maker"]), nm(x["approver"]) if x["approver"] else "none",
                        pw.long_date(x["valid_from"]) if x["valid_from"] else "none",
                        pw.long_date(x["valid_to"]) if x["valid_to"] else "none",
                        "Yes" if x["status"] != "approved" or not x["approved_hash"] or x["approved_hash"] == x["hash"] else "No"]
                       for x in pack["instruction_versions"]], [28, 10, 14, 14, 12, 10, 12]))
    out.append("<h2>Mapping chain</h2>")
    rows = [[nm(i), pw.RELATION.get(l["relation"], l["relation"]), l["to_label"] or nm(l["to"]) if l["to"] else "Nothing is mapped",
             (l["status"] or "").capitalize(), nm(l["mapping"]) if l["mapping"] else "none"]
            for i, links in pack["mapping_chain"]["chains"].items() for l in links]
    out.append(_table(["Instruction version", "Link", "Linked to", "Status", "Mapping"], rows, [30, 20, 28, 10, 12]))
    out.append("<h2>Ledger</h2>")
    led = pack["ledger"]
    head = led["head"] or {}
    out.append(f"<p>The ledger holds {_e(head.get('seq', 'no'))} entries in total.</p>")
    comp = led["completeness"]
    out.append("<p>Completeness check: " + ("not available, because the ledger check has not run." if comp is None else
               f"{'complete' if comp['ok'] else 'not complete'}, {_e(comp['entries'])} entries, "
               f"{len(comp['breaks'] or [])} break{'' if len(comp['breaks'] or []) == 1 else 's'}.") + "</p>")
    out.append("<h2>Back-tests</h2>")
    out.append(_table(["Back-test", "Version", "Alerts compared", "Agreement", "False closures", "False escalations"],
                      [[b["id"], nm.text(b["version"]), b["n"], f"{round(b['agreement'] * 100)}%", b["false_closures"],
                        b["false_escalations"]] for b in pack["backtests"]], [18, 34, 12, 12, 12, 12]))
    out.append(f"<p>Fingerprint of the graph that the pack was built from: <span class=\"hash\">{_e(pack['graph_sha256'])}</span></p>")
    out.append("</body></html>\n")
    return "\n".join(out)


def export(cfg: Config, scope: str, out_dir: str | Path | None = None, now: datetime | None = None) -> tuple[Path, dict]:
    st = now or datetime.now(timezone.utc)
    pack = build_pack(cfg, scope, st)
    folder = Path(out_dir or cfg.data_dir / "packs") / f"pack-{slugify(scope.replace('..', '-to-'), 60)}-{st.strftime('%Y%m%d-%H%M%S')}"
    if folder.exists():
        raise PackError(f"The folder {folder.name} exists.")
    texts = {"pack.json": json.dumps(pack, indent=2, ensure_ascii=False) + "\n", "pack.html": render_html(pack)}
    files = []
    for name, text in texts.items():
        write_atomic(folder / name, text)
        raw = text.encode("utf-8")
        files.append({"path": name, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
    manifest = {"v": 1, "created": pack["created"], "files": files}
    write_atomic(folder / "manifest.json", json.dumps(manifest, indent=2) + "\n")
    return folder, manifest


def main(argv: list[str] | None = None) -> int:
    import argparse
    argv = list(argv or [])
    if argv and argv[0] == "pack":
        argv = argv[1:]
    if argv and argv[0] == "export":
        argv = argv[1:]
    ap = argparse.ArgumentParser(prog="pack export")
    ap.add_argument("--config")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--scope", required=True)
    ap.add_argument("--out")
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    from .config import load_config
    try:
        folder, manifest = export(load_config(a.config), a.scope, a.out)
    except (PackError, oversight.OversightError, OSError, ValueError) as exc:
        print(f"The request was refused: {exc}")
        return 2
    print(json.dumps({"path": str(folder), "manifest": manifest}, indent=2) if a.json else
          f"Wrote the pack {folder} with {len(manifest['files'])} files and a manifest.")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:]))
