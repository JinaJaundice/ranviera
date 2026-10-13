"""The run ledger: a hash chained, append only record of every run step, approval and ratification.

The format is set out in docs/CONTRACTS.md (section 'The run ledger') and docs/TRACE.md. Each entry is one line of
<data_dir>/ledger/YYYY-MM.jsonl. The head, which names the last entry and may carry an HMAC signature, is
<data_dir>/ledger/head.json. The normalised records themselves are kept beside the graph in
<data_dir>/runs/<run>.records.jsonl so that verify can recompute each record hash.

A chain detects an alteration or a deletion of an entry that sits before the head. A deletion of the last entry, or a
rewrite of the whole chain, is detected only where the head is signed with a key that the writer does not hold.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .fileio import write_atomic

ZERO_HASH = "0" * 64
KINDS = ("run.record", "instruction.approve", "instruction.publish", "mapping.ratify", "mapping.reject",
         "mapping.reassign", "review")
_MONTH = re.compile(r"^\d{4}-\d{2}\.jsonl$")


def canonical(obj) -> str:
    """Canonical JSON: sorted keys, separators , and :, UTF-8 text and no non-finite numbers."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def record_hash(obj) -> str:
    return sha256_hex(canonical(obj))


def now_ts() -> str:
    t = datetime.now(timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def entry_hash_of(entry: dict) -> str:
    return record_hash({k: v for k, v in entry.items() if k != "entry_hash"})


def head_message(seq: int, entry_hash: str) -> str:
    return canonical({"v": 1, "seq": seq, "entry_hash": entry_hash})


def sign(key: bytes, seq: int, entry_hash: str) -> str:
    return hmac.new(key, head_message(seq, entry_hash).encode("utf-8"), hashlib.sha256).hexdigest()


@dataclass
class VerifyReport:
    ok: bool = True
    entries: int = 0
    breaks: list[dict] = field(default_factory=list)       # {seq, reason}
    runs: dict[str, dict] = field(default_factory=dict)    # run -> {captured, reported, status}
    signature: str = "unchecked"                           # valid, invalid, unsigned, unchecked
    head_seq: int = 0

    def to_json(self) -> dict:
        return {"v": 1, "ok": self.ok, "entries": self.entries, "head_seq": self.head_seq, "breaks": self.breaks,
                "runs": self.runs, "signature": self.signature}


class RunLedger:
    def __init__(self, data_dir: str | os.PathLike):
        self.data_dir = Path(data_dir)
        self.dir = self.data_dir / "ledger"
        self.head_path = self.dir / "head.json"
        self.runs_dir = self.data_dir / "runs"

    # reading

    def month_files(self) -> list[Path]:
        if not self.dir.is_dir():
            return []
        return sorted(p for p in self.dir.iterdir() if _MONTH.match(p.name))

    def entries(self) -> list[dict]:
        """Every line in order. A line that is not JSON becomes {"_bad_line": text, "_file": name}."""
        out: list[dict] = []
        for p in self.month_files():
            for text in p.read_text(encoding="utf-8").splitlines():
                if not text.strip():
                    continue
                try:
                    obj = json.loads(text)
                    if not isinstance(obj, dict):
                        raise ValueError("not an object")
                except ValueError:
                    obj = {"_bad_line": text[:80], "_file": p.name}
                out.append(obj)
        return out

    def head(self) -> dict | None:
        if not self.head_path.is_file():
            return None
        try:
            return json.loads(self.head_path.read_text(encoding="utf-8"))
        except ValueError:
            return None

    def known(self) -> dict[tuple[str, int], str]:
        """(run, step) -> record_hash for every run record already in the ledger."""
        out = {}
        for e in self.entries():
            if e.get("kind") == "run.record" and e.get("run") is not None:
                out[(e["run"], e["step"])] = e.get("record_hash")
        return out

    # writing

    def append(self, kind: str, record, *, run: str | None = None, step: int | None = None, actor: str = "system",
               ts: str | None = None, key: bytes | None = None, key_id: str | None = None) -> dict:
        if kind not in KINDS:
            raise ValueError(f"unknown ledger kind {kind!r}")
        head = self.head()
        entries = self.entries() if head is None else None
        if head is None and entries:
            raise ValueError("the ledger has entries but no head, so it cannot be extended")
        seq = (head["seq"] if head else 0) + 1
        prev = head["entry_hash"] if head else ZERO_HASH
        ts = ts or now_ts()
        entry = {"v": 1, "seq": seq, "ts": ts, "kind": kind, "run": run, "step": step, "actor": actor,
                 "record_hash": record_hash(record), "prev_hash": prev}
        entry["entry_hash"] = entry_hash_of(entry)
        self.dir.mkdir(parents=True, exist_ok=True)
        path = self.dir / f"{ts[:7]}.jsonl"
        with open(path, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(canonical(entry) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        self._write_head(seq, entry["entry_hash"], key, key_id)
        return entry

    def _write_head(self, seq: int, entry_hash: str, key: bytes | None, key_id: str | None) -> None:
        head = {"v": 1, "seq": seq, "entry_hash": entry_hash, "signed_at": None, "alg": None, "key_id": None,
                "signature": None}
        if key:
            head.update(signed_at=now_ts(), alg="hmac-sha256", key_id=key_id or "ledger_key",
                        signature=sign(key, seq, entry_hash))
        write_atomic(self.head_path, json.dumps(head, indent=2) + "\n")

    def sign_head(self, key: bytes, key_id: str | None = None) -> dict:
        head = self.head()
        if not head:
            raise ValueError("there is no head to sign")
        self._write_head(head["seq"], head["entry_hash"], key, key_id)
        return self.head()

    # verification

    def verify(self, head_path: str | os.PathLike | None = None, key: bytes | None = None) -> VerifyReport:
        rep = VerifyReport()

        def brk(seq, reason):
            rep.ok = False
            rep.breaks.append({"seq": seq, "reason": reason})

        entries = self.entries()
        rep.entries = len(entries)
        prev, expect = ZERO_HASH, 1
        for e in entries:
            if "_bad_line" in e:
                brk(expect, f"a line in {e['_file']} is not valid JSON, so an entry was altered")
                continue
            seq = e.get("seq")
            if seq != expect:
                brk(expect, f"expected entry {expect} and found {seq}, so an entry was deleted or moved")
                expect = seq if isinstance(seq, int) else expect
            if e.get("prev_hash") != prev:
                brk(seq, "prev_hash does not match the entry before it")
            if e.get("entry_hash") != entry_hash_of(e):
                brk(seq, "entry_hash does not match the content, so the entry was altered")
            prev = e.get("entry_hash")
            expect = (seq if isinstance(seq, int) else expect) + 1

        head = None
        if head_path:
            try:
                head = json.loads(Path(head_path).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                brk(0, "the head file cannot be read")
        else:
            head = self.head()
        if head is None and not head_path:
            if entries:
                brk(0, "the ledger has entries and no head")
        elif head is not None:
            rep.head_seq = head.get("seq", 0)
            last = entries[-1] if entries else None
            if last is None and head.get("seq"):
                brk(head["seq"], "the head names entries that are absent")
            elif last is not None and "_bad_line" not in last:
                if head.get("seq") != last.get("seq") or head.get("entry_hash") != last.get("entry_hash"):
                    brk(head.get("seq", 0), "the head does not name the last entry, so entries at the end were "
                                            "deleted or added")
            if head.get("signature"):
                if key is None:
                    rep.signature = "unchecked"
                elif hmac.compare_digest(str(head["signature"]),
                                         sign(key, head.get("seq", 0), head.get("entry_hash", ""))):
                    rep.signature = "valid"
                else:
                    rep.signature = "invalid"
                    brk(head.get("seq", 0), "the head signature does not match the key")
            else:
                rep.signature = "unsigned"

        self._check_runs(entries, brk, rep)
        return rep

    def _check_runs(self, entries: list[dict], brk, rep: VerifyReport) -> None:
        by_run: dict[str, dict[int, dict]] = {}
        for e in entries:
            if e.get("kind") == "run.record" and e.get("run") is not None and isinstance(e.get("step"), int):
                by_run.setdefault(e["run"], {})[e["step"]] = e
        stored = self._stored_records()
        for run, steps in by_run.items():
            recs = stored.get(run, {})
            for n, e in steps.items():
                rec = recs.get(n)
                if rec is not None and record_hash(rec) != e.get("record_hash"):
                    brk(e["seq"], f"the stored record of {run} step {n} does not match its record_hash")
            missing = [n for n in range(max(steps) + 1) if n not in steps]
            info = {"captured": len(steps), "reported": None, "status": "complete"}
            end = recs.get(max(steps))
            if end is not None and end.get("kind") == "end":
                info["reported"] = end["payload"].get("steps_reported")
            else:
                info["status"] = "open"
            if missing:
                info["status"] = "incomplete"
                brk(steps[min(steps)]["seq"], f"{run} is missing step {missing[0]} of the ledger")
            elif info["reported"] is not None and info["reported"] != max(steps):
                info["status"] = "incomplete"
                brk(steps[max(steps)]["seq"],
                    f"{run} reports {info['reported']} steps and the ledger holds {max(steps)}")
            rep.runs[run] = info

    def _stored_records(self) -> dict[str, dict[int, dict]]:
        out: dict[str, dict[int, dict]] = {}
        if not self.runs_dir.is_dir():
            return out
        for p in sorted(self.runs_dir.glob("*.records.jsonl")):
            for text in p.read_text(encoding="utf-8").splitlines():
                if not text.strip():
                    continue
                try:
                    rec = json.loads(text)
                    out.setdefault(rec["run"], {})[rec["step"]] = rec
                except (ValueError, KeyError, TypeError):
                    continue
        return out

    def write_report(self, rep: VerifyReport) -> Path:
        path = self.dir / "verify.json"
        write_atomic(path, json.dumps(rep.to_json(), indent=2) + "\n")
        return path


def main(argv: list[str] | None = None) -> int:
    """ledger verify [--head FILE] [--data-dir DIR] [--key-file FILE] [--json]. Exit 0 ok, 1 on a break, 2 on a bad request."""
    import argparse
    if argv and argv[0] == "verify":
        argv = argv[1:]
    ap = argparse.ArgumentParser(prog="ledger verify")
    ap.add_argument("--head")
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--key-file")
    ap.add_argument("--json", action="store_true")
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    key = None
    if a.key_file:
        try:
            key = Path(a.key_file).read_bytes().strip()
        except OSError as exc:
            print(f"The key file cannot be read: {exc}")
            return 2
    led = RunLedger(a.data_dir)
    rep = led.verify(a.head, key)
    led.write_report(rep)
    if a.json:
        print(json.dumps(rep.to_json(), indent=2))
    else:
        print(f"Ledger entries {rep.entries}, head {rep.head_seq}, signature {rep.signature}, "
              f"{len(rep.breaks)} break(s).")
        for b in rep.breaks:
            print(f"  entry {b['seq']}: {b['reason']}")
    return 0 if rep.ok else 1


if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:]))
