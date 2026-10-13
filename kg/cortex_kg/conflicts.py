"""Candidate conflicts between written instructions, found by deterministic signals (7 October 2026).

The scan reads the instruction files of a set-up (every CLAUDE.md, .claude/rules/*.md and the bodies of .claude/agents/*.md),
splits them into rules and compares each pair of rules. Three signals give a candidate:

- polarity: one rule bans a specific term that the other requires, such as a code span or a rare word
- numeric: both rules set a different number for the same setting, such as retries=3 and retries=5
- exclusive: the rules choose different members of a set of exclusive choices, such as British and American spelling

A candidate is suppressed where either rule states an exception or a precedence, or where the two rules name different
folders. The scan gives the same list on every run, because it uses no model and no randomness. A candidate is a proposal
for a person to ratify or reject (docs/CONTRACTS.md, "Assertion statuses"), and only a ratified conflict reaches rule R04
or O03.
"""
from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

STOP = set("""a an the and or but if then else of to in on at by for with from into onto as is are be been being was were it its
this that these those each every any all some no not never do does did don't doesn't must should may might will would can could
shall use used using uses always only also than so such per via one two three when where which who whom whose what how why our
your their them they we you he she his her him us me my mine own same other another more most less least very just about over
under above below up down out new before after while until once both either neither nor make makes made keep keeps kept put puts
add adds added write writes written run runs ran set sets get gets let lets need needs file files code rule rules see note
instead rather like ever still yet here there""".split())

# words that mark a ban, and the clause that follows them holds the banned terms
NEG = re.compile(r"\b(?:never|do not|don't|does not|must not|should not|may not|cannot|can't|no longer|avoid|forbid(?:den)?|"
                 r"ban(?:s|ned)?|not allowed|prohibit(?:ed)?|keep [\w`.-]+ out|is not|are not|none)\b", re.I)
LEAD_VERB = re.compile(r"\s*(?:use|write|add|call|commit|run|create|make|put|send|include|introduce|chase|regenerate)\b", re.I)
# words that state an exception or a precedence, which suppress a candidate
EXCEPT = re.compile(r"\b(?:except|unless|other than|exception|relax(?:es)?|overrides?|takes? precedence|in place of the|"
                    r"only (?:for|in|when|if|to)|for \S+ files only|apart from|excluding)\b", re.I)
PATH = re.compile(r"`?((?:[\w.-]+/)+)`?")
CODE = re.compile(r"`([^`]+)`")
NUM_SETTING = re.compile(r"([A-Za-z_][\w.]*)\s*=\s*(\d+(?:\.\d+)?)")
NUM_UNIT = re.compile(r"(\d+(?:\.\d+)?)\s*(%|per cent|percent|[A-Za-z]+)")
NUM_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
             "twelve": 12, "fifteen": 15, "twenty": 20, "thirty": 30, "fifty": 50, "hundred": 100}
UNIT_ALIASES = {"percent": "%", "per cent": "%", "chars": "characters", "character": "characters", "word": "words",
                "line": "lines", "minute": "minutes", "second": "seconds", "hour": "hours", "day": "days", "kb": "kb", "mb": "mb"}
UNITS = {"%", "characters", "words", "lines", "minutes", "seconds", "hours", "days", "kb", "mb", "retries", "attempts",
         "reviewers", "approvals", "pages", "sentences", "items", "tests", "columns", "spaces", "times", "weeks", "months",
         "points", "slides", "bullets", "paragraphs", "commits", "files", "rows"}

# sets of exclusive choices: a rule that requires one member and a rule that requires another member of the same set conflict
# where they share a topic. The sets are general choices of tooling and style, and a set-up may add its own.
EXCLUSIVE: list[set[str]] = [
    {"british", "american"}, {"uk english", "us english"}, {"tabs", "spaces"}, {"pandas", "polars"},
    {"npm", "yarn", "pnpm", "bun"}, {"jest", "vitest", "mocha"}, {"pytest", "unittest"}, {"squash", "rebase", "merge commit"},
    {"single quotes", "double quotes"}, {"camelcase", "snake_case", "kebab-case", "pascalcase"}, {"rest", "graphql"},
    {"postgres", "postgresql", "mysql", "sqlite"}, {"redux", "zustand", "mobx"}, {"tailwind", "css modules", "styled-components"},
    {"metric", "imperial"}, {"active voice", "passive voice"}, {"first person", "third person"}, {"formal", "informal"},
    {"utc", "local time"}, {"json", "yaml", "toml"}, {"black", "ruff format"}, {"poetry", "uv", "pipenv"},
    {"dd/mm/yyyy", "mm/dd/yyyy", "yyyy-mm-dd"}, {"oxford comma", "no oxford comma"}, {"monorepo", "polyrepo"},
    {"docker", "podman"}, {"terraform", "pulumi", "cloudformation"}, {"github actions", "jenkins", "gitlab ci"},
    {"sentence case", "title case"}, {"numbered", "bulleted"}, {"pdf", "docx"}, {"gbp", "usd", "eur"},
]


@dataclass
class RuleLine:
    file: str
    line: int
    text: str
    scope: str              # the folder of a nested CLAUDE.md, "agent:<name>" for an agent body, or "" for the whole set-up
    paths: list[str] = field(default_factory=list)
    neg: set[str] = field(default_factory=set)
    pos: set[str] = field(default_factory=set)
    nums: list[tuple[str, float, str]] = field(default_factory=list)   # (key, value, bound) with bound max, min or eq
    choices: set[str] = field(default_factory=set)
    exception: bool = False


@dataclass
class Candidate:
    a: dict
    b: dict
    signal: str
    basis: str
    score: float


def _stem(w: str) -> str:
    w = w.lower().strip("`'\".,:;()[]")
    for suf, keep in (("ies", "y"), ("es", ""), ("s", ""), ("ing", ""), ("ed", "")):
        if len(w) > 5 and w.endswith(suf):
            return w[: -len(suf)] + keep
    return w


def _terms(text: str) -> set[str]:
    spans = CODE.findall(text)
    out = {c.strip().lower() for c in spans}
    # the words of a code span count as well, so that `export default X` meets "default exports"
    plain = CODE.sub(" ", text) + " " + " ".join(re.sub(r"[^A-Za-z]+", " ", c) for c in spans)
    for w in re.findall(r"[A-Za-z][\w.+-]*", plain):
        s = _stem(w)
        if len(s) >= 3 and s not in STOP:
            out.add(s)
    return out


def _numbers(text: str) -> list[tuple[str, float, str]]:
    out: list[tuple[str, float, str]] = []
    low = text.lower()
    for k, v in NUM_SETTING.findall(text):
        out.append((k.lower(), float(v), "eq"))
    t = low
    for word, n in NUM_WORDS.items():
        t = re.sub(rf"\b{word}\b", str(n), t)
    for m in NUM_UNIT.finditer(t):
        v, unit = float(m.group(1)), m.group(2).lower()
        unit = UNIT_ALIASES.get(unit, unit)
        if unit not in UNITS:
            continue
        before = t[max(0, m.start() - 30): m.start()]
        bound = ("max" if re.search(r"(under|below|at most|no more than|fewer than|less than|maximum|max|up to|within|cap)\s*$", before)
                 else "min" if re.search(r"(over|above|at least|no fewer than|more than|minimum|min)\s*$", before) else "eq")
        out.append((unit, v, bound))
    return out


def _choices(text: str) -> set[str]:
    low = " " + re.sub(r"[`*_]", "", text.lower()) + " "
    found = set()
    for group in EXCLUSIVE:
        for c in group:
            if re.search(rf"(?<![\w-]){re.escape(c)}(?![\w-])", low):
                found.add(c)
    return found


def _polarity(text: str) -> tuple[set[str], set[str]]:
    """The terms that a rule bans and the terms it requires. A ban covers the clause after a ban word up to the next
    full stop or 'and use'."""
    neg: set[str] = set()
    pos: set[str] = set()
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        m = NEG.search(sentence)
        if not m:
            pos |= _terms(sentence)
            continue
        pos |= _terms(sentence[: m.start()])
        if m.group(0).lower().startswith("keep "):          # "keep pandas out" bans pandas
            neg |= _terms(m.group(0)[5:-4])
        rest = sentence[m.end():]
        # the verb right after a ban word belongs to the ban ("do not use X"), so the end of the ban is searched after it
        lead = LEAD_VERB.match(rest)
        off = lead.end() if lead else 0
        cut = re.search(r"\b(?:use|instead|prefer|but)\b", rest[off:], re.I)
        end = off + cut.start() if cut else len(rest)
        neg |= _terms(rest[:end])
        pos |= _terms(rest[end:])
    return neg, pos - neg


def _frontmatter_end(lines: list[str]) -> int:
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                return i + 1
    return 0


def read_rules(root: Path) -> list[RuleLine]:
    """Every rule line of the set-up at root, in file order."""
    root = Path(root)
    files: list[tuple[Path, str]] = []
    for p in sorted(root.rglob("CLAUDE.md")):
        rel = p.relative_to(root).as_posix()
        scope = "" if rel == "CLAUDE.md" else rel[: -len("CLAUDE.md")]
        files.append((p, scope))
    for p in sorted((root / ".claude" / "rules").glob("*.md")) if (root / ".claude" / "rules").is_dir() else []:
        files.append((p, ""))
    for p in sorted((root / ".claude" / "agents").glob("*.md")) if (root / ".claude" / "agents").is_dir() else []:
        files.append((p, f"agent:{p.stem}"))
    out: list[RuleLine] = []
    for p, scope in files:
        try:
            lines = p.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        start = _frontmatter_end(lines)
        in_code = False
        for i, raw in enumerate(lines[start:], start=start + 1):
            s = raw.strip()
            if s.startswith("```"):
                in_code = not in_code
                continue
            if in_code or not s or s.startswith("#") or s.startswith("|") or s.startswith(">"):
                continue
            text = re.sub(r"^(?:[-*+]|\d+[.)])\s+", "", s)
            if len(text.split()) < 4:
                continue
            neg, pos = _polarity(text)
            out.append(RuleLine(file=p.relative_to(root).as_posix(), line=i, text=text, scope=scope,
                                paths=sorted({m.rstrip("/") for m in PATH.findall(text) if "/" in m}),
                                neg=neg, pos=pos, nums=_numbers(text), choices=_choices(text),
                                exception=bool(EXCEPT.search(text))))
    return out


def _df(rules: list[RuleLine]) -> dict[str, int]:
    df: dict[str, int] = {}
    for r in rules:
        for t in r.neg | r.pos:
            df[t] = df.get(t, 0) + 1
    return df


def _codeish(t: str) -> bool:
    return " " in t or "." in t or "_" in t or "=" in t or "/" in t or "(" in t


def _specific(t: str, df: dict[str, int], n: int) -> bool:
    """A term specific enough to carry a conflict: a code span, or a word found in few rules of the set-up."""
    return (" " in t or "." in t or "_" in t or "=" in t or "/" in t) or df.get(t, 0) <= max(2, n // 25)


def _scoped_apart(a: RuleLine, b: RuleLine) -> bool:
    """The two rules name different folders, so each applies to a different part of the set-up."""
    pa, pb = set(a.paths), set(b.paths)
    if a.scope and not a.scope.startswith("agent:"):
        pa.add(a.scope.rstrip("/"))
    if b.scope and not b.scope.startswith("agent:"):
        pb.add(b.scope.rstrip("/"))
    return bool(pa and pb and not (pa & pb) and not any(x.startswith(y) or y.startswith(x) for x in pa for y in pb))


def _ref(r: RuleLine) -> dict:
    return {"file": r.file, "line": r.line, "text": r.text}


def scan(root: Path) -> list[Candidate]:
    rules = read_rules(root)
    df = _df(rules)
    n = len(rules)
    out: list[Candidate] = []
    for i, a in enumerate(rules):
        for b in rules[i + 1:]:
            if a.file == b.file and abs(a.line - b.line) <= 1:
                continue
            if a.exception or b.exception or _scoped_apart(a, b):
                continue
            shared = {t for t in (a.neg | a.pos) & (b.neg | b.pos) if _specific(t, df, n)}
            # polarity: a specific term banned by one rule and required by the other
            # a path names where a rule applies, which is its scope and not its object, so it never carries a clash
            raw = {t for t in (a.neg & b.pos) | (b.neg & a.pos) if "/" not in t}
            clash = {t for t in raw if _specific(t, df, n)}
            # a clash on one plain word is too weak, so it needs a code span or 2 more shared specific terms as its topic
            strong = {t for t in clash if _codeish(t)}
            pair_clash = len(raw) >= 2 and min(df.get(t, 0) for t in raw) <= 4
            if (clash and (strong or len(clash) >= 2 or len(shared - clash) >= 3)) or pair_clash:
                clash = clash or raw
                out.append(Candidate(_ref(a), _ref(b), "polarity", ", ".join(sorted(clash)), 1.0 + 0.1 * len(clash)))
                continue
            # numeric: the same setting or unit with values that cannot both hold
            hit = None
            for ka, va, ba in a.nums:
                for kb, vb, bb in b.nums:
                    if ka != kb or va == vb:
                        continue
                    topic = shared - {ka}
                    if "=" in ka or "_" in ka or ka.isidentifier() and ka not in UNITS:
                        hit = (ka, va, vb)
                    elif topic and not (ba == bb == "max" or ba == bb == "min") or (ba, bb) in (("max", "min"), ("min", "max"), ("eq", "eq")) and topic:
                        hit = (ka, va, vb)
                    elif ba != bb and {ba, bb} == {"max", "min"} and ((ba == "max" and va < vb) or (bb == "max" and vb < va)):
                        hit = (ka, va, vb)
                    if hit:
                        break
                if hit:
                    break
            if hit:
                out.append(Candidate(_ref(a), _ref(b), "numeric", f"{hit[0]}: {hit[1]:g} against {hit[2]:g}", 0.9))
                continue
            # exclusive: different members of one set of exclusive choices, each required by its rule
            for group in EXCLUSIVE:
                # a choice named inside a ban is not chosen ("keep pandas out")
                ca = {c for c in a.choices & group if not any(c in t or t in c for t in a.neg)}
                cb = {c for c in b.choices & group if not any(c in t or t in c for t in b.neg)}
                if len(ca) == 1 and len(cb) == 1 and ca != cb:
                    ta, tb = next(iter(ca)), next(iter(cb))
                    if shared or group & {"british", "american", "uk english", "us english", "tabs", "spaces"}:
                        out.append(Candidate(_ref(a), _ref(b), "exclusive", f"{ta} against {tb}", 0.8))
                        break
    out.sort(key=lambda c: (-c.score, c.a["file"], c.a["line"], c.b["file"], c.b["line"]))
    return out


def main(argv: list[str] | None = None) -> int:
    """conflicts scan ROOT [--json]: print the candidate conflicts of the set-up at ROOT."""
    argv = list(argv or [])
    if argv[:1] == ["conflicts"]:
        argv = argv[1:]
    ap = argparse.ArgumentParser(prog="conflicts")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan")
    s.add_argument("root")
    s.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    found = scan(Path(args.root))
    if args.json:
        print(json.dumps([asdict(c) for c in found], ensure_ascii=False, indent=1))
    else:
        for c in found:
            print(f"{c.signal}: {c.a['file']}:{c.a['line']} and {c.b['file']}:{c.b['line']} ({c.basis})")
        print(f"{len(found)} candidate conflict{'s' if len(found) != 1 else ''}. Each is a proposal for a person to ratify or reject.")
    return 0
