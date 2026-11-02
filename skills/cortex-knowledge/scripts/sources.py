# Copyright 2026 Cortex contributors. Licensed under the Apache License, Version 2.0 (see ../LICENSE).
"""Read the linked roots and the file records that Cortex keeps in learn/cortex/.

Usage: sources.py [--learn-dir PATH] [--format markdown|json] <command>
  roots                              the linked roots, with the number of files in each state
  files [--root ID] [--state STATE]  the newest record of each file
A root path and a file path are references. The reader never opens them.
"""
from __future__ import annotations

import argparse
import sys

sys.dont_write_bytecode = True


import _data as D

STATES = {"pending", "current", "missing", "refused"}


def check_file(obj) -> str | None:
    if not isinstance(obj, dict):
        return "the line is not an object"
    for key in ("sourceId", "rootId", "path"):
        if not isinstance(obj.get(key), str) or not obj[key]:
            return f"the field {key} is missing or not text"
    if obj.get("state") not in STATES:
        return "the field state is not one of pending, current, missing or refused"
    return None


def load_roots(root, problems: D.Problems) -> dict[str, dict]:
    data = D.read_json(root, "cortex/sources.json", None)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise D.ReaderError("cortex/sources.json does not hold an object.")
    D.check_version(data.get("version", 1), "cortex/sources.json")
    roots = data.get("roots")
    if not isinstance(roots, dict):
        raise D.ReaderError("cortex/sources.json has no roots object.")
    out = {}
    for rid, rec in roots.items():
        if not isinstance(rec, dict) or not isinstance(rec.get("path"), str) or not isinstance(rec.get("kind"), str):
            problems.add("cortex/sources.json", None, f"the root {rid} lacks a kind or a path")
            continue
        out[rid] = rec
    return out


def load_files(root, problems: D.Problems) -> dict[str, dict]:
    """The newest line for each source id wins."""
    latest: dict[str, dict] = {}
    for _, line in D.read_jsonl(root, "cortex/files.jsonl", problems, check_file):
        latest[line["sourceId"]] = line
    return latest


def main() -> int:
    parser = argparse.ArgumentParser(prog="sources.py", description=__doc__.split("\n")[0])
    D.add_common(parser, top=True)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("roots")
    D.add_common(p, top=False)
    p = sub.add_parser("files")
    p.add_argument("--root")
    p.add_argument("--state", choices=sorted(STATES))
    D.add_common(p, top=False)
    args = parser.parse_args()
    root = D.resolve_root(args.learn_dir)
    problems = D.Problems()
    roots = load_roots(root, problems)
    files = load_files(root, problems)
    md = []
    if args.command == "roots":
        rows = []
        for rid in sorted(roots):
            rec = roots[rid]
            counts = {s: 0 for s in sorted(STATES)}
            for f in files.values():
                if f["rootId"] == rid:
                    counts[f["state"]] += 1
            rows.append({"id": rid, "kind": rec["kind"], "label": rec.get("label"), "path": rec["path"],
                         "sensitivity": rec.get("sensitivity"), "mode": rec.get("mode"),
                         "enabled": rec.get("enabled"), "hostedConsentAt": rec.get("hostedConsentAt"),
                         "lastScanAt": rec.get("lastScanAt"), "files": counts})
        md = ["# Linked roots", "", f"Learning folder: {D.one_line(root)}", f"Count: {len(rows)}", "", D.NOTICE, ""]
        if not rows:
            md.append("No linked roots are recorded in cortex/sources.json.")
        for r in rows:
            md.append(f"- {D.one_line(r['id'])}, {D.one_line(r['kind'])}, {D.one_line(r['label'])}, "
                      f"path {D.one_line(r['path'])}, sensitivity {D.one_line(r['sensitivity'])}, "
                      f"enabled {D.one_line(r['enabled'])}, last scan {D.one_line(r['lastScanAt'])}, files "
                      + ", ".join(f"{k} {v}" for k, v in r["files"].items()))
        D.emit(args, {"learn_dir": str(root), "count": len(rows), "roots": rows}, md, problems)
        return 0
    rows = [f for f in files.values()
            if (args.root is None or f["rootId"] == args.root) and (args.state is None or f["state"] == args.state)]
    rows.sort(key=lambda f: (f["rootId"], f["path"]))
    md = ["# Files under linked roots", "", f"Learning folder: {D.one_line(root)}", f"Count: {len(rows)}", "", D.NOTICE, ""]
    for f in rows:
        extra = f", reason {D.one_line(f['reason'])}" if f.get("reason") else ""
        md.append(f"- {D.one_line(f['sourceId'])}, root {D.one_line(f['rootId'])}, {D.one_line(f['path'])}, "
                  f"{f['state']}, last extracted {D.one_line(f.get('lastExtractedAt'))}{extra}")
    D.emit(args, {"learn_dir": str(root), "count": len(rows), "files": rows}, md, problems)
    return 0


if __name__ == "__main__":
    sys.exit(D.run(main))
