"""The people file and the role rules of the oversight views (docs/CONTRACTS.md, section 'Identity and roles').

The file named by the key oversight_people (or the environment variable CORTEX_OVERSIGHT_PEOPLE) lists the people of an
installation and their roles. A proposal and a draft need the role maker. A ratification and a rejection need the role
checker and a person other than the maker of the mapping. A reassignment needs the role checker. An approval needs the
role approver and a person other than the maker of the version. A sample verdict needs the role reviewer. A withdrawal
needs the role approver. Where the key is null no write is allowed.

`can` answers with a pair: whether the action is allowed and one sentence that names the rule. The identity itself comes
from the configuration (oversight_actor or RANVIERA_ACTOR), never from the body of a request. This contract is
provisional until the interviews of section 12 of the specification report.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

ROLES = ("maker", "checker", "approver", "reviewer", "viewer")

# the role that each action needs, and whether the person must differ from the maker of the record
RULES: dict[str, tuple[str, bool]] = {
    "propose": ("maker", False), "draft": ("maker", False),
    "ratify": ("checker", True), "reject": ("checker", True), "reassign": ("checker", False),
    "approve": ("approver", True), "withdraw": ("approver", False), "verdict": ("reviewer", False),
}


class PeopleError(ValueError):
    pass


def _same(a: str | None, b: str | None) -> bool:
    return (a or "").strip().lower() == (b or "").strip().lower()


def people_path(cfg) -> Path | None:
    v = os.environ.get("CORTEX_OVERSIGHT_PEOPLE") or (cfg.raw or {}).get("oversight_people")
    return Path(os.path.expanduser(str(v))).resolve() if v and str(v).strip() else None


def load_file(path: str | Path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise PeopleError(f"The people file cannot be read: {exc}") from None
    if data.get("v") != 1 or not isinstance(data.get("people"), list):
        raise PeopleError("The people file is not version 1.")
    for p in data["people"]:
        bad = [r for r in p.get("roles", []) if r not in ROLES]
        if bad or not p.get("id"):
            raise PeopleError(f"A person needs an id and roles from {', '.join(ROLES)}.")
    return data


def load_people(cfg) -> dict | None:
    """The people file of the configuration, or None where the key is not set (so that no write is allowed)."""
    p = people_path(cfg)
    return load_file(p) if p else None


def actor(cfg) -> str | None:
    v = os.environ.get("RANVIERA_ACTOR") or (cfg.raw or {}).get("oversight_actor")
    return str(v).strip() if v and str(v).strip() else None


def find(people: dict | None, person: str | None) -> dict | None:
    if not people:
        return None
    for p in people["people"]:
        if _same(p["id"], person):
            return p
    return None


def can(people, person: str | None, action: str, record: dict | None = None) -> tuple[bool, str]:
    """Whether the person may take the action on the record. `people` is the loaded file, a path to it, or None. The
    record is the mapping or the instruction version, and its `maker` is compared with the person."""
    if isinstance(people, (str, os.PathLike)):
        people = load_file(people)
    if action not in RULES:
        return False, f"The action '{action}' is not one that the people file governs."
    if people is None:
        return False, "No people file is configured, so no write is allowed."
    if not person or not str(person).strip():
        return False, f"The action '{action}' needs the person who acts."
    who = find(people, person)
    if who is None:
        return False, f"{person.strip()} is not in the people file, so the action '{action}' is refused."
    role, differ = RULES[action]
    if role not in who.get("roles", []):
        return False, f"The action '{action}' needs the role {role}, which {who['id']} does not hold."
    if differ and record is not None and _same(person, record.get("maker")):
        return False, (f"{who['id']} made this record, and the action '{action}' needs a person other than the maker.")
    return True, f"{who['id']} may take the action '{action}'."
