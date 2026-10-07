"""Harvest the Projects folder: apps, launch configurations, the backlog, decisions, history, deliverables,
templates and build tools.

The harvest reads cfg.projects_root with fixed rules. The project nodes themselves come from the memory harvest,
which this module calls to find the project each backlog section and history file belongs to.
"""
from __future__ import annotations

import ast
import hashlib
import json
import re
from datetime import date
from pathlib import Path

from .. import md, paths
from ..config import Config
from ..ledger import ItemLedger
from ..model import Harvest, Node, slugify
from . import memory as memory_harvest

SKIP_DIRS = {"node_modules", "__pycache__", ".git", "archive", "_archive"}
# Folders of deliverables that name a client, and app folders with a name of their own, come from the configuration
# (client_folders and app_labels), so that nothing in this module names a person's clients or products.
# words that name no particular project, so they carry no weight when a heading is matched to a project
_GENERIC = {"digital", "assets", "asset", "da", "financial", "crime", "fincrime", "hub", "tool", "project", "the",
            "and", "of", "for", "a", "in", "on", "with", "to", "formerly", "by", "key", "from", "x"}
_TABLE_STATUS = (("blocked", "blocked"), ("parked", "parked"), ("maintained", "maintained"), ("active", "active"))


def _p(path: Path) -> str:
    return str(path).replace("\\", "/")


def _rel(cfg: Config, p: Path) -> str:
    try:
        return p.relative_to(cfg.projects_root).as_posix()
    except ValueError:
        return _p(p)


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="replace")


def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in _GENERIC and not t.isdigit()]


def match_project(text: str, projects: dict[str, str]) -> str | None:
    """The project id whose slug or label shares most words with the text (ties go to the earliest word)."""
    words = _tokens(text)
    if not words:
        return None
    best: tuple[int, int, float, str] | None = None
    for pid, label in projects.items():
        ptoks = set(_tokens(pid.split(":", 1)[1].replace("-", " "))) | set(_tokens(label))
        hits = [i for i, w in enumerate(words) if w in ptoks]
        if not hits:
            continue
        key = (len({words[i] for i in hits}), -hits[0], len({words[i] for i in hits}) / len(ptoks), pid)
        if best is None or key[:3] > best[:3]:
            best = key
    return best[3] if best else None


def _purpose(path: Path) -> str | None:
    """The first sentence of the docstring or of the leading comment."""
    try:
        text = _read(path)
    except OSError:
        return None
    para = ""
    if path.suffix == ".py":
        try:
            para = ast.get_docstring(ast.parse(text)) or ""
        except SyntaxError:
            para = ""
    if not para:
        lines: list[str] = []
        started = False
        for raw in text.splitlines()[:40]:
            s = raw.strip()
            if not s or s.startswith(("#!", "# -*-", "<#", "#>", "/**", "*/")):
                if started and not s:
                    break
                continue
            m = re.match(r"^(?:#|//|\*)\s?(.*)$", s)
            if not m:
                break
            started = True
            lines.append(m.group(1).strip())
        para = " ".join(x for x in lines if x)
    else:
        para = " ".join(para.split("\n\n")[0].split())
    para = " ".join(para.split())
    if not para:
        return None
    cut = re.split(r"(?<=[a-z0-9\)])\.\s", para, maxsplit=1)[0]
    return cut[:200].rstrip(".")


def _readme_table(text: str) -> dict[str, dict]:
    """folder -> {what, status} from the table of apps in the Projects README."""
    out: dict[str, dict] = {}
    for line in text.splitlines():
        if not line.startswith("|") or set(line.replace("|", "").strip()) <= set("-: "):
            continue
        cols = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cols) < 3 or cols[0].lower() == "folder":
            continue
        for folder in re.findall(r"`([\w-]+)/`", cols[0]):
            out[folder] = {"what": cols[1], "status": cols[2]}
    return out


def _label_from(folder: str, what: str, shared_row: bool, labels: dict | None = None) -> str:
    if labels and labels.get(folder):
        return str(labels[folder])
    if shared_row:
        return folder.replace("-", " ").title()
    first = what.split(",")[0].strip()
    return first or folder.title()


def _package(app: Path) -> tuple[list[str], dict]:
    stack: list[str] = []
    scripts: dict = {}
    for pj in (app / "web" / "package.json", app / "package.json"):
        if not pj.is_file():
            continue
        try:
            data = json.loads(_read(pj))
        except json.JSONDecodeError:
            continue
        deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
        for name, test in (("react", lambda d: "react" in d), ("vite", lambda d: "vite" in d),
                           ("next", lambda d: "next" in d),
                           ("tailwind", lambda d: any("tailwindcss" in k for k in d))):
            if test(deps) and name not in stack:
                stack.append(name)
        for k, v in data.get("scripts", {}).items():
            scripts.setdefault(k, v)
    return stack, scripts


def _launch_folders(entry: dict, cfg: Config) -> list[str]:
    """Folders named in a launch entry's arguments, or in the command file it runs, relative to the root."""
    blob = " ".join(str(a) for a in entry.get("runtimeArgs", []))
    exe = Path(str(entry.get("runtimeExecutable", "")))
    if exe.suffix.lower() == ".cmd" and exe.name.lower() != "npm.cmd" and exe.is_file():
        blob += " " + _read(exe)
    blob = blob.replace("\\", "/")
    root = _p(cfg.projects_root)
    found: list[str] = []
    for m in re.finditer(rf"(?:{re.escape(root)}/)?(apps/[\w.-]+(?:/[\w.-]+)*)", blob):
        if m.group(1) not in found:
            found.append(m.group(1))
    return found


def _client_folder(cfg: Config, path: Path) -> bool:
    """True where the path is inside a client's folder of deliverables (a folder named client-* under deliverables)."""
    try:
        parts = path.resolve().relative_to((cfg.projects_root / "deliverables").resolve()).parts
    except ValueError:
        return False
    return bool(parts) and parts[0].startswith("client-")


_WORKING_EXT = {"md", "json", "txt", "csv", "py", "js", "mjs", "log", "yaml", "yml"}


def _stage(path: Path) -> str:
    """working for a note, a data file or a draft, and unconfirmed for the rest. A deliverable is shipped only where a
    ratified deliveredTo assertion says so, because nothing in the file or the folder shows that it was sent."""
    stem = path.stem.lower()
    if path.suffix.lstrip(".").lower() in _WORKING_EXT or stem.startswith("_") or "notes" in stem or "draft" in stem:
        return "working"
    return "unconfirmed"


def _walk_files(top: Path):
    """Every file under top, leaving out the folders in SKIP_DIRS (archive folders and build output)."""
    for entry in sorted(top.iterdir()):
        if entry.is_dir():
            if entry.name not in SKIP_DIRS:
                yield from _walk_files(entry)
        elif entry.is_file():
            yield entry


def _version(name: str) -> str | None:
    m = re.findall(r"[ _-]v(\d+)\b", name, re.I)
    return f"v{m[-1]}" if m else None


def _owner(text: str, names: list[str] | None = None) -> str | None:
    """The owner an item names: after 'owner:', or a name from owner_names in the configuration followed by to, will,
    must or needs (Claude by default)."""
    m = re.search(r"\bowner\s*[:=]\s*(\w+)", text, re.I)
    if not m:
        alt = "|".join(re.escape(n) for n in (names or ["Claude"]))
        m = re.search(rf"\b({alt})\s+(?:to|will|must|needs)\b", text)
    return m.group(1) if m else None


def harvest(cfg: Config) -> Harvest:
    h = Harvest("projects")
    root = cfg.projects_root
    if not cfg.has_projects:    # no projects folder is configured, or it is missing: nothing is read or reported
        return h
    client_folders = cfg.raw.get("client_folders") or {}
    app_labels = cfg.raw.get("app_labels") or {}
    owner_names = cfg.raw.get("owner_names") or ["Claude"]
    mem = memory_harvest.harvest(cfg)
    projects = {n.id: n.label for n in mem.nodes.values() if n.id.startswith("project:")}
    project_sens = {n.id: n.sensitivity for n in mem.nodes.values() if n.id.startswith("project:")}

    def ev(path: Path, line: int = 1) -> str:
        """The one evidence format, '<root>/<relative path>:<line>' (cortex_kg.md.evidence)."""
        return md.evidence(cfg, path, line)

    # records and folders
    readme = root / "README.md"
    readme_text = _read(readme) if readme.is_file() else ""
    if readme.is_file():
        h.add_node(Node(id="record:projects-readme", label="Projects README", path=_p(readme),
                        sensitivity="internal", evidence=ev(readme)))
        h.texts["record:projects-readme"] = readme_text
    backlog = root / "BACKLOG.md"
    backlog_text = _read(backlog) if backlog.is_file() else ""
    if backlog.is_file():
        h.add_node(Node(id="record:backlog", label="Backlog", path=_p(backlog), sensitivity="internal",
                        evidence=ev(backlog)))
        h.texts["record:backlog"] = backlog_text

    def folder(path: Path) -> str:
        fid = f"folder:{slugify(_rel(cfg, path))}"
        # a folder of a client's deliverables is as sensitive as the files in it
        sens = "client-confidential" if _client_folder(cfg, path) else "internal"
        h.add_node(Node(id=fid, label=_rel(cfg, path) + "/", path=_p(path), sensitivity=sens, evidence=ev(path)))
        return fid

    for d in sorted(root.iterdir()):
        if d.is_dir() and not d.name.startswith(".") and d.name not in SKIP_DIRS:
            folder(d)
    for sub in ("build/tools", "docs/history"):
        if (root / sub).is_dir():
            folder(root / sub)
    deliv = root / "deliverables"
    if deliv.is_dir():
        for d in sorted(deliv.iterdir()):
            if d.is_dir() and d.name not in SKIP_DIRS:
                folder(d)

    # apps and launch configurations
    table = _readme_table(readme_text)
    apps_dir = root / (cfg.raw.get("apps_folder") or "apps")
    launch_path = root / ".claude" / "launch.json"
    launches: list[dict] = []
    launch_text = ""
    if launch_path.is_file():
        launch_text = _read(launch_path)
        try:
            launches = json.loads(launch_text).get("configurations", [])
        except json.JSONDecodeError:
            launches = []
    by_app: dict[str, list[dict]] = {}
    for entry in launches:
        name = entry.get("name", "")
        lid = f"launch:{slugify(name)}"
        line = next((i for i, ln in enumerate(launch_text.splitlines(), 1) if f'"{name}"' in ln), 1)
        args = [str(a) for a in entry.get("runtimeArgs", [])]
        h.add_node(Node(id=lid, label=name, path=_p(launch_path), sensitivity="internal",
                        props={"port": entry.get("port"),
                               "command": " ".join([Path(str(entry.get("runtimeExecutable", ""))).name, *args])},
                        evidence=ev(launch_path, line)))
        for rel in _launch_folders(entry, cfg):
            if not (root / rel).exists():
                h.find("L01", "violation", f"The launch configuration {name} names the folder {rel}, which does "
                       "not exist.", lid, ev(launch_path, line))
                continue
            app = rel.split("/")[1]
            by_app.setdefault(app, []).append(entry)
            h.add_edge(lid, "launches", f"app:{slugify(app)}", ev(launch_path, line))

    if apps_dir.is_dir():
        shared_rows = {f for f, r in table.items()
                       if len([x for x in re.findall(r"`([\w-]+)/`", _first_col(readme_text, f))]) > 1}
        for a in sorted(apps_dir.iterdir()):
            if not a.is_dir() or a.name.startswith(".") or a.name in SKIP_DIRS:
                continue
            aid = f"app:{slugify(a.name)}"
            row = table.get(a.name)
            what = row["what"] if row else ""
            stack, scripts = _package(a)
            mine = by_app.get(a.name, [])
            main = next((e for e in mine if e.get("name") == a.name), mine[0] if mine else None)
            url = re.search(r"live at ([\w.-]+\.[a-z]{2,})", what)
            status = None
            if row:
                low = row["status"].lower()
                status = next((s for k, s in _TABLE_STATUS if low.startswith(k)), None)
            props = {"stack": stack, "scripts": scripts, "port": main.get("port") if main else None,
                     "launch": main.get("name") if main else None,
                     "launches": [e.get("name") for e in mine],
                     "url": f"https://{url.group(1)}" if url else None,
                     "readmeStatus": row["status"] if row else None}
            # the app's own README states what it is, and the row of the Projects README gives its status
            own = a / "README.md"
            row_line = next((i for i, ln in enumerate(readme_text.splitlines(), 1) if f"`{a.name}/`" in ln
                             and ln.startswith("|")), 1)
            at = ev(own) if own.is_file() else (ev(readme, row_line) if row else ev(a))
            h.add_node(Node(id=aid, label=_label_from(a.name, what, a.name in shared_rows, app_labels) if row
                            else a.name.replace("-", " ").title(),
                            path=_p(a), summary=what or None, status=status, sensitivity="internal",
                            props=props, evidence=at))
            h.add_edge(aid, "locatedAt", folder(a), ev(a))
            cm = a / "CLAUDE.md"
            if cm.is_file():
                cid = f"claudemd:app-{slugify(a.name)}"
                h.add_node(Node(id=cid, label=f"CLAUDE.md of {a.name}", path=_p(cm), sensitivity="internal",
                                evidence=ev(cm)))
                h.texts[cid] = _read(cm)
                h.add_edge(cid, "locatedAt", f"folder:apps-{slugify(a.name)}", ev(cm))

    # the backlog
    if backlog.is_file():
        lines = backlog_text.splitlines()
        starts = [(i, ln[3:].strip()) for i, ln in enumerate(lines, 1) if ln.startswith("## ")]
        doc = md.parse(backlog_text)
        item_ledger = ItemLedger.load(cfg.data_dir / "ledger" / "openitems.json")
        today = date.today().isoformat()
        for k, (start, raw) in enumerate(starts):
            end = starts[k + 1][0] if k + 1 < len(starts) else len(lines) + 1
            heading = raw.replace("`", "")
            bid = f"backlog:{slugify(heading)}"
            section_key = bid.split(":", 1)[1]
            # a top-level bullet is an item, and so is a nested bullet that has a checkbox
            members = [(idx, it) for idx, it in enumerate(doc.items)
                       if start < it.line < end and not it.numbered
                       and (it.indent == 0 or md.checkbox(it.text)[0] is not None)]
            pid = match_project(re.split(r"[(]", heading)[0], projects)
            # a section that belongs to a project is as sensitive as the project's memory file
            sect_sens = project_sens.get(pid, "internal") if pid else "internal"
            if memory_harvest.sensitivity_of(heading) == "client-confidential":
                sect_sens = "client-confidential"
            n_open = sum(1 for _i, it in members if md.checkbox(it.text)[0] != "done")
            h.add_node(Node(id=bid, label=heading, path=_p(backlog), sensitivity=sect_sens,
                            props={"open_items": n_open}, evidence=ev(backlog, start)))
            if pid:
                h.add_edge(bid, "belongsTo", pid, ev(backlog, start))
            ids: dict[int, str] = {}
            for idx, it in members:
                state, text = md.checkbox(it.text)
                oid = f"openitem:{item_ledger.assign(section_key, text, today)}"
                ids[idx] = oid
                item_sens = memory_harvest.sensitivity_of(text)
                if sect_sens == "client-confidential":
                    item_sens = "client-confidential"
                lead = md.dates_in(text[:30])
                props = {"text": text, "owner": _owner(text, owner_names), "due": md.due_date(text),
                         "state": "done" if state == "done" else "open"}
                if it.parent is not None and it.parent in ids:
                    props["parent"] = ids[it.parent]       # a nested checkbox is a part of the item above it
                h.add_node(Node(id=oid, label=re.sub(r"[*`]", "", text)[:90], summary=text[:240],
                                date=lead[0] if lead else None, status="archived" if state == "done" else None,
                                sensitivity=item_sens, props=props, evidence=ev(backlog, it.line)))
                h.add_edge(oid, "belongsTo", bid, ev(backlog, it.line))
        item_ledger.finish(today)
        item_ledger.save(cfg.data_dir / "ledger" / "openitems.json")

    # decisions
    hd = root / "docs" / "harness"
    for f in sorted(hd.glob("DECISIONS_*.md")) if hd.is_dir() else []:
        m = re.search(r"(\d{4}-\d{2}-\d{2})", f.name)
        if not m:
            continue
        day = m.group(1)
        text = _read(f)
        rid = f"record:decisions-{day}"
        h.add_node(Node(id=rid, label=f"Decisions of {day}", path=_p(f), date=day, sensitivity="internal",
                        evidence=ev(f)))
        h.texts[rid] = text
        for it in md.parse(text).items:
            if not it.numbered or it.indent:
                continue
            num = _item_number(lines_of=text, line=it.line)
            if num is None:
                continue
            did = f"decision:{day}-{num}"
            q, _, d = it.text.partition("Decided.")
            h.add_node(Node(id=did, label=f"Decision {num} of {day}", path=_p(f), summary=q.strip()[:240],
                            date=day, sensitivity=memory_harvest.sensitivity_of(it.text),
                            props={"question": q.strip(), "decision": d.strip() or None},
                            evidence=ev(f, it.line)))
            h.add_edge(rid, "contains", did, ev(f, it.line))
            for cp in md.cited_paths(md.parse(it.text)):
                h.ref(did, cp.raw, paths.resolve_cited(cp.raw, f, cfg), ev(f, it.line),
                      cp.acknowledged_missing)

    # history
    hist = root / "docs" / "history"
    if hist.is_dir():
        for f in sorted([*hist.glob("*.md"), *(hist / "backlog").glob("*.md")]):
            if f.name.lower() == "readme.md":
                continue
            text = _read(f)
            ds = md.dates_in(text)
            hid = f"history:{slugify(f.stem)}"
            h.add_node(Node(id=hid, label=f.stem, path=_p(f), date=max(ds) if ds else None,
                            sensitivity=memory_harvest.sensitivity_of(text), evidence=ev(f)))
            pid = match_project(re.sub(r"^\d+-", "", f.stem).replace("_", "-"), projects)
            if pid:
                h.add_edge(pid, "documentedIn", hid, ev(f))

    # deliverables: every file under a folder of deliverables, grouped by folder and name so that a PDF beside its
    # PowerPoint is one deliverable. The folder a file sits in says where it is and who it concerns, and says nothing
    # about whether it was delivered, so no deliveredTo edge is made here. That relation comes from a curated
    # assertion (docs/ONTOLOGY.md), and a deliverable is shown as shipped only when such an assertion is ratified.
    if deliv.is_dir():
        groups: dict[tuple[str, str], dict] = {}
        for top in sorted(d for d in deliv.iterdir() if d.is_dir() and d.name not in SKIP_DIRS):
            for f in sorted(_walk_files(top)):
                if f.name.startswith(("~$", ".")) or f.name.lower() == "desktop.ini":
                    continue
                rel_dir = f.parent.relative_to(deliv).as_posix()
                st = f.stat()
                rec = groups.setdefault((rel_dir, f.stem), {"files": [], "top": top, "stem": f.stem})
                rec["files"].append((f, st.st_size, date.fromtimestamp(st.st_mtime).isoformat()))
        stem_count: dict[str, int] = {}
        for (_dir, stem) in groups:
            stem_count[slugify(stem)] = stem_count.get(slugify(stem), 0) + 1
        for (rel_dir, stem), rec in sorted(groups.items()):
            # a name that is unique keeps its short identifier, and a name used in 2 folders takes its folder as well
            if stem_count[slugify(stem)] == 1:
                did = f"deliverable:{slugify(stem)}"
            else:
                tag = hashlib.sha1(f"{rel_dir}/{stem}".encode("utf-8")).hexdigest()[:6]
                did = f"deliverable:{slugify(rel_dir + '/' + stem, 48)}-{tag}"
            files = sorted(rec["files"], key=lambda t: (t[0].suffix.lower() == ".pdf", t[0].name))
            f, size, _mod = files[0]
            top = rec["top"]
            client = client_folders.get(top.name)
            h.add_node(Node(id=did, label=rec["stem"], path=_p(f), date=max(t[2] for t in files),
                            sensitivity="client-confidential" if _client_folder(cfg, f) else "internal",
                            evidence=ev(f),
                            props={"folder": top.name, "directory": rel_dir, "client": client,
                                   "stage": _stage(f), "ext": f.suffix.lstrip(".").lower(), "bytes": size,
                                   "modified": max(t[2] for t in files), "version": _version(f.stem),
                                   "formats": sorted({t[0].suffix.lstrip(".").lower() for t in files})}))
            h.add_edge(did, "locatedAt", f"folder:deliverables-{slugify(top.name)}", ev(f))
            if client:     # the folder says whom the file concerns, and says nothing about delivery
                h.add_edge(did, "mentions", client, ev(f))

    # templates
    shared = root / "_shared"
    if shared.is_dir():
        for f in sorted(x for x in shared.iterdir() if x.is_file() and not x.name.startswith((".", "~$"))):
            tid = f"template:{slugify(f.stem)}"
            h.add_node(Node(id=tid, label=f.stem, path=_p(f), sensitivity="internal",
                            props={"ext": f.suffix.lstrip(".").lower(), "bytes": f.stat().st_size},
                            evidence=ev(f)))
            h.add_edge(tid, "locatedAt", "folder:shared", ev(f))

    # build tools
    build = root / "build"
    if build.is_dir():
        groups = [(sorted(f for f in build.iterdir() if f.is_file() and f.suffix in (".py", ".mjs", ".ps1")),
                   "build-", "folder:build"),
                  (sorted(f for f in (build / "tools").iterdir() if f.is_file() and not f.name.startswith("."))
                   if (build / "tools").is_dir() else [], "build-tools-", "folder:build-tools")]
        for files, prefix, fid in groups:
            for f in files:
                tid = f"tool:{prefix}{slugify(f.stem)}"
                h.add_node(Node(id=tid, label=f.name, path=_p(f), sensitivity="internal",
                                props={"purpose": _purpose(f), "scope": "build"}, evidence=ev(f)))
                h.add_edge(tid, "locatedAt", fid, ev(f))
    return h


def _first_col(readme_text: str, folder_name: str) -> str:
    for line in readme_text.splitlines():
        if line.startswith("|") and f"`{folder_name}/`" in line:
            return line.strip().strip("|").split("|")[0]
    return ""


def _item_number(lines_of: str, line: int) -> int | None:
    m = re.match(r"\s*(\d{1,3})[.)]\s", lines_of.splitlines()[line - 1])
    return int(m.group(1)) if m else None
