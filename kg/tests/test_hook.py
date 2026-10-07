"""The hook script, run as Claude Code runs it: a subprocess with a JSON payload on stdin."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HOOK = Path(__file__).resolve().parents[2] / "hooks" / "cortex_hook.py"
INDEX = {"v": 1, "paths": {}, "prefixes": [], "routes": [{"id": "route:decks", "patterns": [r"\bdecks?\b"],
         "fires": ["task:deck"]}], "skills": {}, "agents": {}, "tools": {}, "terms": [], "faults": {},
         "hooks": {}, "always": []}


def run(data_dir, payload, raw=None, debug=False):
    env = {**os.environ, "CORTEX_DATA_DIR": str(data_dir), "CORTEX_CONFIG": str(data_dir / "none.json")}
    env.pop("CORTEX_LOG_SNIPPETS", None)
    env.pop("CORTEX_DEBUG", None)
    if debug:
        env["CORTEX_DEBUG"] = "1"
    stdin = raw if raw is not None else json.dumps(payload).encode()
    return subprocess.run([sys.executable, str(HOOK)], input=stdin, capture_output=True, env=env, timeout=30)


def lines(data_dir):
    return [json.loads(x) for f in sorted((data_dir / "events").glob("*.jsonl"))
            for x in f.read_text(encoding="utf-8").splitlines()]


def test_pre_tool_use_writes_one_line_and_prints_nothing(tmp_path):
    (tmp_path / "index.json").write_text(json.dumps(INDEX), encoding="utf-8")
    p = {"session_id": "s1", "transcript_path": "t", "cwd": str(tmp_path), "hook_event_name": "PreToolUse",
         "tool_name": "Grep", "tool_input": {"pattern": "x"}, "tool_use_id": "toolu_9"}
    r = run(tmp_path, p)
    assert r.returncode == 0 and r.stdout == b"" and r.stderr == b""
    ev = lines(tmp_path)
    assert len(ev) == 1 and ev[0]["kind"] == "tool" and ev[0]["key"] == "toolu_9" and ev[0]["session"] == "s1"


def test_prompt_text_is_not_stored(tmp_path):
    (tmp_path / "index.json").write_text(json.dumps(INDEX), encoding="utf-8")
    p = {"session_id": "s1", "hook_event_name": "UserPromptSubmit", "prompt": "make a deck with SECRETWORD"}
    r = run(tmp_path, p)
    assert r.returncode == 0 and r.stdout == b""
    raw = next((tmp_path / "events").glob("*.jsonl")).read_text(encoding="utf-8")
    assert "SECRETWORD" not in raw and "route:decks" in raw


def test_errors_exit_zero_silently_and_log_only_when_asked(tmp_path):
    r = run(tmp_path, None, raw=b"not json")
    assert r.returncode == 0 and r.stdout == b"" and r.stderr == b""
    assert not (tmp_path / "hook-errors.log").exists()
    r = run(tmp_path, {"hook_event_name": "SessionStart"}, debug=True)  # no index.json
    assert r.returncode == 0 and r.stdout == b""
    assert "index.json" in (tmp_path / "hook-errors.log").read_text(encoding="utf-8")


def test_payload_with_no_nodes_writes_nothing(tmp_path):
    (tmp_path / "index.json").write_text(json.dumps(INDEX), encoding="utf-8")
    r = run(tmp_path, {"session_id": "s", "hook_event_name": "SubagentStart", "agent_type": "nobody"})
    assert r.returncode == 0 and r.stdout == b"" and not (tmp_path / "events").exists()


# ---------------------------------------------------------------- the session hook (export check)

SESSION = Path(__file__).resolve().parents[2] / "hooks" / "cortex_session.py"


def run_session(config_path, mode, stdin=b"{}"):
    env = {**os.environ, "CORTEX_CONFIG": str(config_path)}
    return subprocess.run([sys.executable, str(SESSION), mode], input=stdin, capture_output=True, env=env, timeout=30)


def load_session_module():
    import importlib.util
    spec = importlib.util.spec_from_file_location("cortex_session_under_test", SESSION)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_session_hook_does_nothing_when_auto_sync_is_off(tmp_path):
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps({"auto_sync": False, "data_dir": str(tmp_path / "d"), "claude_home": str(tmp_path / "h")}),
                   encoding="utf-8")
    for mode in ("start", "end"):
        r = run_session(cfg, mode)
        assert r.returncode == 0 and r.stdout == b"" and r.stderr == b""
    assert not (tmp_path / "d").exists()


def test_session_hook_never_fails_on_a_broken_config_or_input(tmp_path):
    cfg = tmp_path / "c.json"
    cfg.write_text("{ broken", encoding="utf-8")
    r = run_session(cfg, "start", stdin=b"\xff\xfe not json")
    assert r.returncode == 0 and r.stdout == b""


def test_session_start_reports_drift_to_claude_as_context_and_end_runs_the_sync(monkeypatch, capsys, tmp_path):
    from cortex_kg import autosync
    from cortex_kg.config import Config
    cfg = Config(claude_home=tmp_path / "h", projects_root=tmp_path, memory_dir=tmp_path, data_dir=tmp_path / "d", port=1,
                 include_sensitivity=[], log_prompt_snippets=False, repo_root=tmp_path / "r", raw={"auto_sync": True})
    mod = load_session_module()
    import cortex_kg.config as C
    monkeypatch.setattr(C, "load_config", lambda *a, **k: cfg)
    monkeypatch.setattr(autosync, "check_drift", lambda c: "2 files differ")
    monkeypatch.setattr(mod.sys, "argv", ["cortex_session.py", "start"])
    mod.main()
    out = json.loads(capsys.readouterr().out)
    assert out["hookSpecificOutput"] == {"hookEventName": "SessionStart", "additionalContext": "2 files differ"}
    calls = []
    monkeypatch.setattr(autosync, "run_sync", lambda c: calls.append(c))
    monkeypatch.setattr(mod.sys, "argv", ["cortex_session.py", "end"])
    mod.main()
    assert calls == [cfg] and capsys.readouterr().out == ""


def test_the_session_hook_does_nothing_unless_the_configuration_turns_auto_sync_on(tmp_path):
    cfg = tmp_path / "c.json"
    cfg.write_text(json.dumps({"data_dir": str(tmp_path / "d"), "claude_home": str(tmp_path / "h")}), encoding="utf-8")
    r = run_session(cfg, "start")
    assert r.returncode == 0 and r.stdout == b"" and not (tmp_path / "d").exists()


# ---------------------------------------------------------------- the hook command of the compiler

CLI = Path(__file__).resolve().parents[2] / "cortex.py"


def run_cli(data_dir, args, payload=None, raw=None):
    env = {**os.environ, "CORTEX_DATA_DIR": str(data_dir), "CORTEX_CONFIG": str(data_dir / "none.json")}
    env.pop("CORTEX_DEBUG", None)
    stdin = raw if raw is not None else json.dumps(payload).encode()
    return subprocess.run([sys.executable, str(CLI), *args], input=stdin, capture_output=True, env=env, timeout=30)


def test_the_hook_command_writes_the_same_event_as_the_script_and_prints_nothing(tmp_path):
    (tmp_path / "index.json").write_text(json.dumps(INDEX), encoding="utf-8")
    p = {"session_id": "s1", "cwd": str(tmp_path), "hook_event_name": "PreToolUse", "tool_name": "Grep",
         "tool_input": {"pattern": "x"}, "tool_use_id": "toolu_9"}
    r = run_cli(tmp_path, ["hook", "PreToolUse"], p)
    assert r.returncode == 0 and r.stdout == b"" and r.stderr == b""
    ev = lines(tmp_path)
    assert len(ev) == 1 and ev[0]["kind"] == "tool" and ev[0]["key"] == "toolu_9"
    other = tmp_path / "script"
    other.mkdir()
    (other / "index.json").write_text(json.dumps(INDEX), encoding="utf-8")
    assert run(other, p).returncode == 0
    a, b = lines(tmp_path)[0], lines(other)[0]
    assert {k: v for k, v in a.items() if k != "ts"} == {k: v for k, v in b.items() if k != "ts"}


def test_the_event_name_on_the_command_line_fills_a_payload_that_has_none(tmp_path):
    (tmp_path / "index.json").write_text(json.dumps(INDEX), encoding="utf-8")
    r = run_cli(tmp_path, ["hook", "UserPromptSubmit"], {"session_id": "s1", "prompt": "make a deck"})
    assert r.returncode == 0 and "route:decks" in next((tmp_path / "events").glob("*.jsonl")).read_text(encoding="utf-8")


def test_the_hook_command_never_raises_on_bad_input_or_a_missing_index(tmp_path):
    for raw in (b"not json", b"", b"\xff\xfe", b"[1, 2]", b"null"):
        r = run_cli(tmp_path, ["hook", "PreToolUse"], raw=raw)
        assert r.returncode == 0 and r.stdout == b"" and r.stderr == b"", raw
    r = run_cli(tmp_path, ["hook"], {"session_id": "s", "hook_event_name": "SessionStart"})  # no index.json
    assert r.returncode == 0 and r.stdout == b"" and not (tmp_path / "events").exists()


def test_the_append_takes_under_50_ms(tmp_path, monkeypatch):
    import time
    from cortex_kg import hook
    (tmp_path / "index.json").write_text(json.dumps(INDEX), encoding="utf-8")
    monkeypatch.setenv("CORTEX_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("CORTEX_CONFIG", str(tmp_path / "none.json"))
    p = json.dumps({"session_id": "s1", "hook_event_name": "PreToolUse", "tool_name": "Grep", "tool_input": {"pattern": "x"},
                    "tool_use_id": "t"}).encode()
    hook.run(p)  # the first call pays for the file cache
    times = []
    for _ in range(15):
        t = time.perf_counter()
        hook.run(p)
        times.append(time.perf_counter() - t)
    assert sorted(times)[len(times) // 2] < 0.05
