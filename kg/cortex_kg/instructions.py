"""The instruction store: the instructions of a deployed agent, kept by the bank and approved by a second person.

The file is <profile_dir>/instructions/<agent>.json and the text of each version is
<profile_dir>/instructions/<agent>/<version-slug>.md. The format is in docs/CONTRACTS.md, in the section 'The
instruction store'. A version is drafted by a maker and approved by an approver who is a different person (O06). The
hash of a version is recomputed from its text file at each load, so an edit of the text outside Ranviera changes `hash`
and leaves `approved_hash` as it was, which is what rule O06 reports.

The store never reads the graph. `graph_parts` gives the nodes and edges for the build in the shape of
mappings.graph_parts, and `ledger_entry` gives the body of the ledger entry that an approval must also write.

Commands: instructions draft ID --text-file F --by MAKER, instructions approve VERSION --by APPROVER, instructions
withdraw VERSION --by PERSON, instructions list [--agent A]. Exit 0 on success, 2 on a refused or invalid request.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime, timezone
from pathlib import Path

from .fileio import write_atomic
from .model import slugify

STATUSES = ("draft", "approved", "withdrawn")
RISK_TIERS = ("high", "medium", "low")


class InstructionError(ValueError):
    """A refused change. The message is one sentence that names the reason."""


def instructions_dir(profile_dir: str | Path) -> Path:
    return Path(profile_dir) / "instructions"


def agent_slug(agent: str) -> str:
    """The slug of an agent id, which is the file name of its store. 'dagent:alert-triage' gives 'alert-triage'."""
    a = (agent or "").strip()
    if a.startswith("dagent:"):
        a = a[7:]
    return slugify(a)


def agent_node(agent: str) -> str:
    return f"dagent:{agent_slug(agent)}"


def store_path(profile_dir: str | Path, agent: str) -> Path:
    return instructions_dir(profile_dir) / f"{agent_slug(agent)}.json"


def version_slug(version_id: str) -> str:
    return slugify(version_id[6:] if version_id.startswith("instr:") else version_id, 120)


def text_path(profile_dir: str | Path, agent: str, version_id: str) -> Path:
    return instructions_dir(profile_dir) / agent_slug(agent) / f"{version_slug(version_id)}.md"


def person_node(person: str) -> str:
    p = (person or "").strip()
    return p if p.startswith("person:") else f"person:{slugify(p)}"


def file_hash(path: Path) -> str | None:
    """The sha256 of a text file as stored, written sha256: and 64 hexadecimal characters, or None where it is absent."""
    try:
        return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _stamp(now: datetime | None) -> datetime:
    return now or datetime.now(timezone.utc)


def _ts(now: datetime | None) -> str:
    return _stamp(now).strftime("%Y-%m-%dT%H:%M:%SZ")


def _day(now: datetime | None) -> str:
    return _stamp(now).strftime("%Y-%m-%d")


def _actor(by: str | None, what: str) -> str:
    if by is None or not str(by).strip():
        raise InstructionError(f"{what} needs the person who acts.")
    return str(by).strip()


def _same_person(a: str | None, b: str | None) -> bool:
    return (a or "").strip().lower() == (b or "").strip().lower()


def _entry(now: datetime | None, action: str, by: str, note: str | None) -> dict:
    return {"ts": _ts(now), "action": action, "by": by, "note": note}


def agents(profile_dir: str | Path) -> list[str]:
    d = instructions_dir(profile_dir)
    return sorted(f.stem for f in d.glob("*.json")) if d.is_dir() else []


def load(profile_dir: str | Path, agent: str) -> dict:
    """The store of one agent, with the hash of each version recomputed from its text file."""
    p = store_path(profile_dir, agent)
    if not p.is_file():
        raise InstructionError(f"No instruction store exists for the agent {agent}.")
    data = json.loads(p.read_text(encoding="utf-8-sig"))
    if data.get("v") != 1 or not isinstance(data.get("instructions"), list):
        raise InstructionError(f"The instruction file {p.name} is not version 1.")
    for ins in data["instructions"]:
        for v in ins.get("versions", []):
            v["hash"] = file_hash(instructions_dir(profile_dir) / agent_slug(agent) / v["text"])
    return data


def save(profile_dir: str | Path, data: dict) -> Path:
    p = store_path(profile_dir, data["agent"])
    write_atomic(p, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return p


def _locate_version(profile_dir: str | Path, version_id: str) -> tuple[dict, dict, dict]:
    for a in agents(profile_dir):
        data = load(profile_dir, a)
        for ins in data["instructions"]:
            for v in ins["versions"]:
                if v["id"] == version_id:
                    return data, ins, v
    raise InstructionError(f"No instruction version has the id {version_id}.")


def _locate_instruction(profile_dir: str | Path, instruction_id: str, agent: str | None) -> tuple[dict, dict] | None:
    for a in ([agent_slug(agent)] if agent else agents(profile_dir)):
        try:
            data = load(profile_dir, a)
        except InstructionError:
            continue
        for ins in data["instructions"]:
            if ins["id"] == instruction_id:
                return data, ins
    return None


def find_instruction(profile_dir: str | Path, ident: str, agent: str | None = None) -> tuple[dict, dict] | None:
    """The store and the logical instruction that an instruction id or a version id names."""
    hit = _locate_instruction(profile_dir, ident, agent)
    if hit:
        return hit
    try:
        data, ins, _v = _locate_version(profile_dir, ident)
    except InstructionError:
        return None
    return data, ins


def in_force(v: dict, day: str | None = None) -> bool:
    """Whether a version is approved and its interval holds on the day (YYYY-MM-DD, today by default). The interval is
    closed at its start and open at its end, so that the version replaced on a day is no longer in force on that day."""
    if v.get("status") != "approved":
        return False
    day = day or date.today().isoformat()
    if v.get("valid_from") and v["valid_from"] > day:
        return False
    return not v.get("valid_to") or v["valid_to"] > day


def draft(profile_dir: str | Path, instruction_id: str, *, text: str, by: str, agent: str | None = None,
          label: str | None = None, file: str | None = None, detects: list[str] | None = None,
          now: datetime | None = None) -> dict:
    """Write a new version of status draft with the next number and return it. A new logical instruction needs the
    agent, a label and the instruction file that holds it."""
    by = _actor(by, "A draft")
    if not text or not text.strip():
        raise InstructionError("A draft needs text.")
    hit = _locate_instruction(profile_dir, instruction_id, agent)
    if hit is None:
        if not agent or not label or not file:
            raise InstructionError(f"No instruction has the id {instruction_id}. A new instruction needs the agent, a "
                                   "label and the instruction file.")
        data = load(profile_dir, agent)
        if not instruction_id.startswith(f"instr:{agent_slug(agent)}-"):
            raise InstructionError(f"The id of an instruction of this agent starts with instr:{agent_slug(agent)}-.")
        ins = {"id": instruction_id, "label": label, "file": file, "versions": []}
        if detects:
            ins["detects"] = list(detects)
        data["instructions"].append(ins)
    else:
        data, ins = hit
    slug_agent = agent_slug(data["agent"])
    n = max([v["version"] for v in ins["versions"]] or [0]) + 1
    vid = f"{instruction_id}-v{n}"
    path = text_path(profile_dir, slug_agent, vid)
    write_atomic(path, text if text.endswith("\n") else text + "\n")
    rec = {
        "id": vid, "version": n, "text": path.name, "hash": file_hash(path), "status": "draft", "maker": by,
        "approver": None, "approved_hash": None, "valid_from": None, "valid_to": None,
        "history": [_entry(now, "draft", by, None)],
    }
    ins["versions"].append(rec)
    save(profile_dir, data)
    return rec


def ledger_entry(rec: dict, kind: str = "instruction.approve") -> dict:
    """The body of the run ledger entry that an approval or a withdrawal must also write."""
    last = rec["history"][-1]
    return {"kind": kind, "actor": last["by"], "ts": last["ts"], "version": rec["id"], "status": rec["status"],
            "hash": rec["approved_hash"] or rec["hash"], "note": last["note"]}


def approve(profile_dir: str | Path, version_id: str, *, by: str, note: str | None = None,
            now: datetime | None = None) -> dict:
    """Approve a draft. The approver must differ from the maker, case and surrounding spaces ignored. The approved hash is
    the hash of the text file now, and the interval of the version that this one replaces is closed on the same day."""
    data, ins, rec = _locate_version(profile_dir, version_id)
    by = _actor(by, "An approval")
    if rec["status"] != "draft":
        raise InstructionError(f"{version_id} is {rec['status']} and only a draft can be approved.")
    if _same_person(by, rec["maker"]):
        raise InstructionError(f"{version_id} cannot be approved by its maker, because the approver must be a different "
                               "person.")
    if rec["hash"] is None:
        raise InstructionError(f"The text file of {version_id} is absent, so it cannot be approved.")
    day = _day(now)
    for other in ins["versions"]:
        if other is not rec and other["status"] == "approved" and not other.get("valid_to"):
            other["valid_to"] = day
    rec["status"] = "approved"
    rec["approver"] = by
    rec["approved_hash"] = rec["hash"]
    rec["valid_from"] = day
    rec["history"].append(_entry(now, "approve", by, note))
    save(profile_dir, data)
    return rec


def withdraw(profile_dir: str | Path, version_id: str, *, by: str, note: str | None = None,
             now: datetime | None = None) -> dict:
    data, _ins, rec = _locate_version(profile_dir, version_id)
    by = _actor(by, "A withdrawal")
    if rec["status"] == "withdrawn":
        raise InstructionError(f"{version_id} is already withdrawn.")
    rec["status"] = "withdrawn"
    if not rec.get("valid_to"):
        rec["valid_to"] = _day(now)
    rec["history"].append(_entry(now, "withdraw", by, note))
    save(profile_dir, data)
    return rec


def list_versions(profile_dir: str | Path, agent: str | None = None) -> list[dict]:
    """Every version with its instruction and agent, in file order."""
    out = []
    for a in ([agent_slug(agent)] if agent else agents(profile_dir)):
        data = load(profile_dir, a)
        for ins in data["instructions"]:
            for v in ins["versions"]:
                out.append({**v, "instruction": ins["id"], "label": ins["label"], "file": ins["file"],
                            "agent": data["agent"], "in_force": in_force(v)})
    return out


def graph_parts(profile_dir: str | Path) -> tuple[list[dict], list[dict]]:
    """The InstructionVersion, DeployedAgent, ModelVersion and Person nodes, and the edges operatesUnder (approved
    versions only), proposedBy, approvedBy, conflictsWith, overrides, detects, ownedBy and drawsOn. The evidence of a
    version is instructions/<agent>.json#<id>."""
    nodes: dict[str, dict] = {}
    edges: list[dict] = []

    def person(p: str) -> str:
        pid = person_node(p)
        nodes.setdefault(pid, {"id": pid, "type": "Person", "label": p, "status": None, "evidence": None,
                               "sensitivity": "internal", "props": {}})
        return pid

    for a in agents(profile_dir):
        data = load(profile_dir, a)
        aid = agent_node(data["agent"])
        ev_agent = f"instructions/{a}.json"
        nodes[aid] = {"id": aid, "type": "DeployedAgent", "label": data["agent"], "status": None, "evidence": ev_agent,
                      "sensitivity": "internal",
                      "props": {"owner": data.get("owner"), "intendedUse": data.get("intended_use"),
                                "riskTier": data.get("risk_tier")}}
        if data.get("owner"):
            edges.append({"s": aid, "r": "ownedBy", "t": person(data["owner"]), "evidence": ev_agent,
                          "provenance": "stated", "weight": 1.0})
        for mid in data.get("approved_models", []):
            nodes[mid] = {"id": mid, "type": "ModelVersion", "label": mid.split(":", 1)[-1], "status": "approved",
                          "evidence": ev_agent, "sensitivity": "internal", "props": {}}
            edges.append({"s": aid, "r": "drawsOn", "t": mid, "evidence": ev_agent, "provenance": "stated",
                          "weight": 1.0})
        for ins in data["instructions"]:
            for v in ins["versions"]:
                ev = f"instructions/{a}.json#{v['id']}"
                nodes[v["id"]] = {
                    "id": v["id"], "type": "InstructionVersion", "label": f"{ins['label']} (version {v['version']})",
                    "status": v["status"], "evidence": ev, "sensitivity": "internal",
                    "props": {"hash": v["hash"], "approvedHash": v.get("approved_hash"), "validFrom": v.get("valid_from"),
                              "validTo": v.get("valid_to"), "version": v["version"], "instruction": ins["id"],
                              "file": ins["file"]},
                }
                if v["status"] == "approved":
                    edges.append({"s": aid, "r": "operatesUnder", "t": v["id"], "evidence": ev, "provenance": "stated",
                                  "weight": 1.0})
                if v.get("maker"):
                    edges.append({"s": v["id"], "r": "proposedBy", "t": person(v["maker"]), "evidence": ev,
                                  "provenance": "stated", "weight": 1.0})
                if v.get("approver"):
                    edges.append({"s": v["id"], "r": "approvedBy", "t": person(v["approver"]), "evidence": ev,
                                  "provenance": "stated", "weight": 1.0})
                for rel, key in (("conflictsWith", "conflicts_with"), ("overrides", "overrides")):
                    for t in v.get(key) or []:
                        edges.append({"s": v["id"], "r": rel, "t": t, "evidence": ev, "provenance": "stated",
                                      "weight": 1.0})
                for t in ins.get("detects") or []:
                    edges.append({"s": v["id"], "r": "detects", "t": t, "evidence": ev, "provenance": "stated",
                                  "weight": 1.0})
    return sorted(nodes.values(), key=lambda n: n["id"]), edges


# ---------------------------------------------------------------- command line

def _config(path: str | None):
    from .config import load_config
    return load_config(path)


def _refuse(msg: str) -> int:
    print(msg)
    return 2


def main(argv: list[str] | None = None) -> int:
    """instructions draft|approve|withdraw|list. Exit 0 on success, 2 on a refused or invalid request."""
    import argparse
    from . import people as ppl
    from .runledger import RunLedger
    argv = list(argv or [])
    if argv and argv[0] == "instructions":
        argv = argv[1:]
    ap = argparse.ArgumentParser(prog="instructions")
    ap.add_argument("--config")
    ap.add_argument("--json", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("draft")
    d.add_argument("id")
    d.add_argument("--text-file", required=True)
    d.add_argument("--by")
    d.add_argument("--agent")
    d.add_argument("--label")
    d.add_argument("--file")
    a_ = sub.add_parser("approve")
    a_.add_argument("version")
    a_.add_argument("--by")
    a_.add_argument("--note")
    w = sub.add_parser("withdraw")
    w.add_argument("version")
    w.add_argument("--by")
    w.add_argument("--note")
    ls = sub.add_parser("list")
    ls.add_argument("--agent")
    # --json and --config may follow the subcommand as well
    for p in (d, a_, w, ls):
        p.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        p.add_argument("--config", default=argparse.SUPPRESS)
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    cfg = _config(a.config)
    profile = cfg.profile_dir
    try:
        if a.cmd == "list":
            out = list_versions(profile, a.agent)
            print(json.dumps(out, indent=2) if a.json else
                  "\n".join(f"{v['id']}  {v['status']}{'  in force' if v['in_force'] else ''}" for v in out)
                  or "No instructions are stored.")
            return 0
        people = ppl.load_people(cfg)
        by = (a.by or ppl.actor(cfg) or "").strip()
        if not by:
            return _refuse("The command needs the person who acts, through --by or the configured actor.")
        action = {"draft": "draft", "approve": "approve", "withdraw": "withdraw"}[a.cmd]
        if a.cmd == "draft":
            record = None
        else:
            record = _locate_version(profile, a.version)[2]
        ok, why = ppl.can(people, by, action, record)
        if not ok:
            return _refuse(why)
        if a.cmd == "draft":
            text = Path(a.text_file).read_text(encoding="utf-8")
            rec = draft(profile, a.id, text=text, by=by, agent=a.agent, label=a.label, file=a.file)
            msg = f"Drafted {rec['id']}."
        elif a.cmd == "approve":
            rec = approve(profile, a.version, by=by, note=a.note)
            body = ledger_entry(rec, "instruction.approve")
            key = Path(cfg.ledger_key).read_bytes().strip() if cfg.ledger_key else None
            RunLedger(cfg.data_dir).append("instruction.approve", body, actor=by, key=key)
            msg = f"Approved {rec['id']} from {rec['valid_from']}."
        else:
            rec = withdraw(profile, a.version, by=by, note=a.note)
            msg = f"Withdrew {rec['id']}."
    except (InstructionError, OSError, ValueError, KeyError) as exc:
        return _refuse(f"The request was refused: {exc}")
    print(json.dumps(rec, indent=2) if a.json else msg)
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:]))
