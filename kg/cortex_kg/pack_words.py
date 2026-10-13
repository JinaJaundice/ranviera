"""Words for the readable evidence pack: names in place of identifiers, dates in the form 12 August 2026, and the facts of a
proof in sentences. The data file pack.json keeps the identifiers. Only the document uses these helpers.
"""
from __future__ import annotations

import re
from datetime import datetime

MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
          "December"]

CHECK_TITLE = {
    "O01": "Obligation with no ratified chain to an instruction",
    "O02": "Instruction with no ratified policy clause",
    "O03": "Conflicting instructions",
    "O04": "Decision with no cited instruction",
    "O05": "Ratified mapping that is out of date",
    "O06": "Fault in the approval of an instruction",
    "O07": "Instruction used outside its dates",
    "O08": "Typology that no instruction detects",
    "O09": "Loaded instruction differs from the approved text",
    "O10": "Run that cannot be replayed",
    "O11": "Incomplete run record",
    "O12": "Model version that is not approved",
    "O13": "Measure outside the bound of the bank",
    "O14": "Retrieved item with no verified source",
}
SEVERITY = {"violation": "Violation", "warning": "Warning", "info": "Note"}
RELATION = {
    "implementsClause": "implements the clause", "realises": "realises the control", "satisfies": "satisfies the obligation",
    "expressedIn": "is expressed in the provision", "notDischargedBy": "is not discharged by", "detects": "detects the typology",
    "appliesTo": "applies to", "operatesUnder": "operates under", "approvedBy": "was approved by", "proposedBy": "was made by",
    "conflictsWith": "conflicts with", "drawsOn": "draws on",
}
OUTCOME = {"close": "Closed", "escalate": "Escalated", "request-information": "Information requested"}
DRIFT_KIND = {"instruction": "Instructions", "model": "Model version", "snapshot": "Retrieval data", "override": "Override rate"}
STEP_KIND = {"start": "Start of the run", "evidence": "Evidence read", "retrieval": "Retrieval of records",
             "rationale": "Rationale written", "decision": "Decision", "review": "Human review", "end": "End of the run"}

ID_RE = re.compile(r"\b(?:instr|model|dagent|run|adec|map|obligation|clause|control|typology|provision|person|evid|step):"
                   r"[A-Za-z0-9._#-]*[A-Za-z0-9]")


def long_date(iso) -> str:
    """12 August 2026 from a date or a timestamp, or the text itself where it cannot be read."""
    if not iso:
        return "not recorded"
    s = str(iso)
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00")) if len(s) > 10 else datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        return s
    return f"{d.day} {MONTHS[d.month - 1]} {d.year}"


def long_time(iso) -> str:
    """12 August 2026 at 09:41 (UTC)."""
    if not iso:
        return "not recorded"
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return str(iso)
    return f"{d.day} {MONTHS[d.month - 1]} {d.year} at {d.hour:02d}:{d.minute:02d} (UTC)"


def model_name(label: str) -> str:
    """Triage model, version 2 (September 2026) from ngt-triage-2-2026-09."""
    bare = re.sub(r"^model:", "", label)
    m = re.fullmatch(r"[a-z]+-([a-z]+)-(\d+)-(\d{4})-(\d{2})", bare)
    if m and 1 <= int(m.group(4)) <= 12:
        return f"{m.group(1).capitalize()} model, version {m.group(2)} ({MONTHS[int(m.group(4)) - 1]} {m.group(3)})"
    return bare.replace("-", " ").replace("_", " ").capitalize()


def evidence_name(label: str) -> str:
    m = re.fullmatch(r"(alert|customer|payment|watchlist-entry)-(.+)", label or "")
    word = {"alert": "Alert", "customer": "Customer record", "payment": "Payment", "watchlist-entry": "Watchlist entry"}
    return f"{word[m.group(1)]} {m.group(2)}" if m else (label or "")


def agent_name(label: str) -> str:
    s = re.sub(r"^dagent:", "", label or "").replace("-", " ").replace("_", " ").strip()
    return s.capitalize() if s else label


def tool_name(tool: str) -> str:
    """Read the alert queue from alert-queue-read."""
    m = re.fullmatch(r"(.+)-(read|lookup)", tool or "")
    words = (m.group(1) if m else tool or "").replace("-", " ").replace("_", " ")
    if m:
        return f"{'Read' if m.group(2) == 'read' else 'Look up'} the {words}"
    return words.capitalize()


class Namer:
    """Turns identifiers into names, from the labels of the graph and the people file."""

    def __init__(self, names: dict[str, str]):
        self.names = names

    def __call__(self, ident) -> str:
        if ident is None or ident == "":
            return "none"
        s = str(ident)
        if s in self.names:
            return self.names[s]
        if s.startswith("model:"):
            return model_name(s)
        if s.startswith("dagent:"):
            return agent_name(s)
        if s.startswith("person:"):
            return self(s[7:])
        if s in ("ranviera-matcher",):
            return "The automatic matching tool"
        return s

    def text(self, text) -> str:
        """A sentence with every identifier and every model code in it replaced by a name."""
        s = ID_RE.sub(lambda m: self(m.group(0)), str(text or ""))
        s = re.sub(r"\b[a-z]+-[a-z]+-\d+-\d{4}-\d{2}\b", lambda m: model_name(m.group(0)), s)
        return s[:1].upper() + s[1:]


_FACT = re.compile(r"^(not\s+)?([a-z_]+)\((.*)\)$", re.S)
_ARG = re.compile(r'"((?:[^"\\]|\\.)*)"|([^,\s][^,]*)')


def _args(s: str) -> list[str]:
    return [(a or b).strip() for a, b in _ARG.findall(s)]


def fact_words(fact: str, nm: Namer) -> str:
    """One fact of a proof in a sentence."""
    m = _FACT.match((fact or "").strip())
    if not m:
        return nm.text(fact)
    neg, pred, raw = m.group(1), m.group(2), _args(m.group(3))
    a = [nm(x) if ID_RE.fullmatch(x) else x for x in raw]
    if pred == "edge" and len(a) == 3:
        body = f"{a[0]} {RELATION.get(raw[1], raw[1])} {a[2]}"
    elif pred == "node" and len(a) == 2:
        body = f"{a[0]} is a record of the kind {a[1]}"
    elif pred == "status" and len(a) == 2:
        body = f"{a[0]} has the status {a[1]}"
    elif pred in ("valid_from", "today") and a:
        digits = a[-1]
        iso = f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}" if re.fullmatch(r"\d{8}", digits) else digits
        body = f"{a[0]} is valid from {long_date(iso)}" if pred == "valid_from" and len(a) == 2 else f"The date of the check is {long_date(iso)}"
    elif pred in ("violation", "warning", "info") and len(a) >= 2:
        body = f"{CHECK_TITLE.get(raw[0], 'Finding')} concerns {a[1]}"
    else:
        body = f"{pred.replace('_', ' ')} {', '.join(a)}".strip()
    return f"No record shows that {body}" if neg else body[:1].upper() + body[1:]
