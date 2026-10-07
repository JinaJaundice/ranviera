"""The Cortex event hook. Claude Code runs it for each registered hook event, through hooks/cortex_hook.py or through
the command `hook <Event>` of the bundled compiler.

It reads one JSON payload from standard input, maps it to an event with hookmap.py and appends the event to the month
file in the data folder. It prints nothing and never raises, so that it cannot block a session. Set CORTEX_DEBUG=1 to
write errors to <data folder>/hook-errors.log. The module imports the standard library and two small modules only,
so that the append takes well under 50 ms.
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path
from types import SimpleNamespace

from . import events, hookmap
from .config import load_config

# The 7 events that Cortex records. hookinstall.py registers the same list.
HOOK_EVENTS = ["SessionStart", "SessionEnd", "UserPromptSubmit", "InstructionsLoaded", "PreToolUse",
               "SubagentStart", "SubagentStop"]


def data_dir(cfg=None) -> Path:
    """CORTEX_DATA_DIR, else the data folder of the configuration."""
    env = os.environ.get("CORTEX_DATA_DIR")
    if env:
        return Path(os.path.expanduser(env))
    return (cfg or load_config()).data_dir


def wants_snippets(cfg=None) -> bool:
    """Prompt snippets are stored only when log_prompt_snippets is true in the configuration."""
    if os.environ.get("CORTEX_LOG_SNIPPETS") == "1":
        return True
    try:
        return bool((cfg or load_config()).raw.get("log_prompt_snippets"))
    except Exception:
        return False


def run(raw: bytes, event: str | None = None) -> bool:
    """Map one payload and append its event. Returns whether an event was written. A payload without an event name
    takes the one given on the command line."""
    payload = json.loads(raw.decode("utf-8"))
    if event and isinstance(payload, dict) and not payload.get("hook_event_name"):
        payload["hook_event_name"] = event
    cfg = load_config()
    data = data_dir(cfg)
    with open(data / "index.json", encoding="utf-8") as fh:
        index = json.load(fh)
    ev = hookmap.map_hook(payload, index, log_snippets=wants_snippets(cfg))
    if not ev:
        return False
    events.append(SimpleNamespace(events_dir=data / "events"), ev)
    return True


def _log(exc_text: str) -> None:
    try:
        data = data_dir()
        data.mkdir(parents=True, exist_ok=True)
        with open(data / "hook-errors.log", "a", encoding="utf-8") as fh:
            fh.write(time.strftime("%Y-%m-%dT%H:%M:%S") + "\n" + exc_text + "\n")
    except BaseException:
        pass


def main(event: str | None = None, stdin=None) -> int:
    """The entry point of both commands. Always returns 0."""
    try:
        raw = (stdin or sys.stdin.buffer).read()
        run(raw, event)
    except BaseException:
        if os.environ.get("CORTEX_DEBUG") == "1":
            _log(traceback.format_exc())
    return 0
