"""hookmap: one test for each row of the mapping."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cortex_kg import hookmap  # noqa: E402
from cortex_kg.config import norm_path  # noqa: E402

HOME = "C:/Users/test/.claude"
INDEX = {
    "v": 1,
    "paths": {
        norm_path(f"{HOME}/rules/decks.md"): "rulefile:decks",
        norm_path(f"{HOME}/CLAUDE.md"): "claudemd:global",
        norm_path(f"{HOME}/tools/register/fca_style.py"): "tool:fca-style",
    },
    "prefixes": [[norm_path(f"{HOME}/skills/jordan-playbook/references"), "folder:references"],
                 [norm_path(f"{HOME}/skills"), "folder:skills"]],
    "routes": [{"id": "route:decks-and-slides", "patterns": [r"\bdecks?\b", r"\bslides?\b"],
                "fires": ["task:deck"]},
               {"id": "route:charts", "patterns": [r"\bchart"], "fires": ["task:visual"]}],
    "skills": {"plain-writing-voice": "skill:plain-writing-voice", "pptx": "skill:pptx"},
    "agents": {"checker": "agent:checker", "writer": "agent:writer"},
    "tools": {"fca_style.py": "tool:fca-style", "prose_check.py": "tool:prose-check"},
    "terms": [{"id": "term:falcon", "pattern": r"falcon", "fires": ["project:falcon"]}],
    "faults": {},
    "hooks": {"SessionStart": ["hook:sessionstart-register"], "UserPromptSubmit": ["hook:userpromptsubmit-register"]},
    "always": ["claudemd:global", "rulefile:writing"],
}
BASE = {"session_id": "s1", "transcript_path": "x", "cwd": "C:/Users/test/Projects"}


def pre(tool, tool_input, tid="toolu_1"):
    return {**BASE, "hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": tool_input, "tool_use_id": tid}


def test_session_start():
    ev = hookmap.map_hook({**BASE, "hook_event_name": "SessionStart"}, INDEX)
    assert ev["kind"] == "session.start" and ev["weight"] == 0.6 and ev["source"] == "hook"
    assert ev["nodes"] == ["claudemd:global", "rulefile:writing", "hook:sessionstart-register"]


def test_session_end_has_no_nodes():
    ev = hookmap.map_hook({**BASE, "hook_event_name": "SessionEnd", "reason": "clear"}, INDEX)
    assert ev["kind"] == "session.end" and ev["nodes"] == [] and ev["meta"]["reason"] == "clear"


def test_instructions_loaded():
    p = {**BASE, "hook_event_name": "InstructionsLoaded", "file_path": f"{HOME}\\rules\\decks.md",
         "memory_type": "User", "load_reason": "session_start"}
    ev = hookmap.map_hook(p, INDEX)
    assert ev["kind"] == "instructions" and ev["nodes"] == ["rulefile:decks"] and ev["weight"] == 0.9
    assert ev["meta"]["load_reason"] == "session_start"
    assert hookmap.map_hook({**p, "file_path": "C:/elsewhere/x.md"}, INDEX) is None


def test_prompt_matches_routes_and_terms_without_text():
    p = {**BASE, "hook_event_name": "UserPromptSubmit", "prompt": "Build a DECK about Falcon"}
    ev = hookmap.map_hook(p, INDEX)
    assert ev["kind"] == "prompt" and ev["weight"] == 1.0
    assert ev["nodes"] == ["route:decks-and-slides", "task:deck", "term:falcon", "project:falcon",
                           "hook:userpromptsubmit-register"]
    assert ev["meta"] == {"matched_routes": ["route:decks-and-slides"], "matched_terms": ["term:falcon"]}
    assert ev["label"] == "Prompt matched Decks and slides"
    assert "Build a DECK" not in str(ev)
    withsnip = hookmap.map_hook({**p, "prompt": "deck " + "x" * 200}, INDEX, log_snippets=True)
    assert len(withsnip["meta"]["snippet"]) == 120


def test_prompt_with_no_match_is_still_an_event():
    ev = hookmap.map_hook({**BASE, "hook_event_name": "UserPromptSubmit", "prompt": "hello"}, INDEX)
    assert ev["nodes"] == ["hook:userpromptsubmit-register"] and ev["label"] == "Prompt sent"


@pytest.mark.parametrize("tool,kind,weight,verb", [("Read", "read", 0.8, "Read"), ("Write", "write", 0.7, "Wrote"),
                                                    ("Edit", "write", 0.7, "Edited")])
def test_read_and_write_use_the_exact_path(tool, kind, weight, verb):
    ev = hookmap.map_hook(pre(tool, {"file_path": f"{HOME}/rules/decks.md"}), INDEX)
    assert ev["kind"] == kind and ev["weight"] == weight and ev["key"] == "toolu_1"
    assert ev["nodes"] == ["rulefile:decks", f"builtin:{tool.lower()}"]
    assert ev["label"] == f"{verb} rules/decks.md"
    assert ev["meta"]["path"] == norm_path(f"{HOME}/rules/decks.md")


def test_read_falls_back_to_the_longest_prefix_and_notebook_path():
    ev = hookmap.map_hook(pre("Read", {"file_path": f"{HOME}/skills/jordan-playbook/references/new.md"}), INDEX)
    assert ev["nodes"][0] == "folder:references"
    ev = hookmap.map_hook(pre("NotebookEdit", {"notebook_path": f"{HOME}/skills/x/n.ipynb"}), INDEX)
    assert ev["kind"] == "write" and ev["nodes"] == ["folder:skills", "builtin:notebookedit"]
    ev = hookmap.map_hook(pre("MultiEdit", {"file_path": "C:/nowhere/a.txt"}), INDEX)
    assert ev["nodes"] == ["builtin:multiedit"]


def test_skill_strips_the_namespace_when_needed():
    ev = hookmap.map_hook(pre("Skill", {"skill": "plain-writing-voice"}), INDEX)
    assert ev["kind"] == "skill" and ev["nodes"] == ["skill:plain-writing-voice", "builtin:skill"]
    ev = hookmap.map_hook(pre("Skill", {"skill": "anthropic-skills:pptx"}), INDEX)
    assert ev["nodes"][0] == "skill:pptx"


def test_agent_and_task():
    ev = hookmap.map_hook(pre("Agent", {"subagent_type": "checker", "description": "d", "prompt": "p"}), INDEX)
    assert ev["kind"] == "agent.start" and ev["nodes"] == ["agent:checker", "builtin:agent"]
    assert ev["label"] == "Started the checker agent"
    ev = hookmap.map_hook(pre("Task", {"subagent_type": "writer"}), INDEX)
    assert ev["nodes"] == ["agent:writer", "builtin:task"]


def test_workflow_finds_agent_types():
    script = "agent({ agentType: 'writer' }); agent({ agentType: \"checker\" }); agent({ agentType: 'unknown' })"
    ev = hookmap.map_hook(pre("Workflow", {"script": script, "name": "demo"}), INDEX)
    assert ev["kind"] == "workflow" and ev["weight"] == 0.9
    assert ev["nodes"] == ["builtin:workflow", "agent:writer", "agent:checker"]


def test_bash_finds_scripts_and_paths():
    cmd = f"python {HOME}/tools/register/fca_style.py score {HOME}/rules/decks.md && python prose_check.py x.md"
    ev = hookmap.map_hook(pre("Bash", {"command": cmd}), INDEX)
    assert ev["kind"] == "tool" and ev["weight"] == 0.5
    assert ev["nodes"] == ["tool:fca-style", "rulefile:decks", "tool:prose-check", "builtin:bash"]
    assert ev["meta"]["scripts"] == ["fca_style.py", "prose_check.py"]
    assert "score" not in str(ev["meta"])
    ev = hookmap.map_hook(pre("PowerShell", {"command": "Get-Date"}), INDEX)
    assert ev["nodes"] == ["builtin:powershell"]


@pytest.mark.parametrize("tool,ti", [("Grep", {"pattern": "x", "path": "."}), ("Glob", {"pattern": "*.md"}),
                                     ("WebFetch", {"url": "https://example.com"})])
def test_other_tools_fire_the_builtin_only(tool, ti):
    ev = hookmap.map_hook(pre(tool, ti), INDEX)
    assert ev["kind"] == "tool" and ev["nodes"] == [f"builtin:{tool.lower()}"]


def test_subagent_start_and_stop():
    start = hookmap.map_hook({**BASE, "hook_event_name": "SubagentStart", "agent_type": "checker",
                              "agent_id": "a1"}, INDEX)
    stop = hookmap.map_hook({**BASE, "hook_event_name": "SubagentStop", "agent_type": "checker",
                             "agent_id": "a1"}, INDEX)
    assert (start["kind"], stop["kind"]) == ("agent.start", "agent.stop")
    assert start["nodes"] == stop["nodes"] == ["agent:checker"]
    assert start["key"] != stop["key"]
    assert hookmap.map_hook({**BASE, "hook_event_name": "SubagentStart", "agent_type": "general-purpose"}, INDEX) is None


def test_unmapped_events_return_none():
    assert hookmap.map_hook({**BASE, "hook_event_name": "Stop"}, INDEX) is None
    assert hookmap.map_hook({}, INDEX) is None
