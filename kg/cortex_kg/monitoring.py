"""Monitoring, sampling and drift: the measures of effectiveness that section 7.7 of the specification describes.

`report` gives the MonitoringReport of docs/CONTRACTS.md. It reuses the measures and the bounds of rule O13
(transparency._measures and transparency.load_bounds). The module sets no threshold. The bounds come from the file of the
bank, and without that file the report shows no bound and no breach. A drift entry records that something changed
between 2 periods and does not judge the change.

A sample is kept in <profile_dir>/samples/<id>.json. A draw is random or weighted by risk, and a seed makes it repeat.
A verdict of a reviewer is recorded for each run in the sample, and the agreement by instruction version in the report
comes from those verdicts.

Commands: monitor [--agent A] [--from D] [--to D], sample draw --agent A --size N [--seed S] [--risk-weighted] --by
REVIEWER, and sample verdict SAMPLE RUN --verdict agree|disagree --by REVIEWER [--reason TEXT]. Exit 0 on success, 1 when
the report holds a finding, and 2 on a refused or invalid request.
"""
from __future__ import annotations

import json
import random
import re
import secrets
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from . import backtest
from . import instructions as instr
from .config import Config
from .fileio import write_atomic
from .oversight import View
from .transparency import _measures, load_bounds

VERDICTS = ("agree", "disagree")
KIND_LABELS = {"override": "override rate in thousandths of reviewed decisions", "review_seconds": "average review time in seconds"}


class MonitoringError(ValueError):
    """A refused request. The message is one sentence that names the reason."""


def _day(text: str | None, what: str) -> str | None:
    if text is None:
        return None
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        raise MonitoringError(f"The {what} date '{text}' is not in the form YYYY-MM-DD.") from None


def _in_window(ts: str | None, frm: str | None, to: str | None) -> bool:
    d = (ts or "")[:10]
    return bool(d) and (not frm or d >= frm) and (not to or d <= to)


def _stamp(now: datetime | None) -> datetime:
    return now or datetime.now(timezone.utc)


# ---------------------------------------------------------------- samples

def samples_dir(profile_dir: str | Path) -> Path:
    return Path(profile_dir) / "samples"


def _sample_path(profile_dir: str | Path, sample_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", sample_id):
        raise MonitoringError(f"The sample id '{sample_id}' is not a plain file name.")
    return samples_dir(profile_dir) / f"{sample_id}.json"


def load_sample(profile_dir: str | Path, sample_id: str) -> dict:
    p = _sample_path(profile_dir, sample_id)
    if not p.is_file():
        raise MonitoringError(f"No sample has the id {sample_id}.")
    return json.loads(p.read_text(encoding="utf-8"))


def load_samples(profile_dir: str | Path) -> list[dict]:
    d = samples_dir(profile_dir)
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(d.glob("*.json"))] if d.is_dir() else []


def _save_sample(profile_dir: str | Path, s: dict) -> Path:
    p = _sample_path(profile_dir, s["id"])
    write_atomic(p, json.dumps(s, indent=2, ensure_ascii=False) + "\n")
    return p


def _next_sample_id(profile_dir: str | Path, day: str) -> str:
    n = 0
    for s in load_samples(profile_dir):
        m = re.fullmatch(rf"sample-{day}-(\d+)", s["id"])
        if m:
            n = max(n, int(m.group(1)))
    return f"sample-{day}-{n + 1:03d}"


def risk_weight(summary: dict) -> int:
    """1 for every run, 3 more where the reviewer overrode the agent, and 1 more for each finding on the run."""
    return 1 + (3 if summary["override"] else 0) + int(summary["findings"])


def draw(cfg: Config, agent: str, size: int, by: str, *, seed: int | None = None, risk_weighted: bool = False,
         now: datetime | None = None, view: View | None = None) -> dict:
    """Draw a sample of the runs of an agent that reached a decision. The same seed over the same runs gives the same
    sample, and the seed that was used is stored."""
    from .oversight import runs as run_list
    if not by or not str(by).strip():
        raise MonitoringError("A draw needs the reviewer who draws it.")
    if size < 1:
        raise MonitoringError("The size of a sample must be 1 or more.")
    v = view or View(cfg)
    pool = [r for r in run_list(cfg, agent, view=v) if r["outcome"]]
    if not pool:
        raise MonitoringError(f"The agent {agent} has no run with a decision to sample.")
    pool.sort(key=lambda r: r["run"])
    used = seed if seed is not None else secrets.randbits(32)
    rng = random.Random(used)
    k = min(size, len(pool))
    weights = {r["run"]: risk_weight(r) if risk_weighted else 1 for r in pool}
    if risk_weighted:
        keyed = sorted(((rng.random() ** (1.0 / weights[r["run"]]), r["run"]) for r in pool), reverse=True)
        chosen = sorted(run for _k, run in keyed[:k])
    else:
        chosen = sorted(r["run"] for r in rng.sample(pool, k))
    st = _stamp(now)
    sample = {
        "v": 1, "id": _next_sample_id(cfg.profile_dir, st.strftime("%Y%m%d")), "agent": instr.agent_node(agent),
        "requested": size, "size": k, "seed": used, "risk_weighted": risk_weighted, "pool": len(pool),
        "drawn_by": str(by).strip(), "drawn_at": st.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "runs": [{"run": r, "weight": weights[r], "verdict": None, "reason": None, "by": None, "at": None}
                 for r in chosen],
    }
    _save_sample(cfg.profile_dir, sample)
    return sample


def verdict(cfg: Config, sample_id: str, run: str, outcome: str, by: str, reason: str | None = None,
            now: datetime | None = None) -> dict:
    """Record the verdict of a reviewer on one run of a sample. A later verdict replaces the earlier one."""
    if outcome not in VERDICTS:
        raise MonitoringError("A verdict is agree or disagree.")
    if not by or not str(by).strip():
        raise MonitoringError("A verdict needs the reviewer who gives it.")
    s = load_sample(cfg.profile_dir, sample_id)
    row = next((r for r in s["runs"] if r["run"] == run), None)
    if row is None:
        raise MonitoringError(f"The run {run} is not in {sample_id}.")
    row.update(verdict=outcome, reason=reason, by=str(by).strip(), at=_stamp(now).strftime("%Y-%m-%dT%H:%M:%SZ"))
    _save_sample(cfg.profile_dir, s)
    return s


# ---------------------------------------------------------------- measures and drift

def _versions_in_context(v: View, rid: str) -> set[str]:
    out = set()
    for s in v.steps(rid):
        out.update(i for i in v.out(s, "inContext") if v.type_of(i) == "InstructionVersion")
    return out


def _override_rate(v: View, rids: list[str]) -> tuple[int | None, int]:
    flagged = over = 0
    for rid in rids:
        d = v.decisions(rid)
        rv = v.out(d[-1][0], "reviewedBy") if d else []
        if rv and v.prop(rv[0], "override") is not None:
            flagged += 1
            over += 1 if v.prop(rv[0], "override") is True else 0
    return (int(round(1000 * over / flagged)) if flagged else None), flagged


def _sources(v: View, rid: str) -> dict[str, str]:
    out = {}
    for s in v.steps(rid):
        for e in v.out(s, "usedEvidence"):
            ref, h = v.prop(e, "sourceRef"), v.prop(e, "sourceHash")
            if ref and h:
                out[str(ref)] = str(h)
    return out


def detect_drift(v: View, agent_runs: list[str], frm: str | None, to: str | None) -> list[dict]:
    """Changes between periods for one agent. The instruction versions in context, the model version and the snapshot hash
    of each source are compared from one run to the next, and the override rate is compared between the period and the
    period of equal length before it, or between the 2 halves of the runs where no period is given."""
    out: list[dict] = []
    ordered = sorted(agent_runs, key=lambda r: (str(v.prop(r, "startedAt") or ""), r))
    for prev, cur in zip(ordered, ordered[1:]):
        ts = str(v.prop(cur, "startedAt") or "")
        if not _in_window(ts, frm, to):
            continue
        a = {(i, v.prop(i, "hash")) for i in _versions_in_context(v, prev)}
        b = {(i, v.prop(i, "hash")) for i in _versions_in_context(v, cur)}
        if a != b:
            ids_a, ids_b = {i for i, _ in a}, {i for i, _ in b}
            parts = []
            if ids_b - ids_a:
                parts.append("added " + ", ".join(sorted(ids_b - ids_a)))
            if ids_a - ids_b:
                parts.append("removed " + ", ".join(sorted(ids_a - ids_b)))
            changed = sorted(i for i in ids_a & ids_b if dict(a)[i] != dict(b)[i])
            if changed:
                parts.append("the hash changed for " + ", ".join(changed))
            out.append({"kind": "instruction", "detail": "The instruction versions in context changed: " + "; ".join(parts) + ".",
                        "since": ts})
        ma, mb = v.out(prev, "ranOn"), v.out(cur, "ranOn")
        if ma != mb:
            out.append({"kind": "model", "detail": f"The model version changed from {', '.join(ma) or 'none'} to "
                                                    f"{', '.join(mb) or 'none'}.", "since": ts})
        sa, sb = _sources(v, prev), _sources(v, cur)
        for src in sorted(set(sa) & set(sb)):
            if sa[src] != sb[src]:
                out.append({"kind": "snapshot", "detail": f"The snapshot hash of the source {src} changed.", "since": ts})
    in_window = [r for r in ordered if _in_window(str(v.prop(r, "startedAt") or ""), frm, to)]
    if frm and to:
        span = (date.fromisoformat(to) - date.fromisoformat(frm)).days + 1
        p_to = date.fromisoformat(frm) - timedelta(days=1)
        p_from = p_to - timedelta(days=span - 1)
        earlier = [r for r in ordered if _in_window(str(v.prop(r, "startedAt") or ""), p_from.isoformat(), p_to.isoformat())]
        later, since = in_window, frm
    else:
        half = len(in_window) // 2
        earlier, later = in_window[:half], in_window[half:]
        since = str(v.prop(later[0], "startedAt") or "")[:10] if later else ""
    (r0, n0), (r1, n1) = _override_rate(v, earlier), _override_rate(v, later)
    if r0 is not None and r1 is not None and r0 != r1:
        out.append({"kind": "override", "detail": f"The override rate changed from {r0} to {r1} in thousandths of reviewed "
                                                  f"decisions ({n0} and {n1} reviews), and no threshold was applied.",
                    "since": since})
    return out


def _agreement(v: View, profile_dir: Path, agent_id: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for s in load_samples(profile_dir):
        if s.get("agent") != agent_id:
            continue
        for row in s["runs"]:
            if row.get("verdict") not in VERDICTS:
                continue
            for vid in sorted(_versions_in_context(v, row["run"])):
                e = out.setdefault(vid, {"sampled": 0, "agree": 0})
                e["sampled"] += 1
                e["agree"] += 1 if row["verdict"] == "agree" else 0
    return out


def report(cfg: Config, agent: str | None = None, frm: str | None = None, to: str | None = None,
           view: View | None = None) -> dict:
    frm, to = _day(frm, "from"), _day(to, "to")
    v = view or View(cfg)
    bounds, _path, _problem = load_bounds(cfg)
    keep = {r for r in v.runs() if _in_window(str(v.prop(r, "startedAt") or ""), frm, to)}
    nodes = {i: n for i, n in v.nodes.items() if n.get("type") != "Run" or i in keep}
    measures = _measures(nodes, [(e["s"], e["r"], e["t"]) for e in v.edges])
    wanted = instr.agent_node(agent) if agent else None
    agent_ids = sorted({v.agent_of(r) for r in v.runs()} - {None})
    agents, findings = [], []
    for aid in agent_ids:
        if wanted and aid != wanted:
            continue
        all_runs = [r for r in v.runs() if v.agent_of(r) == aid]
        mine = [r for r in all_runs if r in keep]
        decisions = [d for r in mine for d in v.decisions(r)]
        reviewed = sum(1 for d, _s in decisions if v.out(d, "reviewedBy"))
        m = measures.get(aid, {})
        b = {k: {"min": x.get("min"), "max": x.get("max")} for k, x in bounds.get(aid, {}).items()}
        agents.append({
            "id": aid, "label": v.label(aid), "decisions": len(decisions), "reviewed": reviewed,
            "override_per_mille": m.get("override"), "review_seconds_mean": m.get("review_seconds"),
            "agreement_by_version": _agreement(v, cfg.profile_dir, aid), "bounds": b,
            "drift": detect_drift(v, all_runs, frm, to), "backtests": backtest.summaries(cfg, aid),
        })
        if frm or to:   # the period differs from the whole graph that rule O13 read, so the comparison is made here
            for kind, key in (("override", "override_per_mille"), ("review_seconds", "review_seconds_mean")):
                val, lim = agents[-1][key], b.get(kind, {})
                if val is None:
                    continue
                for end, word, bad in (("max", "above", lambda x, y: x > y), ("min", "below", lambda x, y: x < y)):
                    if lim.get(end) is not None and bad(val, lim[end]):
                        findings.append({"check": "O13", "severity": "warning", "node": aid, "proof": None,
                                         "message": f"The {KIND_LABELS[kind]} of {aid} in this period is {val}, {word} the "
                                                    f"{end}imum of {lim[end]} that the bank set."})
    scope = {a["id"] for a in agents}
    if not (frm or to):
        findings += [{k: x for k, x in f.items() if not k.startswith("_")} for f in v.findings
                     if f["check"] == "O13" and f["node"] in scope]
    return {"from": frm, "to": to, "agents": agents, "findings": findings}


# ---------------------------------------------------------------- command line

def _render(rep: dict) -> str:
    lines = [f"Monitoring from {rep['from'] or 'the start'} to {rep['to'] or 'now'}"]
    for a in rep["agents"]:
        lines.append(f"{a['id']}: {a['decisions']} decision(s), {a['reviewed']} reviewed, override "
                     f"{a['override_per_mille']} per thousand, mean review {a['review_seconds_mean']} s")
        lines += [f"  drift ({d['kind']}) since {d['since']}: {d['detail']}" for d in a["drift"]]
    lines += [f"{f['check']} {f['severity']}: {f['message']}" for f in rep["findings"]]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    import argparse
    from . import people as ppl
    from .runledger import RunLedger
    argv = list(argv or [])
    if argv and argv[0] == "monitor":
        argv = argv[1:]
    if argv and argv[0] == "sample":
        argv = argv[1:]
    if argv and argv[0] in ("draw", "verdict"):
        return _sample_main(argv, ppl, RunLedger)
    ap = argparse.ArgumentParser(prog="monitor")
    ap.add_argument("--config")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--agent")
    ap.add_argument("--from", dest="frm")
    ap.add_argument("--to")
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    from .config import load_config
    try:
        rep = report(load_config(a.config), a.agent, a.frm, a.to)
    except (MonitoringError, OSError, ValueError) as exc:
        print(f"The request was refused: {exc}")
        return 2
    print(json.dumps(rep, indent=2, ensure_ascii=False) if a.json else _render(rep))
    return 1 if rep["findings"] else 0


def _sample_main(argv: list[str], ppl, RunLedger) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="sample")
    ap.add_argument("--config")
    ap.add_argument("--json", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("draw")
    d.add_argument("--agent", required=True)
    d.add_argument("--size", type=int, required=True)
    d.add_argument("--seed", type=int)
    d.add_argument("--risk-weighted", action="store_true")
    d.add_argument("--by")
    vd = sub.add_parser("verdict")
    vd.add_argument("sample")
    vd.add_argument("run")
    vd.add_argument("--verdict", required=True, choices=VERDICTS)
    vd.add_argument("--by")
    vd.add_argument("--reason")
    for p in (d, vd):
        p.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        p.add_argument("--config", default=argparse.SUPPRESS)
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    from .config import load_config
    cfg = load_config(a.config)
    try:
        by = (a.by or ppl.actor(cfg) or "").strip()
        ok, why = ppl.can(ppl.load_people(cfg), by, "verdict")
        if not ok:
            print(f"The request was refused: {why}")
            return 2
        if a.cmd == "draw":
            out = draw(cfg, a.agent, a.size, by, seed=a.seed, risk_weighted=a.risk_weighted)
            msg = f"Drew {out['id']} with {out['size']} of {out['pool']} runs and seed {out['seed']}."
        else:
            out = verdict(cfg, a.sample, a.run, a.verdict, by, a.reason)
            key = Path(cfg.ledger_key).read_bytes().strip() if cfg.ledger_key else None
            RunLedger(cfg.data_dir).append("review", {"sample": a.sample, "run": a.run, "verdict": a.verdict,
                                                      "reason": a.reason}, run=None, actor=by, key=key)
            msg = f"Recorded {a.verdict} for {a.run} in {a.sample}."
    except (MonitoringError, ppl.PeopleError, OSError, ValueError) as exc:
        print(f"The request was refused: {exc}")
        return 2
    print(json.dumps(out, indent=2, ensure_ascii=False) if a.json else msg)
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:]))
