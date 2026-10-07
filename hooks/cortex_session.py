"""Claude Code hook for the Cortex export check, registered on SessionStart and SessionEnd.

  python cortex_session.py start   checks for drift between ~/.claude and the harness mirror, reports it to Claude
                                    as context, and starts a background sync when there is drift
  python cortex_session.py end     runs the sync: export, check, seal the vault when it is on, commit, push

The script never blocks a session and never fails loudly: any error ends with exit code 0, and the sync records its
result in <data_dir>/sync-status.json, which the next session start reports when it did not finish.
"""
import json
import sys
from pathlib import Path

KG = Path(__file__).resolve().parents[1] / "kg"


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "start"
    try:
        sys.stdin.read()
    except Exception:
        pass
    sys.path.insert(0, str(KG))
    from cortex_kg.config import load_config
    cfg = load_config()
    if not cfg.raw.get("auto_sync", False):
        return
    if mode == "start":
        from cortex_kg.autosync import check_drift
        msg = check_drift(cfg)
        if msg:
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": msg}}))
    elif mode == "end":
        from cortex_kg.autosync import run_sync
        run_sync(cfg)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        main()
    except Exception:
        pass
    sys.exit(0)
