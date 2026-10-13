"""The rule ledger: the identifier of every rule ever seen, kept stable across edits.

The file is ledger/rules.json in the profile folder. On each build every rule text is matched to the ledger, first by its exact
fingerprint and then by a difflib similarity of 0.8 or more against an active rule of the same file key that no
earlier text in this build has matched. A rule with no match in a seen file is retired, and its identifier is never
reused. The format is set out in docs/ONTOLOGY.md, in the section on the rule ledger.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import os
from pathlib import Path

from . import md, privacy

from .fileio import write_atomic  # noqa: F401  (kept here for the callers that import it from the ledger)

SIMILARITY = 0.8


def stored_text(text: str) -> str:
    """The text the committed ledger keeps: normalised, with personal and client figures replaced by placeholders
    (cortex_kg.privacy). The fingerprint is a sha1 of the full normalised text and cannot be read back."""
    return md.normalise(privacy.redact(text)[0])


def fingerprint(text: str) -> str:
    return hashlib.sha1(md.normalise(text).encode("utf-8")).hexdigest()


def file_key_of(rule_id: str) -> str:
    """The file key inside an identifier such as rule:decks-common-031."""
    return rule_id.split(":", 1)[1].rsplit("-", 1)[0]


class Ledger:
    def __init__(self, rules: dict | None = None, next_numbers: dict | None = None):
        self.rules: dict[str, dict] = rules or {}
        self.next: dict[str, int] = next_numbers or {}
        self._matched: set[str] = set()
        self._added: list[str] = []
        self._changed: list[str] = []

    @classmethod
    def load(cls, path: str | os.PathLike) -> "Ledger":
        p = Path(path)
        if not p.is_file():
            return cls()
        data = json.loads(p.read_text(encoding="utf-8"))
        return cls(data.get("rules", {}), data.get("next", {}))

    def save(self, path: str | os.PathLike) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        for r in self.rules.values():
            r["text"] = privacy.redact(r.get("text", ""))[0]
        data = {"v": 1, "rules": self.rules, "next": self.next}
        write_atomic(p, json.dumps(data, indent=1, ensure_ascii=False) + "\n")

    def _active(self, file_key: str):
        for rid, r in self.rules.items():
            if r["status"] == "active" and rid not in self._matched and file_key_of(rid) == file_key:
                yield rid, r

    def assign(self, file_key: str, rel_file: str, text: str, today: str) -> str:
        """Return the identifier for a rule text, matching an existing rule where one fits."""
        norm = stored_text(text)
        fp = hashlib.sha1(md.normalise(text).encode("utf-8")).hexdigest()
        candidates = list(self._active(file_key))
        for rid, r in candidates:
            if r["fingerprint"] == fp:
                self._matched.add(rid)
                r["last_seen"] = today
                r["file"] = rel_file
                r["text"] = norm
                return rid
        best_id, best_ratio = None, 0.0
        for rid, r in candidates:
            sm = difflib.SequenceMatcher(None, norm, r["text"], autojunk=False)
            if sm.real_quick_ratio() < SIMILARITY or sm.quick_ratio() < SIMILARITY:
                continue
            ratio = sm.ratio()
            if ratio >= SIMILARITY and ratio > best_ratio:
                best_id, best_ratio = rid, ratio
        if best_id is not None:
            r = self.rules[best_id]
            r.update({"file": rel_file, "fingerprint": fp, "text": norm, "last_seen": today})
            self._matched.add(best_id)
            self._changed.append(best_id)
            return best_id
        n = self.next.get(file_key, 1)
        rid = f"rule:{file_key}-{n:03d}"
        while rid in self.rules:
            n += 1
            rid = f"rule:{file_key}-{n:03d}"
        self.next[file_key] = n + 1
        self.rules[rid] = {"file": rel_file, "fingerprint": fp, "text": norm, "first_seen": today,
                           "last_seen": today, "status": "active", "retired": None}
        self._matched.add(rid)
        self._added.append(rid)
        return rid

    def finish(self, today: str, seen_file_keys) -> dict:
        """Retire the active rules of the seen file keys that nothing matched, and report the build."""
        seen = set(seen_file_keys)
        retired: list[str] = []
        for rid, r in self.rules.items():
            if r["status"] == "active" and rid not in self._matched and file_key_of(rid) in seen:
                r["status"] = "retired"
                r["retired"] = today
                retired.append(rid)
        result = {"added": self._added, "changed": self._changed, "retired": retired}
        self._matched, self._added, self._changed = set(), [], []
        return result


class ItemLedger:
    """The identifiers of the open items in the backlog, kept stable across edits, as the rule ledger does for rules.

    An identifier is the section key and the first 8 characters of the sha1 of the item's normalised text without its
    checkbox, so that the same item has the same identifier on every machine and in any position. A ledger keeps that
    identifier when the item is edited: an exact fingerprint match comes first, ticking '[ ]' to '[x]' does not change
    the fingerprint, and a similarity of 0.8 or more against an unmatched item of the same section follows. An item
    that nothing matches is retired and its identifier is never given to a different item.

    The file is written to the data folder and not to the repository, because the text of a backlog item may be
    client-confidential. It holds the redacted normalised text, as the rule ledger does.
    """

    def __init__(self, items: dict | None = None):
        self.items: dict[str, dict] = items or {}
        self._matched: set[str] = set()

    @classmethod
    def load(cls, path: str | os.PathLike) -> "ItemLedger":
        p = Path(path)
        if not p.is_file():
            return cls()
        try:
            return cls(json.loads(p.read_text(encoding="utf-8")).get("items", {}))
        except (OSError, ValueError):
            return cls()

    def save(self, path: str | os.PathLike) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        write_atomic(p, json.dumps({"v": 1, "items": self.items}, indent=1, ensure_ascii=False) + "\n")

    def assign(self, section_key: str, text: str, today: str) -> str:
        """The identifier (without the openitem: prefix) for an item text, matching an existing item where one fits."""
        fp = hashlib.sha1(md.normalise(text).encode("utf-8")).hexdigest()
        norm = stored_text(text)
        for iid, r in self.items.items():
            if r["fingerprint"] == fp and iid not in self._matched:
                return self._take(iid, section_key, fp, norm, today)
        best, best_ratio = None, 0.0
        for iid, r in self.items.items():
            if iid in self._matched or r["status"] != "active" or r["section"] != section_key:
                continue
            sm = difflib.SequenceMatcher(None, norm, r["text"], autojunk=False)
            if sm.real_quick_ratio() < SIMILARITY or sm.quick_ratio() < SIMILARITY:
                continue
            ratio = sm.ratio()
            if ratio >= SIMILARITY and ratio > best_ratio:
                best, best_ratio = iid, ratio
        if best is not None:
            return self._take(best, section_key, fp, norm, today)
        iid, n = f"{section_key}-{fp[:8]}", 1
        while iid in self.items:      # the same text twice in a section, or an identifier that was retired
            n += 1
            iid = f"{section_key}-{fp[:8]}-{n}"
        self.items[iid] = {"section": section_key, "fingerprint": fp, "text": norm, "first_seen": today,
                           "last_seen": today, "status": "active", "retired": None}
        self._matched.add(iid)
        return iid

    def _take(self, iid: str, section_key: str, fp: str, norm: str, today: str) -> str:
        r = self.items[iid]
        r.update({"section": section_key, "fingerprint": fp, "text": norm, "last_seen": today, "status": "active",
                  "retired": None})
        self._matched.add(iid)
        return iid

    def finish(self, today: str) -> list[str]:
        """Retire the active items that nothing matched, and return their identifiers."""
        gone = [iid for iid, r in self.items.items() if r["status"] == "active" and iid not in self._matched]
        for iid in gone:
            self.items[iid]["status"] = "retired"
            self.items[iid]["retired"] = today
        self._matched = set()
        return gone
