"""Cortex event hook. Claude Code runs this script for the registered hook events.

The logic is in kg/cortex_kg/hook.py. This file stays so that hook entries written before the move keep working. It
reads one JSON payload from stdin, appends the event to the month file in the data folder, prints nothing and always
exits 0. Set CORTEX_DEBUG=1 to write errors to <data folder>/hook-errors.log.
"""
import os
import sys
import time
import traceback
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def _fallback_data_dir() -> str:
    """The data folder of the configured product: data_dir from the configuration, else ~/.claude/<product>."""
    try:
        import json
        conf = Path(os.environ.get("CORTEX_CONFIG") or REPO / "cortex.config.json")
        raw = json.loads(conf.read_text(encoding="utf-8-sig")) if conf.is_file() else {}
        return raw.get("data_dir") or "~/.claude/" + ("cortex" if raw.get("product") == "cortex" else "ranviera")
    except BaseException:
        return "~/.claude/ranviera"


def main() -> None:
    try:
        sys.path.insert(0, str(REPO / "kg"))
        from cortex_kg import hook
        hook.main()
    except BaseException:
        if os.environ.get("CORTEX_DEBUG") == "1":
            try:
                data = Path(os.path.expanduser(os.environ.get("CORTEX_DATA_DIR") or _fallback_data_dir()))
                data.mkdir(parents=True, exist_ok=True)
                with open(data / "hook-errors.log", "a", encoding="utf-8") as fh:
                    fh.write(time.strftime("%Y-%m-%dT%H:%M:%S") + "\n" + traceback.format_exc() + "\n")
            except BaseException:
                pass
    sys.exit(0)


if __name__ == "__main__":
    main()
