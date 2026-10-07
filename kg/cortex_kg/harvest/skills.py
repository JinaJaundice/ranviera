"""Harvest the skills: each skill, its reference files and guides, and the rules and sections of each."""
from __future__ import annotations

from pathlib import Path

from ..config import Config
from .. import md
from ..ledger import Ledger
from ..model import Harvest, Node, slugify
from .harness import Checked, frontmatter, fwd, harvest_doc


def harvest(cfg: Config, ledger: Ledger, today: str) -> Harvest:
    h = Harvest("skills")
    home = cfg.claude_home
    seen_keys: set[str] = set()
    read = Checked(h)

    def doc_file(file_id: str, path: Path, key: str, label: str, summary: str | None = None,
                 props: dict | None = None) -> None:
        text = read(path)
        h.add_node(Node(file_id, label, path=fwd(path), summary=summary, sensitivity="internal",
                        evidence=md.evidence(cfg, path, 1), props=props or {}))
        h.texts[file_id] = text
        seen_keys.add(key)
        harvest_doc(h, ledger, today, cfg, file_id=file_id, path=path, file_key=key, text=text, extras=True)

    for sdir in sorted(x for x in (home / "skills").glob("*") if x.is_dir()):
        skill_md = sdir / "SKILL.md"
        if not skill_md.is_file():
            continue
        sid = f"skill:{slugify(sdir.name)}"
        fm = frontmatter(read(skill_md))
        doc_file(sid, skill_md, f"skill-{slugify(sdir.name)}", fm.get("name") or sdir.name, fm.get("description"),
                 {"name": fm.get("name") or sdir.name, "description": fm.get("description", "")})
        for p in sorted(sdir.rglob("*.md")):
            if p == skill_md or "__pycache__" in p.parts:
                continue
            prefix = "reference" if p.parent.name == "references" else "guide"   # a skill's references folder
            fid = f"{prefix}:{slugify(p.stem)}"
            doc_file(fid, p, slugify(p.stem), p.stem)
            h.add_edge(sid, "contains", fid, md.evidence(cfg, p, 1))

    h.rule_file_keys = seen_keys  # type: ignore[attr-defined]
    return h
