# Copyright 2026 Cortex contributors. Licensed under the Apache License, Version 2.0 (see ../LICENSE).
"""Read the proposition and argument ledgers of the learning folder.

Usage: graph.py [--learn-dir PATH] [--format markdown|json] <command>
  propositions [--session ID]   the merged propositions, sorted by id
  find QUERY                    names, statements and aliases, with * as the only wildcard
  chains [--node ID]            the merged arguments, optionally those that touch one proposition
  births                        the number of propositions by birth source, with clusters of 3 or more
The merge is the one in the contracts, "Proposition and argument ledgers". The reader never writes.
"""
from __future__ import annotations

import argparse
import sys

sys.dont_write_bytecode = True

import re
from pathlib import Path

import _data as D

LEDGER_NOTE = "Recorded propositions and reasoning, not mastery and not guaranteed truth."
CLUSTER_MIN = 3


# ---------------------------------------------------------------- shape checks

def _provenance_problem(value) -> str | None:
    if not isinstance(value, list):
        return "provenance is not a list"
    for point in value:
        if not isinstance(point, dict) or not isinstance(point.get("chatId"), str) \
                or not isinstance(point.get("messageId"), str):
            return "a provenance point lacks a text chatId or messageId"
    return None


def check_node(obj) -> str | None:
    if not isinstance(obj, dict):
        return "the line is not an object"
    for key in ("id", "createdAt", "name", "statement"):
        if not isinstance(obj.get(key), str):
            return f"the field {key} is missing or not text"
    aliases = obj.get("aliases")
    if not isinstance(aliases, list) or not all(isinstance(a, str) for a in aliases):
        return "aliases is not a list of text"
    return _provenance_problem(obj.get("provenance"))


def check_chain(obj) -> str | None:
    if not isinstance(obj, dict):
        return "the line is not an object"
    for key in ("id", "createdAt", "conclusion"):
        if not isinstance(obj.get(key), str):
            return f"the field {key} is missing or not text"
    premises = obj.get("premises")
    if not isinstance(premises, list) or not premises or not all(isinstance(p, str) for p in premises):
        return "premises is not a non empty list of text"
    return _provenance_problem(obj.get("provenance"))


# ---------------------------------------------------------------- merge

def _union(into: list[dict], points: list[dict]) -> None:
    seen = {(p["chatId"], p["messageId"]) for p in into}
    for p in points:
        key = (p["chatId"], p["messageId"])
        if key not in seen:
            seen.add(key)
            into.append({"chatId": p["chatId"], "messageId": p["messageId"]})


def merge_nodes(lines: list[dict]) -> dict[str, dict]:
    """First line fixes name, statement and createdAt. Later statements and aliases become aliases, skipping an empty
    string, the fixed statement and an exact duplicate, as the server and the harvester do. Order is kept."""
    nodes: dict[str, dict] = {}
    for line in lines:
        node = nodes.get(line["id"])
        if node is None:
            node = {"id": line["id"], "name": line["name"], "statement": line["statement"],
                    "createdAt": line["createdAt"], "aliases": [], "provenance": []}
            nodes[line["id"]] = node
            extra = list(line["aliases"])
        else:
            extra = [line["statement"], *line["aliases"]]
        for alias in extra:
            if alias and alias != node["statement"] and alias not in node["aliases"]:
                node["aliases"].append(alias)
        _union(node["provenance"], line["provenance"])
    return nodes


def chain_key(premises: list[str], conclusion: str) -> str:
    return "+".join(sorted(premises)) + ">" + conclusion


def merge_chains(lines: list[dict]) -> dict[str, dict]:
    """Keyed by the sorted premise ids and the conclusion. The first line fixes id, premise order and createdAt."""
    chains: dict[str, dict] = {}
    for line in lines:
        key = chain_key(line["premises"], line["conclusion"])
        chain = chains.get(key)
        if chain is None:
            chain = {"id": line["id"], "premises": list(line["premises"]), "conclusion": line["conclusion"],
                     "createdAt": line["createdAt"], "provenance": []}
            chains[key] = chain
        _union(chain["provenance"], line["provenance"])
    return chains


def birth_source(node: dict) -> str | None:
    return node["provenance"][0]["chatId"] if node["provenance"] else None


def load_graph(root: Path, problems: D.Problems) -> tuple[dict[str, dict], dict[str, dict]]:
    D.check_graph_format(root)
    node_lines = [obj for _, obj in D.read_jsonl(root, "graph/nodes.jsonl", problems, check_node)]
    chain_lines = [obj for _, obj in D.read_jsonl(root, "graph/chains.jsonl", problems, check_chain)]
    return merge_nodes(node_lines), merge_chains(chain_lines)


# ---------------------------------------------------------------- find

def fold(text: str) -> str:
    """Case folding as the application's regular expression does it, not Python's wider rules.

    Each character is upper cased on its own. It stays as it is when it lies outside the basic plane, when its
    upper case form has more than one character, or when a character beyond ASCII would turn into ASCII.
    """
    out = []
    for ch in text:
        if ord(ch) > 0xFFFF:
            out.append(ch)
            continue
        up = ch.upper()
        if len(up) != 1 or (ord(ch) > 127 and ord(up) < 128):
            out.append(ch)
        else:
            out.append(up)
    return "".join(out)


def compile_query(query: str) -> re.Pattern:
    """A query with no star matches as a substring. A star stands for any characters, newlines included."""
    pattern = query if "*" in query else f"*{query}*"
    body = ".*".join(re.escape(fold(part)) for part in pattern.split("*"))
    return re.compile(body, re.DOTALL)


def find_nodes(nodes: dict[str, dict], query: str) -> list[dict]:
    if query == "":
        raise D.ReaderError("The search text is empty.")
    rx = compile_query(query)
    hits = []
    for node in nodes.values():
        fields = [node["name"], node["statement"], *node["aliases"]]
        if any(rx.fullmatch(fold(f)) for f in fields):
            hits.append(node)
    return hits


# ---------------------------------------------------------------- births

def _stem(file_path: str) -> str:
    name = file_path.replace("\\", "/").rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[0] if "." in name.strip(".") else name


def source_labels(root: Path, problems: D.Problems) -> tuple[dict, dict]:
    """Source records and display names, read leniently. A bad file is reported and the labels fall back."""
    records: dict = {}
    names: dict = {}
    try:
        data = D.read_json(root, "graph/sources.json", {})
        if isinstance(data, dict):
            records = {k: v for k, v in data.items() if isinstance(v, dict)}
        else:
            problems.add("graph/sources.json", None, "does not hold an object")
    except D.ReaderError as exc:
        problems.add("graph/sources.json", None, str(exc))
    try:
        org = D.read_json(root, "graph/source-organization.json", None)
        if org is not None:
            if not isinstance(org, dict) or org.get("version") != 1 or not isinstance(org.get("placements"), dict):
                problems.add("graph/source-organization.json", None, "unsupported or malformed, display names ignored")
            else:
                for sid, place in org["placements"].items():
                    if isinstance(place, dict) and isinstance(place.get("name"), str) and place["name"].strip():
                        names[sid] = place["name"].strip()
    except D.ReaderError as exc:
        problems.add("graph/source-organization.json", None, str(exc))
    return records, names


def birth_table(root: Path, nodes: dict[str, dict], problems: D.Problems) -> list[dict]:
    records, names = source_labels(root, problems)
    counts: dict[str, int] = {}
    for node in nodes.values():
        b = birth_source(node)
        if b is not None:
            counts[b] = counts.get(b, 0) + 1
    rows = []
    for sid in sorted(counts):
        row = {"id": sid, "propositions": counts[sid], "kind": "missing", "label": sid,
               "createdAt": None, "updatedAt": None, "cluster": counts[sid] >= CLUSTER_MIN}
        if sid.startswith("chat_"):
            try:
                chat = D.read_chat(root, sid)
                row.update(kind="chat", label=chat["title"], createdAt=chat["createdAt"], updatedAt=chat["updatedAt"])
            except D.ReaderError as exc:
                problems.add(f"chats/{sid}.json", None, f"label unavailable: {exc}")
        elif sid in records:
            rec = records[sid]
            path = rec.get("filePath") if isinstance(rec.get("filePath"), str) else sid
            row.update(kind="notes", label=names.get(sid) or _stem(path), createdAt=rec.get("importedAt"),
                       updatedAt=rec.get("importedAt"))
        rows.append(row)
    return rows


# ---------------------------------------------------------------- rendering

def support(node: dict) -> int:
    return len({p["chatId"] for p in node["provenance"]})


def node_view(node: dict) -> dict:
    return {**node, "birthSource": birth_source(node), "support": support(node)}


def node_markdown(node: dict) -> list[str]:
    lines = [f"### {D.one_line(node['name'])} ({D.one_line(node['id'])})", ""]
    lines += D.quoted(node["statement"])
    lines.append("")
    lines.append(f"- Created: {D.one_line(node['createdAt'])}")
    if node["aliases"]:
        lines.append("- Aliases:")
        lines += [f"  - {D.one_line(a)}" for a in node["aliases"]]
    lines.append(f"- Support (distinct sources): {support(node)}")
    if node["provenance"]:
        lines.append("- Provenance:")
        for p in node["provenance"]:
            where = D.one_line(p["messageId"]) if p["messageId"] else "(source level)"
            lines.append(f"  - {D.one_line(p['chatId'])}, {where}")
    else:
        lines.append("- Provenance: none")
    lines.append("")
    return lines


def chain_markdown(chain: dict, nodes: dict[str, dict]) -> list[str]:
    lines = [f"### {D.one_line(chain['id'])}", "",
             f"- Premises (used together): {', '.join(D.one_line(p) for p in chain['premises'])}",
             f"- Conclusion: {D.one_line(chain['conclusion'])}",
             f"- Created: {D.one_line(chain['createdAt'])}", ""]
    for label, nid in [*[("Premise", p) for p in chain["premises"]], ("Conclusion", chain["conclusion"])]:
        node = nodes.get(nid)
        if node is None:
            lines.append(f"- {label} {D.one_line(nid)}: (missing proposition)")
        else:
            lines.append(f"- {label} {D.one_line(nid)}, {D.one_line(node['name'])}:")
            lines += ["  " + q for q in D.quoted(node["statement"])]
    lines.append("")
    return lines


def header(root: Path, title: str, count: int) -> list[str]:
    return [f"# {title}", "", f"Learning folder: {D.one_line(root)}", f"Count: {count}", "",
            LEDGER_NOTE, "", D.NOTICE, ""]


# ---------------------------------------------------------------- commands

def _nonempty(value: str, what: str) -> str:
    if value == "":
        raise D.ReaderError(f"{what} is empty.")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(prog="graph.py", description=__doc__.split("\n")[0])
    D.add_common(parser, top=True)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("propositions")
    p.add_argument("--session")
    D.add_common(p, top=False)
    p = sub.add_parser("find")
    p.add_argument("query")
    D.add_common(p, top=False)
    p = sub.add_parser("chains")
    p.add_argument("--node")
    D.add_common(p, top=False)
    p = sub.add_parser("births")
    D.add_common(p, top=False)
    args = parser.parse_args()

    root = D.resolve_root(args.learn_dir)
    problems = D.Problems()
    nodes, chains = load_graph(root, problems)

    if args.command in ("propositions", "find"):
        if args.command == "find":
            hits = find_nodes(nodes, _nonempty(args.query, "The search text"))
            title = "Propositions matching a search"
        else:
            hits = sorted(nodes.values(), key=lambda n: n["id"])
            if args.session is not None:
                sid = _nonempty(args.session, "The session id")
                hits = [n for n in hits if birth_source(n) == sid]
            title = "Propositions"
        md = header(root, title, len(hits))
        for node in hits:
            md += node_markdown(node)
        D.emit(args, {"learn_dir": str(root), "note": LEDGER_NOTE, "count": len(hits),
                      "propositions": [node_view(n) for n in hits]}, md, problems)
    elif args.command == "chains":
        found = sorted(chains.values(), key=lambda c: c["id"])
        if args.node is not None:
            nid = _nonempty(args.node, "The node id")
            found = [c for c in found if c["conclusion"] == nid or nid in c["premises"]]
        md = header(root, "Reasoning chains", len(found))
        for chain in found:
            md += chain_markdown(chain, nodes)
        payload = {"learn_dir": str(root), "note": LEDGER_NOTE, "count": len(found),
                   "chains": [{**c, "premiseNodes": [nodes.get(p) for p in c["premises"]],
                               "conclusionNode": nodes.get(c["conclusion"])} for c in found]}
        D.emit(args, payload, md, problems)
    else:
        rows = birth_table(root, nodes, problems)
        md = header(root, "Propositions by birth source", len(rows))
        for r in rows:
            mark = " (cluster)" if r["cluster"] else ""
            md.append(f"- {D.one_line(r['id'])}, {r['kind']}, {D.one_line(r['label'])}: "
                      f"{r['propositions']} propositions{mark}")
        D.emit(args, {"learn_dir": str(root), "note": LEDGER_NOTE, "count": len(rows), "births": rows}, md, problems)
    return 0


if __name__ == "__main__":
    sys.exit(D.run(main))
