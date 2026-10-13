"""A model suggester of conflicts between written instructions (13 October 2026).

`suggest-conflicts ROOT` sends the instruction files of the set-up at ROOT to a model in headless mode and asks for pairs of
instructions that cannot both be followed. A suggestion is kept only where both quotes are found word for word in the files.
With --write, each kept suggestion becomes a proposed mapping of the relation conflictsWith with the origin suggested, in the
same store as every other proposed link, so that a person ratifies or rejects it before rules R04 and O03 report it.

The switch is the key conflict_suggest_cmd (CORTEX_CONFLICT_SUGGEST_CMD), which is null by default. The module never reads
conflicts.py and makes no model call without the key (docs/CONTRACTS.md, "Conflict suggestions").
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import mappings

RELATION = "conflictsWith"
DEFAULT_MAKER = "conflict-suggester"
DEFAULT_SCOPE = "suggestions"
DEFAULT_MODEL = "sonnet"
DEFAULT_TIMEOUT = 600
DEFAULT_CHUNK = 60000
ENV_KEY = "CORTEX_CONFLICT_SUGGEST_CMD"
# credentials that would make the call bill an account instead of using the sign-in of the person
REMOVED_ENV = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")

SIDE = {"type": "object", "additionalProperties": False, "required": ["file", "line", "quote"],
        "properties": {"file": {"type": "string"}, "line": {"type": "integer"}, "quote": {"type": "string"}}}
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["conflicts"],
          "properties": {"conflicts": {"type": "array", "items": {
              "type": "object", "additionalProperties": False, "required": ["a", "b", "reason"],
              "properties": {"a": SIDE, "b": SIDE, "reason": {"type": "string"}}}}}}

SYSTEM = ("You review written instructions for an AI coding agent and report conflicts between them. You answer only with the "
          "JSON that the schema asks for.")

PROMPT = """Below are the instruction files of one Claude Code set-up: CLAUDE.md files, rule files and subagent files. Each file starts with a line "=== path ===" and each line of a file is shown as L<number>: <text>.

Find the pairs of instructions that conflict, meaning that an agent cannot follow both at once. A conflict may be a direct contradiction, different numbers for one setting, a choice of one option where the other instruction requires a different option, a scope or precedence clash, a condition that makes one instruction impossible under the other, or a subagent file that contradicts a rule file. Report a pair only where neither instruction states an exception, a precedence or a narrower scope that settles which one applies, and do not report instructions that cover different topics.

For each conflict give both sides. For each side give the file path exactly as it appears after "===", the line number, and a quote copied exactly from that line (a complete phrase of at least 4 words, with the same characters and spelling). Add a reason of one sentence that says why both cannot be followed. Report nothing that you are unsure of. If there is no conflict, return an empty list.

{files}
"""


@dataclass
class SourceFile:
    rel: str
    lines: list[str]

    def block(self) -> str:
        return f"=== {self.rel} ===\n" + "\n".join(f"L{i}: {t}" for i, t in enumerate(self.lines, start=1))


class SuggestError(ValueError):
    """A refused request. The message is one sentence that names the reason."""


# ---------------------------------------------------------------- input

def read_files(root: Path) -> list[SourceFile]:
    """Every instruction file of the set-up: CLAUDE.md anywhere, .claude/rules/*.md and .claude/agents/*.md."""
    root = Path(root)
    paths = sorted(root.rglob("CLAUDE.md"))
    for sub in ("rules", "agents"):
        d = root / ".claude" / sub
        if d.is_dir():
            paths += sorted(d.glob("*.md"))
    out = []
    for p in paths:
        try:
            lines = p.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        out.append(SourceFile(p.relative_to(root).as_posix(), lines))
    return out


def chunk_files(files: list[SourceFile], limit: int) -> list[list[SourceFile]]:
    """Whole files in chunks of at most limit characters. A file larger than the limit is its own chunk."""
    chunks: list[list[SourceFile]] = []
    cur: list[SourceFile] = []
    size = 0
    for f in files:
        n = len(f.block()) + 1
        if cur and size + n > limit:
            chunks.append(cur)
            cur, size = [], 0
        cur.append(f)
        size += n
    if cur:
        chunks.append(cur)
    return chunks


def jobs(chunks: list[list[SourceFile]]) -> list[list[SourceFile]]:
    """Each chunk alone and each pair of chunks together, so that a conflict between 2 chunks is still seen."""
    out = [list(c) for c in chunks]
    for i in range(len(chunks)):
        for j in range(i + 1, len(chunks)):
            out.append(chunks[i] + chunks[j])
    return out


def build_prompt(files: list[SourceFile]) -> str:
    return PROMPT.format(files="\n\n".join(f.block() for f in files))


# ---------------------------------------------------------------- the command

def command_from(cfg) -> list[str] | None:
    """The command named by the key conflict_suggest_cmd or its environment variable, or None while the switch is off."""
    v = os.environ.get(ENV_KEY) or (getattr(cfg, "raw", None) or {}).get("conflict_suggest_cmd")
    if isinstance(v, str):
        v = v.strip()
        if v.startswith("["):
            try:
                v = json.loads(v)
            except ValueError:
                raise SuggestError(f"The value of {ENV_KEY} is not a JSON array.") from None
        elif v:
            v = [v]
    if isinstance(v, list) and v and all(isinstance(x, str) and x for x in v):
        return list(v)
    return None


def call_env() -> dict:
    return {k: v for k, v in os.environ.items() if k not in REMOVED_ENV}


def command_version(cmd: list[str]) -> str:
    try:
        r = subprocess.run([*cmd, "--version"], capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
                           env=call_env(), cwd=tempfile.gettempdir())
        return (r.stdout.strip().splitlines() or ["unknown"])[0] if r.returncode == 0 else "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def run_model(cmd: list[str], prompt: str, model: str, timeout: int) -> tuple[dict, str]:
    """One headless call. The prompt goes on standard input. Returns the parsed envelope and the raw standard output."""
    args = [*cmd, "-p", "--model", model, "--tools", "", "--setting-sources", "project,local", "--no-session-persistence",
            "--disable-slash-commands", "--strict-mcp-config", "--output-format", "json",
            "--json-schema", json.dumps(SCHEMA), "--system-prompt", SYSTEM]
    with tempfile.TemporaryDirectory(prefix="ranviera-suggest-") as cwd:
        try:
            r = subprocess.run(args, input=prompt, capture_output=True, text=True, encoding="utf-8", timeout=timeout,
                               env=call_env(), cwd=cwd)
        except subprocess.TimeoutExpired:
            raise SuggestError(f"The model did not answer within {timeout} seconds.") from None
        except OSError as exc:
            raise SuggestError(f"The command could not start: {exc}") from None
    if r.returncode != 0:
        raise SuggestError(f"The command exited {r.returncode}: {(r.stderr or r.stdout).strip()[:200]}")
    try:
        env = json.loads(r.stdout)
    except ValueError:
        raise SuggestError("The command did not print a JSON result.") from None
    if not isinstance(env, dict) or env.get("is_error"):
        raise SuggestError(f"The model reported an error: {str(env.get('result') if isinstance(env, dict) else env)[:200]}")
    return env, r.stdout


def parse_envelope(env: dict, default_model: str) -> tuple[list[dict], str]:
    """The conflicts in the structured output of an envelope, and the model that answered."""
    data = env.get("structured_output")
    if not isinstance(data, dict):
        text = env.get("result")
        if isinstance(text, str):
            text = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", text.strip())
            try:
                data = json.loads(text)
            except ValueError:
                data = None
    if not isinstance(data, dict) or not isinstance(data.get("conflicts"), list):
        raise SuggestError("The answer holds no list of conflicts.")
    usage = env.get("modelUsage")
    model = next(iter(usage)) if isinstance(usage, dict) and usage else (env.get("model") or default_model)
    return [c for c in data["conflicts"] if isinstance(c, dict)], str(model)


# ---------------------------------------------------------------- verification

def _norm(t: str) -> str:
    return re.sub(r"\s+", " ", t).strip()


def locate(files: dict[str, SourceFile], side: object) -> dict | None:
    """The side with its quote found word for word in the named file, and the line that holds the quote, or None."""
    if not isinstance(side, dict):
        return None
    f = files.get(str(side.get("file", "")).strip().replace("\\", "/"))
    quote = _norm(str(side.get("quote", "")))
    if f is None or len(quote) < 8:
        return None
    try:
        stated = int(side.get("line"))
    except (TypeError, ValueError):
        stated = 0
    hits = [i for i, t in enumerate(f.lines, start=1) if quote in _norm(t)]
    if not hits:   # a quote that runs over a line break
        joined, starts = "", []
        for i, t in enumerate(f.lines, start=1):
            starts.append((len(joined), i))
            joined += _norm(t) + " "
        k = joined.find(quote)
        if k < 0:
            return None
        hits = [max(i for off, i in starts if off <= k)]
    line = min(hits, key=lambda i: (abs(i - stated), i))
    return {"file": f.rel, "line": line, "quote": quote}


def verify(items: list[dict], files: list[SourceFile]) -> tuple[list[dict], int]:
    """Suggestions with both quotes found in the files, the two sides in file order, and the count dropped."""
    by = {f.rel: f for f in files}
    kept, dropped = [], 0
    for it in items:
        a, b = locate(by, it.get("a")), locate(by, it.get("b"))
        reason = _norm(str(it.get("reason", "")))
        if not a or not b or (a["file"], a["line"]) == (b["file"], b["line"]) or not reason:
            dropped += 1
            continue
        a, b = sorted((a, b), key=lambda s: (s["file"], s["line"]))
        kept.append({"a": a, "b": b, "reason": reason})
    return kept, dropped


def dedupe(items: list[dict]) -> list[dict]:
    """One suggestion for each pair of lines, the first one found."""
    seen, out = set(), []
    for it in items:
        key = ((it["a"]["file"], it["a"]["line"]), (it["b"]["file"], it["b"]["line"]))
        if key not in seen:
            seen.add(key)
            out.append(it)
    return out


# ---------------------------------------------------------------- the run

def suggest(root: Path, cmd: list[str], *, model: str = DEFAULT_MODEL, timeout: int = DEFAULT_TIMEOUT,
            chunk_chars: int = DEFAULT_CHUNK, raw_dir: Path | None = None) -> dict:
    """Ask the model about the set-up at root. Returns the verified suggestions and the counts of the run."""
    root = Path(root)
    if not root.is_dir():
        raise SuggestError(f"The folder {root} does not exist.")
    files = read_files(root)
    if not files:
        raise SuggestError(f"The folder {root} holds no CLAUDE.md, rule file or agent file.")
    version = command_version(cmd)
    found, dropped, failed, errors, n = [], 0, 0, [], 0
    answered = model
    for job in jobs(chunk_files(files, chunk_chars)):
        n += 1
        when = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            env, raw = run_model(cmd, build_prompt(job), model, timeout)
            items, answered = parse_envelope(env, model)
        except SuggestError as exc:
            failed += 1
            errors.append(str(exc))
            continue
        if raw_dir is not None:
            Path(raw_dir).mkdir(parents=True, exist_ok=True)
            (Path(raw_dir) / f"call-{n}.json").write_text(raw, encoding="utf-8")
        kept, d = verify(items, files)
        dropped += d
        for k in kept:
            found.append({"v": 1, "a": k["a"], "b": k["b"], "reason": k["reason"], "model": answered, "version": version,
                          "time": when})
    found.sort(key=lambda s: (s["a"]["file"], s["a"]["line"], s["b"]["file"], s["b"]["line"]))
    return {"suggestions": dedupe(found), "dropped": dropped, "calls": n, "failed": failed, "errors": errors}


# ---------------------------------------------------------------- the store

def _graph_nodes(cfg) -> dict:
    try:
        graph = json.loads((cfg.data_dir / "graph.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    return {n["id"]: n for n in graph.get("nodes", []) if isinstance(n, dict) and str(n.get("id", "")).startswith("rule:")}


def end_id(nodes: dict, file: str, line: int) -> str:
    """The Rule node whose evidence ends with file:line, or file:line where the graph holds none."""
    tail = f"{file}:{line}"
    hits = [nid for nid in sorted(nodes)
            if (ev := str(((nodes[nid].get("props") or {}).get("evidence")) or "").replace("\\", "/")) == tail
            or ev.endswith("/" + tail)]
    return hits[0] if len(hits) == 1 else tail   # an evidence path that fits 2 nodes does not name one


def basis_of(s: dict) -> str:
    return (f"{s['a']['file']}:{s['a']['line']} says '{s['a']['quote']}' and {s['b']['file']}:{s['b']['line']} says "
            f"'{s['b']['quote']}'. {s['reason']}")


def write_proposals(cfg, suggestions: list[dict], *, owner: str, maker: str = DEFAULT_MAKER, scope: str = DEFAULT_SCOPE) -> dict:
    """Write each suggestion as a proposed mapping of origin suggested. A pair that a mapping already links, in either
    order and whatever its status but rejected, is counted as known."""
    nodes = _graph_nodes(cfg)
    profile = cfg.profile_dir
    live = {frozenset((m["s"], m["t"])) for sc in mappings.scopes(profile) for m in mappings.load(profile, sc)["mappings"]
            if m["relation"] == RELATION and m["status"] in ("proposed", "ratified")}
    written, known = [], 0
    for s in suggestions:
        s_id, t_id = end_id(nodes, s["a"]["file"], s["a"]["line"]), end_id(nodes, s["b"]["file"], s["b"]["line"])
        if frozenset((s_id, t_id)) in live:
            known += 1
            continue
        rec = mappings.propose(profile, relation=RELATION, s=s_id, t=t_id, basis=basis_of(s), owner=owner, maker=maker,
                               origin="suggested", scope=scope)
        data = mappings.load(profile, scope)
        for m in data["mappings"]:
            if m["id"] == rec["id"]:
                m["suggestion"] = s
                rec = m
        mappings.save(profile, data)
        live.add(frozenset((s_id, t_id)))
        written.append(rec["id"])
    return {"written": written, "known": known}


# ---------------------------------------------------------------- command line

def main(argv: list[str] | None = None) -> int:
    """suggest-conflicts ROOT [--write]. Exit 0 on success, 1 when a call failed, 2 on a refused or invalid request."""
    argv = list(argv or [])
    if argv[:1] == ["suggest-conflicts"]:
        argv = argv[1:]
    ap = argparse.ArgumentParser(prog="suggest-conflicts")
    ap.add_argument("root")
    ap.add_argument("--config")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--owner")
    ap.add_argument("--by", default=DEFAULT_MAKER)
    ap.add_argument("--scope", default=DEFAULT_SCOPE)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    ap.add_argument("--chunk-chars", type=int, default=DEFAULT_CHUNK)
    ap.add_argument("--raw-dir")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    def refuse(msg: str) -> int:
        print(msg)
        return 2

    from .config import load_config
    cfg = load_config(a.config)
    try:
        cmd = command_from(cfg)
        if cmd is None:
            return refuse("Model calls are off. Set the key conflict_suggest_cmd (or CORTEX_CONFLICT_SUGGEST_CMD) to the command "
                          "that you allow, and nothing was sent.")
        if a.write and not (a.owner and a.owner.strip()):
            return refuse("Writing proposals needs --owner, the person or role who reviews them.")
        res = suggest(Path(a.root), cmd, model=a.model, timeout=a.timeout, chunk_chars=a.chunk_chars,
                      raw_dir=Path(a.raw_dir) if a.raw_dir else None)
        out = {"written": [], "known": 0}
        if a.write and res["suggestions"]:
            out = write_proposals(cfg, res["suggestions"], owner=a.owner, maker=a.by, scope=a.scope)
    except (SuggestError, mappings.MappingError) as exc:
        return refuse(str(exc))
    if a.json:
        print(json.dumps({**res, **out}, ensure_ascii=False, indent=1))
    else:
        for s in res["suggestions"]:
            print(f"suggested: {s['a']['file']}:{s['a']['line']} and {s['b']['file']}:{s['b']['line']} ({s['reason']})")
        n = len(res["suggestions"])
        print(f"{n} suggested conflict{'s' if n != 1 else ''} from {res['calls']} call{'s' if res['calls'] != 1 else ''}, "
              f"{res['dropped']} dropped for a quote that is not in the files. Each is a proposal for a person to ratify or reject.")
        if a.write:
            print(f"{len(out['written'])} proposed mapping{'s' if len(out['written']) != 1 else ''} written, "
                  f"{out['known']} already known.")
        for e in res["errors"]:
            print(f"A call failed: {e}")
    return 1 if res["failed"] else 0
