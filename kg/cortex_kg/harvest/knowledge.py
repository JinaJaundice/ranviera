"""Harvest the learning folder: claims, arguments, sources and learning sessions (docs/ONTOLOGY.md, "Knowledge family").

The harvester reads <learn_dir> (cfg.learn_dir) with fixed rules and calls no model, so two builds of the same files give
the same graph. It never writes to the folder. Where the folder holds no ledger the harvest is empty, so a set-up with no
learning data builds exactly as before.

What it adds:

- a Claim node for each proposition and an Argument node for each chain, merged as docs/CONTRACTS.md ("Proposition and
  argument ledgers") fixes, with premiseOf and concludes edges;
- a documentedIn edge from a claim to the node of the file it came from where the graph has one (a memory file, a rule
  file, a deliverable), and otherwise to a Source node; a discussedIn edge to each LearnSession in its provenance;
- the evidence of each node from the locators, and the sensitivity of each node computed to a fixed point;
- the derived metrics support, held and calibration, kept in Harvest.knowledge and written by the compiler to
  metrics.knowledge in graph.json and never to the RDF files (docs/CONTRACTS.md, "Derived metrics").

Every edge read here is added to Harvest.extracted, so it carries the provenance extracted, draws at half weight and feeds
no rule until a person ratifies it. The vocabulary pass (compile.add_mentions) adds the mentions edges from the text
kept in Harvest.texts, and add_claim_restatements adds the restates edges from a claim to a rule.
"""
from __future__ import annotations

import json
import logging
import re
from collections import Counter, defaultdict
from pathlib import Path

from ..config import Config, norm_path
from ..model import Harvest, Node, SENSITIVITY

AREA = "knowledge"
FORMAT_VERSION = 1
LINE_KINDS = ("notes", "claude-memory", "claude-instructions", "projects-md")   # kinds whose locator lines name the file itself
FILE_TOOLS = ("read", "ls", "find", "grep")
GRADED_TEACH_TOOLS = ("quiz", "explain")
NODE_ARGS = ("node", "nodeId", "planNode", "node_id")
HELD_RUNGS = (None, "R0", "R1")
CALIBRATION_MIN = 5       # a Cortex proposal (docs/CONTRACTS.md, "Derived metrics")
CALIBRATION_BAND = 0.15   # a Cortex proposal
ARROW = " → "
_RANK = {s: i for i, s in enumerate(SENSITIVITY)}
_log = logging.getLogger(__name__)
_ID = re.compile(r"^[A-Za-z0-9_-]+$")


# ---------------------------------------------------------------- reading the files

def _fwd(p) -> str:
    return str(p).replace("\\", "/")


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def _read_jsonl(path: Path, skipped: list[int] | None = None) -> list[tuple[int, dict]]:
    """(line number, object) for each line that holds a JSON object. The file is read as bytes and split on LF only, and
    each line is decoded on its own, so that a torn multibyte character or a U+2028 inside a string cannot change the
    reading of any other line. A line that does not decode, parse or hold an object is skipped with a warning and never
    repaired, so that a torn append cannot take the graph down (docs/CONTRACTS.md, "Format stamp and strict reads").
    The numbers of the skipped lines are added to skipped when it is given."""
    out: list[tuple[int, dict]] = []
    try:
        data = path.read_bytes()
    except OSError:
        return out
    bad: list[int] = []
    for i, raw in enumerate(data.split(b"\n"), 1):
        if i == 1 and raw.startswith(b"\xef\xbb\xbf"):
            raw = raw[3:]
        if not raw.strip():
            continue
        try:
            obj = json.loads(raw.decode("utf-8").strip(" \t\r"))
        except ValueError:   # UnicodeDecodeError and JSONDecodeError are both ValueError
            bad.append(i)
            continue
        if isinstance(obj, dict):
            out.append((i, obj))
    if bad:
        _log.warning("%s: skipped %d line(s) that did not decode or parse: %s", path.name, len(bad),
                     ", ".join(str(n) for n in bad[:10]) + (" ..." if len(bad) > 10 else ""))
        if skipped is not None:
            skipped.extend(bad)
    return out


def _is_str_list(v) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def _prov_list(v) -> list[tuple[str, str]] | None:
    """The provenance points of a ledger line as (chatId, messageId) pairs, or None where the shape is wrong."""
    if not isinstance(v, list):
        return None
    out = []
    for p in v:
        if not isinstance(p, dict) or not isinstance(p.get("chatId"), str) or not isinstance(p.get("messageId"), str):
            return None
        out.append((p["chatId"], p["messageId"]))
    return out


def merge_nodes(lines: list[tuple[int, dict]]) -> dict[str, dict]:
    """The proposition ledger merged by id. The first line fixes name, statement and createdAt, a later line adds its
    statement and aliases as aliases (an empty string and an exact duplicate are skipped), and provenance is the union of the
    exact pairs in first seen order. A line with a missing field or the wrong type is skipped."""
    merged: dict[str, dict] = {}
    for lineno, o in lines:
        nid = o.get("id")
        prov = _prov_list(o.get("provenance"))
        if not (isinstance(nid, str) and nid.startswith("n_") and len(nid) > 2 and _ID.match(nid)):
            continue
        if not all(isinstance(o.get(k), str) for k in ("createdAt", "name", "statement")):
            continue
        if prov is None or not _is_str_list(o.get("aliases")):
            continue
        cur = merged.get(nid)
        if cur is None:
            cur = merged[nid] = {"id": nid, "name": o["name"], "statement": o["statement"], "createdAt": o["createdAt"],
                                 "aliases": [], "provenance": [], "line": lineno}
            extra = list(o["aliases"])
        else:
            extra = [o["statement"], *o["aliases"]]
        for a in extra:
            if a and a != cur["statement"] and a not in cur["aliases"]:
                cur["aliases"].append(a)
        for p in prov:
            if p not in cur["provenance"]:
                cur["provenance"].append(p)
    return merged


def merge_chains(lines: list[tuple[int, dict]]) -> dict[str, dict]:
    """The argument ledger merged by the key '<sorted premise ids joined by +>><conclusion id>'. The first line fixes the
    id, the premise order and createdAt, and provenance is the union."""
    merged: dict[str, dict] = {}
    for lineno, o in lines:
        cid, concl = o.get("id"), o.get("conclusion")
        prov = _prov_list(o.get("provenance"))
        prem = o.get("premises")
        if not (isinstance(cid, str) and cid.startswith("arg_") and len(cid) > 4 and _ID.match(cid)):
            continue
        if not (isinstance(concl, str) and isinstance(o.get("createdAt"), str) and prov is not None):
            continue
        if not (_is_str_list(prem) and prem):
            continue
        key = "+".join(sorted(prem)) + ">" + concl
        cur = merged.get(key)
        if cur is None:
            cur = merged[key] = {"id": cid, "premises": list(prem), "conclusion": concl, "createdAt": o["createdAt"],
                                 "provenance": [], "line": lineno}
        for p in prov:
            if p not in cur["provenance"]:
                cur["provenance"].append(p)
    return merged


# ---------------------------------------------------------------- identifiers

def claim_node_id(learn_id: str) -> str:
    return "claim:" + learn_id[len("n_"):]


def argument_node_id(learn_id: str) -> str:
    return "argument:" + learn_id[len("arg_"):]


def source_node_id(learn_id: str) -> str:
    return "source:" + learn_id[len("src_"):]


def session_node_id(chat_id: str) -> str:
    return "learnsession:" + chat_id.lower().replace("_", "-")


# ---------------------------------------------------------------- the derived metrics

def held_band(outcomes: list[dict]) -> tuple[str, str | None]:
    """(held, lastTested) from the outcomes of one proposition, ordered by time (docs/CONTRACTS.md, "Derived metrics").
    unknown with no outcome. held with at least 2 outcomes when the newest 2 are both correct, the rung of each is null, R0
    or R1, and none of the newest 3 has the miss class structural. shaky otherwise."""
    if not outcomes:
        return "unknown", None
    last = outcomes[-1].get("at")
    newest2, newest3 = outcomes[-2:], outcomes[-3:]
    ok = (len(outcomes) >= 2
          and all(o.get("correct") is True for o in newest2)
          and all(o.get("rung") in HELD_RUNGS for o in newest2)
          and not any(o.get("missClass") == "structural" for o in newest3))
    return ("held" if ok else "shaky"), last


def calibration_of(outcomes: list[dict]) -> dict | None:
    """The comparison of stated confidence with results, from the outcomes of source choice that carry a confidence. None
    while there are fewer than 5. The figures are rounded to 4 places so that two builds agree."""
    rows = [o for o in outcomes if o.get("source") == "choice" and isinstance(o.get("confidence"), (int, float))
            and not isinstance(o.get("confidence"), bool)]
    n = len(rows)
    if n < CALIBRATION_MIN:
        return None
    mean_conf = sum(o["confidence"] for o in rows) / n / 100
    accuracy = sum(1 for o in rows if o.get("correct") is True) / n
    gap = mean_conf - accuracy
    band = "calibrated" if abs(gap) <= CALIBRATION_BAND else ("overconfident" if gap > 0 else "underconfident")
    return {"n": n, "meanConfidence": round(mean_conf, 4), "accuracy": round(accuracy, 4), "gap": round(gap, 4), "band": band}


# ---------------------------------------------------------------- the sessions

def _session_facts(rec: dict) -> dict:
    """What the record of a session says about the graph: its kind, its phase, the propositions in its graph context
    markers and the paths its file tool calls named. The phase is derived and never stored."""
    ctx: list[str] = []
    paths: list[str] = []
    probe_done = False
    teaching = False
    for m in rec.get("messages") or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role == "custom" and m.get("customType") == "graph-context":
            details = m.get("details") if isinstance(m.get("details"), dict) else {}
            for p in details.get("propositions") or []:
                if isinstance(p, dict) and isinstance(p.get("id"), str):
                    ctx.append(p["id"])
        elif role == "toolResult" and m.get("toolName") == "probe_done" and not m.get("isError"):
            probe_done = True
        elif role == "assistant":
            for block in m.get("content") or []:
                if not (isinstance(block, dict) and block.get("type") == "toolCall"):
                    continue
                args = block.get("arguments") if isinstance(block.get("arguments"), dict) else {}
                name = block.get("name")
                if name in FILE_TOOLS and isinstance(args.get("path"), str):
                    paths.append(args["path"])
                if name in GRADED_TEACH_TOOLS and any(isinstance(args.get(k), str) and args[k] for k in NODE_ARGS):
                    teaching = True
    phase = "teach" if teaching else ("plan" if probe_done else "probe")
    kind = rec.get("kind") if rec.get("kind") in ("teach", "practice") else "teach"
    return {"kind": kind, "phase": phase, "ctx": ctx, "paths": paths}


def _load_sessions(cfg: Config, h: Harvest) -> dict[str, dict]:
    """The session records of <learn_dir>/chats by id. A record stamped newer than this build is left out and reported."""
    out: dict[str, dict] = {}
    folder = cfg.learn_dir / "chats"
    for f in sorted(folder.glob("*.json")) if folder.is_dir() else []:
        rec = _read_json(f)
        if not isinstance(rec, dict) or not isinstance(rec.get("id"), str) or not _ID.match(rec["id"]):
            continue
        if not rec["id"].startswith("chat_") or not isinstance(rec.get("title"), str):
            continue
        version = rec.get("version", 1)
        if not isinstance(version, int) or version > FORMAT_VERSION:
            h.find("B09", "warning", f"The session record {f.name} is stamped with a newer format than this build reads, "
                   f"so it was left out.", None, _fwd(f))
            continue
        facts = _session_facts(rec)
        facts.update(id=rec["id"], title=rec["title"].strip() or rec["id"], path=_fwd(f.resolve()),
                     date=str(rec.get("updatedAt") or rec.get("createdAt") or "")[:10] or None)
        out[rec["id"]] = facts
    return out


# ---------------------------------------------------------------- the sources

class _Sources:
    """The files of the linked roots: where each src_ identifier lives and what the claims from it point at."""

    def __init__(self, learn: Path, merged: Harvest | None):
        reg = _read_json(learn / "cortex" / "sources.json")
        roots = reg.get("roots") if isinstance(reg, dict) else None
        self.roots: dict[str, dict] = {k: v for k, v in sorted((roots or {}).items())
                                       if isinstance(v, dict) and isinstance(v.get("path"), str)}
        recs = _read_json(learn / "graph" / "sources.json")
        self.records: dict[str, dict] = recs if isinstance(recs, dict) else {}
        self.files: dict[str, dict] = {}
        for _n, o in _read_jsonl(learn / "cortex" / "files.jsonl"):
            if isinstance(o.get("sourceId"), str):
                self.files[o["sourceId"]] = o   # the newest line for a source wins
        self.by_path: dict[str, str] = {}
        for n in (merged.nodes.values() if merged else []):
            if n.path and n.id.split(":", 1)[0] not in ("claim", "argument", "source", "learnsession"):
                self.by_path.setdefault(norm_path(n.path), n.id)
        self.nodes_sens = {n.id: n.sensitivity for n in (merged.nodes.values() if merged else [])}
        self._cache: dict[str, dict | None] = {}

    def resolve(self, src_id: str) -> dict | None:
        """{path, kind, rootId, sensitivity, target} for a src_ identifier, or None where no record places it. target is
        the id of the harness node that the file already has, or None where a Source node is needed."""
        if src_id in self._cache:
            return self._cache[src_id]
        root, rel = None, None
        f = self.files.get(src_id)
        if f and f.get("rootId") in self.roots and isinstance(f.get("path"), str):
            root, rel = self.roots[f["rootId"]], f["path"]
        else:
            label = (self.records.get(src_id) or {}).get("filePath")
            if isinstance(label, str):
                best = None
                for rid, r in self.roots.items():
                    lab = r.get("label")
                    if isinstance(lab, str) and label.startswith(lab + "/") and (best is None or len(lab) > len(best[1].get("label"))):
                        best = (rid, r)
                if best:
                    root, rel = best[1], label[len(best[1]["label"]) + 1:]
        if root is None or rel is None:
            self._cache[src_id] = None
            return None
        base = _fwd(root["path"]).rstrip("/")
        path = base if Path(root["path"]).is_file() else f"{base}/{rel}"
        sens = root.get("sensitivity") if root.get("sensitivity") in _RANK else "client-confidential"
        rid = next((k for k, v in self.roots.items() if v is root), "")
        target = self.by_path.get(norm_path(path))
        if target:
            sens = self.nodes_sens.get(target, sens)   # a file that has a node keeps the sensitivity of that node
        info = {"path": path, "kind": root.get("kind") or "notes", "rootId": rid, "sensitivity": sens, "target": target,
                "root_path": base, "rel": rel}
        self._cache[src_id] = info
        return info

    def root_for_path(self, p: str) -> dict | None:
        q = _fwd(p).lower()
        for r in self.roots.values():
            base = _fwd(r["path"]).lower().rstrip("/")
            if q == base or q.startswith(base + "/"):
                return r
        return None


def _higher(a: str, b: str) -> str:
    return a if _RANK[a] >= _RANK[b] else b


# ---------------------------------------------------------------- the harvest

def harvest(cfg: Config, merged: Harvest | None = None) -> Harvest:
    """The knowledge harvest. merged is what the other harvesters found, so that a claim can point at the node of the file
    it came from. Without it every claim gets a Source node."""
    h = Harvest(AREA)
    learn = cfg.learn_dir
    graph_dir = learn / "graph"
    if not graph_dir.is_dir():
        return h
    stamp = _read_json(graph_dir / "format.json")
    if isinstance(stamp, dict) and isinstance(stamp.get("version"), int) and stamp["version"] > FORMAT_VERSION:
        h.find("B09", "warning", "The learning folder is stamped with a newer format than this build reads, so it added no knowledge.",
               None, _fwd(graph_dir / "format.json"))
        return h
    props = merge_nodes(_read_jsonl(graph_dir / "nodes.jsonl"))
    chains = merge_chains(_read_jsonl(graph_dir / "chains.jsonl"))
    if not props and not chains:
        return h

    sessions = _load_sessions(cfg, h)
    src = _Sources(learn, merged)
    locators: dict[str, list[dict]] = defaultdict(list)
    for _n, o in _read_jsonl(learn / "cortex" / "locators.jsonl"):
        if isinstance(o.get("nodeId"), str) and isinstance(o.get("sourceId"), str):
            locators[o["nodeId"]].append(o)
    outcomes: dict[str, list[dict]] = defaultdict(list)
    for _n, o in sorted(((n, o) for n, o in _read_jsonl(learn / "cortex" / "outcomes.jsonl")
                         if isinstance(o.get("at"), str) and isinstance(o.get("target"), list)),
                        key=lambda x: (x[1]["at"], x[0])):
        for t in o["target"]:
            if isinstance(t, str):
                outcomes[t].append(o)

    chains_file = _fwd((graph_dir / "chains.jsonl").resolve())
    edge_ev: dict[tuple[str, str, str], str | None] = {}
    claim_targets: dict[str, list[str]] = {}    # claim node id -> ids of the sources and files it is documented in
    claim_sessions: dict[str, list[str]] = {}   # claim node id -> ids of the sessions that discuss it
    source_nodes: dict[str, dict] = {}          # source node id -> info
    dropped_sources: Counter = Counter()
    dropped_sessions: Counter = Counter()

    def located_line(nid: str, sid: str):
        for lo in locators.get(nid, []):
            if lo.get("sourceId") == sid and lo.get("found") is True:
                return lo
        return None

    claims: dict[str, dict] = {}
    for lid in sorted(props):
        p = props[lid]
        cid = claim_node_id(lid)
        claims[cid] = p
        targets, sess = [], []
        for chat_id in dict.fromkeys(c for c, _m in p["provenance"]):
            if chat_id.startswith("src_") and _ID.match(chat_id):
                info = src.resolve(chat_id)
                if info is None:
                    dropped_sources[lid] += 1
                    continue
                tid = info["target"] or source_node_id(chat_id)
                if info["target"] is None:
                    source_nodes[tid] = {**info, "src": chat_id}
                if tid not in targets:
                    targets.append(tid)
                lo = located_line(lid, chat_id)
                ev = info["path"]
                if lo and info["kind"] in LINE_KINDS and isinstance(lo.get("startLine"), int):
                    ev = f"{ev}:{lo['startLine']}"
                edge_ev[(cid, "documentedIn", tid)] = edge_ev.get((cid, "documentedIn", tid)) or ev
            elif chat_id in sessions:
                sess.append(session_node_id(chat_id))
                edge_ev[(cid, "discussedIn", session_node_id(chat_id))] = sessions[chat_id]["path"]
            elif chat_id.startswith("chat_"):
                dropped_sessions[lid] += 1
        claim_targets[cid] = targets
        claim_sessions[cid] = sess

    # the arguments: one whose conclusion is not a claim is left out whole, and a premise that is not a claim is left out
    args: dict[str, dict] = {}
    dropped_premises = dropped_args = 0
    for key in sorted(chains, key=lambda k: chains[k]["id"]):
        c = chains[key]
        aid = argument_node_id(c["id"])
        if not (c["conclusion"].startswith("n_") and claim_node_id(c["conclusion"]) in claims):
            dropped_args += 1
            continue
        prem = [pid for pid in c["premises"] if pid.startswith("n_") and claim_node_id(pid) in claims]
        dropped_premises += len(c["premises"]) - len(prem)
        if not prem:
            dropped_args += 1
            continue
        args[aid] = {**c, "premises": prem, "learn_id": c["id"]}
    if dropped_args or dropped_premises:
        h.find("B09", "warning", f"The argument ledger names a proposition that has no line in the proposition ledger, so "
               f"{dropped_args} arguments and {dropped_premises} premises were left out.", None, chains_file)
    if dropped_sources:
        h.find("B09", "warning", f"{sum(dropped_sources.values())} source references of {len(dropped_sources)} claims have no "
               f"record that places the file, so no documentedIn edge was added for them.", None, _fwd(learn / "graph" / "sources.json"))
    if dropped_sessions:
        h.find("B09", "warning", f"{sum(dropped_sessions.values())} session references of {len(dropped_sessions)} claims have no "
               f"session record, so no discussedIn edge was added for them.", None, _fwd(learn / "chats"))

    # sensitivity, computed to a fixed point (docs/ONTOLOGY.md, "Sensitivity inheritance")
    sens: dict[str, str] = {}
    for tid, s in source_nodes.items():
        sens[tid] = s["sensitivity"]
    session_base: dict[str, str] = {}
    session_ctx: dict[str, list[str]] = {}
    for chat_id, s in sessions.items():
        sid = session_node_id(chat_id)
        base = "internal"
        for path in s["paths"]:
            root = src.root_for_path(path)
            if root is not None and root.get("sensitivity") in _RANK:
                base = _higher(base, root["sensitivity"])
        session_base[sid] = base
        session_ctx[sid] = [claim_node_id(i) for i in s["ctx"] if i.startswith("n_")]
        sens[sid] = base
    for cid in claims:
        sens[cid] = "internal"
    for aid in args:
        sens[aid] = "internal"

    def known(node_id: str) -> str:
        return sens.get(node_id) or src.nodes_sens.get(node_id) or "internal"

    for _round in range(len(claims) + len(args) + len(sessions) + 2):
        changed = False
        for cid in claims:
            v = "internal"
            for t in claim_targets[cid] + claim_sessions[cid]:
                v = _higher(v, known(t))
            if v != sens[cid]:
                sens[cid], changed = v, True
        for aid, a in args.items():
            v = "internal"
            for pid in [*a["premises"], a["conclusion"]]:
                v = _higher(v, sens[claim_node_id(pid)])
            if v != sens[aid]:
                sens[aid], changed = v, True
        for sid, ctx in session_ctx.items():
            v = session_base[sid]
            for cid in ctx:
                if cid in sens:
                    v = _higher(v, sens[cid])
            if v != sens[sid]:
                sens[sid], changed = v, True
        if not changed:
            break

    # the nodes
    for tid, s in sorted(source_nodes.items()):
        p = {"sourceKind": s["kind"], "rootId": s["rootId"]}
        if s["kind"] == "claude-transcripts":
            p["sessionId"] = Path(s["rel"]).stem
        h.add_node(Node(tid, Path(s["rel"]).name or tid, path=s["path"], sensitivity=sens[tid], props=p, evidence=s["path"]))
    for chat_id, s in sorted(sessions.items()):
        sid = session_node_id(chat_id)
        h.add_node(Node(sid, s["title"], path=s["path"], date=s["date"], sensitivity=sens[sid],
                        props={"sessionKind": s["kind"], "phase": s["phase"]}, evidence=s["path"]))
    claim_evidence: dict[str, str | None] = {}
    for cid, p in sorted(claims.items()):
        lid = p["id"]
        found = [lo for lo in locators.get(lid, []) if lo.get("found") is True]
        ev, located = None, bool(found)
        for lo in found:
            info = src.resolve(lo["sourceId"])
            if info:
                ev = info["path"]
                if info["kind"] in LINE_KINDS and isinstance(lo.get("startLine"), int):
                    ev = f"{ev}:{lo['startLine']}"
                break
        if ev is None:
            for chat_id in dict.fromkeys(c for c, _m in p["provenance"]):
                info = src.resolve(chat_id) if chat_id.startswith("src_") else None
                if info:
                    ev = info["path"]
                    break
                if chat_id in sessions:
                    ev = sessions[chat_id]["path"]
                    break
        claim_evidence[cid] = ev
        props_ = {"statement": p["statement"], "learnId": lid, "unlocated": not located}
        if p["aliases"]:
            props_["alias"] = list(p["aliases"])
        h.add_node(Node(cid, p["name"].strip() or lid, summary=p["statement"], date=p["createdAt"][:10] or None,
                        sensitivity=sens[cid], props=props_, evidence=ev))
        h.texts[cid] = " ".join([p["name"], p["statement"], *p["aliases"]])
    for aid, a in sorted(args.items()):
        names = [claims[claim_node_id(pid)]["name"] for pid in a["premises"]]
        concl = claim_node_id(a["conclusion"])
        text = ", ".join(names) + ARROW + claims[concl]["name"]
        h.add_node(Node(aid, text, date=a["createdAt"][:10] or None, sensitivity=sens[aid],
                        props={"learnId": a["learn_id"], "text": text},
                        evidence=claim_evidence.get(concl)))

    # the edges, each of provenance extracted
    def link(s: str, r: str, t: str, evidence: str | None) -> None:
        if s in h.nodes and t in h.nodes:
            h.add_edge(s, r, t, evidence)
            h.extracted.add((s, r, t))

    def chain_ev(a: dict) -> str:
        return f"{chains_file}:{a['line']}"

    for aid, a in sorted(args.items()):
        for pid in a["premises"]:
            link(claim_node_id(pid), "premiseOf", aid, chain_ev(a))
        link(aid, "concludes", claim_node_id(a["conclusion"]), chain_ev(a))
    for cid in sorted(claims):
        for tid in claim_targets[cid]:
            # the target is a Source node of this harvest, or a node of another harvest that the file already has
            h.add_edge(cid, "documentedIn", tid, edge_ev.get((cid, "documentedIn", tid)))
            h.extracted.add((cid, "documentedIn", tid))
        for sid in claim_sessions[cid]:
            link(cid, "discussedIn", sid, edge_ev.get((cid, "discussedIn", sid)))

    # the derived metrics of each claim
    for cid, p in sorted(claims.items()):
        outs = outcomes.get(p["id"], [])
        held, tested = held_band(outs)
        h.knowledge[cid] = {"support": len({c for c, _m in p["provenance"]}), "held": held, "lastTested": tested,
                            "calibration": calibration_of(outs)}
    return h


# ---------------------------------------------------------------- restatements

MIN_CONTAINMENT = 0.7
MIN_JACCARD = 0.3
MARGIN = 0.1
MIN_WORDS = 4


def add_claim_restatements(h: Harvest) -> int:
    """Add a restates edge from a claim to the rule whose text carries the words of the claim, by the containment and overlap
    tests of cortex_kg.restate. The edge is computed, is drawn at half weight as for every computed link of this kind and is
    ratified through the assertions file. A claim that fits two rules equally is left undecided. Returns the number added."""
    from ..restate import _NEGATION, words
    claims = sorted((n for n in h.nodes.values() if n.id.startswith("claim:")), key=lambda n: n.id)
    if not claims:
        return 0
    rules = {n.id: (words(str(n.props.get("text") or "")), str(n.props.get("text") or ""))
             for n in h.nodes.values() if n.id.startswith("rule:") and n.status not in ("retired", "superseded", "archived")
             and n.props.get("text")}
    index: dict[str, list[str]] = defaultdict(list)
    for rid, (ws, _t) in rules.items():
        for w in ws:
            index[w].append(rid)
    added = 0
    for c in claims:
        statement = str(c.props.get("statement") or c.summary or "")
        cw = words(statement)
        if len(cw) < MIN_WORDS:
            continue
        hits: Counter = Counter()
        for w in cw:
            hits.update(index.get(w, ()))
        scored = []
        for rid, common in hits.items():
            rw, rtext = rules[rid]
            cont, jac = common / len(cw), common / len(cw | rw)
            agree = bool(_NEGATION.search(statement)) == bool(_NEGATION.search(rtext))
            if agree and cont >= MIN_CONTAINMENT and jac >= MIN_JACCARD:
                scored.append((cont, jac, rid))
        scored.sort(key=lambda x: (-x[0], -x[1], x[2]))
        if scored and (len(scored) == 1 or scored[0][0] - scored[1][0] >= MARGIN or scored[0][1] - scored[1][1] >= MARGIN):
            h.add_edge(c.id, "restates", scored[0][2],
                       f"computed: {scored[0][0]:.2f} of the claim's words appear in the rule")
            added += 1
    return added
