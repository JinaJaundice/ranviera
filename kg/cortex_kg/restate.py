"""Restatements computed from the text of the rules.

Each bullet in a rule file in ~/.claude/rules is written as the short form of a bullet in the full reference and guide
files of the skills. A rule-file bullet restates the part of a reference bullet that carries its words. The part is a
sentence, 2 neighbouring sentences or the whole bullet, and the pair is kept when all of these hold:

- at least MIN_CONTAINMENT of the rule-file bullet's content words appear in the part, and the word overlap of the 2
  (Jaccard) is at least MIN_JACCARD, so that a short bullet is not matched to a long compound bullet that merely
  contains its words;
- the 2 agree in negation and do not carry different strengths of obligation (must against may);
- the reference bullet does not carry a cue of exception or override (drop, except, replaced by, no longer) that the short
  bullet lacks, because that pair is a rule and its exception, which the rule engine derives as overrides;
- the best reference bullet beats the second best by at least MARGIN in containment or in overlap, so that a
  bullet that fits 2 references equally is left undecided.

A pair with a containment of at least PROPOSE_CONTAINMENT that fails a test is returned by proposed() and is not
applied. Dates in brackets do not count, because a rule and its restatement may record different dates.

These computed links replaced the links proposed by the discovery agents on 6 October 2026, after 113 of those 171
pairs were found to share almost no words, and were tightened the same day after a hand check of 15 pairs found 4
that were wrong or partial (docs/ONTOLOGY.md, rule R01).
"""
from __future__ import annotations

import re

from .model import Harvest

MIN_CONTAINMENT = 0.7
MIN_JACCARD = 0.3
PROPOSE_CONTAINMENT = 0.5
MARGIN = 0.1
_STOP = set(("a an the and or of to in on for with by as is are be it its that this at from not no only one each every "
             "any all so than then when where which who will may must should do does done use used into over under per "
             "can").split())
_NEGATION = re.compile(r"\b(?:never|not|no|cannot|without|nor|don't|doesn't|isn't)\b", re.I)
_EXCEPTION = re.compile(r"\b(?:except|exception|unless|instead of|replaced by|no longer|drops?|dropped|superseded|"
                        r"overrides?)\b", re.I)
_SENTENCES = re.compile(r"(?<=[.!?;])\s+")
_STRONG = {"must", "should", "may", "will"}


def words(text: str) -> set[str]:
    text = re.sub(r"\([^()]*\d{4}[^()]*\)", " ", text or "")
    return {w for w in re.findall(r"[a-z][a-z0-9-]{2,}", text.lower()) if w not in _STOP}


def _is_short(path: str) -> bool:
    p = path.replace("\\", "/")
    return "/.claude/rules/" in p or p.split("/")[-2:-1] == ["rules"]


def _is_full(path: str) -> bool:
    p = path.replace("\\", "/")
    return "/references/" in p or ("/skills/" in p and not p.endswith("/SKILL.md"))


def _windows(text: str) -> list[tuple[str, set[str]]]:
    """The sentences of a bullet, each pair of neighbouring sentences and the whole bullet, with their words."""
    text = re.sub(r"\([^()]*\d{4}[^()]*\)", " ", text or "")
    parts = [s for s in _SENTENCES.split(text) if s.strip()]
    out = list(parts)
    out += [parts[i] + " " + parts[i + 1] for i in range(len(parts) - 1)]
    if len(parts) > 1:
        out.append(" ".join(parts))
    return [(w, words(w)) for w in out]


def _cues(text: str) -> set[str]:
    return {m.group(0).lower()[:5] for m in _EXCEPTION.finditer(text)}


def _agree(short, full, window: str, text: str) -> bool:
    if bool(_NEGATION.search(text)) != bool(_NEGATION.search(window)):
        return False
    if _cues(str(full.props.get("text", ""))) - _cues(text):
        return False
    m1, m2 = short.props.get("modal"), full.props.get("modal")
    if m1 in _STRONG and m2 in _STRONG and m1 != m2:
        return False
    return True


def _candidates(h: Harvest):
    """(short rule, [(containment, jaccard, reference rule, agreed)] best first) for each rule-file rule."""
    rules = [n for n in h.nodes.values() if n.id.startswith("rule:") and n.path and n.status != "retired"]
    short = [n for n in rules if _is_short(n.path) and n.props.get("kind", "instruction") == "instruction"]
    full = [n for n in rules if _is_full(n.path) and n.status != "superseded"
            and n.props.get("kind", "instruction") == "instruction"]
    wins = {n.id: _windows(str(n.props.get("text", ""))) for n in full}
    for s in sorted(short, key=lambda n: n.id):
        text = str(s.props.get("text", ""))
        a = words(text)
        if len(a) < 3:
            continue
        scored = []
        for f in full:
            best = None
            for window, b in wins[f.id]:
                if not b:
                    continue
                common = len(a & b)
                c, j = common / len(a), common / len(a | b)
                if c < PROPOSE_CONTAINMENT:
                    continue
                if best is None or (c, j) > best[:2]:
                    best = (c, j, window)
            if best:
                scored.append((best[0], best[1], f, _agree(s, f, best[2], text)))
        scored.sort(key=lambda x: (-x[0], -x[1], x[2].id))
        yield s, scored


def _applies(top, second) -> bool:
    c, j, _f, agreed = top
    if not (agreed and c >= MIN_CONTAINMENT and j >= MIN_JACCARD):
        return False
    return second is None or c - second[0] >= MARGIN or j - second[1] >= MARGIN


def compute(h: Harvest) -> list[tuple[str, str, float]]:
    """(rule-file rule, reference rule, score) for each restatement found, in id order. The score is the containment."""
    out = []
    for s, scored in _candidates(h):
        if scored and _applies(scored[0], scored[1] if len(scored) > 1 else None):
            out.append((s.id, scored[0][2].id, round(scored[0][0], 2)))
    return out


def proposed(h: Harvest) -> list[tuple[str, str, float]]:
    """The best candidate of each rule-file rule that compute() does not apply, with its containment."""
    applied = {s for s, _t, _c in compute(h)}
    return [(s.id, scored[0][2].id, round(scored[0][0], 2)) for s, scored in _candidates(h)
            if scored and s.id not in applied]


def add_edges(h: Harvest) -> int:
    """Add a restates edge for each computed pair, with its score as evidence. Returns the number added. Where several
    rule-file rules restate the same reference rule the evidence says how many, so that a reader can see the fan-in."""
    pairs = compute(h)
    fan: dict[str, int] = {}
    for _s, t, _c in pairs:
        fan[t] = fan.get(t, 0) + 1
    for s, t, score in pairs:
        extra = f"; {fan[t]} rule-file rules restate it" if fan[t] > 1 else ""
        h.add_edge(s, "restates", t, f"computed: {score:.2f} of the rule's words appear in the reference rule{extra}")
    return len(pairs)
