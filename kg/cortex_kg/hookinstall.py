"""The safe installer of the Cortex hook entries in ~/.claude/settings.json.

The installer merges and never replaces. It adds one entry for each hook event that Cortex records, adds an entry only
when the event holds no Cortex entry of the same kind, keeps every other key and entry as it was, writes a dated backup
before each change and leaves a file that is not valid JSON untouched. Removal deletes only the Cortex hook commands.
A command is a Cortex command when it runs cortex_hook.py or cortex_session.py, or when it runs the runner that was
copied to <data_dir>/bin/. In the packaged app the runner is the bundled compiler with the subcommand `hook`, copied
once for each version to <data_dir>/bin/<version>/, and an earlier version folder is kept.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

from .config import Config
from .hook import HOOK_EVENTS

SETTINGS = "settings.json"
TIMEOUT = 10
_SCRIPT = re.compile(r"(cortex_hook\.py|cortex_session\.py)(.*)$")


class HooksError(Exception):
    """The settings file cannot be merged safely. The message says why, and the file is left as it was."""


def _fwd(p: Path | str) -> str:
    return str(p).replace("\\", "/")


# ---------------------------------------------------------------- the runner

def version() -> str:
    """The version of the product: the package version, else package.json beside the repository."""
    try:
        from . import __version__
        return str(__version__)
    except ImportError:
        pass
    try:
        from .config import REPO_ROOT
        return str(json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8")).get("version") or "dev")
    except (OSError, ValueError):
        return "dev"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def bin_dir(cfg: Config) -> Path:
    return cfg.data_dir / "bin"


def runner_name() -> str:
    return Path(sys.executable).name if is_frozen() else ("ranviera-kg.exe" if os.name == "nt" else "ranviera-kg")


def runner_path(cfg: Config, exe: str | None = None) -> Path:
    return bin_dir(cfg) / version() / (exe or runner_name())


def ensure_bin(cfg: Config, source: Path | None = None, exe: str | None = None) -> dict:
    """Copies the runner folder to <data_dir>/bin/<version>/ once for each version and keeps earlier versions.

    Outside the packaged app there is no runner folder to copy, so a run with no source reports that and copies
    nothing."""
    if source is None:
        if not is_frozen():
            return {"copied": False, "path": None, "version": version(),
                    "reason": "The compiler is not packaged, so there is no runner to copy."}
        source = Path(sys.executable).parent
    exe = exe or (Path(sys.executable).name if is_frozen() else runner_name())
    target = bin_dir(cfg) / version()
    path = target / exe
    if path.is_file():
        return {"copied": False, "path": _fwd(path), "version": version(), "reason": "This version is already in place."}
    shutil.copytree(source, target, dirs_exist_ok=True)
    return {"copied": True, "path": _fwd(path), "version": version(), "reason": None}


def _python_cmd(cfg: Config) -> str:
    return str(cfg.raw.get("python_cmd") or ("python" if os.name == "nt" else "python3"))


def _runner_base(cfg: Config, copy: bool) -> tuple[str, bool]:
    """The command that runs the hook, and whether it is the packaged runner (which takes the event name)."""
    exe = runner_path(cfg)
    if is_frozen() and copy and not exe.is_file():
        ensure_bin(cfg)
    if exe.is_file() or is_frozen():
        return f'"{_fwd(exe)}" hook', True
    return f'{_python_cmd(cfg)} "{_fwd(cfg.repo_root / "hooks" / "cortex_hook.py")}"', False


def wanted_entries(cfg: Config, copy: bool = False) -> list[dict]:
    """The HookEntry list of docs/CONTRACTS.md for the entries that Cortex adds."""
    base, packaged = _runner_base(cfg, copy)
    out = []
    for event in HOOK_EVENTS:
        e: dict = {"event": event}
        if event == "PreToolUse":
            e["matcher"] = "*"
        e["command"] = f"{base} {event}" if packaged else base
        e["async"] = True
        out.append(e)
    return out


def _settings_entry(e: dict) -> dict:
    entry: dict = {}
    if "matcher" in e:
        entry["matcher"] = e["matcher"]
    entry["hooks"] = [{"type": "command", "command": e["command"], "async": bool(e.get("async")), "timeout": TIMEOUT}]
    return entry


# ---------------------------------------------------------------- recognising Cortex commands

def command_key(command: object, data_dir: Path | str | None = None) -> str | None:
    """'hook' for a command that records events, 'session <arguments>' for the session script, else None."""
    c = str(command).replace('"', " ").replace("'", " ").replace("\\", "/")
    m = _SCRIPT.search(c)
    if m:
        return "hook" if m.group(1) == "cortex_hook.py" else "session " + m.group(2).strip()
    if data_dir is not None:
        marker = _fwd(data_dir).rstrip("/").lower() + "/bin/"
        if marker in c.lower():
            return "hook"
    return None


def _keys(entry: object, data_dir) -> set[str]:
    out = set()
    for h in (entry.get("hooks") or []) if isinstance(entry, dict) and isinstance(entry.get("hooks"), list) else []:
        k = command_key(h.get("command", ""), data_dir) if isinstance(h, dict) else None
        if k:
            out.add(k)
    return out


def merge_hooks(settings: dict, wanted: dict, data_dir=None) -> int:
    """Adds the entries of `wanted` ({event: [entry]}) to settings["hooks"] in place and returns how many were added.
    An entry is skipped when the event already holds a Cortex entry of the same kind, so a second run adds nothing."""
    hooks = settings.get("hooks")
    if hooks is None:
        hooks = {}
    elif not isinstance(hooks, dict):
        raise HooksError("settings.json has a hooks value that is not an object, so it was left unchanged.")
    added = 0
    for event, entries in wanted.items():
        have = hooks.get(event)
        if have is not None and not isinstance(have, list):
            continue
        present = set().union(*[_keys(e, data_dir) for e in have]) if have else set()
        for entry in entries:
            k = _keys(entry, data_dir)
            if k and not k <= present:
                if have is None:
                    have = hooks[event] = []
                have.append(entry)
                present |= k
                added += 1
    if added and settings.get("hooks") is None:
        settings["hooks"] = hooks
    return added


def strip_hooks(settings: dict, data_dir=None) -> list[dict]:
    """Removes only the Cortex hook commands from settings["hooks"] in place and returns what was removed. An entry
    that holds other commands keeps them. An entry, an event or the hooks object that this empties is removed."""
    hooks = settings.get("hooks")
    removed: list[dict] = []
    if not isinstance(hooks, dict):
        return removed
    for event in list(hooks):
        entries = hooks[event]
        if not isinstance(entries, list):
            continue
        kept = []
        touched = False
        for entry in entries:
            inner = entry.get("hooks") if isinstance(entry, dict) else None
            if not isinstance(inner, list):
                kept.append(entry)
                continue
            keep_inner = []
            for h in inner:
                if isinstance(h, dict) and command_key(h.get("command", ""), data_dir):
                    removed.append({"event": event, "command": h.get("command", "")})
                    touched = True
                else:
                    keep_inner.append(h)
            if len(keep_inner) == len(inner):
                kept.append(entry)
            elif keep_inner:
                entry["hooks"] = keep_inner
                kept.append(entry)
        if touched:
            if kept:
                hooks[event] = kept
            else:
                del hooks[event]
    if removed and not hooks:
        del settings["hooks"]
    return removed


def merge_template(existing: dict, template: dict, data_dir=None) -> int:
    """For sync.install: adds the Cortex hook entries of a rendered settings template to an existing settings object."""
    return merge_hooks(existing, {ev: es for ev, es in (template.get("hooks") or {}).items() if isinstance(es, list)},
                       data_dir)


# ---------------------------------------------------------------- the file

def settings_path(cfg: Config) -> Path:
    return cfg.claude_home / SETTINGS


def backup_dir(cfg: Config) -> Path:
    return cfg.claude_home / "backups" / f"{datetime.now().strftime('%Y-%m-%d')}-{getattr(cfg, 'product', None) or cfg.raw.get('product') or 'ranviera'}-hooks"


def _read(path: Path) -> tuple[dict, str]:
    if not path.is_file():
        return {}, ""
    text = path.read_text(encoding="utf-8-sig")
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise HooksError("settings.json is not valid JSON, so it was left unchanged.") from exc
    if not isinstance(data, dict):
        raise HooksError("settings.json is not a JSON object, so it was left unchanged.")
    return data, text


def _dump(data: dict, original: str) -> bytes:
    """Writes the object in the layout of the original file (its indent, final newline and escapes)."""
    indent: int | str = 2
    m = re.search(r"^([ \t]+)\S", original, re.M)
    if m:
        indent = "\t" if m.group(1).startswith("\t") else len(m.group(1))
    text = json.dumps(data, indent=indent, ensure_ascii="\\u" in original)
    return (text + ("\n" if (original.endswith("\n") or not original) else "")).encode("utf-8")


def _backup(cfg: Config, path: Path) -> str | None:
    if not path.is_file():
        return None
    d = backup_dir(cfg)
    d.mkdir(parents=True, exist_ok=True)
    dest = d / f"settings.{datetime.now().strftime('%H%M%S%f')}.json"
    shutil.copy2(path, dest)
    return _fwd(dest)


def _earlier_bytes(cfg: Config, data: dict) -> bytes | None:
    """The bytes of the newest backup of an install that parse to the same object as `data`, so that removal of the
    entries gives back the original file byte for byte, whatever its layout was."""
    root = cfg.claude_home / "backups"
    files = sorted(root.glob("*-hooks/settings.*.json"), key=lambda f: f.stat().st_mtime, reverse=True) if root.is_dir() else []
    for f in files[:20]:
        try:
            if json.loads(f.read_text(encoding="utf-8-sig")) == data:
                return f.read_bytes()
        except (OSError, ValueError):
            continue
    return None


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".cortex-tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def _covered(settings: dict, data_dir) -> bool:
    hooks = settings.get("hooks") if isinstance(settings.get("hooks"), dict) else {}
    for event in HOOK_EVENTS:
        es = hooks.get(event)
        if not isinstance(es, list) or not any("hook" in _keys(e, data_dir) for e in es):
            return False
    return True


# ---------------------------------------------------------------- the commands

def preview(cfg: Config, path: Path | None = None) -> dict:
    """The HooksState: whether every event holds a Cortex entry, and the entries that Cortex adds or would add."""
    path = path or settings_path(cfg)
    data, _ = _read(path)
    return {"installed": _covered(data, cfg.data_dir), "settings_path": _fwd(path), "entries": wanted_entries(cfg),
            "backup_dir": _fwd(backup_dir(cfg))}


def install(cfg: Config, path: Path | None = None) -> dict:
    """Merges the entries after a dated backup. Returns {installed, backup, added}."""
    path = path or settings_path(cfg)
    data, text = _read(path)
    wanted: dict[str, list] = {}
    for e in wanted_entries(cfg, copy=True):
        wanted.setdefault(e["event"], []).append(_settings_entry(e))
    added = merge_hooks(data, wanted, cfg.data_dir)
    backup = None
    if added:
        backup = _backup(cfg, path)
        _write(path, _dump(data, text))
    return {"installed": True, "backup": backup, "added": added, "settings_path": _fwd(path)}


def uninstall(cfg: Config, path: Path | None = None) -> dict:
    """Removes only the Cortex hook commands after a dated backup. Returns {installed, removed, backup}."""
    path = path or settings_path(cfg)
    data, text = _read(path)
    removed = strip_hooks(data, cfg.data_dir)
    backup = None
    if removed:
        backup = _backup(cfg, path)
        _write(path, _earlier_bytes(cfg, data) or _dump(data, text))
    return {"installed": False, "removed": removed, "backup": backup, "settings_path": _fwd(path)}
