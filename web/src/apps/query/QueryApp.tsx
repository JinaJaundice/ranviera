import { useEffect, useMemo, useState } from "react";
import { Play } from "lucide-react";
import type { InferredFile, SavedQuery, SparqlResult } from "@shared/types";
import { api } from "../../lib/api";
import { bus } from "../../lib/bus";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { Empty } from "../../components/Empty";
import { Kbd } from "../../components/Kbd";
import { NodeChip } from "../../components/NodeChip";
import { Segmented } from "../../components/Segmented";
import { StatusDot } from "../../components/StatusDot";
import { FactRow } from "./ProofTree";
import { KIND_LABEL, cellView, groupByRule, kindTone, resultNodeIds } from "./format";

type View = "ask" | "inferred";

const errText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function Cell({ term }: { term: Parameters<typeof cellView>[0] }) {
  const c = cellView(term);
  if (c.kind === "node") return <NodeChip id={c.id} />;
  if (c.kind === "iri") return <span className="break-all font-mono text-small text-ink-soft">{c.value}</span>;
  return <span className="break-words text-body text-ink">{c.value}</span>;
}

const TH = "border-b border-rule-strong px-2 py-1 text-left text-small font-medium text-ink-soft";
const TD = "min-w-0 border-b border-rule px-2 py-1 align-top";

function ResultView({ result }: { result: SparqlResult }) {
  const ids = useMemo(() => resultNodeIds(result), [result]);
  const count = result.kind === "select" ? result.rows.length : result.kind === "construct" ? result.triples.length : 1;
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <p className="text-small text-ink-soft">
          {result.kind === "ask" ? "Answer" : `${count} ${count === 1 ? "row" : "rows"}`} in <span className="num">{result.ms}</span> ms
        </p>
        {ids.length ? (
          <>
            <Button className="h-6 px-2 text-small" onClick={() => bus.emit("highlight", { ids })}>
              Show in graph
            </Button>
            <Button variant="ghost" className="h-6 px-2 text-small" onClick={() => bus.emit("highlight", { ids: [] })}>
              Clear
            </Button>
          </>
        ) : null}
      </div>
      {result.kind !== "ask" && result.truncated ? (
        <p className="text-small text-hold">The result was cut at the limit of rows, so later rows are not shown.</p>
      ) : null}
      {result.kind === "ask" ? (
        <p className="font-display text-title text-ink">{result.value ? "Yes" : "No"}</p>
      ) : result.kind === "select" ? (
        result.rows.length ? (
          <div className="overflow-auto">
            <table className="w-full table-auto border-collapse">
              <thead>
                <tr>
                  {result.vars.map((v) => (
                    <th key={v} className={`${TH} font-mono`}>
                      {v}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i}>
                    {result.vars.map((v) => (
                      <td key={v} className={TD}>
                        <Cell term={row[v]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-body text-ink-faint">The query returned no rows.</p>
        )
      ) : (
        <div className="overflow-auto">
          <table className="w-full table-auto border-collapse">
            <thead>
              <tr>
                {["Subject", "Predicate", "Object"].map((h) => (
                  <th key={h} className={TH}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.triples.map((t, i) => (
                <tr key={i}>
                  {t.map((term, j) => (
                    <td key={j} className={TD}>
                      <Cell term={term} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Ask() {
  const [saved, setSaved] = useState<SavedQuery[] | null>(null);
  const [text, setText] = useState("SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 20");
  const [result, setResult] = useState<SparqlResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .queries()
      .then((d) => live && setSaved(d.queries))
      .catch(() => live && setSaved([]));
    return () => {
      live = false;
    };
  }, []);

  const run = () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError("");
    api
      .sparql(text)
      .then((r) => setResult(r))
      .catch((e: unknown) => {
        setResult(null);
        setError(errText(e, "The query could not be run."));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
      <nav aria-label="Saved queries" className="min-w-0 overflow-auto border-r border-rule p-2">
        <p className="px-2 pb-1 text-small font-medium text-ink-faint">Saved queries</p>
        {saved === null ? (
          <p className="px-2 text-small text-ink-faint">Loading the saved queries.</p>
        ) : saved.length ? (
          <ul>
            {saved.map((q) => (
              <li key={q.id}>
                <button
                  type="button"
                  onClick={() => {
                    setText(q.query);
                    setError("");
                  }}
                  className="w-full rounded-md px-2 py-1.5 text-left text-body text-ink-soft hover:bg-raised hover:text-ink"
                >
                  {q.title}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-2 text-small text-ink-faint">No saved queries were found.</p>
        )}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-auto p-3">
        <div className="min-w-0">
          <label htmlFor="sparql-editor" className="mb-1 block text-small text-ink-soft">
            SPARQL query, read only
          </label>
          <textarea
            id="sparql-editor"
            value={text}
            rows={10}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                run();
              }
            }}
            className="block min-h-[10rem] w-full resize-y rounded-md border border-rule-strong bg-sunken p-2 font-mono text-small text-ink"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button variant="primary" icon={<Play size={14} aria-hidden="true" />} disabled={busy} onClick={run}>
              Run
            </Button>
            <span className="text-small text-ink-faint">
              <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> also runs the query.
            </span>
          </div>
        </div>
        {error ? <p className="text-body text-block">{error}</p> : null}
        {result ? <ResultView result={result} /> : !error ? <Empty>Run a query to see its result here.</Empty> : null}
      </div>
    </div>
  );
}

function Inferred() {
  const [data, setData] = useState<Pick<InferredFile, "rules" | "facts"> | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api
      .inferred()
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setError(errText(e, "The derived facts could not be loaded.")));
    return () => {
      live = false;
    };
  }, []);
  const groups = useMemo(() => (data ? groupByRule(data.facts, data.rules) : []), [data]);

  if (error) return <p className="p-4 text-body text-block">{error}</p>;
  if (!data) return <Empty>Loading the facts that the engine derived.</Empty>;
  if (!groups.length) return <Empty>The engine has derived no facts from the graph.</Empty>;
  return (
    <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-auto p-3">
      <h2 className="text-lead text-ink">Rules that the engine derived from the graph</h2>
      {groups.map((g) => (
        <section key={g.id} className="min-w-0">
          <header className="flex min-w-0 flex-wrap items-center gap-2 pb-1">
            <span className="font-mono text-body text-ink">{g.id}</span>
            <Chip>
              <StatusDot tone={kindTone(g.kind)} />
              {KIND_LABEL[g.kind] ?? g.kind}
            </Chip>
            <span className="min-w-0 flex-1 text-body text-ink-soft">{g.message}</span>
            <span className="num text-small text-ink-faint">{g.facts.length}</span>
          </header>
          <ul className="min-w-0">
            {g.facts.map((f) => (
              <FactRow key={f.key} fact={f} rules={data.rules} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function QueryApp() {
  const [view, setView] = useState<View>("ask");
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-base">
      <div className="flex shrink-0 items-center border-b border-rule px-3 py-2">
        <Segmented
          label="Query view"
          value={view}
          onChange={setView}
          options={[
            { value: "ask", label: "Ask" },
            { value: "inferred", label: "Inferred" },
          ]}
        />
      </div>
      {view === "ask" ? <Ask /> : <Inferred />}
    </div>
  );
}
