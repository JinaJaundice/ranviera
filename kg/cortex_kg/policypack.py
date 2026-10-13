"""The policy pack: the policy clauses, controls, obligations, provisions and typologies that a bank keeps for itself.

The files are <profile_dir>/policy/*.json, one file for each source or business area, in the PolicyPackFile shape of
docs/CONTRACTS.md (section 'The policy pack'). The build reads every file and merges its nodes and edges as stated content.
The links that a person decides, from an instruction to a clause, from a clause to a control and from a control to an
obligation, are mappings in the mapping store and never edges of a pack, because each needs a maker and a checker.

`graph_parts` gives the nodes and edges for the build in the shape of mappings.graph_parts. Node ids use the prefixes of
model.CLASS_TO_PREFIX (clause:, control:, obligation:, provision:, typology: and riskind:), and a Procedure takes the
prefix of a Policy. A file that holds a node class outside the list of the contract, a node whose id does not match its
class, or an edge of a relation that the mapping store owns is refused as a whole and reported as finding B08.

A clause or a provision carries `text` and `hash`. Where a file gives the text and no hash, the hash is the sha256 of the
text, so that rule O05 can find a clause that was amended after a mapping was ratified.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .model import CLASS_TO_PREFIX, RELATIONS, prefix_of

NODE_TYPES = ("PolicyClause", "Policy", "Procedure", "Control", "Obligation", "LegislativeProvision", "Typology",
              "RiskIndicator")
# the relations of the mapping store, which a pack never states
MAPPING_RELATIONS = ("implementsClause", "realises", "satisfies", "notDischargedBy", "detects")
# the id prefix of each class of a pack: a Procedure is a kind of Policy
PREFIX = {t: CLASS_TO_PREFIX.get(t) or "policy" for t in NODE_TYPES}


class PolicyPackError(ValueError):
    """A refused pack file. The message is one sentence that names the file and the reason."""


def policy_dir(profile_dir: str | Path) -> Path:
    return Path(profile_dir) / "policy"


def pack_files(profile_dir: str | Path) -> list[Path]:
    d = policy_dir(profile_dir)
    return sorted(d.glob("*.json")) if d.is_dir() else []


def text_hash(text: str) -> str:
    """The sha256 of a text, written sha256: and 64 hexadecimal characters."""
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise PolicyPackError(f"The policy pack file {path.name} cannot be read: {exc}") from None
    if not isinstance(data, dict) or data.get("v") != 1 or not isinstance(data.get("nodes"), list) \
            or not isinstance(data.get("edges", []), list):
        raise PolicyPackError(f"The policy pack file {path.name} is not version 1.")
    return data


def _check_node(name: str, n: dict) -> None:
    if not isinstance(n, dict) or not isinstance(n.get("id"), str) or not n["id"]:
        raise PolicyPackError(f"The policy pack file {name} holds a node with no identifier.")
    nid, typ = n["id"], n.get("type")
    if typ not in NODE_TYPES:
        raise PolicyPackError(f"The policy pack file {name} gives the node {nid} the class {typ}, which is not one of "
                              f"{', '.join(NODE_TYPES)}.")
    if prefix_of(nid) != PREFIX[typ]:
        raise PolicyPackError(f"The policy pack file {name} gives the node {nid} the class {typ}, whose identifiers start "
                              f"{PREFIX[typ]}:.")
    if not isinstance(n.get("label"), str) or not n["label"].strip():
        raise PolicyPackError(f"The policy pack file {name} holds the node {nid} with no label.")
    if not isinstance(n.get("props", {}), dict):
        raise PolicyPackError(f"The policy pack file {name} holds the node {nid} with props that are not an object.")


def _check_edge(name: str, e: dict) -> None:
    if not isinstance(e, dict) or not all(isinstance(e.get(k), str) and e[k] for k in ("s", "r", "t")):
        raise PolicyPackError(f"The policy pack file {name} holds an edge with no source, relation or target.")
    if e["r"] in MAPPING_RELATIONS:
        raise PolicyPackError(f"The policy pack file {name} states the edge {e['s']} {e['r']} {e['t']}, but the relation "
                              f"{e['r']} belongs to the mapping store, where a maker and a checker decide it.")
    if e["r"] not in RELATIONS:
        raise PolicyPackError(f"The policy pack file {name} states the edge {e['s']} {e['r']} {e['t']}, and {e['r']} is not "
                              "a relation of the ontology.")


def _file_parts(path: Path) -> tuple[list[dict], list[dict]]:
    data = _read(path)
    name = path.name
    nodes, edges = [], []
    for n in data["nodes"]:
        _check_node(name, n)
        props = dict(n.get("props") or {})
        if isinstance(props.get("text"), str) and not props.get("hash"):
            props["hash"] = text_hash(props["text"])
        if n["type"] == "LegislativeProvision":
            if data.get("licence"):
                props.setdefault("licence", data["licence"])
            if data.get("attribution"):
                props.setdefault("attribution", data["attribution"])
        if n["type"] == "Procedure":
            props.setdefault("kind", "Procedure")
        props.setdefault("pack", data.get("name") or name)
        # a web address is the evidence that check P08 accepts for a source that is not a file of the profile
        evidence = props.get("source_url") if str(props.get("source_url") or "").startswith("https://") else None
        nodes.append({"id": n["id"], "type": n["type"] if n["type"] != "Procedure" else "Policy", "label": n["label"],
                      "status": n.get("status"), "evidence": evidence, "sensitivity": "internal", "props": props})
    for e in data["edges"]:
        _check_edge(name, e)
        edges.append({"s": e["s"], "r": e["r"], "t": e["t"], "evidence": e.get("evidence"),
                      "provenance": "stated", "weight": 1.0})
    return nodes, edges


def graph_parts(profile_dir: str | Path, problems: list[str] | None = None) -> tuple[list[dict], list[dict]]:
    """The nodes and stated edges of every pack file of the profile, with a node that two files both give merged on its id
    (the first value of each prop wins). A refused file adds nothing. Where `problems` is a list, the sentence for each
    refused file is appended to it for the build to report as B08, and where it is None the first refusal raises
    PolicyPackError."""
    nodes: dict[str, dict] = {}
    edges: dict[tuple[str, str, str], dict] = {}
    for path in pack_files(profile_dir):
        try:
            n_part, e_part = _file_parts(path)
        except PolicyPackError as exc:
            if problems is None:
                raise
            problems.append(str(exc))
            continue
        for n in n_part:
            old = nodes.get(n["id"])
            if old is None:
                nodes[n["id"]] = n
            else:
                for k, v in n["props"].items():
                    old["props"].setdefault(k, v)
        for e in e_part:
            edges.setdefault((e["s"], e["r"], e["t"]), e)
    return sorted(nodes.values(), key=lambda n: n["id"]), list(edges.values())
