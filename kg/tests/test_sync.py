"""Tests for the synchronisation of the set-up between machines.

public-check: synthetic-secrets (the secret scan is tested with fake keys)
"""
from __future__ import annotations

import json
import platform
import time
from datetime import datetime
from pathlib import Path

import pytest

from cortex_kg import privacy, sync
from cortex_kg.config import Config


def make_cfg(root: Path, projects: Path) -> Config:
    home = root / "u1" / ".claude"
    home.mkdir(parents=True, exist_ok=True)
    repo = root / "repo"
    repo.mkdir(exist_ok=True)
    return Config(claude_home=home, projects_root=projects, memory_dir=home / "m", data_dir=home / "cortex",
                  port=5182, include_sensitivity=["public"], log_prompt_snippets=False, repo_root=repo)


def fill(cfg: Config) -> None:
    h = cfg.claude_home
    key = sync.memory_key(cfg.projects_root)
    fwd = str(h).replace("\\", "/")
    bs = fwd.replace("/", "\\")
    pr = str(cfg.projects_root).replace("\\", "/")
    (h / "rules").mkdir(exist_ok=True)
    (h / "agents").mkdir(exist_ok=True)
    (h / "tools" / "register").mkdir(parents=True, exist_ok=True)
    (h / "tools" / "__pycache__").mkdir(exist_ok=True)
    (h / "tools" / "__pycache__" / "x.pyc").write_bytes(b"\0")
    (h / "skills" / "jordan-cv").mkdir(parents=True, exist_ok=True)
    (h / "skills" / "other").mkdir(parents=True, exist_ok=True)
    (h / "skills" / "other" / "x.md").write_text("unmanaged", encoding="utf-8")
    (h / "CLAUDE.md").write_text(f"Map at {fwd}/rules and {pr}/BACKLOG.md and key {key}\n", encoding="utf-8")
    (h / "rules" / "apps.md").write_text("No machine values here.\n", encoding="utf-8")
    (h / "agents" / "builder.md").write_text("model: sonnet\n", encoding="utf-8")
    (h / "tools" / "register" / "hook.py").write_text(f'P = r"{bs}\\tools"\n', encoding="utf-8")
    (h / "skills" / "jordan-cv" / "SKILL.md").write_text(f"see {fwd}/x\n", encoding="utf-8")
    settings = {
        "outputStyle": "plain-english", "autoUpdatesChannel": "stable",
        "hooks": {"Stop": [{"hooks": [{"type": "command", "command": f'python "{bs}\\tools\\register\\hook.py"'}]}]},
        "autoMemoryDirectory": f"{fwd}/projects/{key}/memory",
    }
    (h / "settings.json").write_text(json.dumps(settings, indent=2), encoding="utf-8")


@pytest.fixture()
def cfg(tmp_path):
    c = make_cfg(tmp_path, tmp_path / "work" / "Projects")
    c.projects_root.mkdir(parents=True)
    fill(c)
    c.overlay_dir.mkdir(parents=True, exist_ok=True)
    (c.overlay_dir / "private_terms.json").write_text(
        json.dumps({"clients": ["Acme Bank", "Northwind Capital"], "projects": [], "people": []}), encoding="utf-8")
    return c


def test_export_templates_and_manifest(cfg):
    res = sync.export(cfg)
    m = cfg.harness_dir
    assert res["files"] == 7
    claude = (m / "CLAUDE.md").read_text(encoding="utf-8")
    assert "{{CLAUDE_HOME}}/rules" in claude and "{{PROJECTS_ROOT}}/BACKLOG.md" in claude and "{{MEMORY_KEY}}" in claude
    assert "{{CLAUDE_HOME:bs}}" in (m / "tools" / "register" / "hook.py").read_text(encoding="utf-8")
    tpl = json.loads((m / "settings.template.json").read_text(encoding="utf-8"))
    assert "autoUpdatesChannel" not in tpl and tpl["outputStyle"] == "plain-english"
    assert "{{CLAUDE_HOME:jbs}}" in (m / "settings.template.json").read_text(encoding="utf-8")
    assert not (m / "tools" / "__pycache__").exists() and (m / "skills" / "other").exists()
    man = json.loads((m / "MANIFEST.json").read_text(encoding="utf-8"))
    assert set(man["tokens"]) == {"CLAUDE_HOME", "PROJECTS_ROOT", "CORTEX_ROOT", "HOME", "MEMORY_KEY"}
    assert len(man["files"]["CLAUDE.md"]) == 64
    assert "host" not in man and "exported" not in man  # nothing in the manifest changes between runs


def test_doctor_no_drift_then_changed(cfg):
    sync.export(cfg)
    d = sync.doctor(cfg)
    assert d["changed"] == [] and d["missing_in_mirror"] == [] and d["missing_in_home"] == []
    assert "settings.json" in d["checked"]
    (cfg.claude_home / "rules" / "apps.md").write_text("Edited.\n", encoding="utf-8")
    (cfg.claude_home / "rules" / "new.md").write_text("New.\n", encoding="utf-8")
    d = sync.doctor(cfg)
    assert d["changed"] == ["rules/apps.md"]
    assert d["missing_in_mirror"] == ["rules/new.md"]
    (cfg.claude_home / "agents" / "builder.md").unlink()
    assert sync.doctor(cfg)["missing_in_home"] == ["agents/builder.md"]


def test_secret_scan_refuses(cfg):
    (cfg.claude_home / "rules" / "apps.md").write_text("ok\nkey = ghp_" + "a" * 30 + "\n", encoding="utf-8")
    with pytest.raises(sync.SecretFound) as e:
        sync.export(cfg)
    assert e.value.findings[0][:2] == ("rules/apps.md", 2)
    assert not cfg.harness_dir.exists()


@pytest.mark.parametrize("bad", ["AKIA" + "A" * 16, "sk-ant-" + "b" * 20, "password: hunter2x",
                                 "-----BEGIN RSA PRIVATE KEY-----", "github_pat_" + "c" * 25])
def test_secret_patterns(cfg, bad):
    (cfg.claude_home / "CLAUDE.md").write_text(bad + "\n", encoding="utf-8")
    with pytest.raises(sync.SecretFound):
        sync.export(cfg)


def test_templating_round_trips_three_forms():
    vals = sync.values(Path("C:/Users/a/.claude"), Path("C:/Users/a/Projects"), Path("C:/Users/a/Projects/apps/cortex"))
    text = ("C:/Users/a/.claude/x C:\\Users\\a\\.claude\\x C:\\\\Users\\\\a\\\\.claude\\\\x "
            "C:/Users/a/Projects/y C:\\\\Users\\\\a\\\\Projects\\\\y C:/Users/a/Projects/apps/cortex/z "
            "C:/Users/a/other")
    t = sync.tokenise(text, vals)
    assert "{{CLAUDE_HOME}}/x" in t and "{{CLAUDE_HOME:bs}}" in t and "{{CLAUDE_HOME:jbs}}" in t
    assert "{{PROJECTS_ROOT:jbs}}" in t and "{{CORTEX_ROOT}}/z" in t and "{{HOME}}/other" in t
    assert sync.render(t, vals) == text


def test_install_copy_into_second_home(cfg, tmp_path, capsys):
    sync.export(cfg)
    home2 = tmp_path / "u2" / ".claude"
    home2.mkdir(parents=True)
    (home2 / "CLAUDE.md").write_text("old\n", encoding="utf-8")
    (home2 / "settings.json").write_text(json.dumps({"autoUpdatesChannel": "latest", "outputStyle": "x"}),
                                         encoding="utf-8")
    proj2 = tmp_path / "other" / "Work"
    proj2.mkdir(parents=True)
    res = sync.install(cfg, target_home=home2, projects_root=proj2)
    out = (home2 / "CLAUDE.md").read_text(encoding="utf-8")
    assert str(home2).replace("\\", "/") + "/rules" in out and str(proj2).replace("\\", "/") + "/BACKLOG.md" in out
    assert sync.memory_key(proj2) in out and "{{" not in out
    st = json.loads((home2 / "settings.json").read_text(encoding="utf-8"))
    # an existing settings.json is merged, not replaced: only Cortex hook entries are ever added to it
    assert st == {"autoUpdatesChannel": "latest", "outputStyle": "x"}
    bak = list((home2 / "backups").glob("*-cortex-install"))
    assert len(bak) == 1 and (bak[0] / "CLAUDE.md").read_text(encoding="utf-8") == "old\n"
    assert res["backed_up"] == 2 and "pip install -r requirements.txt" in capsys.readouterr().out
    assert (cfg.claude_home / "CLAUDE.md").exists()


def test_install_dry_run_writes_nothing(cfg, tmp_path):
    sync.export(cfg)
    home2 = tmp_path / "u3" / ".claude"
    res = sync.install(cfg, target_home=home2, dry_run=True)
    assert not home2.exists() and "copy CLAUDE.md" in res["plan"]


def test_install_link_mode(cfg, tmp_path):
    sync.export(cfg)
    home2 = tmp_path / "u4" / ".claude"
    home2.mkdir(parents=True)
    res = sync.install(cfg, target_home=home2, mode="link")
    assert "rules" in res["linked"] and "agents" in res["linked"]
    assert (home2 / "rules" / "apps.md").read_text(encoding="utf-8") == "No machine values here.\n"
    assert "skills/jordan-cv" not in res["linked"]
    assert (home2 / "skills" / "jordan-cv" / "SKILL.md").is_file()


def test_personal_contact_details_and_client_figures_become_placeholders(cfg, tmp_path):
    (cfg.claude_home / "rules" / "contact.md").write_text(
        "Write to a.person@mail.test or +44 7700 900123.\n"
        "The Acme Bank bundle at £123k runs at 17% margin.\n"
        "Write money as £94k.\n", encoding="utf-8")
    (cfg.claude_home / "rules" / "bot.md").write_text("Author 1+x@users.noreply.github.com\n", encoding="utf-8")
    res = sync.export(cfg)
    assert res["withheld"] == []
    mirrored = (cfg.harness_dir / "rules" / "contact.md").read_text(encoding="utf-8")
    for secret in ("a.person@mail.test", "+44 7700 900123", "£123k", "17%"):
        assert secret not in mirrored
    assert "{{PRIVATE:" in mirrored and "Write money as £94k." in mirrored  # a house-style example is kept
    assert "1+x@users.noreply.github.com" in (cfg.harness_dir / "rules" / "bot.md").read_text(encoding="utf-8")
    assert sync.doctor(cfg)["changed"] == []  # the overlay restores the values on this machine
    # a machine without the overlay values shows [withheld]
    (cfg.overlay_dir / "private_values.json").unlink()
    home2 = tmp_path / "u5" / ".claude"
    home2.mkdir(parents=True)
    sync.install(cfg, target_home=home2)
    installed = (home2 / "rules" / "contact.md").read_text(encoding="utf-8")
    assert "[withheld]" in installed and "protonmail" not in installed


def test_link_failure_falls_back_to_copy(cfg, tmp_path, monkeypatch):
    sync.export(cfg)
    home2 = tmp_path / "u5" / ".claude"
    home2.mkdir(parents=True)

    def boom(src, dst):
        raise OSError("no privilege")
    monkeypatch.setattr(sync, "_link", boom)
    res = sync.install(cfg, target_home=home2, mode="link")
    assert res["linked"] == [] and any("link failed" in p for p in res["plan"])
    assert (home2 / "rules" / "apps.md").is_file()


# ---------------------------------------------------------------- an export with no change changes nothing

def test_a_second_export_writes_no_file_and_the_manifest_has_no_time(cfg):
    sync.export(cfg)
    before = {f: f.stat().st_mtime_ns for f in cfg.harness_dir.rglob("*") if f.is_file()}
    assert before
    time.sleep(0.05)
    res = sync.export(cfg)
    after = {f: f.stat().st_mtime_ns for f in cfg.harness_dir.rglob("*") if f.is_file()}
    assert after == before and res["changed"] == 0 and res["retired"] == []


def test_the_manifest_does_not_depend_on_the_clock_or_the_host(cfg, monkeypatch):
    sync.export(cfg)
    first = (cfg.harness_dir / "MANIFEST.json").read_bytes()
    monkeypatch.setattr(platform, "node", lambda: "other-host")

    class Later(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2031, 1, 1, 12, 0, 1, tzinfo=tz)
    monkeypatch.setattr(sync, "datetime", Later)
    sync.export(cfg)
    assert (cfg.harness_dir / "MANIFEST.json").read_bytes() == first


# ---------------------------------------------------------------- files removed from the home are retired

def test_a_file_removed_from_the_home_is_moved_to_retired_and_drift_clears(cfg):
    (cfg.claude_home / "rules" / "old.md").write_text("Old rule.\n", encoding="utf-8")
    sync.export(cfg)
    assert (cfg.harness_dir / "rules" / "old.md").is_file()
    (cfg.claude_home / "rules" / "old.md").unlink()
    assert sync.doctor(cfg)["missing_in_home"] == ["rules/old.md"]
    res = sync.export(cfg)
    assert res["retired"] == ["rules/old.md"]
    assert not (cfg.harness_dir / "rules" / "old.md").exists()
    moved = list((cfg.harness_dir / sync.RETIRED).glob("*/rules/old.md"))
    assert len(moved) == 1 and moved[0].read_text(encoding="utf-8") == "Old rule.\n"  # nothing is deleted
    d = sync.doctor(cfg)
    assert d["missing_in_home"] == [] and d["changed"] == [] and d["missing_in_mirror"] == []
    assert sync.export(cfg)["retired"] == []  # idempotent
    # install ignores the retired folder
    assert not any(sync.RETIRED in m for m in sync._mirror_files(cfg.harness_dir))


# ---------------------------------------------------------------- the secret scan

@pytest.mark.parametrize("bad", [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
    "API_KEY=abcd1234efgh5678ijkl",
    "xoxb-123456789012-abcdefghijkl",
    "sk-proj-abcdefghijklmnopqrstuvwxyz",
    "vercel token: abcdefghijklmnopqrstuvwx",
    "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    'client_secret: "abcdefghijklmnop1234"',
    "export STRIPE_SECRET_KEY=abcdef1234567890",
    "git clone https://user:hunter2pass@example.com/a/b.git",
    "blob " + "Qx7Rt2Lm9Vb4Nc8Zk3Wd6Hf1Jg5Ys0Pa" + "Xe9Uo2Ti4Rb7",
])
def test_the_wider_secret_scan_refuses(cfg, bad):
    (cfg.claude_home / "CLAUDE.md").write_text("Notes\n" + bad + "\n", encoding="utf-8")
    with pytest.raises(sync.SecretFound) as e:
        sync.export(cfg)
    assert e.value.findings[0][1] == 2


@pytest.mark.parametrize("fine", [
    "Use a bearer token in the header.",
    "token: {{CLAUDE_HOME}}/secrets",
    "The password policy is set elsewhere.",
    "api_key = os.environ[\"X\"]",
    "secret = $SECRET_FROM_THE_ENVIRONMENT_VARIABLE",
    "See https://example.org/docs/page for the guide",
    "sha 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "path C:/Users/jdoe/Downloads/Projects/apps/cortex/kg/cortex_kg/privacy_module_name.py",
])
def test_the_wider_secret_scan_leaves_ordinary_text(cfg, fine):
    (cfg.claude_home / "CLAUDE.md").write_text(fine + "\n", encoding="utf-8")
    sync.export(cfg)


def test_numbers_beside_a_client_rebate_are_replaced_and_a_missed_one_refuses_the_export(cfg, monkeypatch):
    (cfg.claude_home / "rules" / "terms.md").write_text("Acme Bank carries a rebate of 3 points on 120 FTE.\n", encoding="utf-8")
    sync.export(cfg)
    mirrored = (cfg.harness_dir / "rules" / "terms.md").read_text(encoding="utf-8")
    assert "3 points" not in mirrored and "120" not in mirrored and "Acme Bank carries a rebate of" in mirrored
    assert sync.doctor(cfg)["changed"] == []
    # if the redaction were to miss a number, the export would refuse instead of writing it
    monkeypatch.setattr(privacy, "_redact_numbers_near_terms", lambda line, sub, terms: line)
    with pytest.raises(sync.SecretFound) as e:
        sync.export(cfg)
    assert "commercial terms" in str(e.value)


# ---------------------------------------------------------------- the privacy key, in the export

def test_export_makes_the_key_once_and_a_migration_rekeys_legacy_placeholders(cfg):
    legacy = privacy._legacy_token("£123k")
    cfg.overlay_dir.mkdir(parents=True, exist_ok=True)
    (cfg.overlay_dir / "private_values.json").write_text(json.dumps({legacy: "£123k"}), encoding="utf-8")
    cfg.harness_dir.mkdir(parents=True)
    (cfg.harness_dir / "old.md").write_text("The bundle at " + legacy + " here.\n", encoding="utf-8")
    (cfg.claude_home / "rules" / "contact.md").write_text("The Acme Bank bundle at £123k.\n", encoding="utf-8")
    sync.export(cfg)
    key1 = (cfg.overlay_dir / "privacy_key").read_bytes()
    assert len(bytes.fromhex(key1.decode().strip())) == 32
    vals = privacy.load_values(cfg.overlay_dir)
    assert legacy not in vals and "£123k" in vals.values()
    assert legacy not in (cfg.harness_dir / "rules" / "contact.md").read_text(encoding="utf-8")
    assert sync.doctor(cfg)["changed"] == []
    sync.export(cfg)
    assert (cfg.overlay_dir / "privacy_key").read_bytes() == key1


# ---------------------------------------------------------------- install merges settings.json

CORTEX_HOOKS = {"SessionStart": [{"hooks": [{"type": "command", "command": 'python "C:/c/hooks/cortex_hook.py"', "async": True}]},
                                 {"hooks": [{"type": "command", "command": 'python "C:/c/hooks/cortex_session.py" start'}]}],
                "SessionEnd": [{"hooks": [{"type": "command", "command": 'python "C:/c/hooks/cortex_session.py" end'}]}]}


def mirror_with_cortex_hooks(cfg):
    st = json.loads((cfg.claude_home / "settings.json").read_text(encoding="utf-8"))
    st["hooks"].update(json.loads(json.dumps(CORTEX_HOOKS)))
    (cfg.claude_home / "settings.json").write_text(json.dumps(st, indent=2), encoding="utf-8")
    sync.export(cfg)


def test_install_adds_only_cortex_hook_entries_keeps_everything_else_and_never_duplicates(cfg, tmp_path):
    mirror_with_cortex_hooks(cfg)
    home2 = tmp_path / "u6" / ".claude"
    home2.mkdir(parents=True)
    own = {"env": {"A": "1"}, "permissions": {"allow": ["Read"]},
           "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "mine.py"}]}],
                     "SessionStart": [{"matcher": "x", "hooks": [{"type": "command", "command": "keep.py"}]}]}}
    (home2 / "settings.json").write_text(json.dumps(own, indent=2), encoding="utf-8")
    res = sync.install(cfg, target_home=home2)
    st = json.loads((home2 / "settings.json").read_text(encoding="utf-8"))
    assert st["env"] == {"A": "1"} and st["permissions"] == {"allow": ["Read"]} and "outputStyle" not in st
    assert st["hooks"]["Stop"] == own["hooks"]["Stop"]  # the template's own Stop entry is not added
    cmds = [h["command"] for e in st["hooks"]["SessionStart"] for h in e["hooks"]]
    assert cmds[0] == "keep.py" and sum("cortex_hook.py" in c for c in cmds) == 1 and sum(c.endswith("cortex_session.py\" start") for c in cmds) == 1
    assert [h["command"] for e in st["hooks"]["SessionEnd"] for h in e["hooks"]][0].endswith("cortex_session.py\" end")
    assert any("added 3 Cortex hook entries" in line for line in res["plan"])
    # the earlier file was backed up first
    assert json.loads(next((home2 / "backups").glob("*/settings.json")).read_text(encoding="utf-8")) == own
    # a second install adds nothing and writes nothing
    before = (home2 / "settings.json").read_bytes()
    sync.install(cfg, target_home=home2)
    assert (home2 / "settings.json").read_bytes() == before
    assert len(list((home2 / "backups").glob("*/settings*.json"))) == 2  # the second install backed up again


def test_install_leaves_a_settings_file_that_is_not_json_alone(cfg, tmp_path):
    mirror_with_cortex_hooks(cfg)
    home2 = tmp_path / "u7" / ".claude"
    home2.mkdir(parents=True)
    (home2 / "settings.json").write_text("{ not json", encoding="utf-8")
    res = sync.install(cfg, target_home=home2)
    assert (home2 / "settings.json").read_text(encoding="utf-8") == "{ not json"
    assert any("not valid JSON" in line for line in res["plan"])


def test_install_writes_the_whole_template_on_a_machine_with_no_settings(cfg, tmp_path):
    mirror_with_cortex_hooks(cfg)
    home2 = tmp_path / "u8" / ".claude"
    home2.mkdir(parents=True)
    sync.install(cfg, target_home=home2)
    st = json.loads((home2 / "settings.json").read_text(encoding="utf-8"))
    assert st["outputStyle"] == "plain-english" and "SessionEnd" in st["hooks"]


# ---------------------------------------------------------------- the profile folder

def test_a_legacy_placeholder_in_the_profile_ledger_is_rekeyed_by_an_export(cfg):
    import hashlib
    cfg.profile_path = cfg.repo_root / "profile"
    assert sync.profile_dir(cfg) == cfg.repo_root / "profile"
    assert sync.ledger_roots(cfg)[0] == cfg.repo_root / "profile" / "ledger"
    legacy = "{{PRIVATE:%s}}" % hashlib.sha1(b"41%").hexdigest()[:8]
    (cfg.overlay_dir).mkdir(parents=True, exist_ok=True)
    privacy.store_path(cfg.overlay_dir).write_text(json.dumps({legacy: "41%"}), encoding="utf-8")
    led = cfg.repo_root / "profile" / "ledger"
    led.mkdir(parents=True)
    (led / "rules.json").write_text(json.dumps({"text": f"margin {legacy}"}), encoding="utf-8")
    sync.export(cfg)
    assert legacy not in (led / "rules.json").read_text(encoding="utf-8")
