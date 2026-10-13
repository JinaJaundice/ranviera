"""Tests for the model suggester of conflicts (kg/cortex_kg/conflict_suggest.py). No test calls a real model: a fake command
script answers in the shape of the JSON result of Claude Code, and it records what it was given."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cortex_kg import conflict_suggest as cs  # noqa: E402
from cortex_kg import mappings  # noqa: E402
from cortex_kg.__main__ import DELEGATED, main as cli  # noqa: E402

FAKE = '''
import json, os, sys
if "--version" in sys.argv:
    print("9.9.9 (Fake Command)")
    sys.exit(0)
prompt = sys.stdin.read()
with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as f:
    f.write(json.dumps({"argv": sys.argv[1:], "key": "ANTHROPIC_API_KEY" in os.environ, "auth_set": "ANTHROPIC_AUTH_TOKEN" in os.environ,
                        "cwd": os.getcwd(), "prompt": prompt}) + "\\n")
answer = json.load(open(os.environ["FAKE_ANSWER"], encoding="utf-8"))
if answer.get("fail"):
    sys.exit(3)
print(json.dumps({"is_error": False, "result": "", "structured_output": answer,
                  "modelUsage": {"claude-fake-1": {"inputTokens": 1}}}))
'''

GOOD_A = "Pin every package in `environment.yml` to an exact version."
GOOD_B = "Specify minimum versions with `>=` in `environment.yml` and do not pin exact versions."


def setup(tmp_path: Path) -> Path:
    root = tmp_path / "setup"
    (root / ".claude" / "rules").mkdir(parents=True)
    (root / "CLAUDE.md").write_text("# Lab\n\n- " + GOOD_A + "\n- Keep each module small.\n", encoding="utf-8")
    (root / ".claude" / "rules" / "environments.md").write_text("# Environments\n\n- " + GOOD_B + "\n", encoding="utf-8")
    return root


def side(file: str, line: int, quote: str) -> dict:
    return {"file": file, "line": line, "quote": quote}


def good() -> dict:
    return {"a": side("CLAUDE.md", 3, GOOD_A), "b": side(".claude/rules/environments.md", 3, GOOD_B),
            "reason": "One rule pins exact versions and the other forbids it."}


@pytest.fixture
def env(tmp_path, monkeypatch):
    fake = tmp_path / "fake_model.py"
    fake.write_text(FAKE, encoding="utf-8")
    log = tmp_path / "fake.log"
    answer = tmp_path / "answer.json"
    monkeypatch.setenv("FAKE_LOG", str(log))
    monkeypatch.setenv("FAKE_ANSWER", str(answer))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-not-real")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "not-real")
    monkeypatch.delenv(cs.ENV_KEY, raising=False)

    def say(conflicts, **extra):
        answer.write_text(json.dumps({"conflicts": conflicts, **extra}), encoding="utf-8")

    def config(on=True):
        cfg = {"data_dir": str(tmp_path / "data"), "profile_dir": str(tmp_path / "profile"), "memory_dir": str(tmp_path / "mem"),
               "claude_home": str(tmp_path / "home")}
        if on:
            cfg["conflict_suggest_cmd"] = [sys.executable, str(fake)]
        p = tmp_path / ("on.json" if on else "off.json")
        p.write_text(json.dumps(cfg), encoding="utf-8")
        return p

    def calls():
        return [json.loads(x) for x in log.read_text(encoding="utf-8").splitlines()] if log.is_file() else []

    return type("Env", (), {"say": staticmethod(say), "config": staticmethod(config), "calls": staticmethod(calls),
                            "cmd": [sys.executable, str(fake)], "profile": tmp_path / "profile"})


# ---------------------------------------------------------------- parsing and verification

def test_the_answer_is_read_from_the_structured_output_or_the_result_text():
    items, model = cs.parse_envelope({"structured_output": {"conflicts": [good()]}, "modelUsage": {"claude-x-1": {}}}, "sonnet")
    assert len(items) == 1 and model == "claude-x-1"
    fenced = "```json\n" + json.dumps({"conflicts": [good()]}) + "\n```"
    items, model = cs.parse_envelope({"result": fenced}, "sonnet")
    assert len(items) == 1 and model == "sonnet"
    with pytest.raises(cs.SuggestError):
        cs.parse_envelope({"result": "no json here"}, "sonnet")


def test_a_quote_is_kept_only_when_it_is_found_word_for_word(tmp_path):
    files = cs.read_files(setup(tmp_path))
    kept, dropped = cs.verify([good()], files)
    assert dropped == 0 and kept[0]["b"] == side("CLAUDE.md", 3, GOOD_A)
    # white space differs and the stated line is wrong, and the recorded line is the line that holds the quote
    spaced = good()
    spaced["a"] = side("CLAUDE.md", 1, "Pin   every package in `environment.yml`\nto an exact version.")
    kept, dropped = cs.verify([spaced], files)
    assert dropped == 0 and kept[0]["b"]["line"] == 3
    invented = good()
    invented["b"] = side(".claude/rules/environments.md", 3, "Always pin every package to a hash.")
    wrong_file = good()
    wrong_file["a"] = side("missing.md", 3, GOOD_A)
    same_line = {"a": side("CLAUDE.md", 3, GOOD_A), "b": side("CLAUDE.md", 3, "Pin every package in `environment.yml`"),
                 "reason": "x"}
    no_reason = {**good(), "reason": ""}
    short = {**good(), "a": side("CLAUDE.md", 3, "Pin")}
    kept, dropped = cs.verify([invented, wrong_file, same_line, no_reason, short], files)
    assert kept == [] and dropped == 5


def test_the_same_pair_of_lines_is_one_suggestion_whatever_the_order(tmp_path):
    files = cs.read_files(setup(tmp_path))
    swapped = {"a": good()["b"], "b": good()["a"], "reason": "Same pair, other order."}
    kept, dropped = cs.verify([good(), swapped], files)
    assert dropped == 0 and len(kept) == 2
    assert len(cs.dedupe(kept)) == 1


def test_a_large_set_up_is_cut_at_file_boundaries_and_the_chunks_are_paired(tmp_path):
    files = cs.read_files(setup(tmp_path))
    assert len(cs.chunk_files(files, 100000)) == 1
    chunks = cs.chunk_files(files, 50)
    assert [len(c) for c in chunks] == [1, 1]
    assert [len(j) for j in cs.jobs(chunks)] == [1, 1, 2]


# ---------------------------------------------------------------- the run

def test_the_run_sends_the_numbered_files_without_the_api_key_and_with_the_flags_of_the_contract(tmp_path, env):
    root = setup(tmp_path)
    env.say([good()])
    res = cs.suggest(root, env.cmd, timeout=60)
    (call,) = env.calls()
    assert call["key"] is False and call["auth_set"] is False
    assert Path(call["cwd"]) != root and not Path(call["cwd"]).exists()
    argv = call["argv"]
    assert argv[argv.index("--model") + 1] == "sonnet" and argv[argv.index("--tools") + 1] == ""
    assert argv[argv.index("--setting-sources") + 1] == "project,local" and "--no-session-persistence" in argv
    assert "L3: - " + GOOD_A in call["prompt"] and "=== .claude/rules/environments.md ===" in call["prompt"]
    (s,) = res["suggestions"]
    assert s["model"] == "claude-fake-1" and s["version"] == "9.9.9 (Fake Command)" and s["time"].endswith("Z")
    assert res["dropped"] == 0 and res["failed"] == 0 and res["calls"] == 1


def test_a_failed_call_is_counted_and_a_hallucinated_quote_is_dropped(tmp_path, env):
    root = setup(tmp_path)
    env.say([], fail=True)
    res = cs.suggest(root, env.cmd, timeout=60)
    assert res["failed"] == 1 and res["suggestions"] == [] and "exited 3" in res["errors"][0]
    bad = good()
    bad["a"]["quote"] = "Every package is pinned by hash in the lock file."
    env.say([bad, good()])
    res = cs.suggest(root, env.cmd, timeout=60, raw_dir=tmp_path / "raw")
    assert len(res["suggestions"]) == 1 and res["dropped"] == 1
    assert json.loads((tmp_path / "raw" / "call-1.json").read_text(encoding="utf-8"))["modelUsage"]


# ---------------------------------------------------------------- the switch and the command

def test_model_calls_are_off_by_default(tmp_path, env, capsys):
    root = setup(tmp_path)
    env.say([good()])
    code = cli(["--config", str(env.config(on=False)), "suggest-conflicts", str(root), "--write", "--owner", "person:ana"])
    assert code == 2 and "Model calls are off" in capsys.readouterr().out
    assert env.calls() == [] and not (env.profile / "mappings").exists()


def test_the_environment_variable_switches_the_calls_on(tmp_path, env, monkeypatch, capsys):
    root = setup(tmp_path)
    env.say([good()])
    monkeypatch.setenv(cs.ENV_KEY, json.dumps(env.cmd))
    assert cli(["--config", str(env.config(on=False)), "suggest-conflicts", str(root)]) == 0
    assert len(env.calls()) == 1 and "1 suggested conflict " in capsys.readouterr().out


def test_nothing_is_written_without_write(tmp_path, env, capsys):
    root = setup(tmp_path)
    env.say([good()])
    assert cli(["--config", str(env.config()), "suggest-conflicts", str(root)]) == 0
    assert "suggested: .claude/rules/environments.md:3 and CLAUDE.md:3" in capsys.readouterr().out
    assert not (env.profile / "mappings").exists()


def test_write_needs_an_owner(tmp_path, env, capsys):
    env.say([good()])
    code = cli(["--config", str(env.config()), "suggest-conflicts", str(setup(tmp_path)), "--write"])
    assert code == 2 and "--owner" in capsys.readouterr().out and env.calls() == []


def test_write_records_proposed_mappings_of_origin_suggested_once(tmp_path, env, capsys):
    root = setup(tmp_path)
    env.say([good()])
    args = ["--config", str(env.config()), "suggest-conflicts", str(root), "--write", "--owner", "person:ana"]
    assert cli(args) == 0
    (m,) = mappings.list_mappings(env.profile)
    assert (m["relation"], m["origin"], m["status"], m["maker"], m["owner"]) == ("conflictsWith", "suggested", "proposed",
                                                                                 "conflict-suggester", "person:ana")
    assert (m["s"], m["t"]) == (".claude/rules/environments.md:3", "CLAUDE.md:3")
    assert GOOD_A in m["basis"] and GOOD_B in m["basis"] and "forbids" in m["basis"]
    sug = m["suggestion"]
    assert sug["v"] == 1 and sug["b"]["quote"] == GOOD_A and sug["a"]["line"] == 3 and sug["model"] == "claude-fake-1"
    assert sug["version"] == "9.9.9 (Fake Command)"
    # a second run adds nothing, whichever order the model names the two sides
    env.say([{"a": good()["b"], "b": good()["a"], "reason": "Again."}])
    capsys.readouterr()
    assert cli(args) == 0
    assert len(mappings.list_mappings(env.profile)) == 1
    assert "0 proposed mappings written, 1 already known" in capsys.readouterr().out
    # it appears in the graph as a proposed edge of half weight only when both ends are nodes, and as a Mapping node always
    nodes, _edges = mappings.graph_parts(env.profile)
    assert nodes[0]["props"]["origin"] == "suggested" and nodes[0]["status"] == "proposed"


def test_the_ends_are_rule_nodes_where_the_graph_holds_them(tmp_path, env):
    data = tmp_path / "data"
    data.mkdir()
    (data / "graph.json").write_text(json.dumps({"nodes": [
        {"id": "rule:lab-001", "props": {"evidence": "claude/setup/CLAUDE.md:3"}},
        {"id": "rule:env-001", "props": {"evidence": "setup/.claude/rules/environments.md:3"}}]}), encoding="utf-8")
    root = setup(tmp_path)
    env.say([good()])
    assert cli(["--config", str(env.config()), "suggest-conflicts", str(root), "--write", "--owner", "person:ana"]) == 0
    (m,) = mappings.list_mappings(env.profile)
    assert (m["s"], m["t"]) == ("rule:env-001", "rule:lab-001")


def test_the_command_is_listed():
    assert DELEGATED["suggest-conflicts"] == "conflict_suggest"
    from cortex_kg.__main__ import make_parser
    assert "suggest-conflicts" in make_parser().format_help()
