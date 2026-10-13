"""Import of legislation from legislation.gov.uk XML (docs/CONTRACTS.md, importer outputs).

The text is Crown copyright, published under the Open Government Licence v3.0, and each snapshot carries the attribution.
Nothing is fetched unless fetch is true. A saved page is read with from_file. A new version of an instrument writes a new
snapshot and the old one moves to the archive folder beside it.

A provision is a regulation (P1) or one of its numbered paragraphs (P2), with the lower levels folded into the text of the
paragraph. Each provision whose text states a duty, a prohibition or a permission also gives an obligation node of the pack shape that
points back to it by expressedIn.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from . import edge, node, sha256_text, write_json

LICENCE = "Open Government Licence v3.0"
ATTRIBUTION = "Contains public sector information licensed under the Open Government Licence v3.0."
NS = "{http://www.legislation.gov.uk/namespaces/legislation}"
DCT_VALID = "{http://purl.org/dc/terms/}valid"
DC_TITLE = "{http://purl.org/dc/elements/1.1/}title"
ORIGIN = "legislation.gov.uk"

# the instruments that the build knows, with the provisions to keep. A regulation number selects its lettered variants.
INSTRUMENTS: dict[str, dict] = {
    "uksi/2017/692": {"short": "MLR 2017", "unit": "regulation", "abbr": "reg",
                      "select": [(18, 21), (27, 28)]},
    "uksi/2019/855": {"short": "Russia Regulations 2019", "unit": "regulation", "abbr": "reg",
                      "select": [(11, 13), (70, 70)]},
    "ukpga/2017/3": {"short": "PCA 2017", "unit": "section", "abbr": "s", "select": [(146, 146)]},
}

_DEONTIC = [
    ("Prohibition", "F", re.compile(r"\b(must not|may not|is prohibited|are prohibited|shall not)\b", re.I)),
    ("Obligation", "O", re.compile(r"\b(must|is required to|are required to|shall|has a duty to)\b", re.I)),
    ("Permission", "P", re.compile(r"\b(may|is entitled to|is permitted to)\b", re.I)),
]
_BEARER = re.compile(r"^(?:\(\d+\)\s*)?((?:an?|the|any)\s+[a-z][a-z' -]{2,50}?)\s+(?:must|may|shall|is required)", re.I)


def canonical_id(instrument: str) -> str:
    """'uksi-2017-692' and 'uksi/2017/692' both give 'uksi/2017/692'."""
    s = instrument.strip().strip("/").replace("-", "/")
    s = re.sub(r"^https?://www\.legislation\.gov\.uk/", "", s)
    return s


def slug_of(instrument: str) -> str:
    return canonical_id(instrument).replace("/", "-")


def source_url(instrument: str, at: str | None = None) -> str:
    base = f"https://www.legislation.gov.uk/{canonical_id(instrument)}"
    return f"{base}/{at}/data.xml" if at else f"{base}/data.xml"


def fetch_xml(instrument: str, at: str | None = None, timeout: float = 240.0) -> bytes:
    req = urllib.request.Request(source_url(instrument, at), headers={"User-Agent": "ranviera-importer"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # the one outbound call, made only when fetch is asked for
        return resp.read()


# ---- parsing ------------------------------------------------------------------------------------------------------------

def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace(" ", " ")).strip()


def _flat(el: ET.Element, top: bool = True) -> str:
    """The text of a paragraph with its lower levels written as (a), (i) and so on."""
    out: list[str] = []
    for ch in el:
        name = _local(ch.tag)
        if name == "Text":
            out.append("".join(ch.itertext()))
        elif name == "Pnumber":
            if not top:
                out.append(f"({''.join(ch.itertext())})")
        elif name in ("Title", "CommentaryRef"):
            continue
        else:
            out.append(_flat(ch, top=name.endswith("para") and top))
    return _clean(" ".join(out))


def _selected(num: str, ranges: list[tuple[int, int]] | None) -> bool:
    if not ranges:
        return True
    m = re.match(r"\d+", num)
    if not m:
        return False
    n = int(m.group())
    return any(lo <= n <= hi for lo, hi in ranges)


def parse(xml_bytes: bytes, instrument: str, select: list[tuple[int, int]] | None = None) -> tuple[dict, list[dict]]:
    """The snapshot facts and the provision records of the selected regulations. The sha256 of the snapshot is the hash of
    the bytes that were read."""
    iid = canonical_id(instrument)
    spec = INSTRUMENTS.get(iid, {"short": None, "unit": "regulation", "abbr": "reg", "select": None})
    ranges = select if select is not None else spec["select"]
    root = ET.fromstring(xml_bytes)
    meta_title = next((e.text or "" for e in root.iter(DC_TITLE)), "")
    valid = next((e.text for e in root.iter(DCT_VALID) if e.text), None) or root.attrib.get("RestrictStartDate") or ""
    short = spec["short"] or _clean(meta_title) or iid
    parent = {c: p for p in root.iter() for c in p}
    body = root.find(f"{NS}Primary") if root.find(f"{NS}Primary") is not None else root.find(f"{NS}Secondary")
    scope = body if body is not None else root
    unit = spec["unit"]
    abbr = spec["abbr"]
    slug = slug_of(iid)
    eli = f"https://www.legislation.gov.uk/{iid}"
    out: list[dict] = []
    for p1 in scope.iter(f"{NS}P1"):
        pid = p1.attrib.get("id", "")
        if not pid.startswith(unit + "-"):
            continue
        tail = pid[len(unit) + 1:]
        if "-" in tail or not _selected(tail, ranges):
            continue
        grp = parent.get(p1)
        heading = ""
        if grp is not None and _local(grp.tag) == "P1group":
            t = grp.find(f"{NS}Title")
            heading = _clean("".join(t.itertext())) if t is not None else ""
        # direct P2 children of this P1 only
        p2s = [c for para in p1.findall(f"{NS}P1para") for c in para.findall(f"{NS}P2")]
        p1_id = f"provision:{slug}-{abbr}-{tail}"
        own = "" if p2s else _flat(p1.find(f"{NS}P1para") if p1.find(f"{NS}P1para") is not None else p1)
        out.append(_record(p1_id, f"{short} {abbr} {tail}" + (f" {heading}" if heading else ""), own, valid,
                           f"{eli}/{unit}/{tail}", slug))
        for p2 in p2s:
            num = _clean("".join(p2.find(f"{NS}Pnumber").itertext())) if p2.find(f"{NS}Pnumber") is not None else ""
            if not num:
                continue
            p2_id = f"provision:{slug}-{abbr}-{tail}-{num}"
            p2_para = p2.find(f"{NS}P2para")
            text = _flat(p2_para if p2_para is not None else p2)
            out.append(_record(p2_id, f"{short} {abbr} {tail}({num})" + (f" {heading}" if heading else ""), text, valid,
                               f"{eli}/{unit}/{tail}/{num}", p1_id))
    snapshot = {"id": iid, "url": f"https://www.legislation.gov.uk/{iid}", "fetched": None, "version_date": valid,
                "sha256": hashlib.sha256(xml_bytes).hexdigest(), "licence": LICENCE,
                "attribution": ATTRIBUTION, "title": _clean(meta_title), "short": short}
    return snapshot, out


def _record(pid: str, label: str, text: str, valid: str, eli_uri: str, part_of: str) -> dict:
    return {"id": pid, "iri": f"https://cortex.local/provision/{pid.split(':', 1)[1]}", "label": label, "text": text,
            "version_date": valid, "hash": sha256_text(text), "eli_uri": eli_uri, "part_of": part_of}


# ---- the graph ----------------------------------------------------------------------------------------------------------

def classify(text: str) -> tuple[str, str] | None:
    """The deontic class and modality letter of a statement, or None where it states none. A prohibition is tested first."""
    for cls, letter, rx in _DEONTIC:
        if rx.search(text):
            return cls, letter
    return None


def to_nodes(provisions: list[dict]) -> tuple[list[dict], list[dict]]:
    """Nodes of the pack shape. A provision is a LegislativeProvision of family obligation, public and with the origin
    legislation.gov.uk, and a provision that states a duty also gives an Obligation node with an expressedIn edge."""
    nodes: list[dict] = []
    edges: list[dict] = []
    for p in provisions:
        props = {"origin": ORIGIN, "kind": "Paragraph" if p["part_of"].startswith("provision:") else "Regulation",
                 "iri": p["iri"], "eli_uri": p["eli_uri"], "effective_date": p["version_date"], "version_date": p["version_date"],
                 "hash": p["hash"], "licence": LICENCE, "source_ref": p["eli_uri"], "part_of": p["part_of"]}
        if p["text"]:
            props["description"] = p["text"]
        nodes.append(node(p["id"], "LegislativeProvision", p["label"], props, sensitivity="public", evidence=p["eli_uri"]))
        found = classify(p["text"]) if p["text"] else None
        if found:
            cls, letter = found
            oid = "obligation:" + p["id"].split(":", 1)[1] + "-d"
            oprops = {"origin": ORIGIN, "kind": cls, "modality": letter, "effective_date": p["version_date"],
                      "hash": sha256_text(p["text"] + "|" + letter), "action": p["text"][:160]}
            m = _BEARER.match(p["text"])
            if m:
                oprops["bearer"] = m.group(1)
            nodes.append(node(oid, "Obligation", f"{p['label']} - {cls.lower()}", oprops, sensitivity="public", evidence=p["eli_uri"]))
            edges.append(edge(oid, "expressedIn", p["id"], p["eli_uri"]))
    return nodes, edges


# ---- the command --------------------------------------------------------------------------------------------------------

@dataclass
class LegislationResult:
    instrument: str
    snapshot: dict = field(default_factory=dict)
    provisions: list[dict] = field(default_factory=list)
    nodes: list[dict] = field(default_factory=list)
    edges: list[dict] = field(default_factory=list)
    changed: bool = True
    warnings: list[str] = field(default_factory=list)


def import_instrument(cfg, instrument: str, *, fetch: bool = False, from_file: Path | str | None = None, at: str | None = None,
                      select: list[tuple[int, int]] | None = None, today: str | None = None) -> LegislationResult:
    """Read one instrument from a saved page or, with fetch, from legislation.gov.uk, and write the snapshot and the
    provisions in <data_dir>/imports/legislation/. With neither, the page saved there by an earlier run is read."""
    iid = canonical_id(instrument)
    slug = slug_of(iid)
    folder = Path(cfg.data_dir) / "imports" / "legislation"
    saved = folder / f"{slug}.xml"
    result = LegislationResult(instrument=iid)
    if from_file is not None:
        data = Path(from_file).read_bytes()
    elif fetch:
        try:
            data = fetch_xml(iid, at)
        except OSError as exc:  # a failed fetch is reported and nothing is written
            result.warnings.append(f"{iid}: fetch failed ({type(exc).__name__})")
            return result
    elif saved.is_file():
        data = saved.read_bytes()
    else:
        result.warnings.append(f"{iid}: no saved page, and no outbound call without --fetch")
        return result
    snap, provisions = parse(data, iid, select)
    snap["fetched"] = today or date.today().isoformat()
    if not provisions:
        result.warnings.append(f"{iid}: no provision selected")
    old_path = folder / f"{slug}.snapshot.json"
    if old_path.is_file():
        old = json.loads(old_path.read_text(encoding="utf-8"))
        if old.get("sha256") == snap["sha256"]:
            result.changed = False
            snap["fetched"] = old.get("fetched", snap["fetched"])
        else:
            archive = folder / "archive"
            archive.mkdir(parents=True, exist_ok=True)
            tag = f"{old.get('version_date') or 'unknown'}-{str(old.get('sha256', ''))[:8]}"
            for suffix in ("snapshot.json", "provisions.json", "xml"):
                src = folder / f"{slug}.{suffix}"
                if src.is_file():
                    shutil.move(str(src), str(archive / f"{slug}.{tag}.{suffix}"))
    folder.mkdir(parents=True, exist_ok=True)
    if result.changed:
        saved.write_bytes(data)
    write_json(old_path, snap)
    write_json(folder / f"{slug}.provisions.json", provisions)
    result.snapshot, result.provisions = snap, provisions
    result.nodes, result.edges = to_nodes(provisions)
    return result


def load_saved(cfg, instruments: list[str]) -> tuple[list[dict], list[dict]]:
    """The nodes and edges of the provisions files that earlier runs wrote, for the compile step."""
    nodes: list[dict] = []
    edges: list[dict] = []
    folder = Path(cfg.data_dir) / "imports" / "legislation"
    for i in instruments:
        f = folder / f"{slug_of(i)}.provisions.json"
        if f.is_file():
            n, e = to_nodes(json.loads(f.read_text(encoding="utf-8")))
            nodes += n
            edges += e
    return nodes, edges


__all__ = ["import_instrument", "parse", "to_nodes", "classify", "load_saved", "canonical_id", "INSTRUMENTS"]
