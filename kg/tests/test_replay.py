"""Replay on a small synthetic transcript folder. Events are written only into a temporary data folder."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cortex_kg import events, replay  # noqa: E402
from cortex_kg.config import norm_path  # noqa: E402

DECKS = "C:/Users/test/.claude/rules/decks.md"
INDEX = {"v": 1, "paths": {norm_path(DECKS): "rulefile:decks"}, "prefixes": [],
         "routes": [{"id": "route:decks-and-slides", "patterns": [r"\bdecks?\b"], "fires": ["task:deck"]}],
         "skills": {"plain-writing-voice": "skill:plain-writing-voice"}, "agents": {"checker": "agent:checker"},
         "tools": {}, "terms": [], "faults": {}, "hooks": {}, "always": []}


def jl(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")


def tool_line(ts, tid, name, inp):
    return {"type": "assistant", "timestamp": ts, "sessionId": "S1", "uuid": "u-" + tid,
            "message": {"content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}}


def make_cfg(tmp_path):
    home = tmp_path / "home"
    data = tmp_path / "data"
    data.mkdir()
    (data / "index.json").write_text(json.dumps(INDEX), encoding="utf-8")
    proj = home / "projects" / "p1"
    jl(proj / "S1.jsonl", [
        {"type": "user", "timestamp": "2026-10-02T09:00:00.000Z", "sessionId": "S1", "uuid": "m1",
         "message": {"role": "user", "content": "Please make a deck about SECRETWORD"}},
        {"type": "attachment", "timestamp": "2026-10-02T09:00:01.000Z", "sessionId": "S1", "uuid": "a1",
         "attachment": {"type": "hook_additional_context", "content": [
             "House register.\nRules for this task (read first):\n- Decks and slides: ~/.claude/rules/decks.md\n"
             "- Charts and visuals: ~/.claude/rules/visuals.md"]}},
        tool_line("2026-10-02T09:00:05.000Z", "t2", "Skill", {"skill": "plain-writing-voice"}),
        tool_line("2026-10-02T09:00:03.000Z", "t1", "Read", {"file_path": DECKS}),
        tool_line("2026-10-02T09:00:03.000Z", "t1", "Read", {"file_path": DECKS}),  # a repeated streaming line
        {"type": "user", "timestamp": "2026-10-02T09:00:06.000Z", "sessionId": "S1", "uuid": "m2",
         "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}},
        {"type": "user", "timestamp": "2026-10-02T09:00:07.000Z", "sessionId": "S1", "uuid": "m3",
         "message": {"role": "user", "content": "plain text with no match"}},
    ])
    jl(proj / "S1" / "subagents" / "agent-x.jsonl", [
        {"type": "user", "timestamp": "2026-10-02T09:01:00.000Z", "sessionId": "S1", "isSidechain": True, "uuid": "sm1",
         "message": {"role": "user", "content": "a deck prompt given to a subagent"}},
        tool_line("2026-10-02T09:01:02.000Z", "t3", "Agent", {"subagent_type": "checker"}),
    ])
    jl(home / "register-log" / "2026-10.jsonl", [
        {"t": "2026-10-02T10:00:00", "kind": "file", "session": "S1", "path": "C:\\x\\a.md", "faults": ["tail", "colons"]},
        {"t": "2026-10-02T10:05:00", "kind": "stop", "session": "S1", "faults": []},
        {"t": "2026-10-02T10:06:00", "kind": "reply", "session": "S1", "faults": ["tail"]},
    ])
    return SimpleNamespace(claude_home=home, data_dir=data, events_dir=data / "events")


def test_replay_writes_events_in_time_order(tmp_path):
    cfg = make_cfg(tmp_path)
    r = replay.replay(cfg)
    # the "reply" record counts: hook.py writes scored replies as kind "reply" (register log, October 2026)
    assert r["files"] == 2 and r["events_written"] == 8 and r["skipped_duplicates"] == 1
    assert r["by_kind"] == {"prompt": 2, "route": 1, "read": 1, "skill": 1, "agent.start": 1, "fault": 2}
    got = list(events.read(cfg))
    assert [e["ts"] for e in got] == sorted(e["ts"] for e in got)
    assert all(e["source"] == "replay" for e in got)
    by_kind = {}
    for e in got:
        by_kind.setdefault(e["kind"], []).append(e)
    assert by_kind["route"][0]["nodes"] == ["route:decks-and-slides", "route:charts-and-visuals"]
    assert by_kind["read"][0]["nodes"] == ["rulefile:decks", "builtin:read"] and by_kind["read"][0]["key"] == "t1"
    assert by_kind["fault"][0]["nodes"] == ["fault:tail", "fault:colons"]
    assert by_kind["fault"][0]["key"] == "register:2026-10-02T10:00:00:S1:C:\\x\\a.md"
    prompts = by_kind["prompt"]
    assert "route:decks-and-slides" in prompts[0]["nodes"] and "SECRETWORD" not in json.dumps(got)
    assert all(e["key"] != "sm1" for e in got)  # a subagent prompt is not a user prompt


def test_replay_is_idempotent_and_dry_run_writes_nothing(tmp_path):
    cfg = make_cfg(tmp_path)
    dry = replay.replay(cfg, dry_run=True)
    assert dry["events_written"] == 0 and dry["events_new"] == 8 and not cfg.events_dir.exists()
    replay.replay(cfg)
    again = replay.replay(cfg)
    assert again["events_written"] == 0 and again["skipped_duplicates"] == 9
    assert len(list(events.read(cfg))) == 8


def test_since_limits_the_window(tmp_path):
    cfg = make_cfg(tmp_path)
    r = replay.replay(cfg, since="2026-10-02T09:00:06Z", dry_run=True)
    assert r["by_kind"].get("skill") is None and r["by_kind"]["prompt"] == 1
