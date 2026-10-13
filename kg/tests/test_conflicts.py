"""Tests for the candidate conflict scan (kg/cortex_kg/conflicts.py) on an invented set-up."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cortex_kg import conflicts  # noqa: E402


def setup(tmp_path: Path) -> Path:
    (tmp_path / ".claude" / "rules").mkdir(parents=True)
    (tmp_path / ".claude" / "agents").mkdir(parents=True)
    (tmp_path / "CLAUDE.md").write_text(
        "# Widget service\n\n"
        "- Set `timeout=30` on every outbound call so that a slow partner does not hold a worker.\n"
        "- Write every report in British spelling for the client team.\n"
        "- Never call `print` in code under `src/`.\n"
        "- Keep each module small and focused on one job.\n", encoding="utf-8")
    (tmp_path / ".claude" / "rules" / "style.md").write_text(
        "# Style\n\n"
        "- Every outbound call sets `timeout=10`, because the gateway closes idle sockets after 15 seconds.\n"
        "- Use American spelling in every report and email.\n"
        "- Scripts under `scripts/` report progress with `print` so that an operator sees output.\n", encoding="utf-8")
    (tmp_path / ".claude" / "agents" / "tester.md").write_text(
        "---\nname: tester\ndescription: Writes tests.\ntools: Read, Write\nmodel: sonnet\n---\n\n"
        "Write each test as a method on a `unittest.TestCase` subclass.\n", encoding="utf-8")
    (tmp_path / ".claude" / "rules" / "tests.md").write_text(
        "# Tests\n\n- Write tests as plain functions. Do not use `unittest.TestCase` classes.\n", encoding="utf-8")
    return tmp_path


def test_the_scan_finds_the_numeric_exclusive_and_polarity_clashes(tmp_path):
    found = conflicts.scan(setup(tmp_path))
    pairs = {(c.signal, c.a["file"], c.b["file"]) for c in found}
    assert ("numeric", "CLAUDE.md", ".claude/rules/style.md") in pairs or ("numeric", ".claude/rules/style.md", "CLAUDE.md") in pairs
    assert any(c.signal == "exclusive" and "british" in c.basis for c in found)
    assert any(c.signal == "polarity" and "unittest.testcase" in c.basis for c in found)


def test_rules_that_name_different_folders_are_not_a_conflict(tmp_path):
    found = conflicts.scan(setup(tmp_path))
    assert not any("print" in c.basis for c in found)


def test_the_scan_gives_the_same_list_on_every_run(tmp_path):
    root = setup(tmp_path)
    first = [(c.signal, c.a["line"], c.b["line"]) for c in conflicts.scan(root)]
    assert all([(c.signal, c.a["line"], c.b["line"]) for c in conflicts.scan(root)] == first for _ in range(3))


def test_a_stated_exception_suppresses_the_candidate(tmp_path):
    root = setup(tmp_path)
    (root / ".claude" / "rules" / "style.md").write_text(
        "# Style\n\n- Use American spelling in every report, except reports for the client team.\n", encoding="utf-8")
    assert not any(c.signal == "exclusive" for c in conflicts.scan(root))



def test_a_leading_config_option_reaches_a_delegated_command(tmp_path, capsys):
    import json
    from cortex_kg.__main__ import main
    cfg = tmp_path / "ranviera.config.json"
    cfg.write_text(json.dumps({"data_dir": str(tmp_path / "data"), "profile_dir": str(tmp_path / "profile"),
                               "claude_home": str(tmp_path / "claude")}), encoding="utf-8")
    assert main(["--config", str(cfg), "instructions", "list", "--json"]) == 0
    assert json.loads(capsys.readouterr().out) == []
