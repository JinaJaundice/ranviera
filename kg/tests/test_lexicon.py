"""The vocabulary check: compile, check, ratify and the register faults."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cortex_kg import lexicon  # noqa: E402

ENTITIES = {
    "scheme": {"id": "scheme:entities", "label": "Named things"},
    "concepts": [
        {"id": "term:falcon", "prefLabel": "Falcon", "hiddenLabels": ["Nimbus tool", "TM tester"],
         "status": "ratified", "ratified": "2026-10-05", "severity": "warn", "case": "insensitive"},
        {"id": "term:engine", "prefLabel": "Compliance engine", "hiddenLabels": ["the Engine"],
         "status": "proposed", "severity": "warn", "case": "sensitive"},
    ],
}


def make_cfg(tmp_path):
    repo, data = tmp_path / "repo", tmp_path / "data"
    (repo / "ontology" / "vocab").mkdir(parents=True)
    (repo / "ontology" / "vocab" / "entities.json").write_text(json.dumps(ENTITIES, indent=2), encoding="utf-8")
    data.mkdir()
    return SimpleNamespace(ontology_dir=repo / "ontology", data_dir=data, overlay_dir=data / "overlay")


def test_compile_writes_one_rule_per_hidden_label(tmp_path):
    cfg = make_cfg(tmp_path)
    rules = lexicon.compile_rules(cfg)
    assert [r["found_label"] for r in rules] == ["Nimbus tool", "TM tester", "the Engine"]
    r = rules[0]
    assert set(r) == {"concept", "pattern", "found_label", "preferred", "severity", "status", "protect"}
    assert r["preferred"] == "Falcon" and r["pattern"].startswith("(?i)")
    assert not rules[2]["pattern"].startswith("(?i)")  # a case-sensitive concept
    assert json.loads((cfg.data_dir / "lexicon_rules.json").read_text(encoding="utf-8"))["rules"] == rules


def test_overlay_vocab_is_included(tmp_path):
    cfg = make_cfg(tmp_path)
    (cfg.overlay_dir / "vocab").mkdir(parents=True)
    extra = {"scheme": {"id": "scheme:private"}, "concepts": [
        {"id": "term:client", "prefLabel": "Client A", "hiddenLabels": ["Customer A"], "status": "proposed"}]}
    (cfg.overlay_dir / "vocab" / "private.json").write_text(json.dumps(extra), encoding="utf-8")
    assert "Customer A" in [r["found_label"] for r in lexicon.compile_rules(cfg)]


def test_check_text_skips_code_links_urls_and_quotations(tmp_path):
    cfg = make_cfg(tmp_path)
    text = "\n".join([
        "The Nimbus tool was replaced.",
        "`Nimbus tool` in code and ```\nnimbus tool\n``` in a fence.",
        "See [the page](https://example.com/nimbus tool) and https://x.org/tm tester.",
        'He wrote "the nimbus tool" and “TM tester” and \'nimbus tool\'.',
        "It does not stop at an apostrophe in don't or the engine's nimbus tool here.",
        "Case matters for the Engine but not the engine.",
    ])
    hits = lexicon.check_text(cfg, text)
    assert [h["found"] for h in hits] == ["Nimbus tool", "nimbus tool", "the Engine"]
    assert hits[0] == {"concept": "term:falcon", "found": "Nimbus tool", "preferred": "Falcon",
                       "index": 4, "severity": "warn", "status": "ratified"}
    assert text[hits[2]["index"]:].startswith("the Engine")
    assert hits[2]["status"] == "proposed"
    assert lexicon.check_text(cfg, "nothing here, and the Nimbus toolkit is a different word") == []


def test_check_uses_a_fresh_compiled_file_and_recompiles_a_stale_one(tmp_path):
    cfg = make_cfg(tmp_path)
    lexicon.compile_rules(cfg)
    assert lexicon.check_text(cfg, "the Nimbus tool")
    vocab = cfg.ontology_dir / "vocab" / "entities.json"
    doc = json.loads(vocab.read_text(encoding="utf-8"))
    doc["concepts"][0]["hiddenLabels"] = ["Old name"]
    vocab.write_text(json.dumps(doc), encoding="utf-8")
    import os
    os.utime(vocab, (9_999_999_999, 9_999_999_999))
    assert lexicon.check_text(cfg, "the Nimbus tool") == []
    assert lexicon.check_text(cfg, "the Old name")[0]["concept"] == "term:falcon"


def test_ratify_round_trip(tmp_path):
    cfg = make_cfg(tmp_path)
    path = lexicon.ratify(cfg, "term:engine", "2026-10-06")
    assert path == cfg.ontology_dir / "vocab" / "entities.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    c = doc["concepts"][1]
    assert c["status"] == "ratified" and c["ratified"] == "2026-10-06"
    assert doc["concepts"][0] == ENTITIES["concepts"][0]
    assert path.read_text(encoding="utf-8").startswith('{\n  "scheme"')
    assert lexicon.check_text(cfg, "the Engine")[0]["status"] == "ratified"
    try:
        lexicon.ratify(cfg, "term:missing", "2026-10-06")
    except KeyError:
        pass
    else:
        raise AssertionError("a missing concept must raise")


def test_faults_for_register_uses_ratified_rules_only_and_never_raises(tmp_path):
    cfg = make_cfg(tmp_path)
    lexicon.compile_rules(cfg)
    p = cfg.data_dir / "lexicon_rules.json"
    out = lexicon.faults_for_register("We used the Nimbus tool and the Engine, then the Nimbus tool again.", p)
    assert out == [("lexicon", "use 'Falcon' for 'Nimbus tool'")]
    assert lexicon.faults_for_register("The `Nimbus tool` is code.", p) == []
    assert lexicon.faults_for_register("anything", tmp_path / "missing.json") == []
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    assert lexicon.faults_for_register("anything", bad) == []
    assert lexicon.faults_for_register(None, p) == []


def test_an_accepted_form_protects_its_own_words():
    rules = [{"concept": "term:engine", "pattern": r"(?i)(?<!\w)compliance engine(?!\w)", "found_label": "compliance engine",
              "preferred": "Example Compliance Platform", "severity": "warn", "status": "ratified",
              "protect": r"(?<!\w)(?:Example Compliance Platform|the engine)(?!\w)"}]
    hits = lexicon._apply(rules, "The Example Compliance Platform is live, and the compliance engine team met.")
    assert [h["found"] for h in hits] == ["compliance engine"]
