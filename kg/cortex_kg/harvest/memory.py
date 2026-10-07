"""Harvest the memory folder: memory files, the index, the changelog, projects and the links between them.

The harvest reads each folder of cfg.memory_dirs (cfg.memory_dir, or every <claude_home>/projects/*/memory folder that
holds a MEMORY.md) with fixed rules and skips the _archive folder. The first folder keeps the plain identifiers, and
each later folder prefixes the identifiers of its nodes with its label (memory:<label>-<file>). Findings M01 to M05 are
described in docs/ONTOLOGY.md and in the harvester's tests.
"""
from __future__ import annotations

import re
from pathlib import Path

from .. import md
from ..config import Config
from ..model import Harvest, Node, slugify
from .harness import Checked

# A pound or GBP amount with k or m, or the words margin and day rate, make a text client-confidential.
_PRICING = re.compile(
    r"(?:£|GBP\s?)\s?\d[\d,.]*\s?(?:k|m|bn)\b|\bmargins?\b|\bday[ -]rates?\b", re.I)
_STATUS_WORDS = (("superseded", "superseded"), ("archived", "archived"), ("parked", "parked"),
                 ("finished", "archived"))
_INDEX_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+\.md)\)")
_WHY = re.compile(r"\*\*why\b|\bwhy\s*[:.]", re.I)
_HOW = re.compile(r"how to apply", re.I)
PROJECT_BYTES_LIMIT = 4096


_RESTRICTED = re.compile(r"\bRESTRICTED\b")


def sensitivity_of(text: str, frontmatter: dict | None = None) -> str:
    """The label of a text: an explicit 'sensitivity' key in the frontmatter (or under metadata) when it holds a valid
    label, else client-confidential where the text names pricing, fees, margins or day rates or is marked RESTRICTED
    (the word the memory files use for a client's own documents), else internal."""
    fm = frontmatter or {}
    meta = fm.get("metadata") if isinstance(fm.get("metadata"), dict) else {}
    explicit = str(fm.get("sensitivity") or meta.get("sensitivity") or "").strip().lower()
    if explicit in ("public", "internal", "client-confidential"):
        return explicit
    return "client-confidential" if _PRICING.search(text) or _RESTRICTED.search(text) else "internal"


def status_of(*texts: str) -> str | None:
    """parked, superseded or archived when the text says so; finished maps to archived."""
    joined = " ".join(texts).lower()
    for word, status in _STATUS_WORDS:
        if re.search(rf"\b{word}\b", joined):
            return status
    return None


def link_key(name: str) -> str:
    """The form in which a link and a file name are compared: lower case, with _ and - equal."""
    return re.sub(r"[_\s]+", "-", name.strip().lower())


def _rel(cfg: Config, p: Path) -> str:
    return f"memory/{p.relative_to(cfg.memory_dir).as_posix()}"


def _rel_in(root: Path, primary: bool):
    """The evidence path of a file of one memory folder: memory/<file> for the first folder, which validation resolves
    from cfg.memory_dir, and the full path for the others."""
    def rel(p: Path) -> str:
        return f"memory/{p.relative_to(root).as_posix()}" if primary else p.as_posix()
    return rel


def _memory_type(fm: dict) -> str | None:
    meta = fm.get("metadata")
    if isinstance(meta, dict) and meta.get("type"):
        return str(meta["type"])
    return str(fm["type"]) if fm.get("type") else None


def project_slug(stem: str) -> str:
    return slugify(re.sub(r"^project_", "", stem))


def harvest(cfg: Config) -> Harvest:
    h = Harvest("memory")
    rd = Checked(h)
    roots = [(r, label) for r, label in cfg.memory_dirs if r.is_dir()]
    for i, (root, label) in enumerate(roots):
        idp = "" if i == 0 else slugify(label) + "-"
        _harvest_root(h, rd, root, idp, _rel_in(root, i == 0), label if len(roots) > 1 else None)
    return h


def _harvest_root(h: Harvest, rd, root: Path, idp: str, rel, project_label: str | None) -> None:
    rec = "" if not idp else "-" + idp.rstrip("-")
    files = sorted(p for p in root.glob("*.md") if p.name not in ("MEMORY.md", "_changelog.md"))

    # the index: file name -> (title, line)
    index_path = root / "MEMORY.md"
    index: dict[str, tuple[str, int]] = {}
    index_lines: list[tuple[int, str, str]] = []
    # The section of MEMORY.md that lists a file is the record of its status: "Active work" means active, and an
    # entry under "Parked, finished or archived" takes the word its own line uses (parked, superseded, archived,
    # finished or delivered), with parked when it uses none.
    index_status: dict[str, str] = {}
    section = ""
    if index_path.is_file():
        for n, line in enumerate(index_path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if line.startswith("## "):
                section = line[3:].strip().lower()
                continue
            for m in _INDEX_LINK.finditer(line):
                target = m.group(2).replace("\\", "/")
                index_lines.append((n, m.group(1).strip(), target))
                index.setdefault(Path(target).name, (m.group(1).strip(), n))
                if section.startswith("active"):
                    index_status.setdefault(Path(target).name, "active")
                elif section.startswith("parked") or "archived" in section:
                    index_status.setdefault(Path(target).name, status_of(line) or "parked")
    indexed_names = {Path(t).name for _n, _title, t in index_lines}

    # first pass: parse each file and register its keys for link matching
    parsed: dict[Path, tuple[md.Doc, str]] = {}
    keys: dict[str, str] = {}
    for p in files:
        text = rd(p)
        doc = md.parse(text)
        parsed[p] = (doc, text)
        node_id = f"memory:{idp}{slugify(p.stem)}"
        keys.setdefault(link_key(p.stem), node_id)
        if doc.frontmatter.get("name"):
            keys.setdefault(link_key(str(doc.frontmatter["name"])), node_id)

    for p in files:
        doc, text = parsed[p]
        fm = doc.frontmatter
        node_id = f"memory:{idp}{slugify(p.stem)}"
        mtype = _memory_type(fm)
        desc = str(fm.get("description") or "")
        opening = " ".join([ln for ln in doc.lines[doc.body_start - 1:] if ln.strip()][:3])
        status = index_status.get(p.name) or status_of(desc, opening)
        dates = md.dates_in(text)
        title = index.get(p.name, (None, 0))[0]
        h.add_node(Node(
            id=node_id, label=title or str(fm.get("name") or p.stem), path=str(p).replace("\\", "/"),
            summary=desc[:240] or None, date=max(dates) if dates else None, status=status,
            sensitivity=sensitivity_of(text, fm),
            props={"name": fm.get("name"), "description": desc or None, "memoryType": mtype,
                   "bytes": p.stat().st_size, "indexed": p.name in indexed_names,
                   **({"memoryProject": project_label} if project_label else {})},
            evidence=f"{rel(p)}:1"))
        h.texts[node_id] = text
        if p.name not in indexed_names:
            h.find("M05", "warning", f"The memory file {p.name} is not listed in MEMORY.md.", node_id,
                   f"{rel(p)}:1")

        # links between memory files
        for i, line in enumerate(doc.lines, 1):
            for name in md.wiki_links(line):
                target = keys.get(link_key(name))
                if target:
                    h.add_edge(node_id, "linksTo", target, f"{rel(p)}:{i}")
                else:
                    h.find("M01", "warning", f"The link [[{name}]] in {p.name} matches no memory file.",
                           node_id, f"{rel(p)}:{i}")

        if mtype == "project":
            pid = f"project:{idp}{project_slug(p.stem)}"
            h.add_node(Node(id=pid, label=title or str(fm.get("name") or p.stem), summary=desc[:240] or None,
                            date=max(dates) if dates else None, status=status,
                            sensitivity=h.nodes[node_id].sensitivity,   # a project is as sensitive as its memory file
                            props={"memory": node_id}, evidence=f"{rel(p)}:1"))
            h.add_edge(pid, "documentedIn", node_id, f"{rel(p)}:1")
            if p.stat().st_size > PROJECT_BYTES_LIMIT:
                h.find("M02", "warning",
                       f"The project memory {p.name} is {p.stat().st_size} bytes, over the limit of "
                       f"{PROJECT_BYTES_LIMIT}.", node_id, f"{rel(p)}:1")
        if mtype in ("project", "feedback") and not _WHY.search(text) and not _HOW.search(text):
            h.find("M03", "info", f"The {mtype} memory {p.name} has no Why line and no How to apply line.",
                   node_id, f"{rel(p)}:1")

    if index_path.is_file():
        h.add_node(Node(id=f"record:memory-index{rec}", label="Memory index" + (f" ({project_label})" if project_label else ""), path=str(index_path).replace("\\", "/"),
                        sensitivity="internal", props={"links": len(index_lines)},
                        evidence=f"{rel(index_path)}:1"))
        for n, _title, target in index_lines:
            f = (root / target).resolve()
            if not f.is_file():
                h.find("M04", "violation", f"The index line for {target} names a file that is missing.",
                       f"record:memory-index{rec}", f"{rel(index_path)}:{n}")
                continue
            if f.parent == root.resolve() and f.name not in ("MEMORY.md", "_changelog.md"):
                h.add_edge(f"record:memory-index{rec}", "indexes", f"memory:{idp}{slugify(f.stem)}",
                           f"{rel(index_path)}:{n}")
    log = root / "_changelog.md"
    if log.is_file():
        h.add_node(Node(id=f"record:memory-changelog{rec}", label="Memory changelog", path=str(log).replace("\\", "/"),
                        sensitivity="internal", evidence=f"{rel(log)}:1"))
