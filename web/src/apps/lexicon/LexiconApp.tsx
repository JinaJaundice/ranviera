import { useCallback, useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import type { LexiconHit, LexiconScheme } from "@shared/types";
import { api } from "../../lib/api";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { Empty } from "../../components/Empty";
import { Section } from "../../components/Section";
import { Segmented } from "../../components/Segmented";
import { StatusDot } from "../../components/StatusDot";
import { decisionsNeeded, markText, orderedSchemes, schemeName, severityWord, replacementLines } from "./model";

const PAGE = 200;

function Decisions({ schemes, reload }: { schemes: LexiconScheme[]; reload: () => Promise<void> }) {
  const items = useMemo(() => decisionsNeeded(schemes), [schemes]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const ratify = async (id: string) => {
    setBusy(id);
    setError("");
    try {
      await api.ratify(id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The term could not be ratified.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title="Decisions needed"
      note="Ratifying a proposed term makes its preferred form enforceable in the register checks, and records today's date."
    >
      {error ? <p className="mb-2 text-small text-block">{error}</p> : null}
      {items.length ? (
        <ul className="space-y-2">
          {items.map((d) => (
            <li key={d.concept.id} className="min-w-0 rounded-md border border-rule bg-raised p-3">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-body text-ink">
                    <span className="font-medium">{d.concept.prefLabel}</span>
                    <span className="text-ink-faint"> proposed preferred form, in {d.scheme}</span>
                  </p>
                  {d.others.length ? (
                    <div className="mt-1.5 flex min-w-0 flex-wrap gap-1.5">
                      {d.others.map((o) => (
                        <Chip key={o.form} title={`${o.count} uses of this form`}>
                          {o.form} <span className="num text-ink-faint">{o.count}</span>
                        </Chip>
                      ))}
                    </div>
                  ) : null}
                  {d.concept.note ? <p className="mt-1.5 text-small text-ink-soft">{d.concept.note}</p> : null}
                </div>
                <Button
                  variant="primary"
                  className="shrink-0"
                  disabled={busy !== null}
                  icon={<Check size={14} aria-hidden="true" />}
                  onClick={() => void ratify(d.concept.id)}
                >
                  {busy === d.concept.id ? "Ratifying" : "Ratify"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body text-ink-faint">No proposed term needs a decision.</p>
      )}
    </Section>
  );
}

function Table({ scheme }: { scheme: LexiconScheme }) {
  const [limit, setLimit] = useState(PAGE);
  if (!scheme.concepts.length) return <Empty>This scheme holds no concepts.</Empty>;
  return (
    <div className="min-w-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] table-fixed border-collapse text-left text-body">
          <thead>
            <tr className="border-b border-rule-strong text-small text-ink-faint">
              <th className="w-[18%] py-1.5 pr-3 font-medium">Preferred form</th>
              <th className="w-[16%] py-1.5 pr-3 font-medium">Accepted forms</th>
              <th className="w-[16%] py-1.5 pr-3 font-medium">Forms to avoid</th>
              <th className="py-1.5 pr-3 font-medium">Definition</th>
              <th className="w-[16%] py-1.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {scheme.concepts.slice(0, limit).map((c) => (
              <tr key={c.id} className="border-b border-rule align-top">
                <td className="break-words py-1.5 pr-3 text-ink">{c.prefLabel}</td>
                <td className="break-words py-1.5 pr-3 text-ink-soft">{c.altLabels.join(", ") || "None"}</td>
                <td className="break-words py-1.5 pr-3 text-ink-soft">{c.hiddenLabels.join(", ") || "None"}</td>
                <td className="break-words py-1.5 pr-3 text-ink-soft">{c.definition ?? "Not stated"}</td>
                <td className="py-1.5 text-ink">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot tone={c.status === "ratified" ? "pass" : "hold"} />
                    {c.status === "ratified" ? `Ratified ${c.ratified ?? ""}`.trim() : "Proposed"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {scheme.concepts.length > limit ? (
        <div className="pt-3">
          <Button onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, scheme.concepts.length - limit)} more</Button>
        </div>
      ) : null}
    </div>
  );
}

function CheckText() {
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<{ text: string; hits: LexiconHit[] } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const run = async () => {
    setRunning(true);
    setError("");
    try {
      const res = await api.lexiconCheck(text);
      setChecked({ text, hits: res.hits });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The text could not be checked.");
    } finally {
      setRunning(false);
    }
  };

  const segments = checked ? markText(checked.text, checked.hits) : [];
  const lines = checked ? replacementLines(checked.hits) : [];

  return (
    <Section title="Check text" note="Paste text to find forms that the vocabulary asks you to replace.">
      <textarea
        aria-label="Text to check"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        className="w-full min-w-0 resize-y rounded-md border border-rule-strong bg-sunken p-2 text-body text-ink placeholder:text-ink-faint"
        placeholder="Paste the text here"
      />
      <div className="mt-2">
        <Button variant="primary" disabled={running || !text.trim()} onClick={() => void run()}>
          {running ? "Checking" : "Check"}
        </Button>
      </div>
      {error ? <p className="mt-2 text-small text-block">{error}</p> : null}
      {checked ? (
        <div className="mt-3 min-w-0 space-y-3">
          <p className="whitespace-pre-wrap break-words rounded-md border border-rule bg-raised p-3 text-body text-ink">
            {segments.map((s, i) =>
              s.hit ? (
                <mark
                  key={i}
                  title={`${severityWord(s.hit.severity)}. Use ${s.hit.preferred}.`}
                  className={`rounded-sm border-b-2 text-ink ${s.hit.severity === "fail" ? "border-block bg-block-soft" : "border-hold bg-hold-soft"}`}
                >
                  {s.text}
                </mark>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </p>
          {lines.length ? (
            <ul className="space-y-1">
              {lines.map((l) => (
                <li key={l.line} className="flex min-w-0 items-center gap-2 text-body text-ink">
                  <StatusDot tone={l.severity === "fail" ? "block" : "hold"} label={severityWord(l.severity)} />
                  <span className="min-w-0 break-words">{l.line}</span>
                  <span className="text-small text-ink-faint">{severityWord(l.severity)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-body text-ink-soft">No form to replace was found.</p>
          )}
        </div>
      ) : null}
    </Section>
  );
}

export function LexiconApp() {
  const [schemes, setSchemes] = useState<LexiconScheme[] | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState("");

  const reload = useCallback(async () => {
    const res = await api.lexicon();
    setSchemes(orderedSchemes(res.schemes));
  }, []);

  useEffect(() => {
    let live = true;
    api
      .lexicon()
      .then((res) => live && setSchemes(orderedSchemes(res.schemes)))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "The vocabulary could not load."));
    return () => {
      live = false;
    };
  }, []);

  if (error && !schemes) return <Empty>{`The vocabulary could not load. ${error}`}</Empty>;
  if (!schemes) return <Empty>Loading the vocabulary.</Empty>;

  const scheme = schemes.find((s) => s.id === active) ?? schemes[0];

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-surface text-ink">
      <Decisions schemes={schemes} reload={reload} />
      <Section title="Concepts">
        {scheme ? (
          <div className="min-w-0 space-y-3">
            <div className="overflow-x-auto">
              <Segmented
                label="Vocabulary scheme"
                value={scheme.id}
                onChange={setActive}
                options={schemes.map((s) => ({ value: s.id, label: schemeName(s) }))}
              />
            </div>
            {scheme.description ? <p className="text-small text-ink-soft">{scheme.description}</p> : null}
            <Table key={scheme.id} scheme={scheme} />
          </div>
        ) : (
          <Empty>No vocabulary scheme is loaded.</Empty>
        )}
      </Section>
      <CheckText />
    </div>
  );
}
