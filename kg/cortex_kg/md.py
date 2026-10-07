"""Markdown parsing shared by the harvesters: frontmatter, headings, rule items, dates, modal verbs and cited paths.

The parsing is deliberately simple and fixed, so that 2 builds of the same files give the same graph.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}


@dataclass
class Heading:
    level: int
    text: str
    line: int          # 1-based


@dataclass
class Item:
    """A bullet or numbered item, with its wrapped continuation lines joined."""
    text: str
    line: int          # 1-based line of the item's first line
    indent: int
    numbered: bool
    heading: Heading | None   # the nearest heading above the item
    parent: int | None = None  # index in Doc.items of the item this one is nested under, or None at the top level


@dataclass
class Doc:
    frontmatter: dict
    body_start: int              # 1-based line where the body starts
    lines: list[str]
    headings: list[Heading] = field(default_factory=list)
    items: list[Item] = field(default_factory=list)


_FM_KEY = re.compile(r"^(\s*)([A-Za-z_][\w.-]*):\s*(.*)$")


def parse_frontmatter(lines: list[str]) -> tuple[dict, int]:
    """A YAML subset: 'key: value', nested 'key:' blocks by indentation, and '- item' lists.

    Returns the dict and the 0-based index of the first body line. Values keep their quotes stripped.
    """
    if not lines or lines[0].strip() != "---":
        return {}, 0
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return {}, 0
    root: dict = {}
    stack: list[tuple[int, dict]] = [(-1, root)]
    last_key: tuple[dict, str] | None = None
    for raw in lines[1:end]:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        stripped = raw.strip()
        if stripped.startswith("- ") and last_key is not None:
            container, key = last_key
            if not isinstance(container.get(key), list):
                container[key] = []
            container[key].append(_unquote(stripped[2:].strip()))
            continue
        m = _FM_KEY.match(raw)
        if not m:
            continue
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1] if stack else root
        key, value = m.group(2), m.group(3).strip()
        if value == "":
            parent[key] = {}
            stack.append((indent, parent[key]))
            last_key = (parent, key)
        else:
            parent[key] = _unquote(value)
            last_key = (parent, key)
    return root, end + 1


def _unquote(v: str) -> str:
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_BULLET = re.compile(r"^(\s*)([-*+])\s+(.+)$")
_NUMBERED = re.compile(r"^(\s*)(\d{1,3})[.)]\s+(.+)$")
_FENCE = re.compile(r"^\s*(```|~~~)")


def parse(text: str) -> Doc:
    lines = text.splitlines()
    fm, start = parse_frontmatter(lines)
    doc = Doc(frontmatter=fm, body_start=start + 1, lines=lines)
    heading: Heading | None = None
    in_fence = False
    current: Item | None = None
    stack: list[tuple[int, int]] = []   # (indent, index in doc.items) of the open enclosing items
    for i in range(start, len(lines)):
        raw = lines[i]
        if _FENCE.match(raw):
            in_fence = not in_fence
            current = None
            continue
        if in_fence:
            continue
        hm = _HEADING.match(raw)
        if hm:
            heading = Heading(len(hm.group(1)), hm.group(2).strip(), i + 1)
            doc.headings.append(heading)
            current = None
            stack = []
            continue
        bm = _BULLET.match(raw) or _NUMBERED.match(raw)
        if bm:
            indent = len(bm.group(1))
            while stack and stack[-1][0] >= indent:
                stack.pop()
            current = Item(text=bm.group(3).strip(), line=i + 1, indent=indent,
                           numbered=bool(_NUMBERED.match(raw)), heading=heading,
                           parent=stack[-1][1] if stack else None)
            doc.items.append(current)
            stack.append((indent, len(doc.items) - 1))
            continue
        if current is not None and raw.strip() and (len(raw) - len(raw.lstrip())) > current.indent \
                and not raw.lstrip().startswith("|"):
            current.text += " " + raw.strip()
            continue
        if not raw.strip():
            current = None
    return doc


def section_heading(item: Item, min_level: int = 2) -> Heading | None:
    """The heading that names the item's section (the nearest heading at or below level min_level)."""
    return item.heading if item.heading and item.heading.level >= min_level else item.heading


_D1 = re.compile(r"\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(20\d\d)\b", re.I)
_D2 = re.compile(r"\b(20\d\d)-(\d\d)-(\d\d)\b")


def dates_in(text: str) -> list[str]:
    """Every date in the text as YYYY-MM-DD, in order of appearance."""
    found: list[tuple[int, str]] = []
    for m in _D1.finditer(text):
        mon = MONTHS[m.group(2)[:3].lower()]
        try:
            found.append((m.start(), date(int(m.group(3)), mon, int(m.group(1))).isoformat()))
        except ValueError:
            pass
    for m in _D2.finditer(text):
        try:
            found.append((m.start(), date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()))
        except ValueError:
            pass
    return [d for _pos, d in sorted(found)]


def given_date(text: str) -> str | None:
    """The date a rule states it was given: the last date in brackets, else the last date in the text."""
    bracketed = re.findall(r"\(([^()]*\d{4}[^()]*)\)", text)
    for b in reversed(bracketed):
        ds = dates_in(b)
        if ds:
            return ds[-1]
    ds = dates_in(text)
    return ds[-1] if ds else None


_MODAL = re.compile(r"\b(must not|must|should not|should|may not|may|could|will not|will|we expect)\b", re.I)
_LABEL = re.compile(r"^\s*(?:\*\*([^*]{1,80})\*\*|__([^_]{1,80})__)\s*[:.\-]?\s*")
_PROHIBIT = re.compile(r"^(?:do not|don't|never|must not|should not|no|not)\b", re.I)
_CONDITION = re.compile(r"^(?:if|when|where|whenever|once|before|after|while|unless|for|in|on|at|during|until|"
                        r"as soon as)\b[^,]{0,140},\s+", re.I)
_DASH_PROHIBIT = re.compile(r"(?:[;:]|\s[-\u2013\u2014\ufffd]+)\s*(?:do not|don't|never)\b", re.I)
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z`*\"'(\[])")
# base-form verbs that open an instruction ("Use the template", "Check the page")
_VERBS = frozenset("""
accept add address agree align allow answer anchor apply archive ask assert assign attach author avoid back ban bear
begin bind bold break build call cap carry cast centre center change check choose cite clean clear close commit compare
compute confirm connect consult contain convert copy correct count cover create credit cut declare decide default
define delegate delete deliver derive describe design detect diff disable display document draw drive drop edit email
emphasise emphasize enable encode end ensure enter erase estimate evaluate exclude execute expand explain export extract favour favor
feed fetch file fill filter find finish fit fix flag follow force format frame gather generate get give go grade ground guarantee
group guard handle hand head hedge hold house identify ignore implement import include index inherit insert inspect
install invoke iterate join keep key kill label launch lay lead leave lean let lift limit link list load locate lock
log look lower maintain make map mark match measure meet merge mention mirror move name narrow need normalise note
number observe omit open order override own pair parse pass paste pick pin place plan plot point populate position
prefer prepare present press preserve prevent print probe process produce promote prompt propose protect provide
publish pull push put quantify quote raise rank rasterise prioritise minimise maximise standardise organise categorise finalise re-read read rebuild recheck reconcile record redact reduce re-verify reproduce
refer refresh refuse register reject relate release reload remember remove rename render reorder repeat replace
reply report represent request require rerun reserve reset resolve respect restart restate restore restrict retain
retire retry return reuse reverify review revise rewrite roll route run sanitise save scan score scroll search
section seed select send separate serve set settle shape share shorten ship simplify show sign size sketch skip sort source spell
splice split spread stage start state stay stick stop store strip structure submit suggest summarise supply support
suspect swap switch tag take target tell test think tick tie title trace track translate treat trim trust try turn
type understand unpack update upgrade upload use validate verify version view visit wait walk warn watch weigh wire
wrap write zip
""".split())


_SUBJECTS = frozenset("it they we he she this that these those there each every all any no both one the a an its "
                      "their our his her some most many few several claude cortex".split())


def split_label(text: str) -> tuple[str, str]:
    """(label, rest) of an item that opens with a bold label such as '**Language.** Every word ...'."""
    t = text.strip()
    m = _LABEL.match(t)
    if not m:
        return "", re.sub(r"^[`*_\[\]\"'(]+", "", t)
    label = (m.group(1) or m.group(2) or "").strip().rstrip(".:")
    rest = t[m.end():] or label
    return label, re.sub(r"^[`*_\[\]\"'(]+", "", rest)


def _first_clause(text: str) -> str:
    """The text after a leading condition ('Where a firm relies on a tool, it should ...' gives 'it should ...')."""
    m = _CONDITION.match(text)
    return text[m.end():] if m else text


def _head_modal(head: str, after_condition: bool = False) -> str | None:
    words = head.split(None, 1)
    first = words[0].strip(".,:;") if words else ""
    if _PROHIBIT.match(head) or first.lower() == "always":
        return "imperative"
    if first.lower() in _VERBS and (first[:1].isupper() or after_condition):
        return "imperative"
    # after a condition ('After a visual change, grid-scan the render') a lower-case word that is not a subject is a verb
    if after_condition and first and first[:1].islower() and first.lower() not in _SUBJECTS             and not first.lower().endswith(("s", "ed", "ing")):
        return "imperative"
    return None


def _heads(text: str) -> list[tuple[str, bool]]:
    """The candidate heads of an item: the bold label, then the opening of the rest with and without a leading
    condition. Each is paired with whether a condition was removed."""
    label, rest = split_label(text)
    out = []
    if label:
        out.append((label, False))
    out.append((rest, False))
    clause = _first_clause(rest)
    if clause is not rest:
        out.append((clause, True))
    return out


def is_prohibition(text: str) -> bool:
    """True where the item forbids something: a head opens with Do not, Never, No or must not, or the first modal is
    negative."""
    for head, _cond in _heads(text):
        if _PROHIBIT.match(head):
            return True
    first = next((h for h, _c in _heads(text) if _head_modal(h)), None)
    m = _MODAL.search(text)
    return bool(m and m.group(1).lower().endswith(" not") and first is None)


def modal_of(text: str) -> str:
    """The strength of an instruction, read from the head of the sentence first and then from its first modal verb.

    A leading Do not, Never, No or Always, or a leading base-form verb ('Use', 'Check'), is imperative whatever the
    rest of the sentence says, and so is a later sentence that opens that way when the first sentence has no modal
    verb. Otherwise the first of must, should, may, will or we expect gives the value, and an item with none of
    these is none.
    """
    for head, cond in _heads(text):
        found = _head_modal(head, cond)
        if found:
            return found
    m = _MODAL.search(text)
    if m:
        word = m.group(1).lower()
        if word.startswith("must"):
            return "must"
        if word.startswith("should") or word == "we expect":
            return "should"
        if word.startswith("may") or word == "could":
            return "may"
        if word.startswith("will"):
            return "will"
    _label, rest = split_label(text)
    if _DASH_PROHIBIT.search(rest):
        return "imperative"       # 'Each word maps to one meaning - do not rely on context'
    for sentence in _SENTENCE_END.split(rest)[1:]:
        if _head_modal(sentence.lstrip("`*_\"'([")) :
            return "imperative"
    for clause in re.split(r";\s+", rest)[1:]:     # 'Skills lines are ...; put a non-breaking space before each'
        first = clause.split(None, 1)[0].lower() if clause.split() else ""
        if first in _VERBS or _PROHIBIT.match(clause):
            return "imperative"
    return "none"


_NOTE_HEADING = re.compile(
    r"^(?:examples?\b|worked examples?\b|before and after|sources?\b|additional resources|canonical\b|"
    r"what is (?:not )?(?:installed|available)|gate commands|files\b|where things|role variants|rule categories|"
    r"machine-check backlog|what the .* found|when to use|the index\b|project root and paths|"
    r"glossary|definitions?\b|vocabulary\b)", re.I)
_BAN_HEADING = re.compile(r"\b(?:banned|never|forbidden|prohibited)\b", re.I)
_NOTE_FILES = ("before-after", "before_after", "/examples/")
_QUANTIFIER_HEAD = re.compile(r"^(?:every|each|all|any|only|one)\b", re.I)
_CODE = re.compile(r"`[^`\n]+`")
_LINK_ONLY = re.compile(r"^\[[^\]]+\]\([^)]+\)\W*$")


def classify(text: str, heading: str, path: str, parent_kind: str | None = None) -> tuple[str, str, bool]:
    """(modal, kind, negated) of one item.

    The kind is instruction or note. An instruction tells the reader what to do or not to do. An example, a
    definition, a list of paths, a link, a source or a violation shown in a worked example is a note, and so is an
    item nested under a note. The kind is a label on the rule and does not change its identifier.
    """
    modal = modal_of(text)
    negated = is_prohibition(text)
    p = path.replace("\\", "/").lower()
    if any(f in p for f in _NOTE_FILES) or _NOTE_HEADING.match(heading.strip()):
        return modal, "note", negated
    label, rest = split_label(text)
    if _LINK_ONLY.match(rest) or parent_kind == "note":
        return modal, "note", negated
    rest_plain = _CODE.sub("", rest)
    if _CODE.search(rest) and len(re.sub(r"[\W_]+|\band\b|\bor\b", "", rest_plain)) < 12:
        return modal, "note", negated       # a list of paths, commands or names
    if modal == "none" and _BAN_HEADING.search(heading):
        return "imperative", "instruction", True    # an item under a heading that bans things
    if modal != "none" or _QUANTIFIER_HEAD.match(rest) or _QUANTIFIER_HEAD.match(label):
        return modal, "instruction", negated
    return modal, "note", negated


# A cited path: a backticked token, or a bare token, that looks like a file or folder path.
_BACKTICK = re.compile(r"`([^`\n]{2,200})`")
_BARE = re.compile(r"(?<![\w/.])((?:~/\.claude|Projects|apps|build|deliverables|docs|inputs|_shared|skills|rules|"
                   r"references|tools|memory|agents)/[\w./{}*<>-]+)")
_LOOKS_LIKE_PATH = re.compile(r"^(~/|\.{0,2}/)?[\w.{}-]+(/[\w.{}*<>-]+)+/?$|^[\w-]+\.(md|py|mjs|js|ts|tsx|json|"
                              r"pptx|docx|xlsx|pdf|html|css|ps1|cmd|txt|csv|ttl)$")


@dataclass
class CitedPath:
    raw: str
    line: int
    acknowledged_missing: bool   # the text near it says [path not found ...]


def cited_paths(doc: Doc) -> list[CitedPath]:
    """Paths the text cites, with their line. Globs, URLs, placeholders and commands are skipped."""
    out: list[CitedPath] = []
    seen: set[tuple[str, int]] = set()
    for i, line in enumerate(doc.lines[doc.body_start - 1:], start=doc.body_start):
        ack = "path not found" in line.lower() or "[not found" in line.lower()
        cands = [m.group(1) for m in _BACKTICK.finditer(line)] + [m.group(1) for m in _BARE.finditer(line)]
        for c in cands:
            c = c.strip().rstrip(".,;:)")
            token = c.split()[0] if " " in c else c
            if (" " in c and not c.startswith(("python ", "node ", "npm "))) and not _LOOKS_LIKE_PATH.match(token):
                continue
            if c.startswith(("python ", "node ", "npm ")):
                parts = [p for p in c.split() if "/" in p or p.endswith((".py", ".mjs", ".js"))]
                if not parts:
                    continue
                token = parts[0]
            if any(ch in token for ch in "*{}<>") or token.startswith(("http", "#", "@")) or ":" in token[2:]:
                continue
            if not _LOOKS_LIKE_PATH.match(token):
                continue
            key = (token, i)
            if key in seen:
                continue
            seen.add(key)
            out.append(CitedPath(token, i, ack))
    return out


def wiki_links(text: str) -> list[str]:
    return re.findall(r"\[\[([^\]\n]+)\]\]", text)


_MD_MARKS = re.compile(r"[`*_>#\[\]]")


def normalise(text: str) -> str:
    """Rule text for fingerprints: lower case, markdown marks, bracketed dates and repeated spaces removed."""
    t = re.sub(r"\(([^()]*\d{4}[^()]*)\)", " ", text)
    t = _MD_MARKS.sub(" ", t.lower())
    return re.sub(r"\s+", " ", t).strip()


_CHECKBOX = re.compile(r"^\[([ xX])\]\s*")


def checkbox(text: str) -> tuple[str | None, str]:
    """('done', rest) for '[x] ...', ('open', rest) for '[ ] ...' and (None, text) for an item with no checkbox."""
    m = _CHECKBOX.match(text)
    if not m:
        return None, text
    return ("done" if m.group(1) in "xX" else "open"), text[m.end():]


_DATE_SPAN = re.compile(r"\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+20\d\d\b|"
                        r"\b20\d\d-\d\d-\d\d\b", re.I)
_DUE_CUE = re.compile(r"\b(?:by|before|due|deadline|until|no later than|on or before)\b[^.;:()\[\]\n]{0,24}$", re.I)


def due_date(text: str) -> str | None:
    """The date by which an item is to be done: the first date that follows 'by', 'before', 'due', 'deadline', 'until',
    'no later than' or 'on or before' within a few words. A date that only appears in the text (when something was
    written or shipped) is not a due date, and a date with no year is not read."""
    for m in _DATE_SPAN.finditer(text):
        if _DUE_CUE.search(text[max(0, m.start() - 40):m.start()]):
            ds = dates_in(m.group(0))
            if ds:
                return ds[0]
    return None


def evidence(cfg, path, line: int | None = 1) -> str:
    """The one evidence format: '<root>/<relative path>:<line>', where the root is memory (the memory folder), claude
    (the Claude folder) or projects (the Projects folder). A path outside all three is given in full. A file that has
    no lines of its own, such as a folder or a binary file, cites line 1."""
    from pathlib import Path
    p = Path(path)
    try:
        p = p.resolve()
    except OSError:
        pass
    for root, name in ((cfg.memory_dir, "memory"), (cfg.claude_home, "claude"), (cfg.projects_root, "projects")):
        try:
            rel = p.relative_to(Path(root).resolve())
        except ValueError:
            continue
        return f"{name}/{rel.as_posix()}:{line or 1}" if str(rel) != "." else f"{name}:{line or 1}"
    return f"{p.as_posix()}:{line or 1}"
