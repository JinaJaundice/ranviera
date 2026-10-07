from cortex_kg.ledger import Ledger

T1 = "Write measured sentences that carry related facts together."
T2 = "Do not use dashes, semicolons or contractions in any reply to Jordan."


def build(ledger, texts, key="writing", today="2026-10-05"):
    ids = [ledger.assign(key, "rules/writing.md", t, today) for t in texts]
    return ids, ledger.finish(today, [key])


def test_addition_and_next_numbers():
    ids, res = build(Ledger(), [T1, T2])
    assert ids == ["rule:writing-001", "rule:writing-002"]
    assert res == {"added": ids, "changed": [], "retired": []}


def test_unchanged_rule_keeps_id_and_updates_last_seen():
    ledger = Ledger()
    build(ledger, [T1, T2])
    ids, res = build(ledger, [T1, T2], today="2026-10-06")
    assert ids == ["rule:writing-001", "rule:writing-002"]
    assert res == {"added": [], "changed": [], "retired": []}
    assert ledger.rules[ids[0]]["first_seen"] == "2026-10-05"
    assert ledger.rules[ids[0]]["last_seen"] == "2026-10-06"


def test_small_edit_keeps_id_and_updates_text():
    ledger = Ledger()
    build(ledger, [T1, T2])
    edited = T1.replace("together", "together in one sentence")
    ids, res = build(ledger, [edited, T2], today="2026-10-06")
    assert ids[0] == "rule:writing-001"
    assert res["changed"] == ["rule:writing-001"] and res["retired"] == [] and res["added"] == []
    assert "in one sentence" in ledger.rules[ids[0]]["text"]


def test_large_edit_gets_new_id_and_retires_old():
    ledger = Ledger()
    build(ledger, [T1, T2])
    ids, res = build(ledger, ["Check every figure against its primary source before sending.", T2],
                     today="2026-10-06")
    assert ids == ["rule:writing-003", "rule:writing-002"]
    assert res["added"] == ["rule:writing-003"] and res["retired"] == ["rule:writing-001"]
    assert ledger.rules["rule:writing-001"]["status"] == "retired"
    assert ledger.rules["rule:writing-001"]["retired"] == "2026-10-06"


def test_removal_retires_and_id_is_not_reused():
    ledger = Ledger()
    build(ledger, [T1, T2])
    _, res = build(ledger, [T2], today="2026-10-06")
    assert res["retired"] == ["rule:writing-001"]
    ids, _ = build(ledger, [T2, T1], today="2026-10-07")
    assert ids == ["rule:writing-002", "rule:writing-003"]


def test_unseen_file_keys_are_not_retired():
    ledger = Ledger()
    ledger.assign("a", "a.md", T1, "2026-10-05")
    ledger.finish("2026-10-05", ["a"])
    assert ledger.finish("2026-10-06", ["b"])["retired"] == []


def test_similarity_is_per_file_key():
    ledger = Ledger()
    ledger.assign("a", "a.md", T1, "2026-10-05")
    ledger.finish("2026-10-05", ["a"])
    assert ledger.assign("b", "b.md", T1, "2026-10-05") == "rule:b-001"


def test_duplicate_text_in_a_file_gets_two_ids():
    ids, _ = build(Ledger(), [T1, T1])
    assert ids == ["rule:writing-001", "rule:writing-002"]


def test_determinism_and_round_trip(tmp_path):
    texts = [T1, T2, "Name the actor where the actor matters in the sentence."]
    a, b = Ledger(), Ledger()
    build(a, texts)
    build(b, texts)
    a.save(tmp_path / "a" / "rules.json")
    b.save(tmp_path / "b.json")
    assert (tmp_path / "a" / "rules.json").read_text() == (tmp_path / "b.json").read_text()
    loaded = Ledger.load(tmp_path / "a" / "rules.json")
    ids, res = build(loaded, texts, today="2026-10-06")
    assert ids == ["rule:writing-001", "rule:writing-002", "rule:writing-003"] and res["added"] == []


def test_missing_file_gives_empty_ledger(tmp_path):
    assert Ledger.load(tmp_path / "none.json").rules == {}
