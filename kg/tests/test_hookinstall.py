"""The merging hook installer: install adds only the Cortex entries, uninstall removes only them, both write a backup."""
from __future__ import annotations

import json

import pytest

from cortex_kg import __main__ as cli
from cortex_kg import hookinstall
from cortex_kg.config import Config
from cortex_kg.hook import HOOK_EVENTS


def make_cfg(tmp_path) -> Config:
    home = tmp_path / "home" / ".claude"
    home.mkdir(parents=True, exist_ok=True)
    return Config(claude_home=home, projects_root=tmp_path, memory_dir=tmp_path, data_dir=tmp_path / "data", port=1,
                  include_sensitivity=[], log_prompt_snippets=False, repo_root=tmp_path / "repo",
                  raw={"product": "ranviera"})


# other hooks on the same events as the Cortex ones, other keys, an entry with a matcher and one with 2 commands
OTHER = {
    "model": "sonnet",
    "permissions": {"allow": ["Read", "Bash(git status)"], "deny": []},
    "env": {"A": "1"},
    "hooks": {
        "SessionStart": [{"hooks": [{"type": "command", "command": "python tools/team_health.py --hook", "timeout": 30},
                                    {"type": "command", "command": "python tools/other.py"}]}],
        "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "python tools/guard.py"}]}],
        "Stop": [{"hooks": [{"type": "command", "command": "python tools/stop.py", "async": True}]}],
    },
    "statusLine": {"type": "command", "command": "echo hi"},
}


def write(cfg, data, indent=2) -> bytes:
    raw = (json.dumps(data, indent=indent, ensure_ascii=False) + "\n").encode("utf-8")
    hookinstall.settings_path(cfg).write_bytes(raw)
    return raw


def read(cfg) -> dict:
    return json.loads(hookinstall.settings_path(cfg).read_text(encoding="utf-8"))


def commands(settings, event):
    return [h["command"] for e in settings["hooks"][event] for h in e["hooks"]]


def test_install_adds_one_entry_per_event_keeps_every_other_entry_and_writes_a_backup_first(tmp_path):
    cfg = make_cfg(tmp_path)
    before = write(cfg, OTHER)
    r = hookinstall.install(cfg)
    st = read(cfg)
    assert r["installed"] and r["added"] == len(HOOK_EVENTS)
    assert set(HOOK_EVENTS) <= set(st["hooks"])
    for key in ("model", "permissions", "env", "statusLine"):
        assert st[key] == OTHER[key]
    assert st["hooks"]["Stop"] == OTHER["hooks"]["Stop"]
    assert st["hooks"]["SessionStart"][0] == OTHER["hooks"]["SessionStart"][0]
    assert st["hooks"]["PreToolUse"][0] == OTHER["hooks"]["PreToolUse"][0]
    assert sum("cortex_hook.py" in c for c in commands(st, "PreToolUse")) == 1
    pre = [e for e in st["hooks"]["PreToolUse"] if "cortex_hook.py" in e["hooks"][0]["command"]][0]
    assert pre["matcher"] == "*" and pre["hooks"][0]["async"] is True
    assert open(r["backup"], "rb").read() == before


def test_install_then_uninstall_gives_back_the_original_exactly(tmp_path):
    cfg = make_cfg(tmp_path)
    before = write(cfg, OTHER)
    hookinstall.install(cfg)
    r = hookinstall.uninstall(cfg)
    assert len(r["removed"]) == len(HOOK_EVENTS)
    assert hookinstall.settings_path(cfg).read_bytes() == before
    assert read(cfg) == OTHER
    assert list(read(cfg)["hooks"]) == list(OTHER["hooks"])  # the order of the events is kept


@pytest.mark.parametrize("indent", [2, 4])
def test_the_layout_of_the_file_is_kept(tmp_path, indent):
    cfg = make_cfg(tmp_path)
    before = write(cfg, OTHER, indent=indent)
    hookinstall.install(cfg)
    assert hookinstall.settings_path(cfg).read_text(encoding="utf-8").split("\n")[1].startswith(" " * indent + '"')
    hookinstall.uninstall(cfg)
    assert hookinstall.settings_path(cfg).read_bytes() == before


def test_a_compact_layout_comes_back_byte_for_byte_from_the_backup(tmp_path):
    cfg = make_cfg(tmp_path)
    before = b'{"model": "sonnet", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "a.py"}]}]}}'
    hookinstall.settings_path(cfg).write_bytes(before)
    hookinstall.install(cfg)
    assert hookinstall.settings_path(cfg).read_bytes() != before
    hookinstall.uninstall(cfg)
    assert hookinstall.settings_path(cfg).read_bytes() == before


def test_a_file_with_no_hooks_key_comes_back_without_one(tmp_path):
    cfg = make_cfg(tmp_path)
    before = write(cfg, {"model": "opus"})
    hookinstall.install(cfg)
    assert "hooks" in read(cfg)
    hookinstall.uninstall(cfg)
    assert hookinstall.settings_path(cfg).read_bytes() == before


def test_a_null_hooks_value_is_replaced_by_the_cortex_entries(tmp_path):
    cfg = make_cfg(tmp_path)
    before = write(cfg, {"hooks": None, "a": 1})
    r = hookinstall.install(cfg)
    st = read(cfg)
    assert r["installed"] and r["added"] == len(HOOK_EVENTS)
    assert isinstance(st["hooks"], dict) and set(HOOK_EVENTS) <= set(st["hooks"]) and st["a"] == 1
    assert open(r["backup"], "rb").read() == before


def test_a_second_install_adds_nothing_and_writes_no_backup(tmp_path):
    cfg = make_cfg(tmp_path)
    write(cfg, OTHER)
    hookinstall.install(cfg)
    once = hookinstall.settings_path(cfg).read_bytes()
    r = hookinstall.install(cfg)
    assert r["added"] == 0 and r["backup"] is None and hookinstall.settings_path(cfg).read_bytes() == once
    assert len(list(hookinstall.backup_dir(cfg).glob("settings.*.json"))) == 1


def test_entries_that_already_run_the_cortex_scripts_are_recognised_and_removed_with_the_rest(tmp_path):
    cfg = make_cfg(tmp_path)
    own = json.loads(json.dumps(OTHER))
    own["hooks"]["SessionStart"].append({"hooks": [{"type": "command", "command": 'python "C:/c/hooks/cortex_hook.py"', "async": True}]})
    own["hooks"]["SessionStart"].append({"hooks": [{"type": "command", "command": 'python "C:/c/hooks/cortex_session.py" start'}]})
    write(cfg, own)
    r = hookinstall.install(cfg)
    assert r["added"] == len(HOOK_EVENTS) - 1  # SessionStart already records events
    st = read(cfg)
    assert sum("cortex_hook.py" in c for c in commands(st, "SessionStart")) == 1
    removed = hookinstall.uninstall(cfg)["removed"]
    assert len(removed) == len(HOOK_EVENTS) + 1  # the 7 event entries and the session script
    assert read(cfg) == OTHER


def test_uninstall_keeps_a_command_that_shares_an_entry_with_a_cortex_command(tmp_path):
    cfg = make_cfg(tmp_path)
    own = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "mine.py"},
                                         {"type": "command", "command": "python C:/c/hooks/cortex_hook.py"}]}]}}
    write(cfg, own)
    r = hookinstall.uninstall(cfg)
    assert [x["event"] for x in r["removed"]] == ["Stop"]
    assert read(cfg) == {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "mine.py"}]}]}}
    assert r["backup"] is not None


def test_uninstall_with_nothing_to_remove_writes_nothing(tmp_path):
    cfg = make_cfg(tmp_path)
    before = write(cfg, OTHER)
    r = hookinstall.uninstall(cfg)
    assert r["removed"] == [] and r["backup"] is None and hookinstall.settings_path(cfg).read_bytes() == before


def test_a_file_that_is_not_json_is_left_alone(tmp_path):
    cfg = make_cfg(tmp_path)
    hookinstall.settings_path(cfg).write_text("{ not json", encoding="utf-8")
    for fn in (hookinstall.install, hookinstall.uninstall, hookinstall.preview):
        with pytest.raises(hookinstall.HooksError):
            fn(cfg)
    assert hookinstall.settings_path(cfg).read_text(encoding="utf-8") == "{ not json"


def test_install_creates_the_file_when_there_is_none(tmp_path):
    cfg = make_cfg(tmp_path)
    r = hookinstall.install(cfg)
    assert r["backup"] is None and set(read(cfg)["hooks"]) == set(HOOK_EVENTS)
    hookinstall.uninstall(cfg)
    assert read(cfg) == {}


# ---------------------------------------------------------------- the packaged runner

def test_ensure_bin_copies_once_for_each_version_and_keeps_the_earlier_one(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    src = tmp_path / "dist" / "ranviera-kg"
    (src / "_internal").mkdir(parents=True)
    (src / "ranviera-kg.exe").write_text("exe 1", encoding="utf-8")
    (src / "_internal" / "lib.dll").write_text("lib", encoding="utf-8")
    monkeypatch.setattr(hookinstall, "version", lambda: "1.0.0")
    first = hookinstall.ensure_bin(cfg, source=src, exe="ranviera-kg.exe")
    assert first["copied"] and (cfg.data_dir / "bin" / "1.0.0" / "_internal" / "lib.dll").is_file()
    (src / "ranviera-kg.exe").write_text("exe 1 changed", encoding="utf-8")
    again = hookinstall.ensure_bin(cfg, source=src, exe="ranviera-kg.exe")
    assert not again["copied"]
    assert (cfg.data_dir / "bin" / "1.0.0" / "ranviera-kg.exe").read_text(encoding="utf-8") == "exe 1"
    monkeypatch.setattr(hookinstall, "version", lambda: "1.1.0")
    assert hookinstall.ensure_bin(cfg, source=src, exe="ranviera-kg.exe")["copied"]
    assert (cfg.data_dir / "bin" / "1.0.0" / "ranviera-kg.exe").is_file()  # the previous version stays


def test_outside_the_packaged_app_there_is_nothing_to_copy(tmp_path):
    cfg = make_cfg(tmp_path)
    r = hookinstall.ensure_bin(cfg)
    assert not r["copied"] and not (cfg.data_dir / "bin").exists()


def test_a_packaged_install_points_the_entries_at_the_current_copy_and_uninstall_finds_them(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    src = tmp_path / "dist"
    src.mkdir()
    (src / "ranviera-kg.exe").write_text("exe", encoding="utf-8")
    monkeypatch.setattr(hookinstall, "is_frozen", lambda: True)
    monkeypatch.setattr(hookinstall, "runner_name", lambda: "ranviera-kg.exe")
    monkeypatch.setattr(hookinstall, "version", lambda: "2.0.0")
    monkeypatch.setattr(hookinstall.sys, "executable", str(src / "ranviera-kg.exe"))
    before = write(cfg, OTHER)
    r = hookinstall.install(cfg)
    assert r["added"] == len(HOOK_EVENTS) and (cfg.data_dir / "bin" / "2.0.0" / "ranviera-kg.exe").is_file()
    st = read(cfg)
    runner = [c for c in commands(st, "SessionEnd") if "ranviera-kg" in c][0]
    assert runner == f'"{str(cfg.data_dir).replace(chr(92), "/")}/bin/2.0.0/ranviera-kg.exe" hook SessionEnd'
    assert hookinstall.preview(cfg)["installed"] is True
    hookinstall.uninstall(cfg)
    assert hookinstall.settings_path(cfg).read_bytes() == before


# ---------------------------------------------------------------- the commands

def run_cli(tmp_path, capsys, *argv):
    cfgfile = tmp_path / "c.json"
    cfg = make_cfg(tmp_path)
    cfgfile.write_text(json.dumps({"claude_home": str(cfg.claude_home), "data_dir": str(cfg.data_dir),
                                   "product": "ranviera"}), encoding="utf-8")
    code = cli.main(["--config", str(cfgfile), *argv])
    return code, capsys.readouterr().out


def test_hooks_commands_print_the_states_of_the_contract_as_json(tmp_path, capsys):
    code, out = run_cli(tmp_path, capsys, "hooks", "preview", "--json")
    p = json.loads(out)
    assert code == 0 and set(p) == {"installed", "settings_path", "entries", "backup_dir"} and p["installed"] is False
    assert [e["event"] for e in p["entries"]] == HOOK_EVENTS and all(e["async"] for e in p["entries"])
    assert not hookinstall.settings_path(make_cfg(tmp_path)).exists()
    code, out = run_cli(tmp_path, capsys, "hooks", "install", "--json")
    i = json.loads(out)
    assert code == 0 and i["installed"] is True and i["backup"] is None
    code, out = run_cli(tmp_path, capsys, "hooks", "preview", "--json")
    assert json.loads(out)["installed"] is True
    code, out = run_cli(tmp_path, capsys, "hooks", "uninstall", "--json")
    u = json.loads(out)
    assert code == 0 and u["installed"] is False and len(u["removed"]) == len(HOOK_EVENTS) and u["backup"]


def test_the_hooks_command_reports_a_damaged_file_as_an_error(tmp_path, capsys):
    cfg = make_cfg(tmp_path)
    hookinstall.settings_path(cfg).write_text("[1]", encoding="utf-8")
    code, out = run_cli(tmp_path, capsys, "hooks", "install", "--json")
    assert code == 1 and "not a JSON object" in json.loads(out)["error"]
    assert hookinstall.settings_path(cfg).read_text(encoding="utf-8") == "[1]"


def test_the_bin_command_says_so_outside_the_packaged_app(tmp_path, capsys):
    code, out = run_cli(tmp_path, capsys, "bin", "--json")
    assert code == 0 and json.loads(out)["copied"] is False
