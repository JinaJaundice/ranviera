"""Placeholders for personal and client-confidential values in files that may be committed.

Committed files (the harness mirror and the rule ledger) must hold public and internal content only. Two kinds of
value are replaced by a stable placeholder, {{PRIVATE:<8 hex>}}, whose value is kept in the machine-local overlay
(<data_dir>/overlay/private_values.json):

- a personal email address or telephone number, anywhere
- a money figure on a line that discusses a client, a proposal, pricing, fees, rate cards or margins, or on one of the
  2 lines after a line that names a client
- a figure with a thousands comma (1,200) within 40 characters of a commercial word, replaced whole, and a bare
  figure of 2 or more digits within 30 characters of "day rate"
- a percentage on such a line when a commercial word (margin, rebate, discount, fee, price, rate) is within 40
  characters of it. A percentage in a house-style rule, such as a ratio of a box, stays as it is.

A client is any name in <data_dir>/overlay/private_terms.json, { "clients": [...], "projects": [...], "people": [...] }
(or the file that the configuration key private_terms names). The public default is no names, so a line is then
commercial only through the generic words below. The names are never held in this source.

House-style examples such as "write money as £94k" carry no client context and stay as they are.

The placeholder is the first 8 hex digits of an HMAC-SHA256 of the value. The key is 32 random bytes kept in
<data_dir>/overlay/privacy_key, created on first use and never committed, so the same value gives the same placeholder
on this machine, repeated exports give the same files, and nobody holding only the repository can recover a value by
hashing guesses. (Until 6 October 2026 the placeholder was the first 8 hex digits of an unsalted sha1, and 10 of 19
placeholders in the repository were recovered from a dictionary of simple forms. migrate() re-keys those.) A second
machine needs a copy of privacy_key together with private_values.json. On a machine whose overlay lacks a value, the
placeholder is shown as [withheld].
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from pathlib import Path

PERSONAL_EMAIL = re.compile(
    r"[A-Za-z0-9._%+\-]+@(?!(?:users\.noreply\.github\.com|noreply\.anthropic\.com|anthropic\.com|example\.(?:com|org))\b)"
    r"[A-Za-z0-9\-]+\.[A-Za-z.]+")
PERSONAL_PHONE = re.compile(
    r"\+\d{2}[ \d]{9,}\d"                                                           # international, as before
    r"|(?<![\w.\-])\(0\d{2,4}\)[ ]?\d{3,4}[ ]?\d{3,4}(?![\w\-]|\.\w)"                # (020) 7946 0958
    r"|(?<![\w.\-])0\d{2,4}[ ]\d{3,4}[ ]\d{3,4}(?![\w\-]|\.\w)"                      # 020 7946 0958, 01632 960 001
    r"|(?<![\w.\-])0\d{4}[ ]\d{6}(?![\w\-]|\.\w)"                                    # 07700 900123
    r"|(?<![\w.\-])0\d{10}(?![\w\-]|\.\w)")                                          # 07700900123

_CONTEXT_WORDS = (r"rate[- ]card|bundle|day rate|PSP|GCB\d|proposal|"
                  r"pric(?:e|es|ed|ing)|fees?|margin|investment case|budget")
COMMERCIAL_WORD = re.compile(
    r"\b(?:margins?|rebates?|discounts?|fees?|pric(?:e|es|ed|ing)|rate[- ]card|day rate|rates?|card|ceiling|uplift|mark-?up)\b", re.I)

_CUR = r"(?:£|\$|€|GBP\s?|USD\s?|EUR\s?)"
_NUM = r"\d+(?:,\d{3})*(?:\.\d+)?"
_SUF = r"(?:\s?(?:k|m|bn|million|billion|thousand)\b)?"
_AMOUNT = _NUM + _SUF
MONEY = re.compile(
    r"(?<![\w.])(?:" + _CUR + _AMOUNT + r"(?:\s?(?:to|-)\s?" + _CUR + r"?" + _AMOUNT + r")?"
    r"|" + _AMOUNT + r"\s(?:GBP|USD|EUR|pounds|dollars|euros)\b)", re.I)
MARGIN = re.compile(r"\b\d{1,2}(?:\.\d+)?(?:\s?(?:to|-)\s?\d{1,2}(?:\.\d+)?)?\s?(?:%|per\s?cent)", re.I)
NEAR = 40  # characters either side of a percentage in which a commercial word must appear

# A figure with a thousands comma (1,200 or £1,200k) near a commercial word is replaced whole, with or without a
# client name on the line. DAY_RATE marks a bare figure (850) within DAY_RATE_WINDOW characters of "day rate".
THOUSANDS = re.compile(r"(?<![\w.,{}:])(?:£|\$|€)?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:\s?(?:k|m|bn)\b)?(?![\w,]|\.\d)", re.I)
DAY_RATE = re.compile(r"\bday[- ]rates?\b", re.I)
DAY_RATE_WINDOW = 30
# A bare figure of 3 or more digits within CHARGE_WINDOW characters of a charging phrase is a commercial figure.
CHARGE_WORD = re.compile(r"\b(?:charg(?:e|es|ed|ing)|rate[- ]cards?|(?:per|a|each)\s(?:day|month|week|hour)|daily rate|monthly fee)\b", re.I)
CHARGE_WINDOW = 30
_CHARGE_FIGURE = re.compile(r"(?<![\w.,{}:])(?!(?:19|20)\d{2}\b)\d+(?:,\d{3})*(?:\.\d+)?(?![\w]|\.\d)")
_BARE_FIGURE = re.compile(r"(?<![\w.,{}:])(?!(?:19|20)\d{2}\b)\d{2,}(?:,\d{3})*(?:\.\d+)?(?![\w]|\.\d)")

# A client name within DENY_WINDOW characters of one of these words marks commercial terms. Every number in that
# stretch is replaced by a placeholder (redact), and a number that survives fails the export (commercial_detail).
DENY_NEAR = re.compile(r"\b(?:rebates?|rate[- ]card|FTEs?)\b", re.I)
DENY_WINDOW = 100
_UNIT = r"\s?(?:k|m|bn|%|per\s?cent|FTEs?|points?|pts|bps|basis points)\b"
# a figure with a unit, a number of 2 or more digits, or a decimal. A bare single digit (a count, a step in a formula) stays.
_NUMBER = re.compile(
    r"(?<![\w{}:.])(?:\d+(?:,\d{3})*(?:\.\d+)?(?:" + _UNIT + r")|\d{2,}(?:,\d{3})*(?:\.\d+)?|\d\.\d+)", re.I)
_PLACEHOLDER_OR_NUMBER = re.compile(r"\{\{PRIVATE:[0-9a-f]{8}\}\}|" + _NUMBER.pattern, re.I)

TOKEN = re.compile(r"\{\{PRIVATE:([0-9a-f]{8})\}\}")
_ANY_CASE_TOKEN = re.compile(r"\{\{(PRIVATE|private):([0-9a-f]{8})\}\}")  # the ledger lower-cases its text
WITHHELD = "[withheld]"
KEY_FILE = "privacy_key"
KEY_BYTES = 32

_ambient_overlay: Path | None = None
_ambient_terms_path: Path | None = None

TERMS_FILE = "private_terms.json"
TERM_LISTS = ("clients", "projects", "people")


# ---------------------------------------------------------------- the key

def key_path(overlay_dir: Path) -> Path:
    return Path(overlay_dir) / KEY_FILE


def get_key(overlay_dir: Path, create: bool = True) -> bytes:
    """The 32-byte key of this machine, created on first use. A key file that cannot be read as 32 bytes raises
    ValueError, because a new key would silently change every placeholder."""
    p = key_path(overlay_dir)
    if not p.is_file():
        if not create:
            raise FileNotFoundError(str(p))
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            fd = -1  # another process created it first, so it is read below
        if fd >= 0:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(os.urandom(KEY_BYTES).hex() + "\n")
    try:
        key = bytes.fromhex(p.read_text(encoding="utf-8").strip())
    except ValueError as exc:
        raise ValueError(f"The privacy key at {p} is not 64 hex digits. Restore it from a backup, because a new key "
                         "would change every placeholder.") from exc
    if len(key) != KEY_BYTES:
        raise ValueError(f"The privacy key at {p} must hold {KEY_BYTES} bytes, not {len(key)}.")
    return key


def configure(overlay_dir: Path | None, terms_path: Path | None = None) -> None:
    """Sets the overlay folder that redact uses when it is called without a key (None clears it), and optionally the
    file of private terms to read in place of <overlay>/private_terms.json."""
    global _ambient_overlay, _ambient_terms_path
    _ambient_overlay = Path(overlay_dir) if overlay_dir is not None else None
    _ambient_terms_path = Path(terms_path) if terms_path is not None else None


# ---------------------------------------------------------------- the private terms

class Terms:
    """The names that mark a line as one about a client, compiled once. With no names, name is None and a line
    names no client."""

    def __init__(self, names: list[str] | tuple = ()):
        names = sorted({n.strip() for n in names if isinstance(n, str) and n.strip()}, key=lambda n: (-len(n), n.lower()))
        alt = "|".join(re.escape(n) for n in names)
        self.names = tuple(names)
        self.name = re.compile(r"(?<!\w)(?:" + alt + r")(?!\w)", re.I) if names else None
        self.context = re.compile(r"(?<!\w)(?:" + (alt + "|" if names else "") + _CONTEXT_WORDS + r")(?!\w)", re.I)

    def names_client(self, text: str) -> bool:
        return bool(self.name and self.name.search(text))


NO_TERMS = Terms()
_terms_cache: dict[tuple, Terms] = {}


def terms_path(overlay_dir: Path, configured: str | os.PathLike | None = None) -> Path:
    """The file of private terms: the configured one, else <overlay>/private_terms.json."""
    return Path(os.path.expanduser(str(configured))) if configured else Path(overlay_dir) / TERMS_FILE


def load_terms(overlay_dir: Path, configured: str | os.PathLike | None = None) -> Terms:
    """The private terms of this machine. A missing or unreadable file gives the public default, no names."""
    p = terms_path(overlay_dir, configured)
    try:
        st = p.stat()
    except OSError:
        return NO_TERMS
    ident = (str(p), st.st_mtime_ns, st.st_size)
    if ident not in _terms_cache:
        try:
            data = json.loads(p.read_text(encoding="utf-8-sig"))
        except (ValueError, OSError):
            data = {}
        names: list[str] = []
        if isinstance(data, dict):
            for k in TERM_LISTS:
                v = data.get(k)
                if isinstance(v, list):
                    names += [x for x in v if isinstance(x, str)]
        _terms_cache[ident] = Terms(names)
    return _terms_cache[ident]


def terms_for(cfg) -> Terms:
    """The terms of a Config, from its private_terms key or its overlay."""
    return load_terms(cfg.overlay_dir, (getattr(cfg, "raw", None) or {}).get("private_terms"))


def _ambient_terms() -> Terms:
    if _ambient_overlay is not None:
        return load_terms(_ambient_overlay, _ambient_terms_path)
    from .config import load_config
    return terms_for(load_config())


_ambient_cache: dict[tuple, bytes] = {}


def _ambient_key() -> bytes:
    """The key for a redact call that names none: the configured overlay (see configure), else the overlay of the
    configuration file. The result is kept per overlay folder and key file, so a ledger of thousands of rules reads the
    file once."""
    if _ambient_overlay is not None:
        overlay = _ambient_overlay
    else:
        from .config import load_config
        overlay = load_config().overlay_dir
    kp = key_path(overlay)
    try:
        st = kp.stat()
        ident = (str(overlay), st.st_mtime_ns, st.st_size)
    except OSError:
        ident = None
    if ident is not None and ident in _ambient_cache:
        return _ambient_cache[ident]
    key = get_key(overlay)
    st = kp.stat()
    _ambient_cache[(str(overlay), st.st_mtime_ns, st.st_size)] = key
    return key


def _token(value: str, key: bytes) -> str:
    return "{{PRIVATE:%s}}" % hmac.new(key, value.encode("utf-8"), hashlib.sha256).hexdigest()[:8]


def _legacy_token(value: str) -> str:
    return "{{PRIVATE:%s}}" % hashlib.sha1(value.encode("utf-8")).hexdigest()[:8]


# ---------------------------------------------------------------- redaction

# A line that gives an example of how to write money is house style, even straight after a line that names a client.
HOUSE_STYLE = re.compile(
    r"\b(?:write|writes|format|express|round|state|show)\b[^.\n]{0,40}\b(?:money|amounts?|figures?|currency|prices?)\b"
    r"|\b(?:money|amounts?)\s+(?:as|in)\b|\be\.?g\.?\s|\bfor example\b|\bsuch as\b", re.I)


_BLOCK_START = re.compile(r"^\s{0,3}(?:[-*+]\s|\d+[.)]\s|#|\||>|```)")


def _client_lines(lines: list[str], i: int, terms: Terms) -> bool:
    """Whether line i names a client, or continues a paragraph or list item whose first 2 lines before it name one.
    A line that starts a new list item, heading, table row or quotation, or follows a blank line, carries nothing over
    from above, and nor does a house-style example."""
    if terms.names_client(lines[i]):
        return True
    if HOUSE_STYLE.search(lines[i]):
        return False
    j = i
    while j > max(-1, i - 3):
        if _BLOCK_START.match(lines[j]):
            return False
        j -= 1
        if j < 0 or not lines[j].strip():
            return False
        if terms.names_client(lines[j]):
            return True
    return False


def redact(text: str, key: bytes | None = None, terms: Terms | None = None) -> tuple[str, dict[str, str]]:
    """Return the text with sensitive values replaced, and the map from each placeholder to its value.

    Without a key the key of the configured overlay is used (see configure), so older callers keep working. Without
    terms the private terms of the same overlay are used."""
    if key is None:
        key = _ambient_key()
    if terms is None:
        terms = _ambient_terms()
    found: dict[str, str] = {}

    def sub(m: re.Match) -> str:
        value = m.group(0)
        tok = _token(value, key)
        if found.get(tok, value) != value:
            raise ValueError("Two private values share a placeholder. Remove one from the text and run it again.")
        found[tok] = value
        return tok

    def sub_percent(m: re.Match) -> str:
        line = m.string
        lo, hi = max(0, m.start() - NEAR), min(len(line), m.end() + NEAR)
        if COMMERCIAL_WORD.search(line[lo:m.start()]) or COMMERCIAL_WORD.search(line[m.end():hi]):
            return sub(m)
        return m.group(0)

    src = text.splitlines(keepends=True)
    out_lines = []
    for i, line in enumerate(src):
        line = PERSONAL_EMAIL.sub(sub, line)
        line = PERSONAL_PHONE.sub(sub, line)
        if terms.context.search(line) or _client_lines(src, i, terms):
            line = MONEY.sub(sub, line)
        if terms.context.search(line):
            line = MARGIN.sub(sub_percent, line)
        line = _redact_numbers_near_terms(line, sub, terms)
        line = _redact_thousands(line, sub)
        line = _redact_day_rate(line, sub)
        line = _redact_charges(line, sub)
        out_lines.append(line)
    return "".join(out_lines), found


def _redact_thousands(line: str, sub) -> str:
    """A figure with a thousands comma that has a commercial word within NEAR characters on either side."""
    def one(m: re.Match) -> str:
        lo, hi = max(0, m.start() - NEAR), min(len(m.string), m.end() + NEAR)
        if COMMERCIAL_WORD.search(m.string[lo:m.start()]) or COMMERCIAL_WORD.search(m.string[m.end():hi]):
            return sub(m)
        return m.group(0)
    return THOUSANDS.sub(one, line)


def _redact_day_rate(line: str, sub) -> str:
    """A bare figure of 2 or more digits within DAY_RATE_WINDOW characters of "day rate". A year stays."""
    spans = [(max(0, m.start() - DAY_RATE_WINDOW), min(len(line), m.end() + DAY_RATE_WINDOW)) for m in DAY_RATE.finditer(line)]
    if not spans:
        return line

    def one(m: re.Match) -> str:
        return sub(m) if any(lo <= m.start() and m.end() <= hi for lo, hi in spans) else m.group(0)
    return _BARE_FIGURE.sub(one, line)


def _redact_charges(line: str, sub) -> str:
    """A bare figure of 3 or more digits near "charge", "rate card", "a day" or "per month". A year stays."""
    spans = [(max(0, m.start() - CHARGE_WINDOW), min(len(line), m.end() + CHARGE_WINDOW)) for m in CHARGE_WORD.finditer(line)]
    if not spans:
        return line

    def one(m: re.Match) -> str:
        digits = re.sub(r"\D.*", "", m.group(0).replace(",", ""))
        if len(digits) < 3 or not any(lo <= m.start() and m.end() <= hi for lo, hi in spans):
            return m.group(0)
        return sub(m)
    return _CHARGE_FIGURE.sub(one, line)


def _term_spans(line: str, terms: Terms) -> list[tuple[int, int]]:
    """The stretches of the line within DENY_WINDOW characters of a rebate, rate card or FTE count, where a client
    name also stands, merged where they overlap."""
    spans: list[tuple[int, int]] = []
    for m in DENY_NEAR.finditer(line):
        lo, hi = max(0, m.start() - DENY_WINDOW), min(len(line), m.end() + DENY_WINDOW)
        if terms.names_client(line[lo:hi]):
            if spans and lo <= spans[-1][1]:
                spans[-1] = (spans[-1][0], max(hi, spans[-1][1]))
            else:
                spans.append((lo, hi))
    return spans


def _redact_numbers_near_terms(line: str, sub, terms: Terms) -> str:
    spans = _term_spans(line, terms)
    if not spans:
        return line

    def inner(m: re.Match) -> str:
        return m.group(0) if m.group(0).startswith("{{") else sub(m)

    out, pos = [], 0
    for lo, hi in spans:
        out.append(line[pos:lo])
        out.append(_PLACEHOLDER_OR_NUMBER.sub(inner, line[lo:hi]))
        pos = hi
    out.append(line[pos:])
    return "".join(out)


def commercial_detail(text: str, terms: Terms | None = None) -> list[tuple[int, str]]:
    """Lines of the redacted text where a client name stands within 100 characters of a rebate, a rate card or an FTE
    count and a number is still in clear. Such a line gives commercial terms of a client, so the export refuses it
    (line number, line). redact removes the numbers first, so a hit means the redaction missed something."""
    if terms is None:
        terms = _ambient_terms()
    hits = []
    for n, line in enumerate(text.splitlines(), 1):
        for lo, hi in _term_spans(line, terms):
            if any(not m.group(0).startswith("{{") for m in _PLACEHOLDER_OR_NUMBER.finditer(line[lo:hi])):
                hits.append((n, line.strip()[:120]))
                break
    return hits


def restore(text: str, values: dict[str, str], missing: str = WITHHELD) -> str:
    """Put the values back. A placeholder with no value becomes the missing text."""
    def sub(m: re.Match) -> str:
        return values.get(m.group(0), missing)
    return TOKEN.sub(sub, text)


def has_placeholders(text: str) -> bool:
    return bool(TOKEN.search(text))


# ---------------------------------------------------------------- the value store

def store_path(overlay_dir: Path) -> Path:
    return Path(overlay_dir) / "private_values.json"


def load_values(overlay_dir: Path) -> dict[str, str]:
    p = store_path(overlay_dir)
    if not p.is_file():
        return {}
    try:
        return dict(json.loads(p.read_text(encoding="utf-8")))
    except (ValueError, OSError):
        return {}


def _write_values(overlay_dir: Path, values: dict[str, str]) -> None:
    p = store_path(overlay_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(dict(sorted(values.items())), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(p)


def save_values(overlay_dir: Path, values: dict[str, str]) -> None:
    """Merge the values into the overlay store. Values are never removed, so older mirrors still restore."""
    current = load_values(overlay_dir)
    if all(current.get(k) == v for k, v in values.items()):
        return  # nothing new, so the file is not rewritten
    current.update(values)
    _write_values(overlay_dir, current)


# ---------------------------------------------------------------- migration from the unsalted placeholders

def _recase(token: str | None, prefix: str) -> str | None:
    return token if token is None or prefix == "PRIVATE" else token.replace("PRIVATE", "private", 1)


def migrate(overlay_dir: Path, roots: list[Path], dry_run: bool = False) -> dict:
    """Re-key every legacy placeholder (the first 8 hex digits of the sha1 of its value) found in the value store.

    The old placeholder is replaced by the keyed one in each text file under the roots, and the value store is
    rewritten with the keyed placeholders in place of the legacy ones. The run is idempotent: a keyed placeholder is
    never the sha1 of its own value, so a second run finds nothing to do."""
    values = load_values(overlay_dir)
    legacy = {tok: val for tok, val in values.items() if tok == _legacy_token(val)}
    if not legacy:
        return {"rekeyed": 0, "files": []}
    key = get_key(overlay_dir)
    mapping = {tok: _token(val, key) for tok, val in legacy.items()}
    files = []
    for root in roots:
        root = Path(root)
        paths = [root] if root.is_file() else sorted(f for f in root.rglob("*") if f.is_file()) if root.is_dir() else []
        for f in paths:
            try:
                text = f.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            new = _ANY_CASE_TOKEN.sub(lambda m: _recase(mapping.get("{{PRIVATE:%s}}" % m.group(2)), m.group(1)) or m.group(0), text)
            if new != text:
                files.append(str(f).replace("\\", "/"))
                if not dry_run:
                    f.write_bytes(new.encode("utf-8"))
    if not dry_run:
        rewritten = {tok: val for tok, val in values.items() if tok not in legacy}
        rewritten.update({mapping[tok]: val for tok, val in legacy.items()})
        _write_values(overlay_dir, rewritten)
    return {"rekeyed": len(legacy), "files": files}
