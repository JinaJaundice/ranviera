"""The automatic export check: keep the repository in step with this laptop's ~/.claude.

The owner asked that nothing drifts from this machine. Two hooks do the work:

- At session start, check_drift compares ~/.claude with the harness mirror and reports the files that differ, with
  the result of the last sync. When there is drift, it starts a sync in the background.
- At session end, run_sync exports the mirror, confirms that no drift remains, seals the encrypted store when it is
  switched on, commits only the synced paths and pushes to GitHub.

The sync commits only the harness mirror, the profile folder (when it is inside the repository) and the vault, never
code, so work in progress in the repository is not swept into a commit. It runs only where the configuration sets
auto_sync, and it pushes only where the configuration sets auto_push (both are off by default). It pushes only when the remote has no commits that this machine lacks, so
it never overwrites work from another machine; in that case it reports that a pull is needed. A lock file stops 2
syncs running at once, and every run records its result in <data_dir>/sync-status.json.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

from .config import Config

SYNC_PATHS = ["harness", "vault"]  # and the profile folder, when it is inside the repository (sync_paths)
LOCK_STALE_SECONDS = 600
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]


def sync_paths(cfg: Config) -> list[str]:
    """The paths, relative to the repository, that a sync may commit: the mirror, the vault and the profile folder.
    A profile folder outside the repository (the default, <data_dir>/profile) is never committed."""
    from .sync import profile_dir
    paths = list(SYNC_PATHS)
    try:
        paths.append(profile_dir(cfg).resolve().relative_to(cfg.repo_root.resolve()).as_posix())
    except ValueError:
        pass
    return [p for p in paths if (cfg.repo_root / p).exists()]


def _status_path(cfg: Config) -> Path:
    return cfg.data_dir / "sync-status.json"


def _lock_path(cfg: Config) -> Path:
    return cfg.data_dir / "sync.lock"


def last_status(cfg: Config) -> dict:
    try:
        return json.loads(_status_path(cfg).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _write_status(cfg: Config, status: dict) -> None:
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    status["at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    status["host"] = platform.node()
    _status_path(cfg).write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")


def _git(cfg: Config, *args: str, timeout: int = 60) -> subprocess.CompletedProcess:
    # A background git call must never wait for a password or a credential prompt that nobody can see.
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}
    return subprocess.run(["git", "-C", str(cfg.repo_root), *args], capture_output=True, text=True, timeout=timeout,
                          env=env)


def _lock_is_fresh(cfg: Config) -> bool:
    try:
        return time.time() - _lock_path(cfg).stat().st_mtime < LOCK_STALE_SECONDS
    except OSError:
        return False


def _acquire(cfg: Config) -> bool:
    """Takes the lock with an exclusive create, so 2 syncs that start together cannot both hold it. A lock older than
    LOCK_STALE_SECONDS belongs to a run that died, and is removed once, then taken."""
    lp = _lock_path(cfg)
    lp.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(2):
        try:
            fd = os.open(lp, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if _lock_is_fresh(cfg):
                return False
            try:
                lp.unlink()
            except OSError:
                return False
            continue
        except OSError:
            return False
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(str(os.getpid()))
        return True
    return False


def _release(cfg: Config) -> None:
    try:
        _lock_path(cfg).unlink()
    except OSError:
        pass


def _today_words() -> str:
    d = date.today()
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def run_sync(cfg: Config, push: bool | None = None) -> dict:
    """Export, check, seal, commit and push. Never raises; the result is returned and written to sync-status.json."""
    from . import sync as S
    if push is None:
        push = bool(cfg.raw.get("auto_push", False))
    if not _acquire(cfg):
        return {"ok": True, "skipped": "Another sync is running."}
    result: dict = {"ok": False}
    try:
        exported = S.export(cfg)
        drift = S.doctor(cfg)
        left = drift["changed"] + drift["missing_in_mirror"] + drift["missing_in_home"]
        result["files"] = exported.get("files")
        if exported.get("retired"):
            result["retired"] = exported["retired"]
        if left:
            result["drift_sig"] = _drift_sig(left)
            result["error"] = f"After the export, {len(left)} files still differ: {', '.join(left[:5])}."
            return result
        if _vault_enabled(cfg):
            from . import vault
            result["vault"] = vault.seal(cfg)
        paths = sync_paths(cfg)
        if not (cfg.repo_root / ".git").exists():
            result.update(ok=True, committed=False, pushed=False, note="The repository has no git folder.")
            return result
        _git(cfg, "add", "--", *paths)
        if _git(cfg, "diff", "--cached", "--quiet", "--", *paths).returncode == 0:
            result["committed"] = False
        else:
            msg = (f"Sync the harness mirror from {platform.node()} on {_today_words()}\n\n"
                   "The automatic export check copied the managed files of ~/.claude into the mirror and "
                   "committed the synced paths only.")
            c = _git(cfg, "commit", "-q", "-m", msg, "--", *paths)
            result["committed"] = c.returncode == 0
            if c.returncode != 0:
                result["error"] = "The commit failed: " + (c.stderr or c.stdout).strip()[:300]
                return result
        result["pushed"] = False
        if push:
            if _git(cfg, "remote", "get-url", "origin").returncode != 0:
                result.update(ok=True, note="The repository has no origin remote, so nothing was pushed.")
                return result
            f = _git(cfg, "fetch", "-q", "origin", timeout=90)
            if f.returncode != 0:
                result["error"] = "The fetch from GitHub failed, so nothing was pushed: " + (f.stderr or f.stdout).strip()[:300]
                return result
            branch = _git(cfg, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip() or "main"
            if _git(cfg, "rev-parse", "--verify", "-q", f"refs/remotes/origin/{branch}").returncode != 0:
                result.update(ok=True, note=f"origin/{branch} does not exist, so nothing was pushed. Push the branch once by hand.")
                return result
            behind = _git(cfg, "rev-list", "--count", f"HEAD..origin/{branch}").stdout.strip() or "0"
            ahead = _git(cfg, "rev-list", "--count", f"origin/{branch}..HEAD").stdout.strip() or "0"
            if behind != "0":
                result["error"] = (f"GitHub has {behind} commits that this machine lacks, so nothing was pushed. "
                                   "Run git pull in apps/cortex, then the next sync pushes.")
                return result
            if ahead != "0":
                p = _git(cfg, "push", "-q", "origin", f"HEAD:{branch}", timeout=120)
                result["pushed"] = p.returncode == 0
                if p.returncode != 0:
                    result["error"] = "The push failed: " + (p.stderr or p.stdout).strip()[:300]
                    return result
        result["ok"] = True
        return result
    except Exception as exc:  # noqa: BLE001 - a hook must never fail loudly
        result["error"] = f"{type(exc).__name__}: {exc}"[:300]
        return result
    finally:
        _write_status(cfg, result)
        _release(cfg)


def _drift_sig(files: list[str]) -> str:
    return hashlib.sha1("\n".join(sorted(files)).encode("utf-8")).hexdigest()[:12]


def _vault_enabled(cfg: Config) -> bool:
    v = cfg.raw.get("vault") or {}
    return bool(v.get("enabled")) if isinstance(v, dict) else False


def check_drift(cfg: Config, start_sync: bool = True) -> str | None:
    """The message for the session start: the files that differ, and the last sync when it failed. None when all is
    in step. With drift, a sync is started in the background so the mirror catches up without waiting for the end."""
    from . import sync as S
    lines = []
    try:
        d = S.doctor(cfg)
        diff = d["changed"] + d["missing_in_mirror"] + d["missing_in_home"]
    except Exception as exc:  # noqa: BLE001
        return f"Cortex could not run its drift check: {type(exc).__name__}: {exc}"[:300]
    if diff:
        shown = ", ".join(diff[:6]) + (f" and {len(diff) - 6} more" if len(diff) > 6 else "")
        last = last_status(cfg)
        # A sync that ended with this very drift cannot clear it by running again, so none is started. One that is
        # already running is left to finish.
        repeat = last.get("drift_sig") == _drift_sig(diff)
        if start_sync and not repeat and not _lock_is_fresh(cfg):
            _spawn_sync(cfg)
            tail = "A sync has started in the background, and another runs when this session ends."
        elif repeat:
            tail = "The last sync could not clear this drift, so no new sync was started. Run python cortex.py doctor."
        else:
            tail = "A sync is already running."
        lines.append(f"Cortex drift check: {len(diff)} files in ~/.claude differ from the mirror in apps/cortex/harness "
                     f"({shown}). {tail}")
    last = last_status(cfg)
    if last and not last.get("ok") and last.get("error"):
        lines.append(f"The last Cortex sync, at {last.get('at')}, did not finish: {last['error']}")
    return " ".join(lines) or None


def _spawn_sync(cfg: Config) -> None:
    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    cmd = [sys.executable, "sync"] if getattr(sys, "frozen", False) else [sys.executable, str(cfg.repo_root / "cortex.py"), "sync"]
    try:
        subprocess.Popen(cmd, cwd=str(cfg.repo_root),
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=flags, close_fds=True)
    except OSError:
        pass
