"""Map one Claude Code hook payload to a Cortex event, using the lookup tables in index.json.

The mapping is fixed in the task brief of 5 October 2026 and the shapes in docs/CONTRACTS.md. The hook script and
the replay both call map_hook, so a live call and a replayed call give the same event.
"""
from __future__ import annotations

import os
import re

from . import events
from .config import norm_path
from .model import slugify

WEIGHTS = {
    "prompt": 1.0, "route": 1.0, "instructions": 0.9, "skill": 1.0, "agent.start": 1.0, "agent.stop": 0.5,
    "read": 0.8, "write": 0.7, "workflow": 0.9, "tool": 0.5, "session.start": 0.6, "session.end": 0.0,
}
READ_TOOLS = {"Read", "NotebookRead"}
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
SCRIPT_EXT = (".py", ".mjs", ".ps1", ".cmd")
_TOKEN = re.compile(r"[^\s\"'`|;&<>()=,]+")
_AGENT_TYPE = re.compile(r"""agentType\s*:\s*['"]([^'"]+)['"]""")
_SYSTEM_PROMPT = ("<task-notification>", "SYSTEM NOTIFICATION", "<ci-monitor-event")


def _abs_norm(p: str, cwd: str | None) -> str:
    p = os.path.expanduser(p)
    # a Windows path such as C:\Users\... is absolute on every platform (see config.norm_path)
    windows_abs = len(p) > 2 and p[0].isalpha() and p[1] == ":" and p[2] in "\\/"
    if cwd and not (os.path.isabs(p) or windows_abs):
        p = os.path.join(cwd, p)
    return norm_path(p)


def node_for_path(path: str, index: dict, cwd: str | None = None) -> str | None:
    """The node for an exact path, or else for the longest folder prefix that holds it."""
    n = _abs_norm(path, cwd)
    hit = index.get("paths", {}).get(n)
    if hit:
        return hit
    for prefix, node in index.get("prefixes", []):
        pre = prefix.rstrip("/")
        if n == pre or n.startswith(pre + "/"):
            return node
    return None


def _short(path: str) -> str:
    parts = [x for x in path.replace("\\", "/").split("/") if x]
    return "/".join(parts[-2:]) if parts else path


def _unique(nodes) -> list[str]:
    seen: set[str] = set()
    out = []
    for n in nodes:
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _title_of(node_id: str) -> str:
    """A readable name from an id such as route:decks-and-slides."""
    name = node_id.split(":", 1)[-1].replace("-", " ").strip()
    return name[:1].upper() + name[1:]


def _event(kind, nodes, payload, label, key=None, meta=None):
    return events.make(kind, _unique(nodes), payload.get("session_id") or "unknown", "hook", label,
                       WEIGHTS[kind], key, meta)


def _regex_hits(rules, text: str, field: str):
    for r in rules:
        pats = r.get(field)
        pats = [pats] if isinstance(pats, str) else (pats or [])
        for pat in pats:
            try:
                if re.search(pat, text, re.I):
                    yield r
                    break
            except re.error:
                continue


def _prompt(payload, index, log_snippets):
    text = payload.get("prompt") or ""
    nodes: list[str] = []
    routes: list[str] = []
    terms: list[str] = []
    if not any(m in text for m in _SYSTEM_PROMPT):
        for r in _regex_hits(index.get("routes", []), text, "patterns"):
            routes.append(r["id"])
            nodes += [r["id"], *r.get("fires", [])]
        for t in _regex_hits(index.get("terms", []), text, "pattern"):
            terms.append(t["id"])
            nodes += [t["id"], *t.get("fires", [])]
    nodes += index.get("hooks", {}).get("UserPromptSubmit", [])
    meta = {"matched_routes": routes, "matched_terms": terms}
    if log_snippets:
        meta["snippet"] = text[:120]
    label = ("Prompt matched " + ", ".join(_title_of(r) for r in routes)) if routes else "Prompt sent"
    return _event("prompt", nodes, payload, label, None, meta)


def _bash_nodes(command: str, index: dict, cwd: str | None):
    nodes: list[str] = []
    scripts: list[str] = []
    tools = index.get("tools", {})
    paths = index.get("paths", {})
    for tok in _TOKEN.findall(command):
        base = re.split(r"[\\/]", tok)[-1]
        if base.lower().endswith(SCRIPT_EXT):
            node = tools.get(base) or tools.get(base.lower())
            if node:
                nodes.append(node)
                scripts.append(base)
        if "/" in tok or "\\" in tok or tok.startswith("~"):
            try:
                node = paths.get(_abs_norm(tok, cwd))
            except (OSError, ValueError):
                node = None
            if node:
                nodes.append(node)
    return nodes, scripts


def _workflow_agents(ti: dict, index: dict) -> list[str]:
    script = ti.get("script") or ""
    if not script and ti.get("scriptPath"):
        try:
            with open(os.path.expanduser(ti["scriptPath"]), encoding="utf-8", errors="replace") as fh:
                script = fh.read(300_000)
        except OSError:
            script = ""
    agents = index.get("agents", {})
    return [agents[a] for a in _AGENT_TYPE.findall(script) if a in agents]


def _pre_tool(payload, index):
    tool = payload.get("tool_name") or ""
    ti = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    cwd = payload.get("cwd")
    key = payload.get("tool_use_id") or None
    builtin = "builtin:" + slugify(tool)
    meta: dict = {"tool": tool}
    if tool in READ_TOOLS or tool in WRITE_TOOLS:
        kind = "read" if tool in READ_TOOLS else "write"
        path = ti.get("file_path") or ti.get("notebook_path") or ""
        node = None
        if path:
            try:
                node = node_for_path(path, index, cwd)
                meta["path"] = _abs_norm(path, cwd)
            except (OSError, ValueError):
                pass
        verb = "Read" if kind == "read" else "Wrote" if tool == "Write" else "Edited"
        label = f"{verb} {_short(path)}" if path else f"{verb} a file"
        return _event(kind, [node, builtin], payload, label, key, meta)
    if tool == "Skill":
        name = str(ti.get("skill") or "")
        skills = index.get("skills", {})
        node = skills.get(name) or skills.get(name.split(":", 1)[-1])
        meta["skill"] = name
        return _event("skill", [node, builtin], payload, f"Used the {name or 'unnamed'} skill", key, meta)
    if tool in ("Agent", "Task"):
        sub = str(ti.get("subagent_type") or "general-purpose")
        meta["agent"] = sub
        return _event("agent.start", [index.get("agents", {}).get(sub), builtin], payload,
                      f"Started the {sub} agent", key, meta)
    if tool == "Workflow":
        name = ti.get("name") or ""
        agents = _workflow_agents(ti, index)
        meta["agents"] = len(agents)
        label = f"Started the {name} workflow" if name else "Started a workflow"
        return _event("workflow", ["builtin:workflow", *agents, builtin], payload, label, key, meta)
    if tool in ("Bash", "PowerShell"):
        nodes, scripts = _bash_nodes(str(ti.get("command") or ""), index, cwd)
        meta["scripts"] = scripts
        label = f"Ran {', '.join(scripts[:3])}" if scripts else f"Ran a {tool} command"
        return _event("tool", [*nodes, builtin], payload, label, key, meta)
    return _event("tool", [builtin], payload, f"Used the {tool or 'unnamed'} tool", key, meta)


def map_hook(payload: dict, index: dict, log_snippets: bool = False) -> dict | None:
    """Return the event for one hook payload, or None when the payload fires no node."""
    name = payload.get("hook_event_name")
    if name == "SessionStart":
        nodes = [*index.get("always", []), *index.get("hooks", {}).get("SessionStart", [])]
        return _event("session.start", nodes, payload, "Session started")
    if name == "SessionEnd":
        return _event("session.end", [], payload, "Session ended", None, {"reason": payload.get("reason")})
    if name == "UserPromptSubmit":
        return _prompt(payload, index, log_snippets)
    if name == "InstructionsLoaded":
        path = payload.get("file_path") or ""
        try:
            node = node_for_path(path, index, payload.get("cwd")) if path else None
        except (OSError, ValueError):
            node = None
        if not node:
            return None
        return _event("instructions", [node], payload, f"Loaded {_short(path)}", None,
                      {"load_reason": payload.get("load_reason")})
    if name == "PreToolUse":
        return _pre_tool(payload, index)
    if name in ("SubagentStart", "SubagentStop"):
        sub = str(payload.get("agent_type") or "")
        node = index.get("agents", {}).get(sub)
        if not node:
            return None
        start = name == "SubagentStart"
        aid = payload.get("agent_id")
        return _event("agent.start" if start else "agent.stop", [node], payload,
                      f"Started the {sub} agent" if start else f"The {sub} agent finished",
                      f"{aid}:{'start' if start else 'stop'}" if aid else None, {"agent": sub})
    return None
