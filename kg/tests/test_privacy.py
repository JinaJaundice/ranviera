"""Placeholders for personal and client-confidential values: the key, the redaction rules and the migration."""
from __future__ import annotations

import hashlib
import json
import re

import pytest

from cortex_kg import privacy

KEY = bytes(range(32))
OTHER = bytes(range(1, 33))
# invented names: the redaction reads its client names from the overlay, never from its source
TERMS = privacy.Terms(["Acme Bank", "Northwind Capital", "Northwind", "Globex Securities", "Project Falcon"])
_REAL_AMBIENT_TERMS = privacy._ambient_terms


@pytest.fixture(autouse=True)
def _fixed_terms(monkeypatch):
    """A test never reads the private terms of the machine it runs on."""
    monkeypatch.setattr(privacy, "_ambient_terms", lambda: TERMS)


def red(text: str, key: bytes = KEY) -> str:
    return privacy.redact(text, key)[0]


# ---------------------------------------------------------------- the key

def test_the_token_is_a_keyed_hash_not_a_sha1(tmp_path):
    _, found = privacy.redact("The Acme Bank fee is 41% margin.\n", KEY)
    (tok, value), = found.items()
    assert value == "41%" and privacy.TOKEN.fullmatch(tok)
    assert tok != privacy._legacy_token("41%")
    assert tok != "{{PRIVATE:%s}}" % hashlib.sha1(b"41%").hexdigest()[:8]


def test_the_token_for_41_percent_differs_between_two_keys_and_is_stable_for_one():
    text = "The Acme Bank margin is 41%.\n"
    assert red(text, KEY) == red(text, KEY)
    assert red(text, KEY) != red(text, OTHER)


def test_a_dictionary_of_simple_values_no_longer_recovers_a_token():
    """The audit recovered 10 of 19 old tokens by hashing percentages and amounts. With the key unknown it cannot."""
    out = red("The Acme Bank margin is 17% and the fee is £123k.\n", KEY)
    guesses = {"%d%%" % n for n in range(100)} | {"£%dk" % n for n in range(2000)}
    seen = {t[len("{{PRIVATE:"):-2] for t in privacy.TOKEN.findall(out) for t in ["{{PRIVATE:%s}}" % t]}
    assert seen
    assert not seen & {privacy._legacy_token(g)[len("{{PRIVATE:"):-2] for g in guesses}


def test_the_key_is_made_once_with_32_bytes_and_read_back(tmp_path):
    a = privacy.get_key(tmp_path / "overlay")
    assert len(a) == 32
    assert privacy.get_key(tmp_path / "overlay") == a
    assert len(bytes.fromhex((tmp_path / "overlay" / "privacy_key").read_text().strip())) == 32
    with pytest.raises(FileNotFoundError):
        privacy.get_key(tmp_path / "other", create=False)


def test_a_damaged_key_file_is_an_error_not_a_new_key(tmp_path):
    (tmp_path / "privacy_key").write_text("not hex", encoding="utf-8")
    with pytest.raises(ValueError):
        privacy.get_key(tmp_path)
    (tmp_path / "privacy_key").write_text("abcd\n", encoding="utf-8")
    with pytest.raises(ValueError):
        privacy.get_key(tmp_path)


def test_redact_without_a_key_uses_the_configured_overlay(tmp_path):
    privacy.configure(tmp_path / "ov")
    try:
        a = privacy.redact("Write to a.person@mail.test\n")[0]
    finally:
        privacy.configure(None)
    assert a == privacy.redact("Write to a.person@mail.test\n", privacy.get_key(tmp_path / "ov"))[0]


# ---------------------------------------------------------------- contact details

@pytest.mark.parametrize("text, secret", [
    ("Write to a.person@mail.test today", "a.person@mail.test"),
    ("Call +44 7700 900123 now", "+44 7700 900123"),
    ("Tel 07700 900123", "07700 900123"),
    ("Tel 07700900123.", "07700900123"),
    ("Office (020) 7946 0958", "(020) 7946 0958"),
    ("Office 020 7946 0958", "020 7946 0958"),
])
def test_personal_contact_details_are_replaced(text, secret):
    out = red(text)
    assert secret not in out and "{{PRIVATE:" in out


@pytest.mark.parametrize("text", [
    "Author 1+x@users.noreply.github.com",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    "Version 0.1.0 of 2026-10-06",
    "Build 0123456789 failed",
    "The score is 0.5 or more",
])
def test_ordinary_text_is_left_alone(text):
    assert red(text) == text


# ---------------------------------------------------------------- client commercial terms

@pytest.mark.parametrize("text, secret", [
    ("The Acme Bank day rate is $1,200 per day", "$1,200"),
    ("Fee of USD 50,000 for the Northwind Capital work", "USD 50,000"),
    ("client fee €1.2m", "€1.2m"),
    ("Acme Bank proposal worth 660k GBP", "660k GBP"),
    ("Globex Securities 660,000 pounds", "660,000 pounds"),
    ("The Acme Bank bundle at £123k runs at 17% margin.", "£123k"),
    ("The Acme Bank bundle at £123k runs at 17% margin.", "17%"),
    ("The rebate is 3% for Northwind", "3%"),
])
def test_client_commercial_figures_are_replaced(text, secret):
    assert secret not in red(text)


def test_a_figure_on_the_line_after_a_client_name_is_replaced():
    out = red("The proposal for Northwind Capital\nis worth £420k in all.\n")
    assert "420k" not in out and "Northwind Capital" in out


def test_a_blank_line_ends_the_client_context():
    text = "The proposal for Northwind Capital\n\nRound a total to £420k.\n"
    assert red(text) == text


def test_house_style_examples_and_typography_ratios_stay():
    for text in ("Write money as £94k.\n", "The logo must clear 33% of its box.\n",
                 "A proposal slide holds 3 columns and the type is 40% larger.\n",
                 "Write money as £94k.\nThe Acme Bank deck uses 6 pages.\n"):
        assert red(text) == text, text
    # a house-style line directly after a client line is kept as well
    after = "The Acme Bank bundle at £123k.\nWrite money as £94k.\n"
    assert red(after).splitlines()[1] == "Write money as £94k."


def test_the_money_pattern_keeps_the_space_after_a_figure():
    out = red("The Northwind price of £123k against £300k on the right card\n")
    assert "}} against {{" in out and "}} on the right" in out


def test_numbers_within_100_characters_of_a_client_rebate_or_fte_count_are_replaced():
    out = red("Acme Bank has a 1% non-recoverable volume rebate on UK local FTE charges and 12 FTE in all.\n")
    assert "1%" not in out and "12" not in out and out.count("{{PRIVATE:") == 2
    assert privacy.commercial_detail(out) == []
    far = "Acme Bank" + " word" * 40 + " rebate of 3 points"
    assert red(far) == far
    assert red("A rebate is 5 percent, nothing about banks.\n") == "A rebate is 5 percent, nothing about banks.\n"


def test_commercial_detail_reports_a_number_in_clear_beside_a_client_rebate_or_fte_count():
    assert privacy.commercial_detail("Acme Bank has a rebate of 3 points") != []
    assert privacy.commercial_detail("The Northwind Capital rate card lists 3 FTE") != []
    assert privacy.commercial_detail("A rebate is a refund. Nothing about banks here.") == []
    far = "Acme Bank" + " word" * 40 + " rebate 3"
    assert privacy.commercial_detail(far) == []


# ---------------------------------------------------------------- the store and the migration

def test_restore_and_the_store_round_trip(tmp_path):
    out, found = privacy.redact("Write to a.person@mail.test\n", KEY)
    privacy.save_values(tmp_path, found)
    assert privacy.restore(out, privacy.load_values(tmp_path)) == "Write to a.person@mail.test\n"
    assert privacy.restore(out, {}) == "Write to [withheld]\n"


def test_save_values_does_not_rewrite_an_unchanged_store(tmp_path):
    privacy.save_values(tmp_path, {"{{PRIVATE:aaaaaaaa}}": "x"})
    p = privacy.store_path(tmp_path)
    before = p.stat().st_mtime_ns
    privacy.save_values(tmp_path, {"{{PRIVATE:aaaaaaaa}}": "x"})
    assert p.stat().st_mtime_ns == before


def test_migration_rekeys_files_and_the_store_and_is_idempotent(tmp_path):
    ov, mirror = tmp_path / "overlay", tmp_path / "harness"
    mirror.mkdir()
    old = privacy._legacy_token("17%")
    privacy.save_values(ov, {old: "17%", "{{PRIVATE:deadbeef}}": "unrelated, not the sha1 of its value"})
    (mirror / "a.md").write_text(f"Margin {old} and {old}.\n", encoding="utf-8")
    (mirror / "b.bin").write_bytes(b"\xff\xfe")
    r = privacy.migrate(ov, [mirror])
    key = privacy.get_key(ov)
    new = privacy._token("17%", key)
    assert r["rekeyed"] == 1 and new != old
    assert (mirror / "a.md").read_text(encoding="utf-8") == f"Margin {new} and {new}.\n"
    vals = privacy.load_values(ov)
    assert vals[new] == "17%" and old not in vals and "{{PRIVATE:deadbeef}}" in vals
    assert privacy.migrate(ov, [mirror]) == {"rekeyed": 0, "files": []}
    assert privacy.restore((mirror / "a.md").read_text(encoding="utf-8"), vals) == "Margin 17% and 17%.\n"


def test_a_dry_run_migration_changes_nothing(tmp_path):
    ov = tmp_path / "overlay"
    old = privacy._legacy_token("5%")
    privacy.save_values(ov, {old: "5%"})
    f = tmp_path / "x.md"
    f.write_text(old, encoding="utf-8")
    r = privacy.migrate(ov, [f], dry_run=True)
    assert r["rekeyed"] == 1 and f.read_text(encoding="utf-8") == old
    assert json.loads(privacy.store_path(ov).read_text(encoding="utf-8")) == {old: "5%"}


def test_a_bare_count_beside_a_rate_card_stays_and_the_comma_after_a_number_is_kept():
    text = "Ask which rate card applies (Acme Bank has 3, and the formula is cost / (1 - target - rebate)).\n"
    assert red(text) == text


def test_migration_also_rekeys_the_lower_case_placeholders_of_the_ledger(tmp_path):
    ov = tmp_path / "overlay"
    old = privacy._legacy_token("88 per cent")
    privacy.save_values(ov, {old: "88 per cent"})
    f = tmp_path / "rules.json"
    f.write_text('{"text": "ceiling at %s of the card"}' % old.lower(), encoding="utf-8")
    privacy.migrate(ov, [f])
    new = privacy._token("88 per cent", privacy.get_key(ov))
    assert f.read_text(encoding="utf-8") == '{"text": "ceiling at %s of the card"}' % new.lower()


# ---------------------------------------------------------------- figures with a thousands comma and the day rate

@pytest.mark.parametrize("text, secret", [
    ("The rate card shows 1,200 for a senior.", "1,200"),
    ("1,200 on the rate card", "1,200"),
    ("The fee is 12,500 a month.", "12,500"),
    ("A mark-up of £1,200k applies.", "1,200"),
    ("price list 4,000.50 for a bundle", "4,000.50"),
])
def test_a_figure_with_a_thousands_comma_near_a_commercial_word_is_replaced_whole(text, secret):
    out = red(text)
    assert secret not in out and out.count("{{PRIVATE:") == 1 and ",200" not in out


def test_a_comma_figure_far_from_a_commercial_word_stays():
    for text in ("Logs hold 1,200 lines in all.", "The file has 12,500 words and no commercial term at all near it for ages.",
                 "Write money as £94k."):
        assert red(text) == text


def test_a_bare_figure_beside_day_rate_is_replaced():
    for text, secret in (("The day rate is 850.", "850"), ("850 day rate for a manager", "850"),
                         ("day rates: 1,200 and 900", "900"), ("a day rate of 1400 applies", "1400")):
        assert secret not in red(text), text
    same = "A day rate in 2026 is set by the partner.\n"
    assert red(same) == same
    other = "Plan for 3 days, at the day rate set later.\n"
    assert red(other) == other


def test_the_same_figure_gets_the_same_placeholder_in_both_rules():
    out = red("The rate card has 1,200 and the day rate is 1,200.")
    assert len(set(re.findall(r"\{\{PRIVATE:[0-9a-f]{8}\}\}", out))) == 1


@pytest.mark.parametrize("text", [
    "we charge 1,200 a day", "we charge 1,200 a day to Northwind Capital", "we charge Northwind Capital 1200 a day",
    "rate card 1200", "Charge 12,500 per month for Acme Bank"])
def test_charge_figures_redacted(text):
    out, found = privacy.redact(text, key=b"k" * 32)
    assert found and "PRIVATE" in out and not any(v in out for v in ("1200", "1,200", "12,500")), out


@pytest.mark.parametrize("text", ["Logs hold 1,200 lines", "The hook runs 3 times a day", "Built in 2026 per the plan"])
def test_charge_negatives_unchanged(text):
    assert privacy.redact(text, key=b"k" * 32)[0] == text


# ---------------------------------------------------------------- the private terms

def write_terms(folder, **lists):
    folder.mkdir(parents=True, exist_ok=True)
    body = {"clients": [], "projects": [], "people": []}
    body.update(lists)
    (folder / "private_terms.json").write_text(json.dumps(body), encoding="utf-8")


def test_the_public_default_holds_no_names_and_no_source_names():
    assert privacy.NO_TERMS.names == () and privacy.NO_TERMS.name is None
    # with no names a line is commercial only through the generic words, so a bare name does not mark a figure
    assert "£420k" in privacy.redact("Acme Bank paid £420k.\n", KEY, privacy.NO_TERMS)[0]
    assert "£420k" not in privacy.redact("The Acme Bank price was £420k.\n", KEY, privacy.NO_TERMS)[0]
    src = privacy.__file__
    text = open(src, encoding="utf-8").read()
    for name in ("HS" + "BC", "Llo" + "yds", "Barc" + "lays", "Morgan" + " Stanley", "MS" + "IP"):  # built in parts so that this file holds none
        assert name not in text


def test_names_come_from_the_overlay_file(tmp_path):
    write_terms(tmp_path / "ov", clients=["Acme Bank", "Northwind Capital"], projects=["Project Falcon"], people=["Jordan Reyes"])
    terms = privacy.load_terms(tmp_path / "ov")
    assert set(terms.names) == {"Acme Bank", "Northwind Capital", "Project Falcon", "Jordan Reyes"}
    for line in ("Acme Bank paid £420k.\n", "Project Falcon cost £420k.\n", "jordan reyes was paid £420k.\n"):
        assert "£420k" not in privacy.redact(line, KEY, terms)[0], line
    assert "£420k" in privacy.redact("Other Co paid £420k.\n", KEY, terms)[0]
    assert privacy.commercial_detail("Project Falcon has a rebate of 3 points", terms) != []
    assert privacy.commercial_detail("Project Falcon has a rebate of 3 points", privacy.NO_TERMS) == []


def test_a_missing_or_broken_file_gives_no_names(tmp_path):
    assert privacy.load_terms(tmp_path / "none") is privacy.NO_TERMS
    (tmp_path / "ov").mkdir()
    (tmp_path / "ov" / "private_terms.json").write_text("{ not json", encoding="utf-8")
    assert privacy.load_terms(tmp_path / "ov").names == ()
    (tmp_path / "ov" / "private_terms.json").write_text(json.dumps({"clients": "Acme Bank", "projects": [3, " "]}), encoding="utf-8")
    assert privacy.load_terms(tmp_path / "ov").names == ()


def test_a_name_is_matched_whole_and_a_regex_character_is_literal(tmp_path):
    terms = privacy.Terms(["Acme (UK)", "Falcon"])
    assert terms.names_client("Acme (UK) invoice") and terms.names_client("the falcon")
    assert not terms.names_client("Falconry")


def test_the_configured_file_wins_over_the_overlay(tmp_path):
    write_terms(tmp_path / "ov", clients=["Acme Bank"])
    other = tmp_path / "elsewhere" / "names.json"
    other.parent.mkdir()
    other.write_text(json.dumps({"clients": ["Northwind Capital"]}), encoding="utf-8")
    assert privacy.load_terms(tmp_path / "ov").names == ("Acme Bank",)
    assert privacy.load_terms(tmp_path / "ov", other).names == ("Northwind Capital",)


def test_redact_reads_the_ambient_overlay_terms(tmp_path, monkeypatch):
    monkeypatch.setattr(privacy, "_ambient_terms", _REAL_AMBIENT_TERMS)
    write_terms(tmp_path / "ov", clients=["Acme Bank"])
    privacy.configure(tmp_path / "ov")
    try:
        assert "£420k" not in privacy.redact("Acme Bank paid £420k.\n")[0]
        assert "£420k" in privacy.redact("Northwind Capital paid £420k.\n")[0]
        privacy.configure(tmp_path / "ov", tmp_path / "ov" / "private_terms.json")
        assert "£420k" not in privacy.redact("Acme Bank paid £420k.\n")[0]
    finally:
        privacy.configure(None)
