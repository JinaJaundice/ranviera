"""Tests for the agent transparency contracts of 7 October 2026: the reference form of rules O01 to O14 in
docs/REASONING.md runs under Nemo and gives the expected findings on invented facts, and the four contract documents
agree with each other and carry no private pack content."""
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cortex_kg import reason  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
FACTS = Path(__file__).resolve().parent / "fixtures" / "transparency" / "facts.rls"
PRIVATE_RULES = ROOT / "ontology" / "rules" / "transparency_private.rls"
PUBLIC_IDS = {f"O{n:02d}" for n in (3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14)}
ALL_IDS = {f"O{n:02d}" for n in range(1, 15)}
# The public copy holds shortened contract documents (docs/public/) and not the private rule pack (docs/AGENT_TRANSPARENCY.md,
# section 10). Its docs/REASONING.md has no reference nemo block, so the tests that read the full documents skip there.
FULL_DOCS = (DOCS / "AGENT_TRANSPARENCY.md").is_file() and "```nemo" in (DOCS / "REASONING.md").read_text(encoding="utf-8")
needs_docs = pytest.mark.skipif(not FULL_DOCS, reason="the full contract documents are not in this copy")
needs_private = pytest.mark.skipif(not PRIVATE_RULES.is_file(), reason="the private rule pack is not in this copy")


def read(name: str) -> str:
    return (DOCS / name).read_text(encoding="utf-8").replace("\r\n", "\n")


def reference_rules() -> str:
    m = re.search(r"```nemo\n(.*?)\n```", read("REASONING.md"), re.S)
    assert m, "docs/REASONING.md holds no nemo block"
    return m.group(1)


@needs_docs
def test_reference_form_has_a_header_for_every_rule():
    statements = reason._statements(reference_rules())
    reason.validate_statements(statements)
    ids = sorted({s["header"]["id"] for s in statements if s["header"]})
    assert ids == [f"O{n:02d}" for n in range(1, 15)]
    rules = {r["id"]: r["kind"] for r in reason.parse_rules(reference_rules())}
    assert rules["O01"] == "violation" and rules["O08"] == "info" and rules["O13"] == "warning"


@needs_docs
def test_the_rule_table_lists_every_rule():
    text = read("REASONING.md")
    for n in range(1, 15):
        assert f"| O{n:02d} |" in text


def run_reference():
    nmo = pytest.importorskip("nmo_python")
    program = reference_rules() + "\n" + FACTS.read_text(encoding="utf-8")
    engine = nmo.NemoEngine(nmo.load_string(program))
    engine.reason()
    out = {}
    for pred in ("violation", "warning", "info"):
        out[pred] = sorted((str(a).strip('"'), str(b).strip('"')) for a, b in (list(r) for r in engine.result(pred)))
    return out


@needs_docs
def test_each_rule_fires_on_its_planted_fault():
    got = run_reference()
    assert got["violation"] == [
        ("O01", "obl:1"), ("O01", "obl:2"), ("O01", "obl:3"), ("O03", "instr:bad"), ("O03", "instr:ok"),
        ("O04", "dec:1"), ("O04", "dec:2"), ("O06", "instr:bad"), ("O06", "instr:ok"), ("O09", "run:1"),
        ("O11", "run:1"), ("O11", "run:9"), ("O12", "run:1")]
    assert got["warning"] == [
        ("O02", "instr:bad"), ("O05", "map:1"), ("O07", "step:1"), ("O10", "run:1"), ("O13", "agent:a1"),
        ("O14", "evid:1"), ("O14", "evid:2")]
    assert got["info"] == [("O08", "typ:1")]


@needs_docs
def test_a_clean_obligation_and_an_exempt_obligation_give_no_finding():
    got = run_reference()
    flagged = {b for _, b in got["violation"] + got["warning"] + got["info"]}
    assert "obl:4" not in flagged   # a ratified notDischargedBy edge exempts it
    assert "obl:5" not in flagged   # a full chain to an in-force instruction


@needs_docs
def test_removing_a_chain_edge_gives_o01():
    # The edge facts hold stated, computed and ratified edges only, so removing the ratified chain edge gives O01.
    nmo = pytest.importorskip("nmo_python")
    facts = FACTS.read_text(encoding="utf-8").replace('edge("clause:1","realises","ctl:2") .', "")
    engine = nmo.NemoEngine(nmo.load_string(reference_rules() + "\n" + facts))
    engine.reason()
    rows = {(str(a).strip('"'), str(b).strip('"')) for a, b in (list(r) for r in engine.result("violation"))}
    assert ("O01", "obl:5") in rows


@needs_docs
def test_the_contract_documents_agree():
    ont, con, tra = read("ONTOLOGY.md"), read("CONTRACTS.md"), read("AGENT_TRANSPARENCY.md")
    for n in range(1, 15):
        assert f"| F{n:02d} |" in ont
    for token in ("ranviera.run.v1", "mappings ratify", "mappings propose", "mappings reject", "mappings list",
                  "ingest-run", "ledger verify", "import-legislation", "import-pack", "demo build",
                  "pack_dir", "hub_dir", "pack_register", "pack_profile", "include_private_graphs"):
        assert token in con, token
    for state in ("proposed", "ratified", "rejected", "superseded"):
        assert state in con
    assert "### 3.5 Reuse of the " in tra
    assert "test script for sanctions alert investigation" in tra and "### 9.1 The pilot decision" in tra


@needs_docs
def test_no_contract_document_holds_the_pack_base_iri():
    for name in ("ONTOLOGY.md", "CONTRACTS.md", "REASONING.md", "AGENT_TRANSPARENCY.md"):
        assert "regulatory" + "-mapping" + ".org" not in read(name), name


@needs_docs
def test_the_contract_documents_follow_the_register_marks():
    # no dashes, contractions or semicolons in the prose of the new sections (code blocks are left out)
    for name in ("ONTOLOGY.md", "CONTRACTS.md", "REASONING.md", "AGENT_TRANSPARENCY.md"):
        text = re.sub(r"```.*?```", "", read(name), flags=re.S)
        assert "—" not in text and "–" not in text, name


# ---------------------------------------------------------------- the rule files run through reason.run
#
# Each rule has a graph where it fires and a graph where it does not. The graphs are invented and follow the shapes
# of the contracts. No pack file is read, and the data folder is the temporary one of mini_cfg.

import json  # noqa: E402
import shutil  # noqa: E402

from cortex_kg import mappings, transparency  # noqa: E402
from cortex_kg.config import Config  # noqa: E402
from cortex_kg.model import slugify  # noqa: E402

REPO_RULES = ROOT / "ontology" / "rules"
TODAY = "2026-10-07"
H1, H2, H3 = ("sha256:" + c * 64 for c in "abc")


@pytest.fixture
def cfg(mini_cfg: Config) -> Config:
    dest = mini_cfg.ontology_dir / "rules"
    dest.mkdir(parents=True, exist_ok=True)
    for f in REPO_RULES.glob("*.rls"):
        shutil.copy(f, dest / f.name)
    pytest.importorskip("nmo_python")
    return mini_cfg


def N(i, typ, status=None, label=None, **props):
    return {"id": i, "type": typ, "label": label or i, "status": status, "date": None, "sensitivity": "internal",
            "props": props, "metrics": {"uses": 0, "last_used": None, "degree": 0}}


def G(nodes, edges, provenance=None):
    out = []
    for s, r, t in edges:
        e = {"s": s, "r": r, "t": t, "w": 0.5, "evidence": None}
        if provenance:
            e["provenance"] = provenance
        out.append(e)
    return {"nodes": nodes, "edges": out, "built": "2026-10-07T09:00:00Z"}


def reason_all(cfg, g):
    inferred, _edges, findings = reason.run(cfg, g, TODAY)
    assert inferred["engine"] is not None, findings
    return inferred, {(f["check"], f["node"]) for f in findings}


def fired(cfg, g):
    return reason_all(cfg, g)[1]


def instr(i="instr:i1", status="approved", valid_from="2026-01-01", **props):
    return N(i, "InstructionVersion", status, validFrom=valid_from, **props)


def test_the_second_program_is_a_separate_file_set():
    assert transparency.is_transparency_file(Path("transparency.rls"))
    assert transparency.is_transparency_file(Path("transparency_private.rls"))
    assert not transparency.is_transparency_file(Path("cortex.rls"))
    # the public file and the private pack of section 10 together hold O01 to O14 (the private file uses the public helpers)
    ids: list[str] = []
    for name in ("transparency.rls", "transparency_private.rls"):
        if not (REPO_RULES / name).is_file():
            continue
        statements = reason._statements((REPO_RULES / name).read_text(encoding="utf-8"))
        reason.validate_statements(statements)
        ids += [s["header"]["id"] for s in statements if s["header"]]
    assert set(ids) == (ALL_IDS if PRIVATE_RULES.is_file() else PUBLIC_IDS)


@needs_private
def test_o01_an_obligation_without_a_chain_fires_and_a_full_chain_does_not(cfg):
    nodes = [N("dagent:a", "DeployedAgent"), instr(), N("obligation:1", "Obligation", "active", effective_date="2025-01-01")]
    base = [("obligation:1", "appliesTo", "dagent:a")]
    assert ("O01", "obligation:1") in fired(cfg, G(nodes, base))
    chain = base + [("control:1", "satisfies", "obligation:1"), ("clause:1", "realises", "control:1"),
                    ("instr:i1", "implementsClause", "clause:1"), ("dagent:a", "operatesUnder", "instr:i1")]
    assert ("O01", "obligation:1") not in fired(cfg, G(nodes, chain))


@needs_private
def test_o01_exemption_and_expiry_and_each_missing_link(cfg):
    nodes = [N("dagent:a", "DeployedAgent"), instr(), N("obligation:1", "Obligation", "active", effective_date="2025-01-01")]
    base = [("obligation:1", "appliesTo", "dagent:a")]
    assert ("O01", "obligation:1") not in fired(cfg, G(nodes, base + [("obligation:1", "notDischargedBy", "dagent:a")]))
    future = [N("dagent:a", "DeployedAgent"), N("obligation:1", "Obligation", "active", effective_date="2026-12-01")]
    assert ("O01", "obligation:1") not in fired(cfg, G(future, base))     # not yet effective
    no_clause = base + [("control:1", "satisfies", "obligation:1")]
    assert ("O01", "obligation:1") in fired(cfg, G(nodes, no_clause))     # a control and no clause
    no_instr = no_clause + [("clause:1", "realises", "control:1")]
    assert ("O01", "obligation:1") in fired(cfg, G(nodes, no_instr))      # a clause and no in-force instruction


@needs_private
def test_o01_proof_names_the_absent_link(cfg):
    nodes = [N("dagent:a", "DeployedAgent"), N("obligation:1", "Obligation", "active", effective_date="2025-01-01")]
    inferred, _ = reason_all(cfg, G(nodes, [("obligation:1", "appliesTo", "dagent:a")]))
    fact = next(f for f in inferred["facts"] if f["rule"] == "O01" and f["args"][1] == "obligation:1")
    assert fact["kind"] == "violation" and fact["proof"] is not None
    absent = [c["fact"] for c in fact["proof"]["children"] if c["rule"] == reason.ABSENT]
    assert any(a.startswith("not has_control(") for a in absent)


@needs_private
def test_o02_an_instruction_without_a_clause_link(cfg):
    nodes = [instr("instr:a"), instr("instr:b")]
    found = fired(cfg, G(nodes, [("instr:b", "implementsClause", "clause:1")]))
    assert ("O02", "instr:a") in found and ("O02", "instr:b") not in found
    assert ("O02", "instr:d") not in fired(cfg, G([instr("instr:d", status="draft")], []))   # not in force


def test_o03_conflicting_instructions_need_an_override(cfg):
    nodes = [N("dagent:a", "DeployedAgent"), instr("instr:a"), instr("instr:b")]
    base = [("dagent:a", "operatesUnder", "instr:a"), ("dagent:a", "operatesUnder", "instr:b"),
            ("instr:a", "conflictsWith", "instr:b")]
    found = fired(cfg, G(nodes, base))
    assert ("O03", "instr:a") in found and ("O03", "instr:b") in found
    assert not {("O03", "instr:a"), ("O03", "instr:b")} & fired(cfg, G(nodes, base + [("instr:a", "overrides", "instr:b")]))
    other = [N("dagent:a", "DeployedAgent"), N("dagent:b", "DeployedAgent"), instr("instr:a"), instr("instr:b")]
    split = [("dagent:a", "operatesUnder", "instr:a"), ("dagent:b", "operatesUnder", "instr:b"),
             ("instr:a", "conflictsWith", "instr:b")]
    assert ("O03", "instr:a") not in fired(cfg, G(other, split))          # one agent each, so no conflict


def decision_graph(cited=True, evidence=True, context=True):
    nodes = [N("adec:1", "AgentDecision"), N("step:1", "Step"), instr(), N("evid:1", "Evidence")]
    edges = [("step:1", "informedDecision", "adec:1")]
    if cited:
        edges.append(("step:1", "citesInstruction", "instr:i1"))
    if evidence:
        edges.append(("step:1", "usedEvidence", "evid:1"))
    if context:
        edges.append(("step:1", "inContext", "instr:i1"))
    return G(nodes, edges)


def test_o04_a_decision_needs_a_cited_instruction_evidence_and_context(cfg):
    assert ("O04", "adec:1") not in fired(cfg, decision_graph())
    assert ("O04", "adec:1") in fired(cfg, decision_graph(cited=False))
    assert ("O04", "adec:1") in fired(cfg, decision_graph(evidence=False))
    assert ("O04", "adec:1") in fired(cfg, decision_graph(context=False))


def test_o05_a_changed_mapping_end_is_stale(cfg):
    ends = {"clause:1": N("clause:1", "PolicyClause", text="one"), "control:1": N("control:1", "Control")}
    store = cfg.profile_dir
    rec = mappings.propose(store, relation="realises", s="clause:1", t="control:1", basis="b", owner="role:o", maker="p:m")
    mappings.ratify(store, rec["id"], by="p:c", resolve=ends.get)
    nodes, edges = mappings.graph_parts(store)

    def graph(clause):
        return G([clause, ends["control:1"]] + nodes, [(e["s"], e["r"], e["t"]) for e in edges], "ratified")

    assert ("O05", rec["id"]) not in fired(cfg, graph(ends["clause:1"]))
    assert ("O05", rec["id"]) in fired(cfg, graph(N("clause:1", "PolicyClause", text="two")))


def test_o06_approval_and_the_approved_hash(cfg):
    ok = [instr("instr:a", hash=H1, approvedHash=H1)]
    edges = [("instr:a", "approvedBy", "p:c"), ("instr:a", "proposedBy", "p:m")]
    assert ("O06", "instr:a") not in fired(cfg, G(ok, edges))
    assert ("O06", "instr:a") in fired(cfg, G(ok, edges[1:]))                          # no approver
    assert ("O06", "instr:a") in fired(cfg, G(ok, [("instr:a", "approvedBy", "p:m"), edges[1]]))   # the maker approved
    assert ("O06", "instr:a") in fired(cfg, G([instr("instr:a", hash=H1, approvedHash=H2)], edges))


def test_o07_a_step_in_the_context_of_an_ended_or_future_instruction(cfg):
    old = instr("instr:old", valid_from="2025-01-01", validTo="2026-06-01")
    new = instr("instr:new", valid_from="2026-09-01")
    step = N("step:1", "Step", ts="2026-07-01T10:00:00Z")
    assert ("O07", "step:1") in fired(cfg, G([old, step], [("step:1", "inContext", "instr:old")]))
    assert ("O07", "step:1") in fired(cfg, G([new, step], [("step:1", "inContext", "instr:new")]))
    cur = instr("instr:cur", valid_from="2026-01-01")
    assert ("O07", "step:1") not in fired(cfg, G([cur, step], [("step:1", "inContext", "instr:cur")]))


@needs_private
def test_o08_an_active_typology_needs_a_detecting_instruction(cfg):
    nodes = [N("typology:1", "Typology", "active"), instr(), N("typology:2", "Typology", "retired")]
    assert ("O08", "typology:1") in fired(cfg, G(nodes, []))
    found = fired(cfg, G(nodes, [("instr:i1", "detects", "typology:1")]))
    assert ("O08", "typology:1") not in found and ("O08", "typology:2") not in found


def write_records(cfg, agent, run, loaded):
    folder = cfg.data_dir / "runs"
    folder.mkdir(parents=True, exist_ok=True)
    rec = {"schema": "ranviera.run.v1", "run": run, "step": 0, "ts": "2026-10-07T09:00:00.000Z", "kind": "start",
           "agent": {"id": agent}, "payload": {"instructions_loaded": loaded}}
    (folder / f"{run}.records.jsonl").write_text(json.dumps(rec) + "\n", encoding="utf-8")
    return "run:" + slugify(f"{agent}-{run}", 80)


def test_o09_the_hash_a_running_agent_reported(cfg):
    rid = write_records(cfg, "alert-triage", "r1", [{"id": "instr:i1", "hash": H2}])
    nodes = [N(rid, "Run", label="Run r1"), instr(approvedHash=H1)]
    assert ("O09", rid) in fired(cfg, G(nodes, []))
    rid = write_records(cfg, "alert-triage", "r1", [{"id": "i1", "hash": H1.upper().replace("SHA256", "sha256")}])
    assert ("O09", rid) not in fired(cfg, G(nodes, []))     # the prefix is optional and case is ignored


def run_graph(model=True, prompt=True, params=True):
    nodes = [N("run:1", "Run"), N("model:m", "ModelVersion", "approved", promptHash=H1 if prompt else None,
                                   parameters='{"t":0}' if params else None), N("dagent:a", "DeployedAgent")]
    edges = [("run:1", "performedBy", "dagent:a"), ("dagent:a", "drawsOn", "model:m")]
    if model:
        edges.append(("run:1", "ranOn", "model:m"))
    return G(nodes, edges)


def test_o10_a_run_needs_a_model_a_prompt_hash_and_parameters(cfg):
    assert ("O10", "run:1") not in fired(cfg, run_graph())
    for kw in ({"model": False}, {"prompt": False}, {"params": False}):
        assert ("O10", "run:1") in fired(cfg, run_graph(**kw)), kw


def test_o10_retrieval_from_a_source_with_no_snapshot_hash(cfg):
    def graph(snapshot):
        g = run_graph()
        g["nodes"] += [N("step:1", "Step"), N("evid:1", "Evidence"), N("ksrc:k", "KnowledgeSource", snapshotHash=snapshot)]
        for s, r, t in (("run:1", "contains", "step:1"), ("step:1", "usedEvidence", "evid:1"), ("evid:1", "sourcedFrom", "ksrc:k")):
            g["edges"].append({"s": s, "r": r, "t": t, "w": 0.5, "evidence": None})
        return g

    assert ("O10", "run:1") in fired(cfg, graph(None))
    assert ("O10", "run:1") not in fired(cfg, graph(H1))


def write_verify(cfg, runs, breaks):
    folder = cfg.data_dir / "ledger"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "verify.json").write_text(json.dumps({"v": 1, "ok": not breaks, "entries": 9, "head_seq": 9,
                                                    "breaks": breaks, "runs": runs, "signature": "unsigned"}), encoding="utf-8")


def test_o11_fewer_captured_steps_than_reported_or_a_broken_chain(cfg):
    nodes = [N("run:1", "Run", label="Run r1"), N("run:2", "Run", label="Run r2")]
    write_verify(cfg, {"r1": {"captured": 6, "reported": 5, "status": "complete"},
                       "r2": {"captured": 6, "reported": 5, "status": "complete"}}, [])
    found = fired(cfg, G(nodes, []))
    assert ("O11", "run:1") not in found and ("O11", "run:2") not in found
    write_verify(cfg, {"r1": {"captured": 4, "reported": 5, "status": "incomplete"},
                       "r2": {"captured": 6, "reported": 5, "status": "complete"}},
                 [{"seq": 4, "reason": "r1 reports 5 steps and the ledger holds 3"}])
    found = fired(cfg, G(nodes, []))
    assert ("O11", "run:1") in found and ("O11", "run:2") not in found
    write_verify(cfg, {"r1": {"captured": 6, "reported": 5, "status": "complete"},
                       "r2": {"captured": 6, "reported": 5, "status": "complete"}},
                 [{"seq": 2, "reason": "entry_hash does not match the content, so the entry was altered"}])
    found = fired(cfg, G(nodes, []))
    assert ("O11", "run:1") in found and ("O11", "run:2") in found     # a break in the chain puts every run in doubt


def test_o12_a_model_version_outside_the_approved_set(cfg):
    assert ("O12", "run:1") not in fired(cfg, run_graph())
    pending = run_graph()
    pending["nodes"][1]["status"] = "pending"
    assert ("O12", "run:1") in fired(cfg, pending)
    other = run_graph()
    other["edges"] = [e for e in other["edges"] if e["r"] != "drawsOn"]
    assert ("O12", "run:1") in fired(cfg, other)       # the agent has not approved the model


def review_graph(overrides, seconds):
    nodes = [N("run:1", "Run"), N("dagent:a", "DeployedAgent"), N("step:1", "Step"), N("adec:1", "AgentDecision")]
    edges = [("run:1", "performedBy", "dagent:a"), ("run:1", "contains", "step:1"), ("step:1", "informedDecision", "adec:1")]
    for k, (o, s) in enumerate(zip(overrides, seconds)):
        nodes.append(N(f"review:{k}", "Review", override=o, timeOpenS=s))
        edges.append(("adec:1", "reviewedBy", f"review:{k}"))
    return G(nodes, edges)


def write_bounds(cfg, agents):
    p = cfg.data_dir / "bounds.json"
    p.write_text(json.dumps({"v": 1, "agents": agents}), encoding="utf-8")
    cfg.raw["monitoring_bounds"] = str(p)


def test_o13_has_no_default_threshold(cfg):
    g = review_graph([True, True, True, False], [5, 5, 5, 5])      # 750 thousandths overridden, 5 seconds each
    inferred, found = reason_all(cfg, g)
    assert ("O13", "dagent:a") not in found                         # no bounds file, so no bound
    assert inferred["transparency"]["bounds_file"] is None and inferred["transparency"]["measures"] == 2


def test_o13_maximum_and_minimum_of_the_bank(cfg):
    g = review_graph([True, True, True, False], [5, 5, 5, 5])
    write_bounds(cfg, {"dagent:a": {"override": {"min": None, "max": 700}}})
    assert ("O13", "dagent:a") in fired(cfg, g)
    write_bounds(cfg, {"dagent:a": {"override": {"min": None, "max": 800}}})
    assert ("O13", "dagent:a") not in fired(cfg, g)                 # under the maximum
    write_bounds(cfg, {"dagent:a": {"review_seconds": {"min": 20, "max": None}}})
    assert ("O13", "dagent:a") in fired(cfg, g)                     # under the minimum
    write_bounds(cfg, {"dagent:a": {"review_seconds": {"min": 5, "max": 5}}})
    assert ("O13", "dagent:a") not in fired(cfg, g)                 # on both bounds
    write_bounds(cfg, {"dagent:other": {"override": {"min": None, "max": 1}}})
    assert ("O13", "dagent:a") not in fired(cfg, g)                 # the bound belongs to another agent


def test_o13_an_unreadable_bounds_file_gives_no_bound_and_a_note(cfg):
    p = cfg.data_dir / "bounds.json"
    p.write_text("not json", encoding="utf-8")
    cfg.raw["monitoring_bounds"] = str(p)
    inferred, found = reason_all(cfg, review_graph([True], [1]))
    assert ("O13", "dagent:a") not in found and inferred["transparency"]["bounds_problem"]


def evidence_graph(source=True, evid_hash=H1, snap=H1):
    nodes = [N("evid:1", "Evidence", hash=H3, sourceHash=evid_hash), N("ksrc:k", "KnowledgeSource", snapshotHash=snap)]
    return G(nodes, [("evid:1", "sourcedFrom", "ksrc:k")] if source else [])


def test_o14_evidence_needs_a_source_whose_snapshot_hash_matches(cfg):
    assert ("O14", "evid:1") not in fired(cfg, evidence_graph())
    assert ("O14", "evid:1") in fired(cfg, evidence_graph(source=False))
    assert ("O14", "evid:1") in fired(cfg, evidence_graph(snap=H2))


@needs_private
def test_only_stated_computed_and_ratified_edges_feed_the_rules(cfg):
    nodes = [N("dagent:a", "DeployedAgent"), instr(), N("obligation:1", "Obligation", "active", effective_date="2025-01-01")]
    chain = [("obligation:1", "appliesTo", "dagent:a"), ("control:1", "satisfies", "obligation:1"),
             ("clause:1", "realises", "control:1"), ("instr:i1", "implementsClause", "clause:1"),
             ("dagent:a", "operatesUnder", "instr:i1")]
    assert ("O01", "obligation:1") not in fired(cfg, G(nodes, chain))
    g = G(nodes, chain)
    g["edges"][2]["provenance"] = "ratified"
    assert ("O01", "obligation:1") not in fired(cfg, g)                          # a ratified edge counts
    g["edges"][2]["provenance"] = "proposed"
    assert ("O01", "obligation:1") in fired(cfg, g)                              # a proposed mapping clears nothing
    g["edges"][2]["provenance"] = "inferred"
    g["edges"][2]["inferred"] = True
    assert ("O01", "obligation:1") in fired(cfg, g)                              # an inferred edge clears nothing


def test_findings_carry_proofs_and_helper_ids_continue(cfg):
    inferred, _ = reason_all(cfg, decision_graph(cited=False))
    fact = next(f for f in inferred["facts"] if f["rule"] == "O04" and f["args"][1] == "adec:1")
    assert fact["proof"] and fact["proof"]["rule"] == "O04"
    helper_ids = [h["id"] for h in inferred["helpers"]]
    assert helper_ids == [f"H{n:02d}" for n in range(1, len(helper_ids) + 1)]
    assert {r["id"] for r in inferred["rules"]} >= {"R01"} | (ALL_IDS if PRIVATE_RULES.is_file() else PUBLIC_IDS)


def test_the_first_program_alone_when_no_transparency_file_exists(cfg):
    for f in (cfg.ontology_dir / "rules").glob("transparency*.rls"):
        f.unlink()
    inferred, found = reason_all(cfg, decision_graph(cited=False))
    assert "transparency" not in inferred and not any(c.startswith("O") for c, _ in found)


@needs_private
def test_without_the_private_pack_the_public_rules_still_run(cfg):
    (cfg.ontology_dir / "rules" / "transparency_private.rls").unlink()
    inferred, found = reason_all(cfg, decision_graph(cited=False))
    ids = {r["id"] for r in inferred["rules"]}
    assert "O04" in ids and not ids & {"O01", "O02", "O08"}
    assert ("O04", "adec:1") in found
