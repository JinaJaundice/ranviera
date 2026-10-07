"""Shared fixtures for the Cortex knowledge graph tests.

mini_home builds a small set-up in a temporary folder, and mini_cfg is a Config that points at it. Nothing under the
real ~/.claude or the Projects folder is read. Fixtures:

- mini_home: the temporary root (a Path). Its folders are home/ (the Claude home), projects/ (the Projects root),
  memory/ (the memory folder), data/ (the data folder) and repo/ (the repository root, with an ontology/ folder).
- mini_cfg: a Config whose claude_home, projects_root, memory_dir, data_dir and repo_root are those folders.
- mini_paths: a dict of the main files by short name (claude_md, writing, decks, agent, settings, routes, hook,
  guard, prose_check, skill, reference, guide, schedule, memory_index), for tests that edit or cite them.
- ledger_path: where a test may save a ledger (mini_cfg.ontology_dir / "ledger" / "rules.json").
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cortex_kg.config import Config  # noqa: E402

CLAUDE_MD = """# The map

This file is the map for every session.

## Rules for every task

1. **Language.** Every word follows the register in `rules/writing.md`.
2. **Answer first.** State the answer, then the evidence (5 Oct 2026).
3. **Archive, never delete.** Superseded files move to the `archive/` folder.

## Where things are kept

- Writing rules are in `rules/writing.md`.

## Changes to this file

- 5 October 2026: first version.
"""

WRITING_MD = """# Writing

## Sentences

- Write measured sentences that carry related facts together.
- A sentence should not run past 35 words.

## Words

- Do not use dashes.
"""

DECKS_MD = """---
paths:
  - "**/decks/**"
  - "**/*.pptx"
---

# Decks

## Layout

- Every slide must have a title.
- Use the template in `skills/jordan-playbook/references/decks-common.md`.
- Read `skills/missing/nothing.md` first [path not found].

## Layout

- Keep one idea on each slide.
"""

AGENT_MD = """---
name: builder
description: "Makes scoped code changes."
tools: Read, Write, Edit
model: sonnet
effort: medium
memory: user
---

# Builder

## Before you edit

- Read the files you will change.
"""

STYLE_MD = """---
name: plain-english
description: The house style.
---

# Style

- Write in measured sentences.
"""

SETTINGS = {
    "hooks": {
        "SessionStart": [{"hooks": [
            {"type": "command", "command": "python {home}/tools/register/hook.py session", "timeout": 15},
            {"type": "command", "command": "python {home}/tools/register/hook.py session", "async": True},
        ]}],
        "PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": "python {home}/tools/register/guard.py", "timeout": 10,
             "statusMessage": "Checking"}]}],
        "Stop": [{"hooks": [
            {"type": "command", "command": "python {home}/tools/missing_script.py"}]}],
    }
}

ROUTES = [
    {"name": "Decks and slides", "match": ["\\bdecks?\\b", "\\bslides?\\b"],
     "load": "Read rules/decks.md, then the references."},
    {"name": "Documents and reports", "match": ["\\breport\\b"], "load": "Read the writing rule."},
]

HOOK_PY = '''"""The register hook for the mini set-up.

A second line of the docstring.
"""
import re

HARD = [
    (re.compile(r"!"), "exclaim", "an exclamation mark"),
    (re.compile(r";"), "semicolon", "a semicolon"),
]


def check(faults, words):
    faults.append(("tail", "a bolted-on qualifier", ""))
    faults.append(("colons", f"{words} colons per 1,000 words", ""))
'''

GUARD_PY = '''"""The guard for the mini set-up."""
import re

COMMIT_FAULTS = [
    (re.compile(r"!"), "an exclamation mark"),
]
'''

PROSE_PY = '"""Run the prose checks."""\n'

SKILL_MD = """---
name: jordan-playbook
description: >-
  The playbook with
  folded text.
---

# Playbook

## Open decisions

- Decide whether to keep the shared template (source: memory, 2026-10-01).

## Superseded rules

- Use the old template.
"""

REFERENCE_MD = """# Decks common

## Template

- Every deck uses the template.
"""

GUIDE_SKILL_MD = """---
name: plain-writing-voice
description: The writing guide.
---

# Voice

- Use the guide.
"""

GUIDE_MD = """# FCA register

## Sentences

- Write sentences of 23 words.
"""

SCHEDULE_MD = """---
name: nightly
description: A nightly check.
---

Run the check.
"""


def _write(p: Path, text: str) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8", newline="\n")
    return p


@pytest.fixture
def mini_home(tmp_path: Path) -> Path:
    """The temporary root holding the mini set-up. Files are written once, and tests may edit them."""
    home = tmp_path / "home"
    paths = {
        "claude_md": _write(home / "CLAUDE.md", CLAUDE_MD),
        "writing": _write(home / "rules" / "writing.md", WRITING_MD),
        "decks": _write(home / "rules" / "decks.md", DECKS_MD),
        "agent": _write(home / "agents" / "builder.md", AGENT_MD),
        "style": _write(home / "output-styles" / "plain-english.md", STYLE_MD),
        "hook": _write(home / "tools" / "register" / "hook.py", HOOK_PY),
        "guard": _write(home / "tools" / "register" / "guard.py", GUARD_PY),
        "prose_check": _write(home / "tools" / "prose_check.py", PROSE_PY),
        "routes": _write(home / "tools" / "register" / "routes.json", json.dumps(ROUTES, indent=1)),
        "skill": _write(home / "skills" / "jordan-playbook" / "SKILL.md", SKILL_MD),
        "reference": _write(home / "skills" / "jordan-playbook" / "references" / "decks-common.md", REFERENCE_MD),
        "guide_skill": _write(home / "skills" / "plain-writing-voice" / "SKILL.md", GUIDE_SKILL_MD),
        "guide": _write(home / "skills" / "plain-writing-voice" / "FCA_REGISTER.md", GUIDE_MD),
        "schedule": _write(home / "scheduled-tasks" / "nightly" / "SKILL.md", SCHEDULE_MD),
    }
    _write(home / "tools" / "selftest" / "skipped.py", '"""Not harvested."""\n')
    settings = json.dumps(SETTINGS).replace("{home}", str(home).replace("\\", "/"))
    paths["settings"] = _write(home / "settings.json", settings)
    _write(tmp_path / "memory" / "MEMORY.md", "# Memory index\n\n- [A](a.md) - one\n")
    _write(tmp_path / "memory" / "a.md", "---\nname: a\ndescription: one\nmetadata:\n  type: project\n---\n\nBody.\n")
    _write(tmp_path / "projects" / "BACKLOG.md", "# Backlog\n")
    _write(tmp_path / "projects" / "README.md", "# Projects\n")
    (tmp_path / "repo" / "ontology").mkdir(parents=True, exist_ok=True)
    (tmp_path / "data").mkdir(exist_ok=True)
    return tmp_path


@pytest.fixture
def mini_cfg(mini_home: Path) -> Config:
    """A Config that points at the mini set-up."""
    return Config(
        claude_home=(mini_home / "home").resolve(),
        projects_root=(mini_home / "projects").resolve(),
        memory_dir=(mini_home / "memory").resolve(),
        data_dir=(mini_home / "data").resolve(),
        port=5182,
        include_sensitivity=["public", "internal", "client-confidential"],
        log_prompt_snippets=False,
        repo_root=(mini_home / "repo").resolve(),
    )


@pytest.fixture
def mini_paths(mini_cfg: Config) -> dict[str, Path]:
    """The main files of the mini set-up by short name."""
    h = mini_cfg.claude_home
    return {
        "claude_md": h / "CLAUDE.md", "writing": h / "rules" / "writing.md", "decks": h / "rules" / "decks.md",
        "agent": h / "agents" / "builder.md", "settings": h / "settings.json",
        "routes": h / "tools" / "register" / "routes.json", "hook": h / "tools" / "register" / "hook.py",
        "guard": h / "tools" / "register" / "guard.py", "prose_check": h / "tools" / "prose_check.py",
        "skill": h / "skills" / "jordan-playbook" / "SKILL.md",
        "reference": h / "skills" / "jordan-playbook" / "references" / "decks-common.md",
        "guide": h / "skills" / "plain-writing-voice" / "FCA_REGISTER.md",
        "schedule": h / "scheduled-tasks" / "nightly" / "SKILL.md",
        "memory_index": mini_cfg.memory_dir / "MEMORY.md",
    }


@pytest.fixture
def ledger_path(mini_cfg: Config) -> Path:
    """The ledger file for a test, in the mini repository."""
    return mini_cfg.ontology_dir / "ledger" / "rules.json"
