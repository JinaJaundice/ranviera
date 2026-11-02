# Copyright 2026 Cortex contributors. Licensed under the Apache License, Version 2.0 (see ../LICENSE).
"""Read the outcomes ledger and the held band derived from it.

Usage: outcomes.py [--learn-dir PATH] [--format markdown|json] <command>
  list [--node ID]   the graded answers, oldest first
  held [--node ID]   the held band of each proposition that has an outcome, and the calibration of confidence
The band is derived at read time and is not graph truth. It follows the contracts, "Derived metrics".
"""
from __future__ import annotations

import argparse
import sys

sys.dont_write_bytecode = True


import _data as D

RUNGS = {"R0", "R1", "R2", "R3", "R4", "R5"}
MISS = {"cue", "discrimination", "execution", "careless", "structural"}
CALIBRATION_MIN = 5
CALIBRATION_BAND = 0.15


def check_outcome(obj) -> str | None:
    if not isinstance(obj, dict):
        return "the line is not an object"
    for key in ("id", "at"):
        if not isinstance(obj.get(key), str) or not obj[key]:
            return f"the field {key} is missing or not text"
    target = obj.get("target")
    if not isinstance(target, list) or not target or not all(isinstance(t, str) for t in target):
        return "target is not a non empty list of text"
    if obj.get("correct") is not None and not isinstance(obj.get("correct"), bool):
        return "correct is not true, false or null"
    if obj.get("confidence") is not None and not D.is_number(obj.get("confidence")):
        return "confidence is not a number or null"
    if obj.get("rung") is not None and obj.get("rung") not in RUNGS:
        return "rung is not null or R0 to R5"
    if obj.get("missClass") is not None and obj.get("missClass") not in MISS:
        return "missClass is not null or a known class"
    return None


def held_band(outcomes: list[dict]) -> str:
    """unknown without outcomes. held when the newest 2 are correct at rung null, R0 or R1 and none of the newest 3
    is a structural miss. shaky otherwise."""
    if not outcomes:
        return "unknown"
    newest = list(reversed(outcomes))
    if len(outcomes) >= 2 and all(o.get("correct") is True and o.get("rung") in (None, "R0", "R1") for o in newest[:2]) \
            and not any(o.get("missClass") == "structural" for o in newest[:3]):
        return "held"
    return "shaky"


def calibration(outcomes: list[dict]) -> dict | None:
    """Confidence against accuracy over choice answers that carry a confidence. Null below 5 answers."""
    rows = [o for o in outcomes if o.get("source") == "choice" and D.is_number(o.get("confidence"))]
    if len(rows) < CALIBRATION_MIN:
        return None
    mean = sum(o["confidence"] for o in rows) / len(rows) / 100
    accuracy = sum(1 for o in rows if o.get("correct") is True) / len(rows)
    gap = mean - accuracy
    band = "calibrated" if abs(gap) <= CALIBRATION_BAND else ("overconfident" if gap > 0 else "underconfident")
    return {"n": len(rows), "meanConfidence": mean, "accuracy": accuracy, "gap": gap, "band": band}


def main() -> int:
    parser = argparse.ArgumentParser(prog="outcomes.py", description=__doc__.split("\n")[0])
    D.add_common(parser, top=True)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("list", "held"):
        p = sub.add_parser(name)
        p.add_argument("--node")
        D.add_common(p, top=False)
    args = parser.parse_args()
    root = D.resolve_root(args.learn_dir)
    problems = D.Problems()
    if args.node is not None and args.node == "":
        raise D.ReaderError("The node id is empty.")
    lines = [obj for _, obj in D.read_jsonl(root, "cortex/outcomes.jsonl", problems, check_outcome)]
    lines = sorted(lines, key=lambda o: o["at"])  # stable, so equal times keep ledger order
    chosen = [o for o in lines if args.node is None or args.node in o["target"]]
    note = "Derived from graded answers. A held band is evidence of recall at the time, not mastery."
    md = [f"# Outcomes" if args.command == "list" else "# Held band by proposition", "",
          f"Learning folder: {D.one_line(root)}", "", note, "", D.NOTICE, ""]
    if args.command == "list":
        md.insert(3, f"Count: {len(chosen)}")
        for o in chosen:
            conf = o["confidence"] if o.get("confidence") is not None else "none recorded"
            md.append(f"- {D.one_line(o['at'])}, {D.one_line(o.get('tool'))}, correct {D.one_line(o.get('correct'))}, "
                      f"confidence {D.one_line(conf)}, rung {D.one_line(o.get('rung'))}, miss {D.one_line(o.get('missClass'))}, "
                      f"targets {', '.join(D.one_line(t) for t in o['target'])}, session {D.one_line(o.get('sessionId'))}")
        D.emit(args, {"learn_dir": str(root), "note": note, "count": len(chosen), "outcomes": chosen}, md, problems)
        return 0
    per: dict[str, list[dict]] = {}
    for o in lines:
        for t in o["target"]:
            per.setdefault(t, []).append(o)
    if args.node is not None:
        per.setdefault(args.node, [])
    rows = []
    for nid in sorted(per):
        if args.node is not None and nid != args.node:
            continue
        group = per[nid]
        rows.append({"node": nid, "held": held_band(group), "outcomes": len(group),
                     "lastTested": group[-1]["at"] if group else None})
    cal = calibration(chosen)
    md.insert(3, f"Count: {len(rows)}")
    for r in rows:
        md.append(f"- {D.one_line(r['node'])}: {r['held']}, {r['outcomes']} outcomes, last tested {D.one_line(r['lastTested'])}")
    md.append("")
    md.append("Calibration: " + ("not shown, fewer than 5 choice answers carry a confidence." if cal is None else
              f"{cal['band']}, mean confidence {cal['meanConfidence']:.2f}, accuracy {cal['accuracy']:.2f}, "
              f"gap {cal['gap']:.2f}, over {cal['n']} answers."))
    D.emit(args, {"learn_dir": str(root), "note": note, "count": len(rows), "held": rows, "calibration": cal}, md, problems)
    return 0


if __name__ == "__main__":
    sys.exit(D.run(main))
