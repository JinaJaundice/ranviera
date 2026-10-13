"""The back-test: replayed decisions compared with the final dispositions of closed alerts.

Ranviera never runs a model. The bank's harness replays closed alerts through a named instruction and model version and
writes the replays as ranviera.run.v1 records, each with ext.backtest set to the back-test id. This module reads those
records and a dispositions file { v: 1, alerts: [{ case_ref, final }] }, counts the agreement, and writes
<data_dir>/backtests/<id>.json. The bank sets the pass threshold, and none is applied here.

A false closure is a replay that closed an alert whose final disposition was to escalate or to request information. A
false escalation is a replay that escalated or requested information on an alert whose final disposition was to close.

Command: backtest compare --agent A --version V --replays FILE --dispositions FILE [--id ID]. Exit 0 on success and 2 on
a refused or invalid request.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from . import ingest_run
from .config import Config
from .instructions import agent_node
from .fileio import write_atomic

FINALS = ("close", "escalate", "request-information")


class BacktestError(ValueError):
    """A refused request. The message is one sentence that names the reason."""


def backtests_dir(cfg: Config) -> Path:
    return cfg.data_dir / "backtests"


def _sha(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _read_dispositions(text: str) -> dict[str, str]:
    try:
        data = json.loads(text)
    except ValueError:
        raise BacktestError("The dispositions file is not valid JSON.") from None
    if not isinstance(data, dict) or data.get("v") != 1 or not isinstance(data.get("alerts"), list):
        raise BacktestError("The dispositions file is not version 1.")
    out: dict[str, str] = {}
    for a in data["alerts"]:
        if not isinstance(a, dict) or not a.get("case_ref") or a.get("final") not in FINALS:
            raise BacktestError(f"Each alert needs a case_ref and a final of {', '.join(FINALS)}.")
        out[str(a["case_ref"])] = a["final"]
    return out


def compare(cfg: Config, agent: str, version: str, replays_text: str, dispositions_text: str, *, bt_id: str | None = None,
            now: datetime | None = None) -> dict:
    if not version or not version.strip():
        raise BacktestError("A back-test names the version that it tests.")
    try:
        records = ingest_run.parse_lines(replays_text)
    except ingest_run.RunFormatError as exc:
        raise BacktestError(f"The replays were refused: {exc}") from None
    final = _read_dispositions(dispositions_text)
    want = agent_node(agent)
    ids = {r["ext"]["backtest"] for r in records if isinstance(r.get("ext"), dict) and r["ext"].get("backtest")}
    if len(ids) > 1:
        raise BacktestError("The replays name more than one back-test id in ext.backtest.")
    bid = bt_id or (next(iter(ids)) if ids else None)
    if not bid:
        bid = f"bt-{(now or datetime.now(timezone.utc)).strftime('%Y%m%d')}-{len(list(backtests_dir(cfg).glob('*.json'))) + 1:03d}"
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", bid):
        raise BacktestError(f"The back-test id '{bid}' is not a plain file name.")
    path = backtests_dir(cfg) / f"{bid}.json"
    if path.exists():
        raise BacktestError(f"The back-test {bid} exists, so give another id with --id.")
    by_run: dict[str, list[dict]] = {}
    for r in records:
        by_run.setdefault(r["run"], []).append(r)
    cases, unmatched, loaded = [], [], {}
    for run, recs in sorted(by_run.items()):
        if agent_node(recs[0]["agent"]["id"]) != want:
            raise BacktestError(f"The replay {run} is of the agent {recs[0]['agent']['id']} and not of {agent}.")
        for r in recs:
            for item in r["payload"].get("instructions_loaded", []):
                loaded[item["id"]] = item["hash"]
        case = next((r["case_ref"] for r in recs if r.get("case_ref")), None)
        decisions = [r for r in recs if r["kind"] == "decision"]
        outcome = decisions[-1]["payload"]["outcome"] if decisions else None
        if case is None or case not in final or outcome is None:
            unmatched.append(run)
            continue
        agree = outcome == final[case]
        kind = ("agree" if agree else "false_closure" if outcome == "close" else
                "false_escalation" if final[case] == "close" else "other_difference")
        cases.append({"case_ref": case, "run": run, "replay": outcome, "final": final[case], "result": kind})
    n = len(cases)
    if n == 0:
        raise BacktestError("No replay matches a closed alert by case reference, so nothing was compared.")
    replayed = {c["case_ref"] for c in cases}
    out = {
        "v": 1, "id": bid, "agent": want, "version": version.strip(),
        "created": (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"), "n": n,
        "agree": sum(1 for c in cases if c["result"] == "agree"),
        "agreement": round(sum(1 for c in cases if c["result"] == "agree") / n, 4),
        "false_closures": sum(1 for c in cases if c["result"] == "false_closure"),
        "false_escalations": sum(1 for c in cases if c["result"] == "false_escalation"),
        "other_differences": sum(1 for c in cases if c["result"] == "other_difference"),
        "unmatched_replays": unmatched, "alerts_without_replay": sorted(set(final) - replayed),
        "instructions_loaded": [{"id": i, "hash": h} for i, h in sorted(loaded.items())],
        "inputs": {"replays": _sha(replays_text), "dispositions": _sha(dispositions_text)},
        "cases": cases,
    }
    write_atomic(path, json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    return out


def load_all(cfg: Config) -> list[dict]:
    d = backtests_dir(cfg)
    out = []
    for p in sorted(d.glob("*.json")) if d.is_dir() else []:
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except ValueError:
            continue
    return out


def summaries(cfg: Config, agent: str | None = None) -> list[dict]:
    """The back-tests of an agent in the form of MonitoringReport.backtests."""
    want = agent_node(agent) if agent else None
    return [{"id": b["id"], "version": b["version"], "n": b["n"], "agreement": b["agreement"],
             "false_closures": b["false_closures"], "false_escalations": b["false_escalations"]}
            for b in load_all(cfg) if not want or b.get("agent") == want]


def main(argv: list[str] | None = None) -> int:
    import argparse
    argv = list(argv or [])
    if argv and argv[0] == "backtest":
        argv = argv[1:]
    if argv and argv[0] == "compare":
        argv = argv[1:]
    ap = argparse.ArgumentParser(prog="backtest compare")
    ap.add_argument("--config")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--agent", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--replays", required=True)
    ap.add_argument("--dispositions", required=True)
    ap.add_argument("--id")
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    from .config import load_config
    cfg = load_config(a.config)
    try:
        out = compare(cfg, a.agent, a.version, Path(a.replays).read_text(encoding="utf-8"),
                      Path(a.dispositions).read_text(encoding="utf-8"), bt_id=a.id)
    except (BacktestError, OSError) as exc:
        print(f"The request was refused: {exc}")
        return 2
    print(json.dumps(out, indent=2, ensure_ascii=False) if a.json else
          f"Back-test {out['id']}: {out['n']} compared, agreement {out['agreement']}, {out['false_closures']} false "
          f"closure(s) and {out['false_escalations']} false escalation(s).")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:]))
