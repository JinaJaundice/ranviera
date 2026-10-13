"""Integration tests of the agent transparency stage (7 October 2026): the build merges mappings, runs and saved legislation
into the graph, the private graph appears in graph.trig only on request and never in graph.ttl, and each compiler command
runs and returns the exit codes of docs/CONTRACTS.md. Only invented fixtures are read, and every build runs in a temporary
folder."""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from rdflib import Dataset, Graph
from rdflib.namespace import RDF

KG = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(KG))
from cortex_kg import compile as comp  # noqa: E402
from cortex_kg import ingest_run, mappings, reason  # noqa: E402
from cortex_kg.__main__ import main  # noqa: E402
from cortex_kg.config import load_config  # noqa: E402
from cortex_kg.importers import legislation  # noqa: E402
from cortex_kg.rdf import CX, GRAPH_BASE, node_iri  # noqa: E402

# the public copy holds no private pack loader (docs/AGENT_TRANSPARENCY.md, section 10), so the tests that load a pack skip there
needs_private_loaders = pytest.mark.skipif(not list((KG / "cortex_kg" / "importers").glob("*_loader.py")),
                                           reason="the private pack loaders are not in this copy")

ONT = KG.parent / "ontology"
FX = Path(__file__).resolve().parent / "fixtures"
RUN_FILE = FX / "runs" / "triage.run.v1.jsonl"
LEG_FILE = FX / "legislation" / "invented_instrument.xml"
PACK_FILE = FX / "packs" / "mini_pack.ttl"
INSTRUMENT = "uksi-2099-1"
PROVISION = "provision:uksi-2099-1-reg-1-2"
INSTR_CORE = "instr:triage-agent-core@3"
INSTR_ESC = "instr:triage-agent-escalation@1"
PRIVATE_GRAPH = GRAPH_BASE + "private-pack"


@pytest.fixture
def env(mini_home, monkeypatch):
    """A configuration file in the temporary folder, the Config that load_config reads from it, and its folders."""
    for key in ("CORTEX_CONFIG", "CORTEX_DATA_DIR", "CORTEX_PACK_DIR", "CORTEX_PACK_REGISTER", "CORTEX_PACK_PROFILE",
                "CORTEX_HUB_DIR", "CORTEX_INCLUDE_PRIVATE_GRAPHS", "CORTEX_MONITORING_BOUNDS", "CORTEX_LEDGER_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("CORTEX_ONTOLOGY", str(ONT))
    conf = {"claude_home": str(mini_home / "home"), "projects_root": str(mini_home / "projects"),
            "memory_dir": str(mini_home / "memory"), "data_dir": str(mini_home / "data"),
            "profile_dir": str(mini_home / "profile")}
    path = mini_home / "cortex.config.json"
    path.write_text(json.dumps(conf), encoding="utf-8")
    cfg = load_config(path)
    cfg.repo_root = mini_home / "repo"          # the build reads no harness of the real repository
    return SimpleNamespace(root=mini_home, conf=conf, path=path, cfg=cfg)


def cli(env, *argv) -> int:
    return main(["--config", str(env.path), *argv])


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def seed_graph_file(env, ids: list[str]) -> None:
    """A graph.json that the mapping commands can resolve ends against, without a build."""
    (env.cfg.data_dir).mkdir(parents=True, exist_ok=True)
    nodes = [{"id": i, "type": "Run", "label": i, "metrics": {"uses": 1}} for i in ids]
    (env.cfg.data_dir / "graph.json").write_text(json.dumps({"nodes": nodes, "edges": []}), encoding="utf-8")


def with_pack(env, tmp_path: Path) -> Path:
    folder = tmp_path / "local-pack"
    folder.mkdir()
    (folder / "mini_pack.ttl").write_bytes(PACK_FILE.read_bytes())
    return folder


def nodes_of(env) -> dict:
    return {n["id"]: n for n in read(env.cfg.data_dir / "graph.json")["nodes"]}


# ---- the build merges mappings, runs and legislation ----

def test_build_merges_mappings_runs_and_provisions(env):
    cfg = env.cfg
    ingest_run.ingest(RUN_FILE.read_text(encoding="utf-8"), cfg.data_dir)
    legislation.import_instrument(cfg, INSTRUMENT, from_file=LEG_FILE, today="2026-10-07")
    first = comp.build(cfg, today="2026-10-07")
    assert first["by_class"]["Run"] == 1 and first["by_class"]["Step"] >= 5
    assert PROVISION in nodes_of(env) and INSTR_CORE in nodes_of(env)

    # one ratified, one proposed and one rejected mapping, written through the commands
    assert cli(env, "mappings", "propose", "--relation", "implementsClause", "--from", INSTR_CORE, "--to", PROVISION,
               "--basis", "Core instruction.", "--owner", "role:mlro", "--by", "ana") == 0
    assert cli(env, "mappings", "propose", "--relation", "implementsClause", "--from", INSTR_ESC, "--to", PROVISION,
               "--basis", "Escalation instruction.", "--owner", "role:mlro", "--by", "ana") == 0
    assert cli(env, "mappings", "propose", "--relation", "detects", "--from", INSTR_CORE, "--to", PROVISION,
               "--basis", "Wrong link.", "--owner", "role:mlro", "--by", "ana") == 0
    ids = [m["id"] for m in mappings.list_mappings(cfg.profile_dir)]
    assert cli(env, "mappings", "ratify", ids[0], "--by", "ben") == 0
    assert cli(env, "mappings", "reject", ids[2], "--by", "ben", "--reason", "No such link.") == 0
    comp.build(cfg, today="2026-10-07")

    g = read(cfg.data_dir / "graph.json")
    by_id = {n["id"]: n for n in g["nodes"]}
    assert {i: by_id[i]["type"] for i in ids} == {i: "Mapping" for i in ids}
    assert by_id[ids[0]]["status"] == "ratified" and by_id[ids[2]]["status"] == "rejected"
    assert by_id[ids[0]]["family"] == "agent" and by_id[PROVISION]["family"] == "obligation"
    edge = {(e["s"], e["r"], e["t"]): e for e in g["edges"]}
    weights = {r["id"]: r["weight"] for r in g["relations"]}
    ratified = edge[(INSTR_CORE, "implementsClause", PROVISION)]
    proposed = edge[(INSTR_ESC, "implementsClause", PROVISION)]
    assert ratified["provenance"] == "ratified" and ratified["by"] == "ben"
    assert ratified["evidence"] == f"mappings/default.json#{ids[0]}"
    assert proposed["provenance"] == "proposed" and proposed["by"] == "ana"
    assert proposed["w"] == round(weights["implementsClause"] * 0.5, 4) and ratified["w"] == weights["implementsClause"]
    assert (INSTR_CORE, "detects", PROVISION) not in edge        # a rejected mapping gives no edge
    run_edges = {(e["r"]) for e in g["edges"]}
    assert {"performedBy", "ranOn", "inContext", "informedDecision"} <= run_edges
    assert all(e["provenance"] == "stated" for e in g["edges"] if e["r"] in ("performedBy", "contains"))
    assert not [f for f in read(cfg.data_dir / "findings.json")["findings"] if f["check"] in ("P08", "B08")]
    # the producers write what shapes F02 to F04, F06, F08 and F14 read (12 October 2026)
    kinds = {r: {e["s"] for e in g["edges"] if e["r"] == r} for r in ("ownedBy", "proposedBy", "approvedBy", "entryOf", "statesRationale")}
    assert set(ids) <= kinds["ownedBy"] and set(ids) <= kinds["proposedBy"]
    assert kinds["approvedBy"] == {ids[0]}                      # only the ratified mapping has an approver
    assert by_id[ids[0]]["props"]["ratifiedOn"] and by_id[ids[0]]["props"]["sourceAnchor"]
    runs = [n for n in g["nodes"] if n["type"] == "Run"]
    assert runs and all(n["props"].get("promptHash") for n in runs)
    assert kinds["statesRationale"] and {e["t"] for e in g["edges"] if e["r"] == "entryOf"} == {n["id"] for n in runs}

    # the rule facts read the ratified link and not the proposed one (O01 counts only ratified links)
    seen = {tuple(r) for r in reason.fact_rows(g)["edge"]}
    assert (INSTR_CORE, "implementsClause", PROVISION) in seen
    assert (INSTR_ESC, "implementsClause", PROVISION) not in seen

    ds = Dataset()
    ds.parse(str(cfg.data_dir / "graph.trig"), format="trig")
    named = NamedGraphs(ds)
    assert (node_iri(INSTR_CORE), CX.implementsClause, node_iri(PROVISION)) in named[GRAPH_BASE + "ratified"]
    assert (node_iri(INSTR_ESC), CX.implementsClause, node_iri(PROVISION)) in named[GRAPH_BASE + "proposed"]
    assert (node_iri(ids[0]), RDF.type, CX.Mapping) in named[GRAPH_BASE + "stated"]
    assert (node_iri(first_run(g)), RDF.type, CX.Run) in named[GRAPH_BASE + "stated"]


class NamedGraphs(dict):
    """The named graphs of a parsed dataset, where a graph that holds no triple is an empty one."""

    def __init__(self, ds):
        super().__init__({str(c.identifier): c for c in ds.graphs()})

    def __missing__(self, key):
        return Graph()


def first_run(g: dict) -> str:
    return next(n["id"] for n in g["nodes"] if n["type"] == "Run")


def test_mapping_anchors_ignore_the_metrics_of_a_build(env):
    cfg = env.cfg
    ingest_run.ingest(RUN_FILE.read_text(encoding="utf-8"), cfg.data_dir)
    comp.build(cfg, today="2026-10-07")
    rec = mappings.propose(cfg.profile_dir, relation="implementsClause", s=INSTR_CORE, t=INSTR_ESC, basis="b",
                           owner="role:mlro", maker="ana")
    assert cli(env, "mappings", "ratify", rec["id"], "--by", "ben") == 0
    comp.build(cfg, today="2026-10-08")      # the metrics and the build time change, and the nodes do not
    assert cli(env, "mappings", "list", "--stale", "--json") == 0
    assert mappings.list_stale(cfg.profile_dir, lambda i: nodes_of(env).get(i)) == []


# ---- the private graph ----

def test_private_graph_is_absent_unless_asked_for(env, tmp_path):
    env.cfg.raw["pack_dir"] = str(with_pack(env, tmp_path))
    comp.build(env.cfg, today="2026-10-07")
    trig = (env.cfg.data_dir / "graph.trig").read_text(encoding="utf-8")
    assert PRIVATE_GRAPH not in trig
    assert not [n for n in nodes_of(env).values() if (n.get("props") or {}).get("origin") == "local-pack"]
    assert "Invented" not in (env.cfg.data_dir / "graph.ttl").read_text(encoding="utf-8")


@needs_private_loaders
def test_private_nodes_go_to_the_sixth_graph_only(env, tmp_path):
    env.cfg.raw["pack_dir"] = str(with_pack(env, tmp_path))
    env.cfg.raw["include_private_graphs"] = True
    assert env.cfg.include_private_graphs is True
    comp.build(env.cfg, today="2026-10-07")
    private_ids = [i for i, n in nodes_of(env).items() if (n.get("props") or {}).get("origin") == "local-pack"]
    assert any(i.startswith("obligation:") for i in private_ids) and any(i.startswith("provision:") for i in private_ids)
    assert all(nodes_of(env)[i]["sensitivity"] == "internal" for i in private_ids)

    ttl = (env.cfg.data_dir / "graph.ttl").read_text(encoding="utf-8")
    assert "Invented" not in ttl and not any(f"/{i.split(':', 1)[1]}" in ttl for i in private_ids)
    ds = Dataset()
    ds.parse(str(env.cfg.data_dir / "graph.trig"), format="trig")
    named = NamedGraphs(ds)
    private = named[PRIVATE_GRAPH]
    for i in private_ids:
        assert (node_iri(i), CX.origin, None) in private
        for name in ("stated", "ratified", "proposed", "inferred"):
            assert (node_iri(i), None, None) not in named[GRAPH_BASE + name]
            assert (None, None, node_iri(i)) not in named[GRAPH_BASE + name]


def test_private_graph_stays_out_when_no_key_is_set(env):
    env.cfg.raw["include_private_graphs"] = True
    comp.build(env.cfg, today="2026-10-07")
    assert PRIVATE_GRAPH not in (env.cfg.data_dir / "graph.trig").read_text(encoding="utf-8")


def test_config_keys_default_to_null_and_take_the_environment(env, monkeypatch, tmp_path):
    cfg = env.cfg
    assert [getattr(cfg, k) for k in ("pack_dir", "pack_register", "hub_dir", "pack_profile", "monitoring_bounds",
                                       "ledger_key")] == [None] * 6
    assert cfg.include_private_graphs is False
    monkeypatch.setenv("CORTEX_PACK_DIR", str(tmp_path))
    monkeypatch.setenv("CORTEX_INCLUDE_PRIVATE_GRAPHS", "true")
    assert cfg.pack_dir == tmp_path.resolve() or cfg.pack_dir == Path(str(tmp_path))
    assert cfg.include_private_graphs is True
    monkeypatch.setenv("CORTEX_INCLUDE_PRIVATE_GRAPHS", "false")
    assert cfg.include_private_graphs is False


# ---- the commands ----

def test_mappings_commands_and_their_ledger_entries(env, capsys):
    seed_graph_file(env, ["a:one", "b:two"])
    assert cli(env, "mappings", "propose", "--relation", "satisfies", "--from", "a:one", "--to", "b:two", "--basis", "b",
               "--owner", "role:o", "--by", "Ana") == 0
    new_id = capsys.readouterr().out.strip().splitlines()[-1]
    assert new_id.startswith("map:")
    assert cli(env, "mappings", "propose", "--relation", "satisfies", "--from", "a:one", "--by", "Ana") == 2   # refused
    assert cli(env, "mappings", "ratify", new_id, "--by", " ana ") == 2                                         # the maker
    assert cli(env, "mappings", "ratify", "map:20000101-001", "--by", "ben") == 2                               # unknown
    assert not (env.cfg.data_dir / "ledger").exists()
    capsys.readouterr()
    assert cli(env, "mappings", "ratify", new_id, "--by", "Ben", "--note", "checked", "--json") == 0
    assert json.loads(capsys.readouterr().out)["status"] == "ratified"
    assert cli(env, "mappings", "reassign", new_id, "--by", "Ben", "--owner", "role:p") == 0
    assert cli(env, "mappings", "reject", new_id, "--by", "Cat", "--reason", "Withdrawn.") == 0
    assert cli(env, "mappings", "reassign", new_id, "--by", "Cat", "--owner", "role:q") == 2                    # rejected
    kinds = [json.loads(line)["kind"] for p in sorted((env.cfg.data_dir / "ledger").glob("*.jsonl"))
             for line in p.read_text(encoding="utf-8").splitlines()]
    assert kinds == ["mapping.ratify", "mapping.reassign", "mapping.reject"]
    assert cli(env, "ledger", "verify") == 0
    capsys.readouterr()
    assert cli(env, "mappings", "list", "--status", "rejected", "--json") == 0
    assert [m["id"] for m in json.loads(capsys.readouterr().out)] == [new_id]


def test_mappings_list_stale_reports_a_changed_end(env, capsys):
    seed_graph_file(env, ["a:one", "b:two"])
    rec = mappings.propose(env.cfg.profile_dir, relation="satisfies", s="a:one", t="b:two", basis="b", owner="role:o", maker="ana")
    assert cli(env, "mappings", "ratify", rec["id"], "--by", "ben") == 0
    capsys.readouterr()
    assert cli(env, "mappings", "list", "--stale", "--json") == 0 and json.loads(capsys.readouterr().out) == []
    graph = read(env.cfg.data_dir / "graph.json")
    graph["nodes"][1]["label"] = "changed"
    (env.cfg.data_dir / "graph.json").write_text(json.dumps(graph), encoding="utf-8")
    assert cli(env, "mappings", "list", "--stale", "--json") == 0
    rows = json.loads(capsys.readouterr().out)
    assert [r["id"] for r in rows] == [rec["id"]] and "has changed" in rows[0]["stale"][0]


def test_ingest_run_and_ledger_verify(env, monkeypatch, capsys):
    assert cli(env, "ingest-run", str(RUN_FILE), "--json") == 0
    out = json.loads(capsys.readouterr().out)
    assert len(out["runs"]) == 1 and out["entries_added"] > 0
    assert cli(env, "ingest-run", str(RUN_FILE)) == 0                      # a repeat adds nothing
    monkeypatch.setattr(sys, "stdin", io.StringIO(RUN_FILE.read_text(encoding="utf-8")))
    assert cli(env, "ingest-run", "-") == 0
    bad = env.root / "bad.jsonl"
    bad.write_text('{"schema": "wrong"}\n', encoding="utf-8")
    assert cli(env, "ingest-run", str(bad)) == 2
    assert cli(env, "ingest-run", str(env.root / "missing.jsonl")) == 2
    assert cli(env, "ingest-run", str(RUN_FILE), "--format", "hook") == 2
    capsys.readouterr()
    assert cli(env, "ledger", "verify", "--json") == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True
    assert (env.cfg.data_dir / "ledger" / "verify.json").is_file()
    month = next((env.cfg.data_dir / "ledger").glob("*.jsonl"))
    lines = month.read_text(encoding="utf-8").splitlines()
    month.write_text("\n".join([lines[0].replace("run.record", "review")] + lines[1:]) + "\n", encoding="utf-8")
    assert cli(env, "ledger", "verify") == 1                               # an altered entry breaks the chain
    assert cli(env, "ledger", "verify", "--head", str(env.root / "no-head.json")) == 1


def test_import_legislation_command(env, capsys):
    assert cli(env, "import-legislation", "--instrument", INSTRUMENT, "--from-file", str(LEG_FILE), "--json") == 0
    rows = json.loads(capsys.readouterr().out)
    assert rows[0]["provisions"] > 3 and rows[0]["sha256"]
    assert (env.cfg.data_dir / "imports" / "legislation" / "uksi-2099-1.provisions.json").is_file()
    assert cli(env, "import-legislation", "--instrument", INSTRUMENT) == 0                   # the saved page
    assert cli(env, "import-legislation", "--instrument", "uksi-2099-2") == 2                # no outbound call without --fetch
    assert cli(env, "import-legislation", "--instrument", "a", "--instrument", "b", "--from-file", str(LEG_FILE)) == 2
    assert cli(env, "import-legislation", "--instrument", INSTRUMENT, "--from-file", str(env.root / "none.xml")) == 2
    with pytest.raises(SystemExit) as exc:
        cli(env, "import-legislation")
    assert exc.value.code == 2


@needs_private_loaders
def test_import_pack_command(env, monkeypatch, tmp_path, capsys):
    assert cli(env, "import-pack") == 0                                       # no key set: nothing to load
    assert "nothing to load" in capsys.readouterr().out
    monkeypatch.setenv("CORTEX_PACK_DIR", str(with_pack(env, tmp_path)))
    manifest = env.cfg.data_dir / "imports" / "pack.json"
    assert cli(env, "import-pack", "--check", "--json") == 0
    assert json.loads(capsys.readouterr().out)["manifest"]["loaded"]["obligations"] >= 1 and not manifest.exists()
    assert cli(env, "import-pack") == 0 and manifest.is_file()
    assert "mini_pack.ttl" in manifest.read_text(encoding="utf-8")
    monkeypatch.setenv("CORTEX_PACK_DIR", str(tmp_path / "absent"))
    assert cli(env, "import-pack") == 1                                       # a key is set and nothing loads


def test_demo_build_command(env, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "cortex_kg.demo", None)
    assert cli(env, "demo", "build", "--seed", "3") == 2
    assert "not built yet" in capsys.readouterr().out
    seen = []
    monkeypatch.setitem(sys.modules, "cortex_kg.demo", SimpleNamespace(main=lambda argv: seen.append(argv) or 1))
    assert cli(env, "demo", "build", "--seed", "3", "--out", "somewhere") == 1
    assert seen == [["--seed", "3", "--out", "somewhere"]]
