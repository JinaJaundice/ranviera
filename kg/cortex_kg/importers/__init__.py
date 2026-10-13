"""The obligation importers of docs/CONTRACTS.md (7 October 2026).

legislation reads MLR 2017 and the sanctions provisions from legislation.gov.uk XML. The private pack loaders, which the
public product does not hold, map local obligation packs and the workbooks of an obligation hub to the graph and write the
import manifest. They read the packs from the folders that the configuration names and hold none of their content. Every importer returns nodes and edges in the shape that packs.to_nodes returns.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

ORIGIN_HUB = "local-pack"


def local_loader():
    """The private module that loads the local obligation packs, or None where the installation holds none. It is found by
    its suffix, so that the public code names no private file."""
    import importlib
    import pkgutil
    for info in pkgutil.iter_modules(__path__):
        if info.name.endswith("_loader"):
            mod = importlib.import_module(f"{__name__}.{info.name}")
            if hasattr(mod, "import_pack"):
                return mod
    return None


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> tuple[str, int]:
    data = Path(path).read_bytes()
    return hashlib.sha256(data).hexdigest(), len(data)


def norm_id(identifier: str) -> str:
    """The join key of the reconciliation: lower case with every space removed, so that 'MLR2017 reg 1(1)' and
    'MLR 2017 reg 1(1)' meet."""
    return re.sub(r"\s+", "", str(identifier)).lower()


def instrument_key(identifier: str) -> str:
    """The letters of the words that come before the first number of an identifier, as a key for the row counts of an
    instrument. 'MLR2017 reg 74(6)' and 'MLR 2017 reg 1(1)' both give 'mlr'."""
    words: list[str] = []
    for w in str(identifier).split():
        if w[:1].isdigit():
            break
        words.append(w)
    if words and words[-1].lower() in ("reg", "para", "s", "art", "article", "regulation", "sch", "paragraph"):
        words.pop()
    return re.sub(r"[^a-z]", "", " ".join(words).lower())


def node(nid: str, ntype: str, label: str, props: dict, *, sensitivity: str = "internal", evidence: str = "", family: str = "obligation") -> dict:
    return {"id": nid, "type": ntype, "label": label, "family": family, "sensitivity": sensitivity,
            "evidence": evidence, "props": props}


def edge(s: str, r: str, t: str, evidence: str = "", status: str = "stated") -> dict:
    return {"s": s, "r": r, "t": t, "status": status, "evidence": evidence}


def opt_path(env_name: str, key: str, cfg) -> Path | None:
    """A configuration key that names a path. The environment variable overrides the key, and null means not set."""
    raw = getattr(cfg, "raw", None) or {}
    v = os.environ.get(env_name) or raw.get(key)
    return Path(str(v)).expanduser() if isinstance(v, (str, os.PathLike)) and str(v).strip() else None


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    os.replace(tmp, path)
