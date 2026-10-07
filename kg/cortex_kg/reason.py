"""The reasoning step: turn the compiled graph into Nemo facts, run the Datalog rules in ontology/rules/*.rls, and
return the inferred facts with a proof tree for each finding. This is the only module that imports nmo_python, which
its authors mark as experimental, so every call into the engine is wrapped. A failure of the engine gives finding B03,
and run() raises only where it cannot write inferred.json or inferred.ttl."""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from datetime import date, datetime, timezone
from pathlib import Path

from .config import Config

MAX_PROOFS = 2000        # inferred facts that get a proof (every finding gets one as well)
MAX_DEPTH = 8            # a proof tree is cut at this depth
OUTPUTS = ("inferred", "violation", "warning", "info")
HEADER_RE = re.compile(r"^%%\s*(R\d+|[A-Z]\d+)\s*\|\s*(\w+)\s*\|\s*(.+?)\s*$")
VAR_RE = re.compile(r"\?[A-Za-z_][A-Za-z_0-9]*")
B03_MESSAGE = ("The reasoning step did not run because the rule engine Nemo is not available, "
               "so the graph has no inferred facts and no rule findings.")
NEG_RE = re.compile(r"~\s*(\w+)\s*\(([^()]*)\)")
ABSENT = "absent from the graph"   # the rule of a proof child that records a negated atom
# only edges of these provenances feed the rules, and an edge with no provenance counts as stated
RULE_PROVENANCE = ("stated", "computed", "ratified")
BRACKET_RE = re.compile(r"\(([^()]*\d{4}[^()]*)\)")
# the order in which inferred relations get a proof when the cap bites
RELATION_ORDER = {"overrides": 0, "supersedesChain": 1, "restates": 2, "appliesToTask": 3}


# ---------------------------------------------------------------- facts

def _q(value) -> str:
    """A Nemo string constant. Backslashes are escaped, and a string with a quote uses the triple-quoted form."""
    s = re.sub(r"[\r\n\t]+", " ", str(value)).replace("\\", "\\\\")
    if '"' not in s:
        return f'"{s}"'
    if s.endswith('"') or '"""' in s:  # the triple-quoted form cannot hold these, so the quote is replaced
        s = s.replace('"', "”")
        return f'"{s}"'
    return f'"""{s}"""'


def _day(text) -> int | None:
    """A date as an integer such as 20260929, or None where the text does not start with a real calendar date."""
    try:
        d = date.fromisoformat(str(text or "")[:10])
    except ValueError:
        return None
    return d.year * 10000 + d.month * 100 + d.day


def _idle(last_used, today: str) -> int | None:
    """The days from the last use to today. The last use is converted to the local zone, which is the zone of today."""
    try:
        last = datetime.fromisoformat(str(last_used).replace("Z", "+00:00"))
        if last.tzinfo is not None:
            last = last.astimezone()
        return max(0, (date.fromisoformat(today) - last.date()).days)
    except (TypeError, ValueError):
        return None


def _stated_day(n: dict) -> int | None:
    """The date of a node where the node gives it in brackets: props.dateSource "bracketed", or else a bracketed date
    in the text that matches the node date. A date found elsewhere in the text may be one the text only mentions, so it
    is not a date the node was given and no rule orders by it."""
    props = n.get("props") or {}
    d = _day(n.get("date"))
    if d is None:
        return None
    source = props.get("dateSource")
    if source is not None:
        return d if source == "bracketed" else None
    from . import md
    for b in reversed(BRACKET_RE.findall(str(props.get("text") or ""))):
        ds = md.dates_in(b)
        if ds:
            return d if _day(ds[-1]) == d else None
    return None


def _observed_days(cfg: Config, today: str) -> int | None:
    """The days from the first recorded event to today, so that no recorded use can be told from no coverage."""
    try:
        first = sorted(cfg.events_dir.glob("*.jsonl"))[0]
        with open(first, encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    ts = json.loads(line)["ts"]
                    return max(0, (date.fromisoformat(today) - date.fromisoformat(str(ts)[:10])).days)
    except (IndexError, OSError, ValueError, KeyError, TypeError):
        return None
    return None


# the columns of each fact predicate, "s" for a string and "i" for an integer
FACT_FORMATS = {"node": "ss", "edge": "sss", "status": "ss", "day": "si", "stated_day": "si", "sensitivity": "ss",
                "uses": "si", "idle": "si", "observed": "i"}


def fact_rows(graph_json: dict, today: str | None = None, observed: int | None = None) -> dict[str, list[tuple]]:
    """The rows of each fact predicate: node, edge, status, day, stated_day, sensitivity, uses, idle and observed. Only
    edges of provenance stated, computed or ratified are given, so a proposed or inferred edge feeds no rule."""
    today = today or date.today().isoformat()
    rows: dict[str, list[tuple]] = {p: [] for p in FACT_FORMATS}
    for n in graph_json.get("nodes", []):
        i = n["id"]
        rows["node"].append((i, n.get("type") or ""))
        props = n.get("props") or {}
        status = n.get("status") or props.get("status") or props.get("termStatus")
        if status:
            rows["status"].append((i, str(status)))
        d = _day(n.get("date"))
        if d is not None:
            rows["day"].append((i, d))
        sd = _stated_day(n)
        if sd is not None:
            rows["stated_day"].append((i, sd))
        rows["sensitivity"].append((i, n.get("sensitivity") or "internal"))
        m = n.get("metrics") or {}
        rows["uses"].append((i, int(m.get("uses") or 0)))
        idle = _idle(m.get("last_used"), today) if m.get("last_used") else None
        if idle is not None:
            rows["idle"].append((i, idle))
    for e in graph_json.get("edges", []):
        if e.get("inferred") or (e.get("provenance") or "stated") not in RULE_PROVENANCE:
            continue  # an inferred edge is the rules' own output, and a proposed edge has not been reviewed
        rows["edge"].append((e["s"], e["r"], e["t"]))
    if observed is not None:
        rows["observed"].append((observed,))
    return rows


def graph_digest(graph_json: dict) -> str:
    """The sha256 of the graph as the rules see it: the nodes and the edges that are not inferred, in a canonical form.
    graph.json on disk gives the same digest as the graph in memory at build time, whatever the rules inferred."""
    body = {"nodes": graph_json.get("nodes", []),
            "edges": [e for e in graph_json.get("edges", []) if not e.get("inferred") and e.get("provenance") != "inferred"]}
    text = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _fact_line(pred: str, row: tuple) -> str:
    fmt = FACT_FORMATS[pred]
    return f"{pred}({', '.join(_q(v) if c == 's' else str(v) for v, c in zip(row, fmt))}) ."


def facts(graph_json: dict, today: str | None = None, observed: int | None = None) -> str:
    """The Nemo fact text for a compiled graph, one line for each row of fact_rows."""
    out = [_fact_line(pred, r) for pred, rows in fact_rows(graph_json, today, observed).items() for r in rows]
    return "\n".join(out) + "\n"


def _csv_program(rows: dict[str, list[tuple]], folder: str) -> str:
    """Write each fact predicate to a CSV file in the folder and return the @import lines. Nemo reads a file much faster
    than the same facts as program text, and traces them faster too."""
    import csv
    imports = []
    for pred, preds_rows in rows.items():
        with open(os.path.join(folder, f"{pred}.csv"), "w", newline="", encoding="utf-8") as fh:
            csv.writer(fh).writerows(preds_rows)
        fmt = ",".join("string" if c == "s" else "int" for c in FACT_FORMATS[pred])
        imports.append(f'@import {pred} :- csv{{resource="{pred}.csv", format=({fmt})}} .')
    return "\n".join(imports) + "\n"


# ---------------------------------------------------------------- rules

def _statements(text: str) -> list[dict]:
    """Split rule text into statements, each with the header that governs it (None for a helper)."""
    out, header, buf = [], None, []
    for line in text.splitlines():
        s = line.strip()
        m = HEADER_RE.match(s)
        if m:
            header = {"id": m.group(1), "kind": m.group(2), "message": m.group(3)}
            continue
        if not s or s.startswith("%"):
            continue
        s = re.sub(r"\s%.*$", "", s)
        buf.append(s)
        if s.endswith("."):
            out.append({"text": " ".join(buf), "header": header})
            buf = []
    return out


def _head_pred(text: str) -> str:
    m = re.match(r"\s*(\w+)", text)
    return m.group(1) if m else ""


def validate_statements(statements: list[dict]) -> None:
    """A statement under a header must derive one of the output predicates, and a statement that derives one must have a
    header. Otherwise a helper that follows a header would be attributed to that rule, and an output without a header
    would have no identifier. Raises ValueError."""
    for s in statements:
        pred = _head_pred(s["text"])
        if s["header"] and pred not in OUTPUTS:
            raise ValueError(f"The statement '{s['text'][:60]}' follows the header of rule {s['header']['id']} but derives "
                             f"{pred}, which is not an output. Put helper rules before the first header.")
        if not s["header"] and pred in OUTPUTS:
            raise ValueError(f"The statement '{s['text'][:60]}' derives the output {pred} but has no rule header.")


def helper_rules(statements: list[dict]) -> list[dict]:
    """The helper rules, in order, as {id, text} with the identifiers H01, H02 and so on. A directive such as @output is not
    a rule, so it is left out."""
    texts = [s["text"] for s in statements if not s["header"] and not s["text"].startswith("@")]
    return [{"id": f"H{i:02d}", "text": t} for i, t in enumerate(texts, 1)]


def _source(path_or_text) -> str:
    if isinstance(path_or_text, Path) or (isinstance(path_or_text, str) and "\n" not in path_or_text and Path(path_or_text).is_file()):
        return Path(path_or_text).read_text(encoding="utf-8")
    return str(path_or_text)


def parse_rules(path_or_text) -> list[dict]:
    """The rule headers of a file or of rule text, as {id, kind, message, text}. The text joins the rule's statements."""
    rules: dict[str, dict] = {}
    for st in _statements(_source(path_or_text)):
        h = st["header"]
        if not h:
            continue
        r = rules.setdefault(h["id"], {"id": h["id"], "kind": h["kind"], "message": h["message"], "text": ""})
        r["text"] = (r["text"] + "\n" + st["text"]).strip()
    return list(rules.values())


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", text)


def _head(rule_text: str) -> str:
    return rule_text.split(":-", 1)[0].strip()


def _body(rule_text: str) -> str:
    return rule_text.split(":-", 1)[1] if ":-" in rule_text else ""


def _unquote(term: str) -> str:
    t = term.strip()
    if len(t) >= 6 and t.startswith('"""') and t.endswith('"""'):
        return t[3:-3]
    if len(t) >= 2 and t.startswith('"') and t.endswith('"'):
        return t[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return t


def _split_args(text: str) -> list[str]:
    """The terms of an atom's argument list, split at the commas that are outside a quoted string."""
    out, buf, quoted, i = [], [], False, 0
    while i < len(text):
        c = text[i]
        if c == "\\" and quoted and i + 1 < len(text):
            buf.append(text[i:i + 2])
            i += 2
            continue
        if c == '"':
            quoted = not quoted
        if c == "," and not quoted:
            out.append("".join(buf).strip())
            buf = []
        else:
            buf.append(c)
        i += 1
    if "".join(buf).strip():
        out.append("".join(buf).strip())
    return out


def _rule_files(cfg: Config) -> list[Path]:
    return sorted((cfg.ontology_dir / "rules").glob("*.rls"))


def weights(cfg: Config) -> dict[str, float]:
    """The forward weight of each relation: the starting weights.json and then the profile's."""
    from .config import weights_table
    table = weights_table(cfg)
    return {k: float(v.get("weight", 0.3) if isinstance(v, dict) else v) for k, v in table.items()
            if isinstance(v, (int, float, dict))}


# ---------------------------------------------------------------- proofs

def _substitute(head: str, assignment: dict) -> str:
    return VAR_RE.sub(lambda m: str(assignment.get(m.group(0), m.group(0))), head)


class NegationError(RuntimeError):
    """A negated atom that the engine holds, so that the recorded absence would be false."""


class _Prover:
    """Converts a Nemo trace into a proof tree. A rule with negation gets one child for each negated atom of its body,
    instantiated from the variable assignment of the trace, with the fact "not <atom>" and the rule "absent from the
    graph". Each child is checked against the engine's own rows for the predicate (or against the facts given to it
    for an input predicate), so a child never states an absence that the engine contradicts."""

    def __init__(self, engine, statements: list[dict], helpers: list[dict], holds) -> None:
        self.engine = engine
        self.by_text = {_norm(s["text"]): s["header"]["id"] for s in statements if s["header"]}
        self.by_text.update({_norm(h["text"]): h["id"] for h in helpers})
        self.holds = holds                # holds(pred, terms) is True where the atom is in the engine's rows
        self.negations_checked = 0

    def rule_id(self, rule_text: str) -> str:
        return self.by_text.get(_norm(rule_text), rule_text)

    def negations(self, text: str, assignment: dict) -> list[dict]:
        out = []
        for pred, argtext in NEG_RE.findall(_body(text)):
            terms = []
            for t in _split_args(argtext):
                terms.append(str(assignment[t]) if t.startswith("?") else t)
            if self.holds(pred, tuple(_unquote(t) for t in terms)):
                raise NegationError(f"The rule negates {pred}({', '.join(terms)}), but the engine holds that atom.")
            self.negations_checked += 1
            out.append({"fact": f"not {pred}({', '.join(terms)})", "rule": ABSENT, "children": []})
        return out

    def convert(self, d: dict, depth: int) -> dict:
        if "fact" in d:
            return {"fact": d["fact"], "rule": None, "children": []}
        text = d.get("rule", "")
        assignment = d.get("assignment", {})
        node = {"fact": _substitute(_head(text), assignment), "rule": self.rule_id(text), "children": []}
        if depth < MAX_DEPTH:
            node["children"] = [self.convert(s, depth + 1) for s in d.get("subtraces", [])]
            node["children"] += self.negations(text, assignment)
        return node

    def prove(self, nemo_fact: str) -> dict | None:
        try:
            tr = self.engine.trace(nemo_fact)
            return None if tr is None else self.convert(tr.dict(), 1)
        except KeyError:  # a negated variable the trace did not bind: the proof is left empty and not guessed
            return None
        except NegationError:
            raise
        except Exception:  # noqa: BLE001 - tracing is optional, so a failure leaves the proof empty
            return None


# ---------------------------------------------------------------- run

def _stamp(inferred: dict, graph_json: dict, today: str) -> dict:
    """Add the run date and the identity of the graph that the rules read, in the order of the contract."""
    try:
        digest = graph_digest(graph_json)
    except (TypeError, ValueError):
        digest = None
    head = {"v": inferred["v"], "built": inferred["built"], "today": today,
            "inputs": {"graph_built": graph_json.get("built"), "graph_sha256": digest}}
    return {**head, **{k: v for k, v in inferred.items() if k not in head}}


def _unavailable(reason: str) -> tuple[dict, list, list]:
    finding = {"check": "B03", "severity": "warning", "message": B03_MESSAGE, "node": None, "evidence": reason[:200]}
    inferred = {"v": 1, "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "engine": None, "rules": [],
                "helpers": [], "facts": []}
    return inferred, [], [finding]


def _import_nemo():
    import nmo_python  # the one import of the engine in Cortex
    return nmo_python


def _rows(engine, pred: str) -> list[list[str]]:
    try:
        return [[str(v) for v in row] for row in engine.result(pred)]
    except Exception:  # noqa: BLE001 - a predicate with no rows can raise
        return []


def run(cfg: Config, graph_json: dict, today: str | None = None) -> tuple[dict, list[dict], list[dict]]:
    """Reason over the graph. Returns (inferred file, inferred edges, findings). A failure of the engine or of a rule
    file gives the finding B03 and an empty result. The inferred file is also written to the data folder as
    inferred.json, with inferred.ttl holding one triple per inferred edge, and a failure to write either raises."""
    today = today or date.today().isoformat()
    try:
        inferred, edges, findings = _run(cfg, graph_json, today)
    except Exception as exc:  # noqa: BLE001
        inferred, edges, findings = _unavailable(f"{type(exc).__name__}: {exc}")
    inferred = _stamp(inferred, graph_json, today)
    _write(cfg, inferred, edges)
    return inferred, edges, findings


def _run(cfg: Config, graph_json: dict, today: str) -> tuple[dict, list[dict], list[dict]]:
    try:
        nmo = _import_nemo()
    except ImportError as exc:
        return _unavailable(f"nmo_python could not be imported: {exc}")
    files = _rule_files(cfg)
    texts = [p.read_text(encoding="utf-8") for p in files]
    statements = [s for t in texts for s in _statements(t)]
    validate_statements(statements)
    headers = [r for t in texts for r in parse_rules(t)]
    rows = fact_rows(graph_json, today, _observed_days(cfg, today))
    cwd = os.getcwd()
    with tempfile.TemporaryDirectory() as folder:
        # Nemo resolves the relative paths of the CSV imports against the working directory, which is process-wide,
        # so run() is for the command line and the build only and must not be called from a threaded server
        os.chdir(folder)
        try:
            return _reason_in(nmo, rows, texts, statements, headers, folder)
        finally:
            os.chdir(cwd)


def _reason_in(nmo, fact_data, texts, statements, headers, folder):
    by_id = {h["id"]: h for h in headers}
    helpers = helper_rules(statements)
    program = _csv_program(fact_data, folder) + "\n" + "\n".join(texts)
    engine = nmo.NemoEngine(nmo.load_string(program))
    engine.reason()
    version = getattr(nmo, "__version__", None) or _nemo_version()

    # the atoms that the rules negate are checked against the engine's rows, for a derived predicate, or against the
    # facts given to it, for an input predicate
    given = {p: {tuple(str(v) for v in r) for r in rs} for p, rs in fact_data.items()}
    derived: dict[str, set] = {}

    def holds(pred: str, terms: tuple) -> bool:
        if pred in given:
            return terms in given[pred]
        if pred not in derived:
            derived[pred] = {tuple(_unquote(t) for t in r) for r in _rows(engine, pred)}
        return terms in derived[pred]

    # the rule that derives a fact is read from the constant in its head: the relation of an inferred fact and the
    # first argument of a finding, so that a fact whose trace fails still names its rule
    head_rule: dict[tuple[str, str], str] = {}
    for s in statements:
        if not s["header"]:
            continue
        m = re.match(r'(\w+)\(\s*(?:"(\w+)"|[^,]+,\s*"(\w+)")', _head(s["text"]))
        if m:
            head_rule.setdefault((m.group(1), m.group(2) or m.group(3) or ""), s["header"]["id"])

    prover = _Prover(engine, statements, helpers, holds)
    facts_out: list[dict] = []
    edges: list[dict] = []
    findings: list[dict] = []
    seen_edges = set()
    rows = {p: _rows(engine, p) for p in OUTPUTS}
    inf_rows = sorted(rows["inferred"], key=lambda r: (RELATION_ORDER.get(_unquote(r[1]), 9), r))
    proofs_left = MAX_PROOFS
    for pred in OUTPUTS:
        for row in (inf_rows if pred == "inferred" else sorted(rows[pred])):
            terms = row
            args = [_unquote(t) for t in terms]
            key = f"{pred}({','.join(terms)})"
            if pred == "inferred":
                rid = head_rule.get((pred, args[1]), "")
                kind = "inference"
                if proofs_left > 0:
                    proofs_left -= 1
                    proof = prover.prove(f"{pred}({', '.join(terms)})")
                else:
                    proof = None
                edge_key = (args[0], args[1], args[2])
                if edge_key not in seen_edges:
                    seen_edges.add(edge_key)
                    edges.append({"s": args[0], "r": args[1], "t": args[2], "evidence": f"rule {rid}" if rid else None})
            else:
                rid = head_rule.get((pred, args[0]), "")
                kind = pred
                proof = prover.prove(f"{pred}({', '.join(terms)})")
                findings.append({"check": args[0], "severity": pred,
                                 "message": by_id.get(args[0], {}).get("message", args[0]),
                                 "node": args[1] if len(args) > 1 else None, "evidence": None})
            facts_out.append({"key": key, "rule": rid or args[0], "kind": kind, "args": args, "proof": proof})
    inferred = {"v": 1, "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "engine": {"name": "nemo", "version": version}, "rules": headers, "helpers": helpers, "facts": facts_out}
    return inferred, edges, findings


def _nemo_version() -> str:
    try:
        from importlib.metadata import version
        return version("nemo-python")
    except Exception:  # noqa: BLE001
        try:
            from importlib.metadata import version
            return version("nmo-python")
        except Exception:  # noqa: BLE001
            return "0.10.1"


# ---------------------------------------------------------------- files

def _write(cfg: Config, inferred: dict, edges: list[dict]) -> None:
    """Write inferred.json and inferred.ttl so that they cannot disagree. Both go to temporary files first, and only when
    both are complete are they renamed over the old files, so a failure leaves the old pair in place."""
    from .rdf import CX, node_iri
    from rdflib import Graph

    g = Graph()
    g.bind("cx", CX)
    for e in edges:
        g.add((node_iri(e["s"]), CX[e["r"]], node_iri(e["t"])))
    pairs = [(cfg.data_dir / "inferred.json", json.dumps(inferred, ensure_ascii=False, indent=1) + "\n"),
             (cfg.data_dir / "inferred.ttl", g.serialize(format="turtle"))]
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    temps = [(path.with_name(path.name + ".tmp"), path) for path, _text in pairs]
    olds = {path: (path.read_bytes() if path.is_file() else None) for _tmp, path in temps}
    replaced: list[Path] = []
    try:
        for (tmp, _path), (_p, text) in zip(temps, pairs):
            tmp.write_text(text, encoding="utf-8")
        for tmp, path in temps:
            os.replace(tmp, path)
            replaced.append(path)
    except OSError:
        for tmp, _path in temps:
            tmp.unlink(missing_ok=True)
        for path in replaced:  # the first file was renamed and the second was not, so put the first back
            try:
                if olds[path] is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_bytes(olds[path])
            except OSError:
                pass
        raise


def merge_findings(cfg: Config, findings: list[dict]) -> None:
    """Replace the rule findings in findings.json (the checks R01 to R99 and B03) and keep the harvest findings."""
    from .compile import read_json, write_json
    path = cfg.data_dir / "findings.json"
    data = read_json(path, None) or {"v": 1, "checked": "", "counts": {}, "findings": [], "drift": None}
    kept = [f for f in data.get("findings", []) if not re.match(r"^(R\d+|B03)$", str(f.get("check")))]
    all_f = kept + findings
    data["findings"] = all_f
    data["counts"] = {k: sum(1 for f in all_f if f["severity"] == k) for k in ("violation", "warning", "info")}
    write_json(path, data)


def explain(inferred: dict, query: str) -> list[str]:
    """The proof tree of the fact that matches the query, as indented plain lines."""
    q = _norm(query)
    hits = [f for f in inferred.get("facts", []) if _norm(f["key"]) == q] or \
           [f for f in inferred.get("facts", []) if q in _norm(f["key"])]
    if not hits:
        return [f"No inferred fact matches {query}."]
    f = hits[0]
    lines = [f"{f['key']} was derived by {f['rule']}."]
    if len(hits) > 1:
        lines.append(f"{len(hits)} facts match, so the first is shown.")
    msg = next((r["message"] for r in inferred.get("rules", []) if r["id"] == f["rule"]), None)
    if msg:
        lines.append(f"Rule {f['rule']}: {msg}")
    if not f.get("proof"):
        lines.append("No proof was recorded for this fact.")
        return lines

    def walk(p: dict, depth: int) -> None:
        if p.get("rule") == ABSENT:
            how = ABSENT
        else:
            how = f"by {p['rule']}" if p.get("rule") else "given as a fact of the graph"
        lines.append(f"{'  ' * depth}{p['fact']} ({how})")
        for c in p.get("children", []):
            walk(c, depth + 1)

    walk(f["proof"], 0)
    return lines


def summary(inferred: dict, findings: list[dict], seconds: float) -> str:
    if inferred.get("engine") is None:
        return "The reasoning step did not run because the rule engine is not available."
    v = sum(1 for f in findings if f["severity"] == "violation")
    w = sum(1 for f in findings if f["severity"] == "warning")
    vs = "1 violation" if v == 1 else f"{v} violations"
    ws = "1 warning" if w == 1 else f"{w} warnings"
    return f"Reasoned over the graph: {len(inferred['facts']):,} inferred facts, {vs} and {ws} in {seconds:.1f} seconds."


def timed_run(cfg: Config, graph_json: dict, today: str | None = None):
    t0 = time.time()
    r = run(cfg, graph_json, today)
    return r, time.time() - t0
