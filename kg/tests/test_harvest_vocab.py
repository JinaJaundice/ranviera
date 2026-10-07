"""Tests for the vocabulary harvester, on small fixture vocabulary files."""
import json
import re
from pathlib import Path

import pytest

from cortex_kg.config import Config
from cortex_kg.harvest import vocab


def make_cfg(tmp_path: Path) -> Config:
    return Config(claude_home=tmp_path / "claude", projects_root=tmp_path / "proj", memory_dir=tmp_path / "mem",
                  data_dir=tmp_path / "data", port=5182, include_sensitivity=["internal"],
                  log_prompt_snippets=False, repo_root=tmp_path / "repo")


def write(path: Path, scheme_id: str, concepts: list):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"scheme": {"id": scheme_id, "label": scheme_id.split(":")[1].title(),
                                           "description": "d"}, "concepts": concepts}), encoding="utf-8")


@pytest.fixture
def cfg(tmp_path):
    cfg = make_cfg(tmp_path)
    (tmp_path / "mem").mkdir()
    (tmp_path / "mem" / "x.md").write_text("one\ntwo\nFalcon is the tool\n", encoding="utf-8")
    write(cfg.profile_dir / "vocab" / "entities.json", "scheme:entities", [
        {"id": "term:falcon", "prefLabel": "Falcon", "altLabels": ["Falcon TM"],
         "hiddenLabels": ["Nimbus"], "definition": "The tool.",
         "denotes": ["project:falcon", "app:nimbus"], "status": "ratified",
         "ratified": "2026-10-05", "severity": "warn", "case": "sensitive", "source": "memory/x.md:3",
         "variant_counts": {"Nimbus": 4}}])
    write(cfg.profile_dir / "vocab" / "banned-words.json", "scheme:banned-words", [
        {"id": "term:robust", "prefLabel": "robust", "denotes": [], "status": "ratified"}])
    write(cfg.overlay_dir / "vocab" / "entities-private.json", "scheme:entities-private", [
        {"id": "term:acme", "prefLabel": "Acme", "altLabels": [], "denotes": ["client:acme"], "case": "insensitive",
         "status": "proposed"}])
    return cfg


def test_load_adds_scheme_and_private(cfg):
    cs = {c["id"]: c for c in vocab.load(cfg)}
    assert cs["term:falcon"]["scheme"] == "scheme:entities" and cs["term:falcon"]["private"] is False
    assert cs["term:acme"]["scheme"] == "scheme:entities-private" and cs["term:acme"]["private"] is True
    assert len(cs) == 3


def test_harvest_nodes_and_edges(cfg):
    h = vocab.harvest(cfg)
    t = h.nodes["term:falcon"]
    assert t.label == "Falcon" and t.sensitivity == "internal"
    assert t.props["altLabels"] == ["Falcon TM"] and t.props["hiddenLabels"] == ["Nimbus"]
    assert t.props["status"] == "ratified" and t.props["severity"] == "warn" and t.props["case"] == "sensitive"
    assert t.props["variant_counts"] == {"Nimbus": 4} and t.props["definition"] == "The tool."
    assert ("term:falcon", "inScheme", "scheme:entities") in h.edges
    assert ("term:falcon", "denotes", "app:nimbus") in h.edges
    assert h.nodes["term:acme"].sensitivity == "client-confidential"
    assert h.nodes["scheme:entities-private"].sensitivity == "client-confidential"
    assert h.nodes["scheme:entities"].props["concept_count"] == 1


def test_patterns(cfg):
    pats = vocab.patterns(vocab.load(cfg))
    assert {p[0] for p in pats} == {"term:falcon", "term:acme"}
    _tid, src, denotes = next(p for p in pats if p[0] == "term:falcon")
    assert denotes == ["project:falcon", "app:nimbus"]
    rx = re.compile(src)
    assert rx.search("use Falcon here") and not rx.search("falcon") and not rx.search("Falcons")
    assert rx.search("Falcon TM").group(0) == "Falcon TM"
    acme = re.compile(next(p[1] for p in pats if p[0] == "term:acme"))
    assert acme.search("ACME ltd")


def test_missing_vocab_is_empty(tmp_path):
    cfg = make_cfg(tmp_path)
    assert vocab.load(cfg) == [] and vocab.harvest(cfg).nodes == {}


def _with_source(cfg, source, label="Zeta"):
    write(cfg.profile_dir / "vocab" / "domain-terms.json", "scheme:domain-terms", [
        {"id": "term:zeta", "prefLabel": label, "altLabels": ["ZT"], "denotes": [], "status": "ratified", "source": source}])
    return vocab.harvest(cfg)


def test_evidence_is_the_first_line_that_holds_the_label(cfg, tmp_path):
    assert vocab.harvest(cfg).nodes["term:falcon"].evidence == "mem/x.md:3"  # the typed line was 3 by chance
    (tmp_path / "mem" / "y.md").write_text("a\nb\nc\nd\nthe ZT form\n", encoding="utf-8")
    ev = _with_source(cfg, "mem/y.md:2").nodes["term:zeta"].evidence
    assert ev == "mem/y.md:5"


def test_wrong_typed_line_is_replaced_and_term_elsewhere_is_found(cfg, tmp_path):
    (tmp_path / "mem" / "z.md").write_text("Zeta here\n", encoding="utf-8")
    assert _with_source(cfg, "memory/x.md:1").nodes["term:zeta"].evidence == "mem/z.md:1"


def test_a_term_that_no_line_holds_is_kept_with_a_finding(cfg):
    h = _with_source(cfg, "memory/x.md:1")
    assert "term:zeta" in h.nodes  # one failing term never removes the vocabulary from the graph
    found = [f for f in h.findings if f.check == "P08" and "term:zeta" in f.message]
    assert len(found) == 1 and found[0].severity == "warning"


def test_declared_decision_is_kept_without_a_search(cfg):
    h = _with_source(cfg, "decision of 6 October 2026")
    assert h.nodes["term:zeta"].evidence == "decision of 6 October 2026"
    assert ("term:zeta", "inScheme", "scheme:domain-terms") in h.edges


def test_acronym_is_case_exact_and_not_matched_inside_a_hyphenated_word(cfg, tmp_path):
    (tmp_path / "mem" / "w.md").write_text("name: project-zt-da\nthe zt form\nthe ZT form\n", encoding="utf-8")
    assert _with_source(cfg, "mem/w.md:1", label="Qq").nodes["term:zeta"].evidence == "mem/w.md:3"
