"""The automatic export check and the encrypted store."""
import json
import os
import platform
import subprocess
import time

import pytest

from cortex_kg import autosync, vault
from cortex_kg.config import Config


def make_cfg(tmp_path, vault_on=False):
    home = tmp_path / "home" / ".claude"
    (home / "rules").mkdir(parents=True)
    (home / "rules" / "writing.md").write_text("Write in the FCA register.\n", encoding="utf-8")
    mem = tmp_path / "memory"
    mem.mkdir()
    (mem / "project_x.md").write_text("Price at £123k.\n", encoding="utf-8")
    repo = tmp_path / "repo"
    repo.mkdir()
    data = tmp_path / "data"
    (data / "overlay").mkdir(parents=True)
    (data / "overlay" / "private_values.json").write_text('{"{{PRIVATE:aaaaaaaa}}": "x"}\n', encoding="utf-8")
    cfg = Config(claude_home=home, projects_root=tmp_path / "projects", memory_dir=mem, data_dir=data, port=5182,
                 include_sensitivity=["public", "internal"], log_prompt_snippets=False, repo_root=repo,
                 raw={"vault": {"enabled": vault_on}, "auto_push": False})
    return cfg


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)


def test_the_vault_round_trips_and_does_not_reseal_unchanged_content(tmp_path):
    pytest.importorskip("pyrage")
    cfg = make_cfg(tmp_path, vault_on=True)
    r = vault.init(cfg)
    assert r["created"] and r["public_key"].startswith("age1") and vault.recipients(cfg) == [r["public_key"]]
    first = vault.seal(cfg)
    assert first["sealed"] and first["files"] == 2
    assert not vault.seal(cfg)["sealed"]  # nothing changed
    assert vault.status(cfg)["in_step"]
    store = (cfg.repo_root / "vault" / "memory.age").read_bytes()
    assert b"123k" not in store and b"Price" not in store
    # a new machine with the same identity and an empty memory folder gets the files back
    (cfg.memory_dir / "project_x.md").write_text("changed locally\n", encoding="utf-8")
    opened = vault.open_store(cfg)
    assert opened["opened"] and opened["written"] == 1 and opened["backed_up"] == 1
    assert (cfg.memory_dir / "project_x.md").read_text(encoding="utf-8") == "Price at £123k.\n"


def test_opening_without_an_identity_explains_what_to_do(tmp_path):
    pytest.importorskip("pyrage")
    cfg = make_cfg(tmp_path)
    vault.init(cfg)
    vault.seal(cfg)
    vault.identity_path(cfg).unlink()
    r = vault.open_store(cfg)
    assert not r["opened"] and "backup" in r["reason"]


def test_the_sync_commits_only_the_synced_paths(tmp_path):
    cfg = make_cfg(tmp_path)
    repo = cfg.repo_root
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "t@example.com")
    git(repo, "config", "user.name", "t")
    (repo / "code.py").write_text("work in progress\n", encoding="utf-8")
    r = autosync.run_sync(cfg, push=False)
    assert r["ok"] and r["committed"], r
    tracked = git(repo, "ls-files").stdout.split()
    assert "harness/rules/writing.md" in tracked and "code.py" not in tracked
    assert json.loads((cfg.data_dir / "sync-status.json").read_text(encoding="utf-8"))["ok"]
    again = autosync.run_sync(cfg, push=False)
    assert again["ok"] and again["committed"] is False


def test_the_drift_check_reports_a_changed_rule_and_the_lock_stops_a_second_sync(tmp_path):
    cfg = make_cfg(tmp_path)
    git(cfg.repo_root, "init", "-q", "-b", "main")
    git(cfg.repo_root, "config", "user.email", "t@example.com")
    git(cfg.repo_root, "config", "user.name", "t")
    autosync.run_sync(cfg, push=False)
    assert autosync.check_drift(cfg, start_sync=False) is None
    (cfg.claude_home / "rules" / "writing.md").write_text("Write in the FCA register, always.\n", encoding="utf-8")
    msg = autosync.check_drift(cfg, start_sync=False)
    assert msg and "rules/writing.md" in msg and "1 files" in msg
    autosync._lock_path(cfg).write_text("1", encoding="utf-8")
    assert autosync.run_sync(cfg, push=False).get("skipped")


# ---------------------------------------------------------------- the sync with no change, and the failure paths

def repo_with_sync(tmp_path, **kw):
    cfg = make_cfg(tmp_path, **kw)
    git(cfg.repo_root, "init", "-q", "-b", "main")
    git(cfg.repo_root, "config", "user.email", "t@example.com")
    git(cfg.repo_root, "config", "user.name", "t")
    return cfg


def commits(repo):
    r = git(repo, "rev-list", "--count", "HEAD")
    return int(r.stdout.strip()) if r.returncode == 0 else 0


def test_a_sync_with_no_change_makes_no_commit_whatever_the_clock_and_the_host(tmp_path, monkeypatch):
    """Regression for the test that failed about one run in four: the manifest held a time to the second, so 2 syncs
    on either side of a second boundary differed. The clock and the host are now moved on purpose."""
    cfg = repo_with_sync(tmp_path)
    assert autosync.run_sync(cfg, push=False)["committed"]
    n = commits(cfg.repo_root)
    monkeypatch.setattr(platform, "node", lambda: "another-host")
    real_time = time.time
    monkeypatch.setattr(time, "time", lambda: real_time() + 3600)
    from cortex_kg import sync as S
    from datetime import datetime as _dt

    class Later(_dt):
        @classmethod
        def now(cls, tz=None):
            return _dt(2031, 5, 5, 5, 5, 5, tzinfo=tz)
    monkeypatch.setattr(S, "datetime", Later)
    again = autosync.run_sync(cfg, push=False)
    assert again["ok"] and again["committed"] is False and commits(cfg.repo_root) == n


def test_a_file_removed_from_the_home_is_retired_by_the_sync_and_the_drift_clears(tmp_path):
    cfg = repo_with_sync(tmp_path)
    (cfg.claude_home / "rules" / "old.md").write_text("Old.\n", encoding="utf-8")
    assert autosync.run_sync(cfg, push=False)["committed"]
    (cfg.claude_home / "rules" / "old.md").unlink()
    r = autosync.run_sync(cfg, push=False)
    assert r["ok"] and r["committed"] and r["retired"] == ["rules/old.md"], r
    assert autosync.check_drift(cfg, start_sync=False) is None
    assert "harness/_retired" in git(cfg.repo_root, "ls-files").stdout
    assert autosync.run_sync(cfg, push=False)["committed"] is False


class FakeGit:
    """Wraps the real git call and fails the named sub-commands, so each failure path of the sync can be reached."""

    def __init__(self, real, fail=()):
        self.real, self.fail, self.seen = real, set(fail), []

    def __call__(self, cfg, *args, timeout=60):
        self.seen.append(args[0])
        if args[0] in self.fail:
            return subprocess.CompletedProcess(["git", *args], 1, "", "simulated failure of " + args[0])
        return self.real(cfg, *args, timeout=timeout)


def with_remote(tmp_path, cfg, push_first=True):
    bare = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
    git(cfg.repo_root, "remote", "add", "origin", str(bare))
    if push_first:
        assert autosync.run_sync(cfg, push=False)["committed"]
        git(cfg.repo_root, "push", "-q", "origin", "HEAD:main")
    return bare


def test_no_origin_remote_is_reported_not_silently_ignored(tmp_path):
    cfg = repo_with_sync(tmp_path)
    r = autosync.run_sync(cfg, push=True)
    assert r["ok"] and r["pushed"] is False and "no origin remote" in r["note"]


def test_a_missing_origin_branch_is_reported(tmp_path):
    cfg = repo_with_sync(tmp_path)
    with_remote(tmp_path, cfg, push_first=False)
    r = autosync.run_sync(cfg, push=True)
    assert r["ok"] and r["pushed"] is False and "origin/main does not exist" in r["note"], r


def test_a_failed_fetch_stops_the_push_and_says_so(tmp_path, monkeypatch):
    cfg = repo_with_sync(tmp_path)
    with_remote(tmp_path, cfg)
    fake = FakeGit(autosync._git, fail={"fetch"})
    monkeypatch.setattr(autosync, "_git", fake)
    (cfg.claude_home / "rules" / "writing.md").write_text("Changed.\n", encoding="utf-8")
    r = autosync.run_sync(cfg, push=True)
    assert r["ok"] is False and "fetch" in r["error"] and r["committed"] and "push" not in fake.seen
    assert json.loads((cfg.data_dir / "sync-status.json").read_text(encoding="utf-8"))["ok"] is False


def test_a_remote_that_is_ahead_is_never_overwritten(tmp_path):
    cfg = repo_with_sync(tmp_path)
    bare = with_remote(tmp_path, cfg)
    other = tmp_path / "other"
    subprocess.run(["git", "clone", "-q", str(bare), str(other)], check=True)
    git(other, "config", "user.email", "o@example.com")
    git(other, "config", "user.name", "o")
    (other / "harness" / "extra.md").write_text("from the other machine\n", encoding="utf-8")
    git(other, "add", "-A")
    git(other, "commit", "-q", "-m", "other")
    git(other, "push", "-q", "origin", "HEAD:main")
    (cfg.claude_home / "rules" / "writing.md").write_text("Changed here.\n", encoding="utf-8")
    r = autosync.run_sync(cfg, push=True)
    assert r["ok"] is False and "lacks" in r["error"] and r["pushed"] is False


def test_a_rejected_push_is_an_error(tmp_path, monkeypatch):
    cfg = repo_with_sync(tmp_path)
    with_remote(tmp_path, cfg)
    monkeypatch.setattr(autosync, "_git", FakeGit(autosync._git, fail={"push"}))
    (cfg.claude_home / "rules" / "writing.md").write_text("Changed.\n", encoding="utf-8")
    r = autosync.run_sync(cfg, push=True)
    assert r["ok"] is False and "The push failed" in r["error"] and r["pushed"] is False


def test_a_missing_git_executable_ends_the_sync_cleanly_and_frees_the_lock(tmp_path, monkeypatch):
    cfg = repo_with_sync(tmp_path)

    def no_git(*a, **k):
        raise FileNotFoundError("git")
    monkeypatch.setattr(autosync.subprocess, "run", no_git)
    r = autosync.run_sync(cfg, push=False)
    assert r["ok"] is False and "FileNotFoundError" in r["error"]
    assert not autosync._lock_path(cfg).exists()
    assert json.loads((cfg.data_dir / "sync-status.json").read_text(encoding="utf-8"))["ok"] is False


def test_background_git_never_waits_for_a_prompt(tmp_path, monkeypatch):
    cfg = repo_with_sync(tmp_path)
    seen = {}

    def spy(cmd, **kw):
        seen.update(kw.get("env") or {})
        return subprocess.CompletedProcess(cmd, 0, "", "")
    monkeypatch.setattr(autosync.subprocess, "run", spy)
    autosync._git(cfg, "status")
    assert seen["GIT_TERMINAL_PROMPT"] == "0" and seen["GCM_INTERACTIVE"] == "never"


# ---------------------------------------------------------------- the lock

def test_the_lock_is_taken_exclusively_and_a_stale_lock_is_replaced(tmp_path):
    cfg = make_cfg(tmp_path)
    assert autosync._acquire(cfg) is True
    assert autosync._acquire(cfg) is False  # a second sync cannot take a fresh lock
    lock = autosync._lock_path(cfg)
    old = time.time() - autosync.LOCK_STALE_SECONDS - 5
    os.utime(lock, (old, old))
    assert autosync._acquire(cfg) is True  # a lock from a run that died is replaced
    assert lock.read_text(encoding="utf-8") == str(os.getpid())
    autosync._release(cfg)
    assert not lock.exists()


def test_two_syncs_that_start_together_cannot_both_take_the_lock(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    cfg = make_cfg(tmp_path)
    with ThreadPoolExecutor(8) as pool:
        got = list(pool.map(lambda _: autosync._acquire(cfg), range(8)))
    assert got.count(True) == 1


# ---------------------------------------------------------------- the drift check does not start a sync that cannot help

def test_a_drift_that_the_last_sync_could_not_clear_does_not_start_another_sync(tmp_path, monkeypatch):
    cfg = repo_with_sync(tmp_path)
    autosync.run_sync(cfg, push=False)
    spawned = []
    monkeypatch.setattr(autosync, "_spawn_sync", lambda c: spawned.append(1))
    (cfg.claude_home / "rules" / "writing.md").write_text("Edited.\n", encoding="utf-8")
    msg = autosync.check_drift(cfg)
    assert "has started" in msg and spawned == [1]
    # the last sync ended with this same drift
    autosync._write_status(cfg, {"ok": False, "error": "x", "drift_sig": autosync._drift_sig(["rules/writing.md"])})
    msg = autosync.check_drift(cfg)
    assert "no new sync was started" in msg and spawned == [1]
    # a sync that is running is left to finish
    autosync._write_status(cfg, {"ok": True})
    autosync._acquire(cfg)
    msg = autosync.check_drift(cfg)
    assert "already running" in msg and spawned == [1]


# ---------------------------------------------------------------- the profile folder and the defaults that keep the sync off

def test_the_sync_paths_follow_the_profile_folder_when_it_is_inside_the_repository(tmp_path):
    cfg = make_cfg(tmp_path)
    for d in ("harness", "vault", "profile/vocab", "ontology/vocab", "ontology/ledger"):
        (cfg.repo_root / d).mkdir(parents=True)
    cfg.profile_path = cfg.repo_root / "profile"
    assert autosync.sync_paths(cfg) == ["harness", "vault", "profile"]  # the old ontology folders are not synced


def test_a_profile_folder_outside_the_repository_is_never_committed(tmp_path):
    cfg = make_cfg(tmp_path)
    (cfg.repo_root / "harness").mkdir()
    (cfg.data_dir / "profile").mkdir()
    assert autosync.sync_paths(cfg) == ["harness"]


def test_a_sync_pushes_only_where_the_configuration_turns_auto_push_on(tmp_path, monkeypatch):
    cfg = make_cfg(tmp_path)
    (cfg.repo_root / ".git").mkdir()
    (cfg.repo_root / "harness").mkdir()
    calls = []

    def fake_git(c, *args, timeout=60):
        calls.append(args[0])
        return subprocess.CompletedProcess(args, 1 if args[0] == "remote" else 0, "", "")
    monkeypatch.setattr(autosync, "_git", fake_git)
    cfg.raw.pop("auto_push")
    assert autosync.run_sync(cfg)["ok"] and "remote" not in calls and "push" not in calls
    cfg.raw["auto_push"] = True
    calls.clear()
    autosync.run_sync(cfg)
    assert "remote" in calls
