"""Tests of the hash chained run ledger. Every fixture is synthetic."""
import json
from pathlib import Path

from cortex_kg import ingest_run, runledger
from cortex_kg.runledger import RunLedger, ZERO_HASH

FIX = Path(__file__).parent / "fixtures" / "runs"


def ingested(tmp_path, key=None):
    ingest_run.ingest((FIX / "triage.run.v1.jsonl").read_text(encoding="utf-8"), tmp_path, key=key)
    return RunLedger(tmp_path)


def month_file(led):
    return led.month_files()[0]


def rewrite(path, fn):
    rows = [json.loads(t) for t in path.read_text(encoding="utf-8").splitlines()]
    rows = fn(rows)
    path.write_text("".join(runledger.canonical(r) + "\n" for r in rows), encoding="utf-8", newline="\n")


def test_canonical_json_is_sorted_and_compact():
    assert runledger.canonical({"b": 1, "a": "é"}) == '{"a":"é","b":1}'


def test_chain_links_and_verifies(tmp_path):
    led = ingested(tmp_path)
    rows = led.entries()
    assert [r["seq"] for r in rows] == [1, 2, 3, 4, 5, 6]
    assert rows[0]["prev_hash"] == ZERO_HASH
    assert all(rows[i]["prev_hash"] == rows[i - 1]["entry_hash"] for i in range(1, 6))
    rep = led.verify()
    assert rep.ok and rep.signature == "unsigned"
    assert rep.runs["R-001"] == {"captured": 6, "reported": 5, "status": "complete"}


def test_a_month_file_is_named_from_the_entry_date(tmp_path):
    led = RunLedger(tmp_path)
    led.append("review", {"a": 1}, ts="2026-11-30T23:59:59.000Z")
    led.append("review", {"a": 2}, ts="2026-12-01T00:00:00.000Z")
    assert [p.name for p in led.month_files()] == ["2026-11.jsonl", "2026-12.jsonl"]
    assert led.verify().ok


def test_altered_entry_is_detected(tmp_path):
    led = ingested(tmp_path)

    def alter(rows):
        rows[2]["actor"] = "someone"
        return rows
    rewrite(month_file(led), alter)
    rep = led.verify()
    assert not rep.ok and any(b["seq"] == 3 and "altered" in b["reason"] for b in rep.breaks)


def test_altered_entry_with_recomputed_hash_breaks_the_next_link(tmp_path):
    led = ingested(tmp_path)

    def alter(rows):
        rows[2]["actor"] = "someone"
        rows[2]["entry_hash"] = runledger.entry_hash_of(rows[2])
        return rows
    rewrite(month_file(led), alter)
    rep = led.verify()
    assert not rep.ok and any(b["seq"] == 4 and "prev_hash" in b["reason"] for b in rep.breaks)


def test_deleted_middle_entry_is_detected(tmp_path):
    led = ingested(tmp_path)
    rewrite(month_file(led), lambda rows: rows[:2] + rows[3:])
    rep = led.verify()
    assert not rep.ok and any("deleted" in b["reason"] for b in rep.breaks)
    assert rep.runs["R-001"]["status"] == "incomplete"


def test_deleted_last_entry_is_detected_through_the_head(tmp_path):
    led = ingested(tmp_path)
    rewrite(month_file(led), lambda rows: rows[:-1])
    rep = led.verify()
    assert not rep.ok and any("head does not name the last entry" in b["reason"] for b in rep.breaks)


def test_unparseable_line_is_a_break(tmp_path):
    led = ingested(tmp_path)
    with open(month_file(led), "a", encoding="utf-8") as fh:
        fh.write("not json\n")
    assert not led.verify().ok


def test_stored_record_that_was_altered_is_detected(tmp_path):
    led = ingested(tmp_path)
    p = next(led.runs_dir.glob("*.records.jsonl"))
    rows = [json.loads(t) for t in p.read_text(encoding="utf-8").splitlines()]
    rows[1]["payload"]["tool"] = "other"
    p.write_text("".join(runledger.canonical(r) + "\n" for r in rows), encoding="utf-8", newline="\n")
    rep = led.verify()
    assert not rep.ok and any("record_hash" in b["reason"] for b in rep.breaks)


def test_signed_head_verifies_and_a_wrong_key_fails(tmp_path):
    led = ingested(tmp_path, key=b"bank-key")
    assert led.verify(key=b"bank-key").signature == "valid"
    rep = led.verify(key=b"other-key")
    assert not rep.ok and rep.signature == "invalid"
    assert led.verify().signature == "unchecked"


def test_signed_head_catches_a_rewritten_head(tmp_path):
    led = ingested(tmp_path, key=b"bank-key")
    rewrite(month_file(led), lambda rows: rows[:-1])
    head = led.head()
    last = led.entries()[-1]
    head.update(seq=last["seq"], entry_hash=last["entry_hash"])
    led.head_path.write_text(json.dumps(head), encoding="utf-8")
    rep = led.verify(key=b"bank-key")
    assert not rep.ok and rep.signature == "invalid"


def test_steps_reported_that_exceeds_the_ledger_is_a_break(tmp_path):
    doc = (FIX / "triage.run.v1.jsonl").read_text(encoding="utf-8").splitlines()
    end = json.loads(doc[-1])
    end["payload"]["steps_reported"] = 9
    ingest_run.ingest("\n".join(doc[:-1] + [json.dumps(end)]) + "\n", tmp_path)
    rep = RunLedger(tmp_path).verify()
    assert not rep.ok and rep.runs["R-001"]["status"] == "incomplete"


def test_run_without_an_end_record_is_open(tmp_path):
    doc = (FIX / "triage.run.v1.jsonl").read_text(encoding="utf-8").splitlines()
    ingest_run.ingest("\n".join(doc[:-1]) + "\n", tmp_path)
    rep = RunLedger(tmp_path).verify()
    assert rep.ok and rep.runs["R-001"]["status"] == "open"


def test_head_from_another_file_is_compared(tmp_path):
    led = ingested(tmp_path)
    copy = tmp_path / "head-copy.json"
    copy.write_text(led.head_path.read_text(encoding="utf-8"), encoding="utf-8")
    ingest_run.ingest(
        (FIX / "triage.run.v1.jsonl").read_text(encoding="utf-8").replace("R-001", "R-002"), tmp_path)
    assert led.verify().ok
    rep = led.verify(head_path=copy)
    assert not rep.ok


def test_verify_writes_report_and_cli_exit_codes(tmp_path, capsys):
    led = ingested(tmp_path)
    assert runledger.main(["--data-dir", str(tmp_path), "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True
    assert (tmp_path / "ledger" / "verify.json").is_file()
    rewrite(month_file(led), lambda rows: rows[:1] + rows[2:])
    assert runledger.main(["--data-dir", str(tmp_path)]) == 1
    assert runledger.main(["--data-dir", str(tmp_path), "--key-file", str(tmp_path / "none")]) == 2


def test_append_refuses_an_unknown_kind_and_headless_ledger(tmp_path):
    led = RunLedger(tmp_path)
    try:
        led.append("bogus", {})
    except ValueError:
        pass
    else:
        raise AssertionError("unknown kind accepted")
    led.append("review", {"x": 1})
    led.head_path.unlink()
    try:
        led.append("review", {"x": 2})
    except ValueError:
        pass
    else:
        raise AssertionError("append without head accepted")
