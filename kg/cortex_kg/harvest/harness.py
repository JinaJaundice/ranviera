"""Harvest the harness: the map file, rule files, output styles, agents, hooks, tools, routes, faults and schedules.

The functions here also serve the skills harvester: frontmatter(), harvest_doc(), fwd() and read() are shared.
The returned Harvest carries one extra attribute, rule_file_keys, the file keys whose rules were assigned, which the
caller passes to Ledger.finish.
"""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path

from .. import md
from ..config import Config
from ..ledger import Ledger, fingerprint
from ..model import Harvest, Node, slugify
from ..paths import resolve_cited

SKIPPED_HEADINGS = ("full reference", "where things are kept", "changes to")
BUILTINS = ("Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "Grep", "Glob", "WebFetch",
            "WebSearch", "Agent", "Task", "Skill", "Workflow", "TodoWrite", "AskUserQuestion", "Artifact",
            "Monitor", "ToolSearch")


def fwd(p: Path | str) -> str:
    return str(p).replace("\\", "/")


def rel_to(p: Path, base: Path) -> str:
    try:
        return fwd(p.resolve().relative_to(base.resolve()))
    except ValueError:
        return fwd(p)


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8-sig", errors="replace")


def check_frontmatter(h: Harvest, p: Path, text: str) -> None:
    """A finding for front matter that opens and is never closed, or that closes with nothing in it."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        h.find("B08", "warning", f"The front matter of {p.name} opens on line 1 and is never closed, so no property was read from it.",
               None, f"{fwd(p)}:1")
    elif not any(ln.strip() and not ln.lstrip().startswith("#") for ln in lines[1:end]):
        h.find("B08", "warning", f"The front matter of {p.name} is empty.", None, f"{fwd(p)}:1")


class Checked:
    """A reader that reports, once for each file, text that is not valid UTF-8 (the bad bytes are replaced and the file
    is still read) and front matter that is not closed or is empty."""

    def __init__(self, h: Harvest):
        self.h = h
        self.done: dict[Path, str] = {}

    def __call__(self, p: Path) -> str:
        if p in self.done:
            return self.done[p]
        raw = p.read_bytes()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            self.h.find("B07", "warning", f"The file {p.name} is not valid UTF-8 (byte {exc.start}), so the bad bytes were replaced when it was read.",
                        None, f"{fwd(p)}:1")
            text = raw.decode("utf-8-sig", errors="replace")
        if p.suffix.lower() == ".md":
            check_frontmatter(self.h, p, text)
        self.done[p] = text
        return text


_KEY = re.compile(r"^([A-Za-z_][\w.-]*):\s*(.*)$")


def frontmatter(text: str) -> dict:
    """Top-level frontmatter keys. Folded and literal blocks are joined, and '- item' lists become lists."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    out: dict = {}
    key = None
    folded: list[str] | None = None
    for raw in lines[1:]:
        if raw.strip() == "---":
            break
        indented = raw[:1] in (" ", "\t")
        m = None if indented else _KEY.match(raw)
        if m:
            key, val = m.group(1), m.group(2).strip()
            folded = None
            if re.fullmatch(r"[>|][-+]?", val):
                folded = []
                out[key] = ""
            elif val == "":
                out[key] = ""
            else:
                out[key] = md._unquote(val)
        elif key is not None and indented and raw.strip():
            s = raw.strip()
            if folded is not None:
                folded.append(s)
                out[key] = " ".join(folded)
            elif s.startswith("- "):
                if not isinstance(out[key], list):
                    out[key] = []
                out[key].append(md._unquote(s[2:].strip()))
    return out


def plain(text: str) -> str:
    t = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    return re.sub(r"\s+", " ", re.sub(r"[`*]", "", t)).strip()


_LABEL = re.compile(r"^\s*(\*\*[^*]{1,60}\*\*|__[^_]{1,60}__)\s*[:.\-]?\s*")
_BARE_INDEX: dict[str, dict[str, list[str]]] = {}


def modal_text(text: str) -> str:
    """The item text without a leading bold label, so that md.modal_of sees the first word of the instruction."""
    stripped = _LABEL.sub("", text, count=1)
    return stripped if stripped.strip() else text


def _bare_index(cfg: Config) -> dict[str, list[str]]:
    key = f"{cfg.claude_home}|{cfg.projects_root}"
    if key not in _BARE_INDEX:
        idx: dict[str, list[str]] = {}
        roots = [cfg.claude_home / d for d in ("rules", "agents", "output-styles", "skills", "tools")]
        roots.append(cfg.projects_root / "build")
        for root in roots:
            if not root.is_dir():
                continue
            for p in sorted(root.rglob("*")):
                if p.is_file() and "__pycache__" not in p.parts:
                    idx.setdefault(p.name, []).append(fwd(p.resolve()))
        _BARE_INDEX[key] = idx
    return _BARE_INDEX[key]


def resolve_ref(raw: str, citing_file: Path, cfg: Config) -> str | None:
    """paths.resolve_cited, then a bare file name looked up in the set-up folders where the name is unique."""
    found = resolve_cited(raw, citing_file, cfg)
    if found is not None:
        return found
    name = raw.strip().strip("`").rstrip("/")
    if "/" not in name and "." in name:
        hits = _bare_index(cfg).get(name, [])
        if len(hits) == 1:
            return hits[0]
    return None


_SOURCE = re.compile(r"\(source:\s*([^()]*?)\)", re.I)


def harvest_doc(h: Harvest, ledger: Ledger, today: str, cfg: Config, *, file_id: str, path: Path, file_key: str,
                text: str, sensitivity: str = "internal", extras: bool = False) -> set[str]:
    """Turn one instruction file into section nodes, rule nodes, contains edges and refs. Returns the rule ids."""
    rel = rel_to(path, cfg.claude_home)   # the ledger keeps the path relative to the Claude folder
    at = lambda line: md.evidence(cfg, path, line)  # noqa: E731  the one evidence format, '<root>/<path>:<line>'
    doc = md.parse(text)
    sections: dict[int, str] = {}
    counts: dict[str, int] = {}
    for hd in doc.headings:
        if hd.text.lower().startswith(SKIPPED_HEADINGS):
            continue
        slug = slugify(hd.text)
        counts[slug] = counts.get(slug, 0) + 1
        sid = f"section:{file_key}-{slug}" + (f"-{counts[slug]}" if counts[slug] > 1 else "")
        sections[hd.line] = sid
        h.add_node(Node(sid, hd.text, path=fwd(path), sensitivity=sensitivity, evidence=at(hd.line),
                        props={"level": hd.level, "file_key": file_key}))
        h.add_edge(file_id, "contains", sid, at(hd.line))
    line_rule: dict[int, str] = {}
    rule_ids: set[str] = set()
    item_lines = {it.line for it in doc.items}
    heading_lines = {hd.line for hd in doc.headings}
    item_rule: dict[int, str] = {}      # index in doc.items -> rule id
    item_kind: dict[int, str] = {}
    for idx, it in enumerate(doc.items):
        head = it.heading.text if it.heading else ""
        if head.lower().startswith(SKIPPED_HEADINGS):
            continue
        rid = ledger.assign(file_key, rel, it.text, today)
        rule_ids.add(rid)
        parent_idx = it.parent
        modal, kind, negated = md.classify(it.text, head, fwd(path), item_kind.get(parent_idx) if parent_idx is not None
                                           else None)
        item_rule[idx], item_kind[idx] = rid, kind
        props = {"text": it.text, "modal": modal, "kind": kind, "section": head, "file_key": file_key,
                 "fingerprint": fingerprint(it.text)}
        if negated:
            props["negated"] = True
        if parent_idx is not None and parent_idx in item_rule:
            props["parent"] = item_rule[parent_idx]     # a nested item is a part of the item above it
        if extras:
            if "open decisions" in head.lower():
                props["open_decision"] = True
            m = _SOURCE.search(it.text)
            if m:
                props["source"] = m.group(1).strip()
        status = "superseded" if "superseded" in head.lower() else None
        h.add_node(Node(rid, plain(it.text)[:80], path=fwd(path), date=md.given_date(it.text), status=status,
                        sensitivity=sensitivity, props=props, evidence=at(it.line)))
        h.add_edge(sections[it.heading.line] if it.heading else file_id, "contains", rid, at(it.line))
        n = it.line
        while n <= len(doc.lines):
            line_rule[n] = rid
            n += 1
            if n > len(doc.lines) or not doc.lines[n - 1].strip() or n in item_lines or n in heading_lines:
                break
    for cp in md.cited_paths(doc):
        h.ref(line_rule.get(cp.line, file_id), cp.raw, resolve_ref(cp.raw, path, cfg), at(cp.line),
              cp.acknowledged_missing)
    return rule_ids


def tool_id(script: Path, cfg: Config) -> str:
    tools = (cfg.claude_home / "tools").resolve()
    try:
        parts = list(script.resolve().relative_to(tools).with_suffix("").parts)
    except ValueError:
        return f"tool:{slugify(script.stem)}"
    return "tool:" + slugify("-".join(parts))


def _docstring_line(src: str) -> str:
    try:
        doc = ast.get_docstring(ast.parse(src)) or ""
    except SyntaxError:
        return ""
    for line in doc.splitlines():
        if line.strip():
            return line.strip()
    return ""


def _str_of(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(v.value if isinstance(v, ast.Constant) else "{}" for v in node.values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        a, b = _str_of(node.left), _str_of(node.right)
        return a + b if a is not None and b is not None else None
    return None


def _is_regex(node: ast.AST) -> bool:
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "compile"


def fault_checks(src: str) -> list[tuple[str, str, int]]:
    """(key, message, line) for each fault the script defines, read from the syntax tree.

    A list of (compiled regex, key, message) is a fault table. A list of (compiled regex, label) is a table of
    labels and gives the key commit-<label>. A call faults.append(("key", "message", ...)) adds one more.
    """
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return []
    out: list[tuple[str, str, int]] = []
    for n in ast.walk(tree):
        if isinstance(n, (ast.Assign, ast.AnnAssign)) and isinstance(n.value, ast.List):
            for el in n.value.elts:
                if not (isinstance(el, ast.Tuple) and el.elts and _is_regex(el.elts[0])):
                    continue
                if len(el.elts) == 3:
                    k, m = _str_of(el.elts[1]), _str_of(el.elts[2])
                    if k and m:
                        out.append((k, m, el.lineno))
                elif len(el.elts) == 2:
                    lab = _str_of(el.elts[1])
                    if lab:
                        out.append(("commit-" + slugify(re.sub(r"^an? ", "", lab)), f"{lab} in a commit message",
                                    el.lineno))
        elif isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "append" \
                and n.args and isinstance(n.args[0], ast.Tuple) and len(n.args[0].elts) >= 2:
            first = n.args[0].elts[0]
            k, m = _str_of(first), _str_of(n.args[0].elts[1])
            if isinstance(first, ast.Constant) and k and m and re.fullmatch(r"[a-z][a-z-]*", k):
                out.append((k, m, n.lineno))
    return out


def harvest(cfg: Config, ledger: Ledger, today: str) -> Harvest:
    h = Harvest("harness")
    home = cfg.claude_home
    seen_keys: set[str] = set()
    public_rules = set(cfg.raw.get("public_rule_files") or [])   # rule files whose text is public, by file stem
    rd = Checked(h)

    def instruction_file(file_id: str, path: Path, key: str, sens: str = "internal", props: dict | None = None,
                         label: str | None = None, summary: str | None = None) -> None:
        text = rd(path)
        h.add_node(Node(file_id, label or path.stem, path=fwd(path), summary=summary, sensitivity=sens,
                        evidence=md.evidence(cfg, path, 1), props=props or {}))
        h.texts[file_id] = text
        seen_keys.add(key)
        harvest_doc(h, ledger, today, cfg, file_id=file_id, path=path, file_key=key, text=text, sensitivity=sens)

    if (home / "CLAUDE.md").is_file():
        instruction_file("claudemd:global", home / "CLAUDE.md", "claude-md", label="CLAUDE.md")

    for p in sorted((home / "rules").glob("*.md")):
        fm = frontmatter(rd(p))
        rid = f"rulefile:{slugify(p.stem)}"
        paths = fm.get("paths") or []
        paths = [paths] if isinstance(paths, str) else paths
        instruction_file(rid, p, slugify(p.stem), "public" if p.stem in public_rules else "internal",
                         props={"paths": paths})
        file_lines = rd(p).splitlines()
        for glob in paths:
            sid = f"scope:{slugify(glob)}"
            gline = next((i for i, ln in enumerate(file_lines, 1) if glob in ln), 1)   # the line that lists the glob
            h.add_node(Node(sid, glob, sensitivity="internal", evidence=md.evidence(cfg, p, gline)))
            h.add_edge(rid, "appliesTo", sid, md.evidence(cfg, p, gline))

    for p in sorted((home / "output-styles").glob("*.md")):
        fm = frontmatter(rd(p))
        instruction_file(f"outputstyle:{slugify(p.stem)}", p, f"style-{slugify(p.stem)}", "public", props=fm,
                         summary=fm.get("description"))

    for p in sorted((home / "agents").glob("*.md")):
        fm = frontmatter(rd(p))
        name = fm.get("name") or p.stem
        props = {k: v for k, v in fm.items() if k != "name"}
        instruction_file(f"agent:{slugify(name)}", p, f"agent-{slugify(name)}", props=props, label=name,
                         summary=fm.get("description"))

    for step in (_tools, _routes, _hooks, _faults):
        _guarded(h, cfg, step)

    for d in sorted(x for x in (home / "scheduled-tasks").glob("*") if x.is_dir()):
        skill = d / "SKILL.md"
        fm = frontmatter(read(skill)) if skill.is_file() else {}
        h.add_node(Node(f"schedule:{slugify(d.name)}", d.name, path=fwd(skill if skill.is_file() else d),
                        summary=fm.get("description"), sensitivity="internal",
                        evidence=md.evidence(cfg, skill if skill.is_file() else d, 1),
                        props={"description": fm.get("description", "")}))

    _guarded(h, cfg, _builtins)

    records = {
        "record:memory-index": ("Memory index", cfg.memory_dir / "MEMORY.md"),
        "record:memory-changelog": ("Memory change log", cfg.memory_dir / "_changelog.md"),
        "record:register-log": ("Register log", home / "register-log"),
        "record:digests": ("Chat digests", home / "digests"),
    }
    if cfg.has_projects:
        records["record:backlog"] = ("Backlog", cfg.projects_root / "BACKLOG.md")
        records["record:projects-readme"] = ("Projects folder map", cfg.projects_root / "README.md")
    for rid, (label, p) in records.items():
        if not p.exists():
            continue    # a record that the person's set-up does not have is not a node
        h.add_node(Node(rid, label, path=fwd(p), sensitivity="internal", evidence=md.evidence(cfg, p, 1)))

    h.rule_file_keys = seen_keys  # type: ignore[attr-defined]
    return h


def _guarded(h: Harvest, cfg: Config, step) -> None:
    """Run one part of the harvest. A file that cannot be read or parsed gives a finding and the build goes on."""
    try:
        step(h, cfg)
    except Exception as exc:  # noqa: BLE001 - one bad file must not stop the harvest
        h.find("B07", "warning", f"The step {step.__name__.strip('_')} of the harness harvest stopped early: {type(exc).__name__}: {exc}.",
               None, None)


def _tools(h: Harvest, cfg: Config) -> None:
    root = cfg.claude_home / "tools"
    for p in sorted(root.rglob("*.py")):
        if "__pycache__" in p.parts or "selftest" in p.parts:
            continue
        h.add_node(Node(tool_id(p, cfg), p.stem.replace("_", " "), path=fwd(p), sensitivity="internal",
                        evidence=md.evidence(cfg, p, 1),
                        props={"purpose": _docstring_line(read(p)), "scope": "harness"}))
    routes = root / "register" / "routes.json"
    if routes.is_file():
        h.add_node(Node("tool:register-routes", "register routes", path=fwd(routes), sensitivity="internal",
                        evidence=md.evidence(cfg, routes, 1),
                        props={"purpose": "The prompt patterns and the rule files each route loads.",
                               "scope": "harness"}))


def _routes(h: Harvest, cfg: Config) -> None:
    p = cfg.claude_home / "tools" / "register" / "routes.json"
    if not p.is_file():
        return
    text = read(p)
    for entry in json.loads(text):
        name = entry.get("name", "")
        rid = f"route:{slugify(name)}"
        line = next((i for i, ln in enumerate(text.splitlines(), 1) if json.dumps(name) in ln), 1)
        load = entry.get("load", "")
        h.add_node(Node(rid, name, path=fwd(p), sensitivity="internal", evidence=md.evidence(cfg, p, line),
                        props={"patterns": list(entry.get("match", entry.get("patterns", []))), "load": load}))
        for cp in md.cited_paths(md.parse(load)):
            h.ref(rid, cp.raw, resolve_ref(cp.raw, p, cfg), md.evidence(cfg, p, line), cp.acknowledged_missing)


_SCRIPT = re.compile(r"""([^\s"']+\.py)\b""")


def _hooks(h: Harvest, cfg: Config) -> None:
    sp = cfg.claude_home / "settings.json"
    if not sp.is_file():
        return
    settings_text = read(sp)
    settings = json.loads(settings_text)
    settings_lines = settings_text.splitlines()
    used: dict[str, int] = {}
    for event, groups in (settings.get("hooks") or {}).items():
        for group in groups:
            for hk in group.get("hooks", []):
                cmd = hk.get("command", "")
                cmd_line = next((i for i, ln in enumerate(settings_lines, 1) if json.dumps(cmd)[1:-1] in ln), 1)
                at = md.evidence(cfg, sp, cmd_line)
                m = _SCRIPT.search(cmd)
                script = Path(m.group(1)).expanduser() if m else None
                stem = script.stem if script else (cmd.split() or ["command"])[0]
                hid = f"hook:{event.lower()}-{slugify(stem)}"
                used[hid] = used.get(hid, 0) + 1
                if used[hid] > 1:
                    hid += f"-{used[hid]}"
                h.add_node(Node(hid, f"{event} {stem}", path=fwd(script) if script else None,
                                sensitivity="internal", evidence=at,
                                props={"event": event, "matcher": group.get("matcher", ""), "command": cmd,
                                       "async": bool(hk.get("async", False)), "timeout": hk.get("timeout", 0),
                                       "statusMessage": hk.get("statusMessage", "")}))
                if script is None:
                    continue
                tid = tool_id(script, cfg)
                h.add_edge(hid, "invokes", tid, at)
                # A script outside ~/.claude/tools, such as the Cortex event hook in the repository, has no tool node
                # from the tools scan, so the hook creates it here and the invokes edge has an end.
                if script.is_file() and tid not in h.nodes:
                    try:
                        in_repo = script.resolve().is_relative_to(cfg.repo_root)
                    except (OSError, ValueError):
                        in_repo = False
                    h.add_node(Node(tid, script.name, path=fwd(script), sensitivity="internal",
                                    evidence=md.evidence(cfg, script, 1),
                                    props={"purpose": _docstring_line(read(script)),
                                           "scope": "cortex" if in_repo else "external"}))
                if not script.is_file():
                    h.find("P07", "violation",
                           f"The hook command names a script that does not exist: {fwd(script)}.", hid, at)


def _faults(h: Harvest, cfg: Config) -> None:
    reg = cfg.claude_home / "tools" / "register"
    for name in ("hook.py", "guard.py"):
        p = reg / name
        if not p.is_file():
            continue
        tid = tool_id(p, cfg)
        rel = rel_to(p, cfg.claude_home)
        for key, message, line in fault_checks(read(p)):
            fid = f"fault:{slugify(key)}"
            h.add_node(Node(fid, key, path=fwd(p), sensitivity="internal", evidence=md.evidence(cfg, p, line),
                            props={"message": message, "script": rel}))
            h.add_edge(tid, "contains", fid, md.evidence(cfg, p, line))


def _builtins(h: Harvest, cfg: Config) -> None:
    """The tools that Claude Code itself provides. No file in the set-up defines one, so the evidence of each is the
    first line of an agent file that names it in its tools list. A tool that no agent names cites the line of the
    BUILTINS list in this module, which is where the node comes from, and carries origin 'external'."""
    named: dict[str, str] = {}
    for p in sorted((cfg.claude_home / "agents").glob("*.md")):
        for n, line in enumerate(read(p).splitlines(), 1):
            if line.lower().startswith("tools:"):
                for tool in re.split(r"[,\s]+", line.split(":", 1)[1]):
                    named.setdefault(tool.strip(), md.evidence(cfg, p, n))
    here = Path(__file__)
    list_line = next((i for i, ln in enumerate(here.read_text(encoding="utf-8").splitlines(), 1)
                      if ln.startswith("BUILTINS = ")), 1)
    for b in BUILTINS:
        h.add_node(Node(f"builtin:{slugify(b)}", b, sensitivity="public",
                        evidence=named.get(b) or md.evidence(cfg, here, list_line),
                        props={"origin": "external", "source": "Claude Code"}))
