"""Tests for the cortex-knowledge skill: its readers, their read only guarantee and its placement by install.

The readers run as the skill ships them, in a copy of the skill folder and from an unrelated working directory,
over a copy of kg/tests/fixtures/skill_knowledge/learn.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from cortex_kg import sync
from cortex_kg.config import Config

REPO = Path(__file__).resolve().parents[2]
SKILL_SRC = REPO / "skills" / "cortex-knowledge"
FIXTURE = Path(__file__).parent / "fixtures" / "skill_knowledge" / "learn"
FIXED_TIME_NS = 1_700_000_000_000_000_000


@pytest.fixture()
def skill(tmp_path):
    dest = tmp_path / "skillcopy" / "cortex-knowledge"
    shutil.copytree(SKILL_SRC, dest)
    return dest


@pytest.fixture()
def learn(tmp_path):
    dest = tmp_path / "data" / "learn"
    shutil.copytree(FIXTURE, dest)
    for p in sorted(dest.rglob("*"), reverse=True):
        os.utime(p, ns=(FIXED_TIME_NS, FIXED_TIME_NS))
    os.utime(dest, ns=(FIXED_TIME_NS, FIXED_TIME_NS))
    return dest


def snapshot(folder: Path) -> dict:
    out = {}
    for p in [folder, *sorted(folder.rglob("*"))]:
        rel = p.relative_to(folder).as_posix()
        out[rel] = (p.read_bytes() if p.is_file() else None, p.stat().st_mtime_ns)
    return out


def run(skill_dir: Path, reader: str, *args: str, learn_dir: Path | None = None, env: dict | None = None,
        cwd: Path | None = None):
    full_env = {k: v for k, v in os.environ.items() if k != "CORTEX_LEARN_DIR"}
    full_env.update(env or {})
    cmd = [sys.executable, str(skill_dir / "scripts" / f"{reader}.py")]
    if learn_dir is not None:
        cmd += ["--learn-dir", str(learn_dir)]
    cmd += list(args)
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", env=full_env,
                          cwd=str(cwd or skill_dir.parent), stdin=subprocess.DEVNULL, timeout=60)


def data(skill_dir, learn_dir, reader, *args):
    r = run(skill_dir, reader, "--format", "json", *args, learn_dir=learn_dir)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout), r


ALL_COMMANDS = [
    ("sessions", ["list"]),
    ("sessions", ["read", "chat_one"]),
    ("sessions", ["read", "chat_one", "--include-agent-thinking", "--include-operations"]),
    ("sessions", ["read", "chat_practice"]),
    ("graph", ["propositions"]),
    ("graph", ["propositions", "--session", "chat_one"]),
    ("graph", ["find", "settle"]),
    ("graph", ["chains"]),
    ("graph", ["chains", "--node", "n_aaaaaaaaaaaa"]),
    ("graph", ["births"]),
    ("sources", ["roots"]),
    ("sources", ["files"]),
    ("outcomes", ["list"]),
    ("outcomes", ["held"]),
]


# ---------------------------------------------------------------- B-11-01, B-11-02

def test_skill_folder_is_portable():
    text = (SKILL_SRC / "SKILL.md").read_text(encoding="utf-8")
    assert text.startswith("---\n")
    front = text.split("---\n")[1]
    assert "name: cortex-knowledge" in front
    assert "license: Apache-2.0" in front
    desc = [line for line in front.splitlines() if line.startswith("description:")][0][len("description:"):].strip()
    assert 1 <= len(desc) <= 1024
    assert len(text.splitlines()) < 500
    assert "references/data-format.md" in text
    licence = (SKILL_SRC / "LICENSE").read_text(encoding="utf-8")
    assert "Apache License" in licence and "Version 2.0" in licence
    assert licence == (REPO / "public" / "LICENSE").read_text(encoding="utf-8")
    for path in (SKILL_SRC / "scripts").glob("*.py"):
        compile(path.read_text(encoding="utf-8"), str(path), "exec", dont_inherit=True)
        body = path.read_text(encoding="utf-8")
        assert "import requests" not in body and "urllib" not in body and "socket" not in body


def test_readers_run_from_a_copy_and_leave_no_cache(skill, learn, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    for reader, args in ALL_COMMANDS:
        r = run(skill, reader, *args, learn_dir=learn, cwd=elsewhere)
        assert r.returncode == 0, (reader, args, r.stderr)
        assert f"Learning folder: {learn}" in r.stdout or str(learn).replace("\\", "\\\\") in r.stdout
    assert not list(skill.rglob("__pycache__"))
    assert not list(skill.rglob("*.pyc"))
    assert list(elsewhere.iterdir()) == []


# ---------------------------------------------------------------- B-11-12, B-11-18

@pytest.mark.parametrize("fmt", ["markdown", "json"])
def test_every_reader_leaves_the_folder_byte_and_time_unchanged(skill, learn, fmt):
    before = snapshot(learn)
    for reader, args in ALL_COMMANDS:
        r = run(skill, reader, "--format", fmt, *args, learn_dir=learn)
        assert r.returncode == 0, (reader, args, r.stderr)
    assert snapshot(learn) == before


def test_a_failed_read_also_changes_nothing(skill, learn):
    (learn / "graph" / "format.json").write_text('{"version": 9}', encoding="utf-8")
    os.utime(learn / "graph" / "format.json", ns=(FIXED_TIME_NS, FIXED_TIME_NS))
    before = snapshot(learn)
    for args in (["propositions"], ["find", "x"], ["chains"], ["births"]):
        assert run(skill, "graph", *args, learn_dir=learn).returncode == 1
    assert run(skill, "sessions", "read", "chat_future", learn_dir=learn).returncode == 1
    assert run(skill, "sessions", "read", "chat_missing", learn_dir=learn).returncode == 1
    assert snapshot(learn) == before


# ---------------------------------------------------------------- B-11-03 location

def test_folder_resolution_option_then_environment_then_default(skill, learn, tmp_path):
    other = tmp_path / "other"
    shutil.copytree(FIXTURE, other)
    (other / "chats" / "chat_practice.json").unlink()
    home = tmp_path / "home"
    default = home / ".claude" / "cortex" / "learn"
    shutil.copytree(FIXTURE, default)
    (default / "chats" / "chat_one.json").unlink()
    home_env = {"HOME": str(home), "USERPROFILE": str(home)}

    r = run(skill, "sessions", "list", learn_dir=learn, env={"CORTEX_LEARN_DIR": str(other), **home_env})
    assert str(learn) in r.stdout and "chat_practice" in r.stdout  # the option wins
    r = run(skill, "sessions", "list", env={"CORTEX_LEARN_DIR": str(other), **home_env})
    assert str(other) in r.stdout and "chat_practice" not in r.stdout and "chat_one" in r.stdout
    r = run(skill, "sessions", "list", env=home_env)
    assert str(default) in r.stdout and "chat_one" not in r.stdout and "chat_practice" in r.stdout
    r = run(skill, "sessions", "--data-dir", str(other), "list")
    assert r.returncode == 0 and str(other) in r.stdout  # the alias


def test_missing_folder_is_an_error_and_is_never_created(skill, tmp_path):
    missing = tmp_path / "nowhere" / "learn"
    r = run(skill, "graph", "propositions", learn_dir=missing)
    assert r.returncode == 1
    assert "does not exist" in r.stderr and "Nothing was created" in r.stderr
    assert not missing.exists() and not missing.parent.exists()
    home = tmp_path / "emptyhome"
    home.mkdir()
    r = run(skill, "sessions", "list", env={"HOME": str(home), "USERPROFILE": str(home)})
    assert r.returncode == 1 and not (home / ".claude").exists()


def test_empty_folder_gives_an_empty_result_and_creates_nothing(skill, tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    for reader, args in ALL_COMMANDS:
        if args[0] == "read":
            continue
        r = run(skill, reader, "--format", "json", *args, learn_dir=empty)
        assert r.returncode == 0, (reader, args, r.stderr)
        assert json.loads(r.stdout)["count"] == 0
    assert list(empty.iterdir()) == []


# ---------------------------------------------------------------- refusal of a newer format

def test_newer_graph_format_is_refused_with_no_partial_output(skill, learn):
    (learn / "graph" / "format.json").write_text('{"version": 2}', encoding="utf-8")
    for args in (["propositions"], ["find", "settle"], ["chains"], ["births"]):
        r = run(skill, "graph", *args, learn_dir=learn)
        assert r.returncode == 1 and r.stdout == ""
        assert "newer" in r.stderr and "Update the skill" in r.stderr and "No migration" in r.stderr


def test_a_stamp_that_is_not_a_whole_number_is_refused(skill, learn):
    for stamp in ('{"version": true}', '{"version": "1"}', '{"version": 1.5}', '{}', '[1]'):
        (learn / "graph" / "format.json").write_text(stamp, encoding="utf-8")
        r = run(skill, "graph", "propositions", learn_dir=learn)
        assert r.returncode == 1, stamp


def test_newer_session_and_cortex_files_are_refused(skill, learn):
    r = run(skill, "sessions", "read", "chat_future", learn_dir=learn)
    assert r.returncode == 1 and "newer" in r.stderr
    body = json.loads((learn / "cortex" / "sources.json").read_text(encoding="utf-8"))
    body["version"] = 2
    (learn / "cortex" / "sources.json").write_text(json.dumps(body), encoding="utf-8")
    r = run(skill, "sources", "roots", learn_dir=learn)
    assert r.returncode == 1 and "newer" in r.stderr and r.stdout == ""


def test_older_dialect_and_bad_ids_are_refused(skill, learn):
    r = run(skill, "sessions", "read", "chat_legacy", learn_dir=learn)
    assert r.returncode == 1 and "older" in r.stderr
    for bad in ("..", "../graph/format", "a/b", "chat one", ""):
        r = run(skill, "sessions", "read", bad, learn_dir=learn)
        assert r.returncode == 1, bad
    (learn / "chats" / "chat_wrong.json").write_text(
        (learn / "chats" / "chat_practice.json").read_text(encoding="utf-8"), encoding="utf-8")
    r = run(skill, "sessions", "read", "chat_wrong", learn_dir=learn)
    assert r.returncode == 1 and "does not match" in r.stderr


# ---------------------------------------------------------------- sessions

def test_session_list_names_files_it_could_not_read(skill, learn):
    payload, r = data(skill, learn, "sessions", "list")
    ids = [s["id"] for s in payload["sessions"]]
    assert ids == ["chat_one", "chat_practice"]
    kinds = {s["id"]: s["kind"] for s in payload["sessions"]}
    assert kinds == {"chat_one": "teach", "chat_practice": "practice"}
    assert payload["skipped_count"] == 2
    reasons = {s["file"]: s["reason"] for s in payload["skipped"]}
    assert "newer" in reasons["chats/chat_future.json"]
    assert "older" in reasons["chats/chat_legacy.json"]
    assert "warning" in r.stderr and "chat_future" in r.stderr


def test_session_read_keeps_learner_evidence(skill, learn):
    payload, _ = data(skill, learn, "sessions", "read", "chat_one")
    view = payload["session"]
    result = [m for m in view["messages"] if m["id"] == "msg_r1"][0]["result"]
    ans = result["answer"]
    assert result["source"] == "details"
    assert ans["confidence"] == 90 and ans["correct"] is False and ans["dontKnow"] is False
    assert ans["thinking"] == "I thought finality came at once."
    assert ans["thinkingFrom"] == "legacy field note"
    assert ans["readingThinking"] == "Read the options twice."
    assert ans["target"] == ["n_aaaaaaaaaaaa"]
    assert "extraContent" not in result  # the compact form adds nothing
    assert view["storedContext"]["customField"] == {"keep": "me"}


def test_session_read_names_every_omission(skill, learn):
    payload, _ = data(skill, learn, "sessions", "read", "chat_one")
    sources = {o["source"]: o["reason"] for o in payload["session"]["omissions"]}
    assert payload["omission_count"] == len(sources)
    assert "agent thinking" in sources["messages[1].content[0]"]
    assert "arguments of the tool read" in sources["messages[1].content[2].arguments"]
    assert "accounting" in sources["messages[1].usage"] and "accounting" in sources["messages[1].stopReason"]
    assert "operation tool" in sources["messages[2].content"]
    assert "embedded payload" in sources["messages[1].content[3].arguments.svg"]
    assert "embedded payload" in sources["messages[3].details.html"]
    assert "embedded payload" in sources["messages[7].content[1].data"]
    assert "compact form" in sources["messages[3].content"]
    assert "statements of injected propositions" in sources["messages[5].details.propositions"]
    assert "turns" in sources and "settings" in sources
    text = json.dumps(payload)
    for hidden in ("FILE BODY", "~/secret.md", "agent considers", "<svg>", "AAAABASE64", "<script>"):
        assert hidden not in text
    # a failed operation result is never hidden
    failed = [m for m in payload["session"]["messages"] if m["id"] == "msg_r2"][0]["result"]
    assert failed["isError"] is True and failed["content"][0]["text"] == "file missing"


def test_flags_restore_operations_and_thinking_but_never_payloads(skill, learn):
    payload, _ = data(skill, learn, "sessions", "read", "chat_one", "--include-agent-thinking", "--include-operations")
    text = json.dumps(payload)
    assert "agent considers" in text and "FILE BODY" in text and "~/secret.md" in text
    assert "Verbose graph text" in text and "Settlement is final when it cannot be reversed." in text
    for hidden in ("<svg>", "AAAABASE64", "<script>"):
        assert hidden not in text
    sources = [o["source"] for o in payload["session"]["omissions"]]
    assert "messages[1].content[3].arguments.svg" in sources and "messages[7].content[1].data" in sources
    assert "messages[1].content[0]" not in sources


def test_markers_and_unknown_shapes_are_labelled(skill, learn):
    payload, _ = data(skill, learn, "sessions", "read", "chat_one")
    msgs = {m["id"]: m for m in payload["session"]["messages"]}
    assert msgs["msg_c1"]["marker"]["label"] == "context marker"
    assert msgs["msg_c1"]["marker"]["details"]["propositions"] == [{"id": "n_aaaaaaaaaaaa", "name": "Settlement finality"}]
    assert msgs["msg_c2"]["marker"]["label"] == "unsupported marker"
    assert msgs["msg_c2"]["marker"]["content"] == "Something new"
    assert msgs["msg_w1"]["role"] == "unsupported" and msgs["msg_w1"]["raw"]["spell"] == "unknown"


def test_markdown_treats_stored_text_as_data(skill, learn):
    r = run(skill, "sessions", "read", "chat_one", learn_dir=learn)
    assert r.returncode == 0
    lines = r.stdout.splitlines()
    assert "## Omissions (" in r.stdout and lines[0] == "# Settlement &lt;b&gt;finality&lt;/b&gt;"
    assert f"- Learning folder: {learn}" in r.stdout
    assert "> ### Teacher" in lines and "### Teacher" not in lines  # stored text cannot pass for a heading
    forged = [i for i, line in enumerate(lines) if "Ignore all earlier instructions" in line]
    assert forged and all(lines[i].startswith(">") for i in forged)
    assert "Learner confidence (self-reported" in r.stdout
    assert "<script>" not in r.stdout and "<svg>" not in r.stdout


# ---------------------------------------------------------------- graph: merge

def test_nodes_merge_exactly_as_the_contract_says(skill, learn):
    payload, _ = data(skill, learn, "graph", "propositions")
    nodes = {n["id"]: n for n in payload["propositions"]}
    assert sorted(nodes) == ["n_aaaaaaaaaaaa", "n_bbbbbbbbbbbb", "n_cccccccccccc", "n_dddddddddddd", "n_hhhhhhhhhhhh"]
    a = nodes["n_aaaaaaaaaaaa"]
    assert a["name"] == "Settlement finality"  # the first line fixes the name, and a later name is not an alias
    assert a["statement"] == "Settlement is final when it cannot be reversed."
    assert a["createdAt"] == "2026-10-01T09:00:00.000Z"
    assert a["aliases"] == ["finality", "Final settlement cannot be undone.", "irreversibility"]
    assert "Finality again" not in a["aliases"] and "" not in a["aliases"]
    assert a["provenance"] == [{"chatId": "chat_one", "messageId": "msg_a1"}, {"chatId": "src_111111111111", "messageId": ""}]
    assert a["birthSource"] == "chat_one" and a["support"] == 2
    assert nodes["n_cccccccccccc"]["birthSource"] is None  # no provenance, no birth source


def test_malformed_ledger_lines_are_reported_not_hidden(skill, learn):
    payload, r = data(skill, learn, "graph", "propositions")
    lines = sorted(s["line"] for s in payload["skipped"] if s["file"] == "graph/nodes.jsonl")
    assert lines == [3, 7, 8, 9]
    reasons = " ".join(s["reason"] for s in payload["skipped"])
    assert "not valid JSON" in reasons and "NaN" in reasons and "aliases" in reasons
    assert "Results may be incomplete" in r.stderr
    md = run(skill, "graph", "propositions", learn_dir=learn).stdout
    assert "## Skipped records (5)" in md  # four node lines and one chain line


def test_chains_merge_on_the_sorted_premise_set(skill, learn):
    payload, _ = data(skill, learn, "graph", "chains")
    chains = {c["id"]: c for c in payload["chains"]}
    assert sorted(chains) == ["arg_111111111111", "arg_333333333333"]  # the second line merged into the first
    merged = chains["arg_111111111111"]
    assert merged["premises"] == ["n_bbbbbbbbbbbb", "n_aaaaaaaaaaaa"]  # the first line fixes the order
    assert merged["createdAt"] == "2026-10-02T10:00:00.000Z"
    assert merged["provenance"] == [{"chatId": "chat_one", "messageId": "msg_a1"}, {"chatId": "src_111111111111", "messageId": ""}]
    assert merged["conclusionNode"]["name"] == "Chain of title"
    assert chains["arg_333333333333"]["conclusionNode"] is None
    md = run(skill, "graph", "chains", learn_dir=learn).stdout
    assert "(missing proposition)" in md
    assert "Recorded propositions and reasoning, not mastery" in md


def test_chains_for_a_node(skill, learn):
    payload, _ = data(skill, learn, "graph", "chains", "--node", "n_cccccccccccc")
    assert [c["id"] for c in payload["chains"]] == ["arg_111111111111"]
    payload, _ = data(skill, learn, "graph", "chains", "--node", "n_aaaaaaaaaaaa")
    assert [c["id"] for c in payload["chains"]] == ["arg_111111111111", "arg_333333333333"]
    payload, _ = data(skill, learn, "graph", "chains", "--node", "n_unknown")
    assert payload["count"] == 0


def test_birth_sources_and_clusters(skill, learn):
    payload, _ = data(skill, learn, "graph", "births")
    rows = {r["id"]: r for r in payload["births"]}
    assert rows["chat_one"]["kind"] == "chat" and rows["chat_one"]["label"] == "Settlement <b>finality</b>"
    assert rows["chat_one"]["propositions"] == 1 and rows["chat_one"]["cluster"] is False
    src = rows["src_111111111111"]
    assert src["propositions"] == 3 and src["cluster"] is True
    assert src["label"] == "settlement.final"  # only the last extension is removed
    only, _ = data(skill, learn, "graph", "propositions", "--session", "src_111111111111")
    assert [n["id"] for n in only["propositions"]] == ["n_bbbbbbbbbbbb", "n_dddddddddddd", "n_hhhhhhhhhhhh"]


def test_display_name_from_source_organisation(skill, learn):
    org = {"version": 1, "folders": [], "placements": {"src_111111111111": {"folderId": None, "name": "Settlement notes"}}}
    (learn / "graph" / "source-organization.json").write_text(json.dumps(org), encoding="utf-8")
    payload, _ = data(skill, learn, "graph", "births")
    assert {r["id"]: r["label"] for r in payload["births"]}["src_111111111111"] == "Settlement notes"


def test_an_unknown_birth_source_is_labelled_missing(skill, learn):
    (learn / "graph" / "sources.json").write_text("{}", encoding="utf-8")
    payload, _ = data(skill, learn, "graph", "births")
    row = {r["id"]: r for r in payload["births"]}["src_111111111111"]
    assert row["kind"] == "missing" and row["label"] == "src_111111111111"


# ---------------------------------------------------------------- graph: find

def test_find_by_name_statement_and_alias_in_ledger_order(skill, learn):
    def ids(query):
        payload, _ = data(skill, learn, "graph", "find", query)
        return [n["id"] for n in payload["propositions"]]

    assert ids("CUSTODY") == ["n_bbbbbbbbbbbb"]  # name and statement, any case
    assert ids("irreversib") == ["n_aaaaaaaaaaaa"]  # alias
    assert ids("undone") == ["n_aaaaaaaaaaaa"]  # a later statement kept as an alias
    assert ids("title") == ["n_cccccccccccc"]
    assert ids("Straße") == ["n_cccccccccccc"]
    assert ids("e") == ["n_aaaaaaaaaaaa", "n_bbbbbbbbbbbb", "n_cccccccccccc", "n_dddddddddddd", "n_hhhhhhhhhhhh"]


def test_find_wildcard_is_the_only_special_character(skill, learn):
    def ids(query):
        payload, _ = data(skill, learn, "graph", "find", query)
        return [n["id"] for n in payload["propositions"]]

    assert ids("*lists*span*") == ["n_dddddddddddd"]  # a star crosses a newline
    assert ids("lists*span") == []  # a query with a star is not wrapped in stars
    assert ids("A ledger lists entries.*") == ["n_dddddddddddd"]
    assert ids("e.d") == [] and ids("(") == [] and ids("[a-z]") == [] and ids("?") == []
    assert ids("title.") == []


def test_find_case_folding_follows_the_application_not_python(skill):
    sys.path.insert(0, str(SKILL_SRC / "scripts"))
    sys.dont_write_bytecode = True
    try:
        import graph
    finally:
        sys.path.remove(str(SKILL_SRC / "scripts"))
    assert graph.fold("é") == "É"
    assert graph.fold("ß") == "ß"  # the upper case form has two characters
    assert graph.fold("ı") == "ı"  # a non ASCII character that would become ASCII
    assert graph.fold("ſ") == "ſ"
    assert graph.fold("a") == "A"
    assert graph.fold("\U0001F600") == "\U0001F600"
    assert graph.fold("\U00010428") == "\U00010428"  # outside the basic plane stays as it is
    assert graph.compile_query("strasse").fullmatch(graph.fold("Straße")) is None


def test_empty_arguments_are_refused_and_whitespace_is_accepted(skill, learn):
    for args in (["find", ""], ["propositions", "--session", ""], ["chains", "--node", ""]):
        r = run(skill, "graph", *args, learn_dir=learn)
        assert r.returncode == 1 and "empty" in r.stderr, args
    r = run(skill, "graph", "find", " ", learn_dir=learn)
    assert r.returncode == 0


def test_a_ledger_that_is_a_symlink_out_of_the_folder_is_refused(skill, learn, tmp_path):
    outside = tmp_path / "outside.jsonl"
    outside.write_text("{}", encoding="utf-8")
    (learn / "graph" / "nodes.jsonl").unlink()
    try:
        os.symlink(outside, learn / "graph" / "nodes.jsonl")
    except (OSError, NotImplementedError):
        pytest.skip("symbolic links are not available")
    r = run(skill, "graph", "propositions", learn_dir=learn)
    assert r.returncode == 1 and "outside the learning folder" in r.stderr


# ---------------------------------------------------------------- sources and outcomes

def test_sources_roots_and_files(skill, learn):
    payload, _ = data(skill, learn, "sources", "roots")
    assert payload["count"] == 1
    root = payload["roots"][0]
    assert root["id"] == "root_11111111" and root["path"] == "C:/Users/example/Vault"
    assert root["files"] == {"current": 1, "missing": 0, "pending": 0, "refused": 1}
    assert any("root_broken" in s["reason"] for s in payload["skipped"])
    files, _ = data(skill, learn, "sources", "files")
    states = {f["sourceId"]: f["state"] for f in files["files"]}
    assert states == {"src_111111111111": "current", "src_222222222222": "refused"}  # the newest line wins
    assert any(s["file"] == "cortex/files.jsonl" and s["line"] == 4 for s in files["skipped"])
    refused, _ = data(skill, learn, "sources", "files", "--state", "refused")
    assert refused["count"] == 1 and refused["files"][0]["reason"] == "sensitivity"
    none, _ = data(skill, learn, "sources", "files", "--root", "root_other")
    assert none["count"] == 0


def test_sources_never_open_the_paths_they_name(skill, learn, tmp_path):
    decoy = tmp_path / "decoy"
    decoy.mkdir()
    body = json.loads((learn / "cortex" / "sources.json").read_text(encoding="utf-8"))
    body["roots"]["root_11111111"]["path"] = str(decoy).replace("\\", "/")
    (learn / "cortex" / "sources.json").write_text(json.dumps(body), encoding="utf-8")
    os.utime(decoy, ns=(FIXED_TIME_NS, FIXED_TIME_NS))
    before = snapshot(decoy)
    data(skill, learn, "sources", "roots")
    data(skill, learn, "sources", "files")
    assert snapshot(decoy) == before


def test_outcomes_list_orders_by_time_and_skips_invalid_lines(skill, learn):
    payload, _ = data(skill, learn, "outcomes", "list")
    ids = [o["id"] for o in payload["outcomes"]]
    assert ids == [f"out_00000000000{n}" for n in (1, 2, 3, 4, 6, 7, 8, 9)]  # line 5 has no target
    assert [s["line"] for s in payload["skipped"]] == [5]
    node, _ = data(skill, learn, "outcomes", "list", "--node", "n_bbbbbbbbbbbb")
    assert [o["id"] for o in node["outcomes"]] == ["out_000000000002", "out_000000000004"]
    md = run(skill, "outcomes", "list", "--node", "n_bbbbbbbbbbbb", learn_dir=learn).stdout
    assert "confidence none recorded" in md  # an absent confidence is not zero


def test_held_band_follows_the_contract(skill, learn):
    payload, _ = data(skill, learn, "outcomes", "held")
    bands = {h["node"]: h["held"] for h in payload["held"]}
    assert bands["n_hhhhhhhhhhhh"] == "held"  # two correct answers at rung R0 and null
    assert bands["n_aaaaaaaaaaaa"] == "shaky"  # the newest two are right, but a structural miss is in the newest three
    assert bands["n_bbbbbbbbbbbb"] == "shaky"  # not known is not correct
    assert bands["n_dddddddddddd"] == "shaky"  # rung R3 in the newest two
    last = {h["node"]: h["lastTested"] for h in payload["held"]}
    assert last["n_hhhhhhhhhhhh"] == "2026-10-08T11:00:00.000Z"
    unknown, _ = data(skill, learn, "outcomes", "held", "--node", "n_cccccccccccc")
    assert unknown["held"] == [{"node": "n_cccccccccccc", "held": "unknown", "outcomes": 0, "lastTested": None}]


def test_held_rule_edges_and_calibration(skill):
    sys.path.insert(0, str(SKILL_SRC / "scripts"))
    sys.dont_write_bytecode = True
    try:
        import outcomes
    finally:
        sys.path.remove(str(SKILL_SRC / "scripts"))

    def o(correct=True, rung=None, miss=None, conf=None):
        return {"correct": correct, "rung": rung, "missClass": miss, "confidence": conf, "source": "choice"}

    assert outcomes.held_band([]) == "unknown"
    assert outcomes.held_band([o()]) == "shaky"  # one outcome is not enough
    assert outcomes.held_band([o(), o()]) == "held"
    assert outcomes.held_band([o(miss="structural"), o(), o()]) == "shaky"
    assert outcomes.held_band([o(miss="structural"), o(), o(), o()]) == "held"  # the fourth newest is outside the window
    assert outcomes.held_band([o(rung="R2"), o()]) == "shaky"
    assert outcomes.held_band([o(correct=False), o()]) == "shaky"
    assert outcomes.calibration([o(conf=90)] * 4) is None
    cal = outcomes.calibration([o(conf=90)] * 5)
    assert cal["band"] == "calibrated" and cal["gap"] == pytest.approx(-0.1)
    over = outcomes.calibration([o(correct=False, conf=90)] * 5)
    assert over["band"] == "overconfident" and over["n"] == 5
    under = outcomes.calibration([o(conf=10)] * 5)
    assert under["band"] == "underconfident"


def test_calibration_in_the_fixture(skill, learn):
    payload, _ = data(skill, learn, "outcomes", "held")
    cal = payload["calibration"]
    assert cal["n"] == 7 and cal["meanConfidence"] == pytest.approx(0.7)
    assert cal["accuracy"] == pytest.approx(6 / 7) and cal["band"] == "underconfident"


# ---------------------------------------------------------------- install and export

def make_cfg(tmp_path: Path) -> Config:
    home = tmp_path / "u1" / ".claude"
    home.mkdir(parents=True)
    repo = tmp_path / "repo"
    (repo / "skills").mkdir(parents=True)
    shutil.copytree(SKILL_SRC, repo / "skills" / "cortex-knowledge")
    projects = tmp_path / "work" / "Projects"
    projects.mkdir(parents=True)
    return Config(claude_home=home, projects_root=projects, memory_dir=home / "m", data_dir=home / "cortex",
                  port=5182, include_sensitivity=["public"], log_prompt_snippets=False, repo_root=repo)


def test_install_places_the_skill_and_export_carries_it(tmp_path, capsys):
    cfg = make_cfg(tmp_path)
    res = sync.install(cfg)
    placed = cfg.claude_home / "skills" / "cortex-knowledge"
    names = sorted(p.relative_to(placed).as_posix() for p in placed.rglob("*") if p.is_file())
    assert names == sorted(p.relative_to(SKILL_SRC).as_posix() for p in SKILL_SRC.rglob("*")
                           if p.is_file() and "__pycache__" not in p.parts)
    assert res["skill_files"] == len(names)
    for n in names:
        assert (placed / n).read_bytes() == (SKILL_SRC / n).read_bytes()
    capsys.readouterr()

    exported = sync.export(cfg)
    mirror = cfg.harness_dir / "skills" / "cortex-knowledge"
    assert (mirror / "SKILL.md").is_file() and (mirror / "scripts" / "graph.py").is_file()
    assert exported["files"] >= len(names)
    assert (mirror / "LICENSE").read_bytes() == (SKILL_SRC / "LICENSE").read_bytes()


def test_install_backs_up_an_existing_copy_first(tmp_path, capsys):
    cfg = make_cfg(tmp_path)
    placed = cfg.claude_home / "skills" / "cortex-knowledge"
    (placed / "scripts").mkdir(parents=True)
    (placed / "SKILL.md").write_text("old skill text\n", encoding="utf-8")
    (placed / "extra.txt").write_text("kept\n", encoding="utf-8")
    res = sync.install(cfg)
    capsys.readouterr()
    backups = list((cfg.claude_home / "backups").glob("*-cortex-install"))
    assert len(backups) == 1
    saved = backups[0] / "skills" / "cortex-knowledge" / "SKILL.md"
    assert saved.read_text(encoding="utf-8") == "old skill text\n"
    assert (placed / "SKILL.md").read_bytes() == (SKILL_SRC / "SKILL.md").read_bytes()
    assert (placed / "extra.txt").read_text(encoding="utf-8") == "kept\n"  # nothing is deleted
    assert any(line == "backup skills/cortex-knowledge/SKILL.md" for line in res["plan"])
    # a second install changes nothing and makes no second backup of the new files
    again = sync.install(cfg)
    capsys.readouterr()
    assert again["skill_files"] == 0


def test_dry_run_install_changes_nothing(tmp_path, capsys):
    cfg = make_cfg(tmp_path)
    res = sync.install(cfg, dry_run=True)
    capsys.readouterr()
    assert not (cfg.claude_home / "skills").exists()
    assert any(line.startswith("copy skills/cortex-knowledge/") for line in res["plan"])


def test_install_without_the_skill_in_the_repository_is_unchanged(tmp_path, capsys):
    cfg = make_cfg(tmp_path)
    shutil.rmtree(cfg.repo_root / "skills")
    res = sync.install(cfg)
    capsys.readouterr()
    assert res["skill_files"] == 0 and not (cfg.claude_home / "skills").exists()


def test_the_merge_skips_a_later_statement_equal_to_the_first_as_the_server_and_harvester_do():
    """Parity with server/src/learn/knowledge/ledger.ts mergeNodes and kg/cortex_kg/harvest/knowledge.py merge_nodes
    (contract review of 2 November 2026): a repeat of the fixed statement never becomes an alias, so merging a merged
    result again changes nothing."""
    import importlib.util
    scripts = SKILL_SRC / "scripts"
    spec = importlib.util.spec_from_file_location("skill_graph", scripts / "graph.py")
    graph = importlib.util.module_from_spec(spec)
    import sys
    sys.path.insert(0, str(scripts))
    try:
        spec.loader.exec_module(graph)
    finally:
        sys.path.remove(str(scripts))
    first = {"id": "n_aaaaaaaaaaaa", "name": "Rate", "statement": "A bucket refills.", "aliases": ["A bucket refills."],
             "createdAt": "2026-11-02T00:00:00.000Z", "provenance": [{"chatId": "chat_a", "messageId": "m1"}]}
    later = dict(first, name="Other", statement="A bucket refills.", aliases=["Refill"],
                 provenance=[{"chatId": "src_bbbbbbbbbbbb", "messageId": ""}])
    merged = graph.merge_nodes([first, later])["n_aaaaaaaaaaaa"]
    assert merged["statement"] == "A bucket refills."
    assert merged["aliases"] == ["Refill"]
    assert [p["chatId"] for p in merged["provenance"]] == ["chat_a", "src_bbbbbbbbbbbb"]


# ---------------------------------------------------------------- C8 default folder order

def _home_with(tmp_path, *names):
    home = tmp_path / "homec8"
    for name in names:
        shutil.copytree(FIXTURE, home / ".claude" / name / "learn")
    return home, {"HOME": str(home), "USERPROFILE": str(home)}


def test_default_falls_back_to_the_ranviera_folder(skill, tmp_path):
    home, env = _home_with(tmp_path, "ranviera")
    r = run(skill, "sessions", "list", env=env)
    assert r.returncode == 0, r.stderr
    assert str(home / ".claude" / "ranviera" / "learn") in r.stdout


def test_default_prefers_cortex_and_names_the_other_folder(skill, tmp_path):
    home, env = _home_with(tmp_path, "cortex", "ranviera")
    r = run(skill, "sessions", "list", env=env)
    assert r.returncode == 0, r.stderr
    assert str(home / ".claude" / "cortex" / "learn") in r.stdout
    assert str(home / ".claude" / "ranviera" / "learn") in r.stderr
    # one folder only: no note about another
    home, env = _home_with(tmp_path / "solo", "cortex")
    r = run(skill, "sessions", "list", env=env)
    assert r.returncode == 0 and "ranviera" not in r.stderr


def test_default_error_names_both_folders(skill, tmp_path):
    home = tmp_path / "bare"
    home.mkdir()
    r = run(skill, "graph", "propositions", env={"HOME": str(home), "USERPROFILE": str(home)})
    assert r.returncode == 1
    assert "cortex" in r.stderr and "ranviera" in r.stderr and "Nothing was created" in r.stderr
    assert not (home / ".claude").exists()


# ---------------------------------------------------------------- C8 parity with the golden fixtures

GOLDEN = Path(__file__).parent / "fixtures" / "knowledge"


def _golden(skill, tmp_path, case, *args):
    dest = tmp_path / "golden" / case
    shutil.copytree(GOLDEN / case, dest)
    r = run(skill, "graph", "--format", "json", *args, learn_dir=dest)
    expected = json.loads((GOLDEN / case / "expected.json").read_text(encoding="utf-8"))
    return r, expected


def test_merge_paraphrase_matches_the_golden_result(skill, tmp_path):
    r, expected = _golden(skill, tmp_path, "merge-paraphrase", "propositions")
    assert r.returncode == 0, r.stderr
    got = {p["id"]: p for p in json.loads(r.stdout)["propositions"]}
    assert sorted(got) == sorted(p["id"] for p in expected["propositions"])
    for want in expected["propositions"]:
        p = got[want["id"]]
        for key in ("name", "statement", "aliases", "createdAt", "provenance"):
            assert p[key] == want[key], (want["id"], key)
        assert p["support"] == want["metrics"]["support"]
    r, _ = _golden(skill, tmp_path / "again", "merge-paraphrase", "chains")
    chains = {c["id"]: c for c in json.loads(r.stdout)["chains"]}
    assert sorted(chains) == sorted(c["id"] for c in expected["chains"])
    for want in expected["chains"]:
        c = chains[want["id"]]
        for key in ("premises", "conclusion", "createdAt", "provenance"):
            assert c[key] == want[key], (want["id"], key)


def test_torn_append_keeps_only_whole_lines(skill, tmp_path):
    r, expected = _golden(skill, tmp_path, "torn-append", "propositions")
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout)
    assert [p["id"] for p in out["propositions"]] == expected["nodes"]
    assert out["skipped_count"] > 0
    r, _ = _golden(skill, tmp_path / "again", "torn-append", "chains")
    assert [c["id"] for c in json.loads(r.stdout)["chains"]] == expected["chains"]


def test_format_newer_is_refused_with_both_versions(skill, tmp_path):
    r, expected = _golden(skill, tmp_path, "format-newer", "propositions")
    assert r.returncode == 1 and r.stdout == ""
    assert f"version {expected['found']}" in r.stderr and f"({expected['supported']})" in r.stderr
