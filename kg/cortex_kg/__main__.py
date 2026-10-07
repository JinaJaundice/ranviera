"""The Cortex command line: python cortex.py <command>."""
from __future__ import annotations

import argparse
import json
import sys

from .config import load_config


def _need(name: str):
    from .compile import load_module  # imported here so that the hook command starts fast
    mod = load_module(name)
    if mod is None:
        print(f"The {name} module is not available yet.")
    return mod


def _show(result, sentence: str) -> None:
    """Print a sentence, then the result as JSON when it carries detail."""
    print(sentence)
    if isinstance(result, (dict, list)) and result:
        print(json.dumps(result, ensure_ascii=False, indent=1, default=str))


def cmd_build(cfg, args) -> int:
    from .compile import build
    r = build(cfg)
    print(f"Built the graph: {r['nodes']:,} nodes and {r['edges']:,} edges in {r['seconds']} seconds.")
    if r["dropped_edges"]:
        print(f"{r['dropped_edges']:,} edges were dropped because an end node is missing.")
    return 0


def cmd_check(cfg, args) -> int:
    from .validate import check
    from .compile import stamp_health
    h = stamp_health(cfg, check(cfg, strict=args.strict, ci=args.ci))
    c = h["counts"]
    print(f"Checked the graph: {c['violation']} violations, {c['warning']} warnings and {c['info']} notes.")
    if args.ci:
        from .validate import ci_blocking
        blocking = ci_blocking(h["findings"])
        for f in blocking[:20]:
            print(f"  {f['check']} {f['message']}")
        print(f"{len(blocking)} of the violations fail a CI run.")
        return 1 if args.strict and blocking else 0
    return 1 if args.strict and c["violation"] else 0


def cmd_reason(cfg, args) -> int:
    from . import reason
    path = cfg.data_dir / "graph.json"
    if not path.is_file():
        print("The graph has not been built yet. Run the build command first.")
        return 1
    graph = json.loads(path.read_text(encoding="utf-8"))
    (inferred, _edges, findings), seconds = reason.timed_run(cfg, graph)
    from .compile import OutputWriteError, finish_check, inferred_on_disk, refresh_dataset
    if not inferred_on_disk(cfg, inferred):
        raise OutputWriteError("The reason command could not write inferred.json.")
    reason.merge_findings(cfg, findings)
    refresh_dataset(cfg)
    health = finish_check(cfg)
    print(reason.summary(inferred, findings, seconds))
    c = health["counts"]
    print(f"Checked the graph: {c['violation']} violations, {c['warning']} warnings and {c['info']} notes.")
    return 0


def cmd_explain(cfg, args) -> int:
    from . import reason
    path = cfg.data_dir / "inferred.json"
    if not path.is_file():
        print("There is no inferred.json yet. Run the build or reason command first.")
        return 1
    for line in reason.explain(json.loads(path.read_text(encoding="utf-8")), " ".join(args.fact)):
        print(line)
    return 0


def cmd_stats(cfg, args) -> int:
    path = cfg.data_dir / "graph.json"
    if not path.is_file():
        print("The graph has not been built yet. Run the build command first.")
        return 1
    g = json.loads(path.read_text(encoding="utf-8"))
    s = g["stats"]
    print(f"The graph built on {g['built']} has {s['nodes']:,} nodes and {s['edges']:,} edges.")
    for cls, n in sorted(s["by_class"].items(), key=lambda kv: -kv[1]):
        print(f"{cls}: {n:,}")
    return 0


def cmd_replay(cfg, args) -> int:
    mod = _need("replay")
    if mod is None:
        return 1
    r = mod.replay(cfg, since=args.since, dry_run=args.dry_run)
    _show(r, "Replayed past chats into events." if not args.dry_run else "Dry run of the replay of past chats.")
    return 0


def cmd_lexicon_check(cfg, args) -> int:
    mod = _need("lexicon")
    if mod is None:
        return 1
    text = args.text if args.text is not None else sys.stdin.read()
    hits = mod.check_text(cfg, text)
    if isinstance(hits, dict) and "hits" in hits:
        hits = hits["hits"]
    print(json.dumps({"hits": hits}, ensure_ascii=False, default=str))
    return 0


def cmd_lexicon_compile(cfg, args) -> int:
    mod = _need("lexicon")
    if mod is None:
        return 1
    r = mod.compile_rules(cfg)
    _show(r if not isinstance(r, (str, int)) else None, "Compiled the lexicon rules.")
    return 0


def cmd_ratify(cfg, args) -> int:
    from datetime import date
    mod = _need("lexicon")
    if mod is None:
        return 1
    print(mod.ratify(cfg, args.concept, date.today().isoformat()))
    return 0


def cmd_export(cfg, args) -> int:
    mod = _need("sync")
    if mod is None:
        return 1
    _show(mod.export(cfg, dry_run=args.dry_run), "Dry run of the export to the harness mirror." if args.dry_run else "Exported the harness to the mirror.")
    return 0


def cmd_sync(cfg, args) -> int:
    from .autosync import run_sync
    r = run_sync(cfg, push=True if args.push else False if args.no_push else None)
    if r.get("skipped"):
        print(r["skipped"])
        return 0
    if not r.get("ok"):
        print(f"The sync did not finish: {r.get('error')}")
        return 1
    v = r.get("vault") or {}
    parts = [f"Synced {r.get('files', 0)} files from ~/.claude into the mirror"]
    parts.append("committed the changes" if r.get("committed") else "found nothing new to commit")
    parts.append("pushed to GitHub" if r.get("pushed") else "pushed nothing")
    if v:
        parts.append("sealed the vault" if v.get("sealed") else "left the vault as it was")
    print(", ".join(parts[:-1]) + " and " + parts[-1] + ".")
    return 0


def cmd_vault(cfg, args) -> int:
    from . import vault
    if args.action == "init":
        r = vault.init(cfg)
        print(f"The vault identity is at {r['identity']} ({'created now' if r['created'] else 'already present'}). "
              f"Its public key {r['public_key']} is one of {r['recipients']} recipients in vault/recipients.txt. "
              "Keep a copy of the identity file in a safe backup place, because without it the vault cannot be opened.")
    elif args.action == "seal":
        r = vault.seal(cfg, force=args.force)
        print(f"Sealed {r['files']} files into vault/memory.age ({r['bytes']:,} bytes)." if r.get("sealed") else r["reason"])
    elif args.action == "status":
        r = vault.status(cfg)
        print(f"The vault is {'on' if r['enabled'] else 'off'} in cortex.config.json, this machine "
              f"{'has' if r['identity'] else 'has no'} identity, there are {r['recipients']} recipients, and the "
              f"{r['files']} files are {'in step with' if r['in_step'] else 'newer than'} the sealed store.")
    elif args.action == "open":
        r = vault.open_store(cfg, dry_run=args.dry_run)
        print(f"Wrote {r['written']} files from the vault and backed up {r['backed_up']}." if r.get("opened") else r["reason"])
    return 0


def cmd_doctor(cfg, args) -> int:
    mod = _need("sync")
    if mod is None:
        return 1
    d = mod.doctor(cfg)
    if isinstance(d, dict) and "changed" in d:
        print(f"Checked the drift: {len(d['changed'])} files changed, {len(d.get('missing_in_mirror', []))} missing in the mirror "
              f"and {len(d.get('missing_in_home', []))} missing in the home folder.")
        return 0
    _show(d, "Checked the drift between the home folder and the mirror.")
    return 0


def cmd_install(cfg, args) -> int:
    mod = _need("sync")
    if mod is None:
        return 1
    r = mod.install(cfg, target_home=args.target_home, projects_root=args.projects_root, mode=args.mode, dry_run=args.dry_run)
    _show(r, "Dry run of the install." if args.dry_run else "Installed the harness.")
    return 0


def cmd_hook(cfg, args) -> int:
    from .hook import main as hook_main
    return hook_main(args.event)


def cmd_hooks(cfg, args) -> int:
    from . import hookinstall
    try:
        r = getattr(hookinstall, args.action)(cfg)
    except hookinstall.HooksError as exc:
        if args.json:
            print(json.dumps({"error": str(exc)}))
        else:
            print(str(exc))
        return 1
    if args.json:
        print(json.dumps(r, ensure_ascii=False))
        return 0
    if args.action == "preview":
        print(f"{r['settings_path']} {'already holds' if r['installed'] else 'does not yet hold'} the Cortex hook entries. "
              f"The install adds these {len(r['entries'])} entries and keeps every other entry:")
        for e in r["entries"]:
            print(f"  {e['event']}: {e['command']}")
    elif args.action == "install":
        print(f"Added {r['added']} Cortex hook entries to {r['settings_path']}."
              + (f" The earlier file is saved at {r['backup']}." if r["backup"] else " Nothing needed to change."))
    else:
        print(f"Removed {len(r['removed'])} Cortex hook commands from {r['settings_path']}."
              + (f" The earlier file is saved at {r['backup']}." if r["backup"] else " Nothing needed to change."))
    return 0


def cmd_bin(cfg, args) -> int:
    from . import hookinstall
    r = hookinstall.ensure_bin(cfg)
    if args.json:
        print(json.dumps(r, ensure_ascii=False))
    elif r["copied"]:
        print(f"Copied the runner for version {r['version']} to {r['path']}.")
    else:
        print(r["reason"])
    return 0


def make_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="cortex", description="Cortex knowledge graph commands.")
    p.add_argument("--config", help="path to cortex.config.json")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("build", help="harvest the set-up and write the graph").set_defaults(fn=cmd_build)
    c = sub.add_parser("check", help="validate the graph")
    c.add_argument("--strict", action="store_true", help="exit 1 on any violation")
    c.add_argument("--ci", action="store_true", help="apply the checks for a committed repository")
    c.set_defaults(fn=cmd_check)
    sub.add_parser("reason", help="run the rules over the built graph").set_defaults(fn=cmd_reason)
    ex_ = sub.add_parser("explain", help="print the proof tree of an inferred fact")
    ex_.add_argument("fact", nargs="+", help="a fact, or part of its key, as shown in inferred.json")
    ex_.set_defaults(fn=cmd_explain)
    sub.add_parser("stats", help="show the size of the built graph").set_defaults(fn=cmd_stats)
    r = sub.add_parser("replay", help="turn past chats into events")
    r.add_argument("--since")
    r.add_argument("--dry-run", action="store_true")
    r.set_defaults(fn=cmd_replay)
    lc = sub.add_parser("lexicon-check", help="check text against the vocabulary")
    lc.add_argument("--text")
    lc.set_defaults(fn=cmd_lexicon_check)
    sub.add_parser("lexicon-compile", help="compile the vocabulary rules").set_defaults(fn=cmd_lexicon_compile)
    ra = sub.add_parser("ratify", help="ratify a proposed concept")
    ra.add_argument("concept")
    ra.set_defaults(fn=cmd_ratify)
    ex = sub.add_parser("export", help="copy the live harness into the mirror")
    ex.add_argument("--dry-run", action="store_true")
    ex.set_defaults(fn=cmd_export)
    sub.add_parser("doctor", help="compare the home folder with the mirror").set_defaults(fn=cmd_doctor)
    sy = sub.add_parser("sync", help="export the mirror, check it, commit the synced paths and push")
    sy.add_argument("--no-push", action="store_true", help="commit but do not push")
    sy.add_argument("--push", action="store_true", help="push even where auto_push is off")
    sy.set_defaults(fn=cmd_sync)
    va = sub.add_parser("vault", help="the encrypted store of the memory and the private overlay")
    va.add_argument("action", choices=["init", "seal", "status", "open"])
    va.add_argument("--force", action="store_true", help="seal even when nothing changed")
    va.add_argument("--dry-run", action="store_true", help="with open: count the files without writing")
    va.set_defaults(fn=cmd_vault)
    hk = sub.add_parser("hook", help="record one Claude Code hook event (the payload is read from standard input)")
    hk.add_argument("event", nargs="?", help="the event name, used when the payload holds none")
    hk.set_defaults(fn=cmd_hook)
    hs = sub.add_parser("hooks", help="preview, install or remove the Cortex entries in ~/.claude/settings.json")
    hs.add_argument("action", choices=["preview", "install", "uninstall"])
    hs.add_argument("--json", action="store_true", help="print the result as JSON")
    hs.set_defaults(fn=cmd_hooks)
    bn = sub.add_parser("bin", help="copy the packaged runner to <data_dir>/bin/<version>/")
    bn.add_argument("--json", action="store_true", help="print the result as JSON")
    bn.set_defaults(fn=cmd_bin)
    ins = sub.add_parser("install", help="place the harness on a machine")
    ins.add_argument("--target-home")
    ins.add_argument("--projects-root")
    ins.add_argument("--mode", choices=["copy", "link"], default="copy")
    ins.add_argument("--dry-run", action="store_true")
    ins.set_defaults(fn=cmd_install)
    return p


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if "--config" not in argv and argv[:1] == ["hook"]:
        # the hook command never raises and prints nothing, so it skips the parser and the final error message
        from .hook import main as hook_main
        return hook_main(argv[1] if len(argv) > 1 else None)
    args = make_parser().parse_args(argv)
    cfg = load_config(args.config)
    try:
        code = args.fn(cfg, args)
    except Exception as exc:
        print(f"The {args.command} command failed: {type(exc).__name__}: {exc}")
        return 1
    return code


if __name__ == "__main__":
    sys.exit(main())
