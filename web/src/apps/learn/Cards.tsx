// The blocks of the transcript. A lesson reads as a document: the learner's words sit on a band with a rail, the teacher's words
// are plain Markdown, and a question, a problem or a plan is a bordered block. There are no chat bubbles.
import { useState, type ReactNode } from "react";
import { Check, ChevronRight, Info, Loader2, X } from "lucide-react";
import type { AnswerDetails } from "@shared/learn/sessions";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { StatusDot, type Tone } from "../../components/StatusDot";
import { Markdown } from "./Markdown";
import { Popover } from "./parts";
import type { Block } from "./project";
import { setOneThinking, useThinkingOpen } from "./thinkingStore";

type B<K extends Block["kind"]> = Extract<Block, { kind: K }>;

export function Label({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-caption text-ink-soft">{children}</div>;
}

export function UserBlock({ block }: { block: B<"user"> }) {
  return (
    <div className="rounded-r-md border-l-2 border-rule-strong bg-raised px-3 py-3" data-block="user">
      <Label>You</Label>
      <p className="whitespace-pre-wrap break-words text-lead text-ink">{block.text}</p>
      {block.images ? <p className="mt-1 text-small text-ink-soft">{block.images === 1 ? "1 image attached" : `${block.images} images attached`}</p> : null}
    </div>
  );
}

/** The learner's thinking, with a row that opens and closes it. The row starts open. */
export function LearnerThinking({ id, label = "Your thinking", text }: { id: string; label?: string; text: string }) {
  const open = useThinkingOpen(id);
  return (
    <div className="rounded-r-md border-l-2 border-rule-strong bg-raised px-3 py-2" data-block="learner-thinking">
      <button type="button" aria-expanded={open} onClick={() => setOneThinking(id, !open)} className="flex items-center gap-1.5 text-caption text-ink-soft hover:text-ink">
        <ChevronRight size={14} aria-hidden="true" className={open ? "rotate-90" : ""} />
        {label}
      </button>
      {open ? <p className="mt-1 whitespace-pre-wrap break-words pl-5 text-body italic text-ink-soft">{text}</p> : null}
    </div>
  );
}

export function TeacherThinking({ block }: { block: B<"thinking"> }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-block="thinking">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-small text-ink-soft hover:text-ink">
        <ChevronRight size={14} aria-hidden="true" className={open ? "rotate-90" : ""} />
        Thinking
        {block.streaming ? <Loader2 size={12} aria-hidden="true" className="animate-spin" /> : null}
      </button>
      {open && block.text ? <Markdown size="body" className="mt-1 pl-5 text-ink-soft">{block.text}</Markdown> : null}
    </div>
  );
}

export function Divider({ label }: { label: string }) {
  return (
    <div className="relative flex items-center justify-center py-1" role="separator" aria-label={label}>
      <div className="absolute inset-x-0 top-1/2 border-t border-dotted border-rule-strong" />
      <Chip className="relative">{label}</Chip>
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="text-center text-small text-ink-faint">{children}</p>;
}

const RESULT: Record<string, { tone: Tone; word: string }> = {
  correct: { tone: "pass", word: "Correct" },
  incorrect: { tone: "block", word: "Incorrect" },
  unknown: { tone: "idle", word: "Did not know" },
};

function resultOf(d: AnswerDetails): { tone: Tone; word: string } | null {
  if (d.kind !== "quiz") return null;
  if (d.dontKnow) return RESULT.unknown;
  if (d.correct === true) return RESULT.correct;
  if (d.correct === false) return RESULT.incorrect;
  return null;
}

function OptionRow({ label, picked, correct, graded }: { label: string; picked: boolean; correct: boolean; graded: boolean }) {
  const tone = graded && correct ? "border-pass" : graded && picked ? "border-block" : picked ? "border-signal bg-signal-soft" : "border-rule-strong";
  const Icon = graded && correct ? Check : graded && picked ? X : null;
  const caption = graded && correct ? "Correct answer" : picked ? "Your answer" : null;
  return (
    <li className={`flex min-h-8 items-start gap-2 rounded-md border px-3 py-1.5 text-body ${tone}`}>
      <span aria-hidden="true" className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {Icon ? <Icon size={14} className={correct ? "text-pass" : "text-block"} /> : <span className={`h-3 w-3 rounded-full border ${picked ? "border-signal bg-signal" : "border-ink-soft"}`} />}
      </span>
      <span className="min-w-0 flex-1">
        <Markdown size="body" fromTool>{label}</Markdown>
      </span>
      {caption ? <span className="shrink-0 pt-0.5 text-caption text-ink-soft">{caption}</span> : null}
    </li>
  );
}

/** A question that has been answered: the question, the options as they were shown, the grade, and the reasons behind a disclosure. */
export function AnsweredCard({ block }: { block: B<"answered"> }) {
  const d = block.details;
  const q = block.question;
  const [why, setWhy] = useState(false);
  const result = resultOf(d);
  const options = d.options ?? q?.options ?? [];
  const picked = new Set(d.answers.map((a) => a.value));
  const graded = d.kind === "quiz" && !d.dontKnow && d.correct !== undefined;
  const correctIdx = new Set(d.correctIndices ?? []);
  const typed = d.other ?? d.text;
  const explanation = d.kind === "quiz" ? block.explanation : "";
  return (
    <>
      {d.readingThinking ? <LearnerThinking id={`${block.id}-r`} label="Your thinking while reading" text={d.readingThinking} /> : null}
      {d.thinking ? <LearnerThinking id={`${block.id}-t`} text={d.thinking} /> : null}
      <div className="rounded-lg border border-rule bg-raised p-3" data-block="answered">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-small font-medium text-ink-soft">{q?.label ?? "Question"}</span>
          {result ? (
            <Chip>
              <StatusDot tone={result.tone} />
              {result.word}
            </Chip>
          ) : null}
        </div>
        <Markdown size="ui" fromTool className="font-medium">{d.questionText || q?.question || ""}</Markdown>
        {q?.details ? <Markdown size="body" fromTool className="mt-1 text-ink-soft">{q.details}</Markdown> : null}
        {options.length ? (
          <ul className="mt-3 space-y-1.5">
            {options.map((o, i) => (
              <OptionRow key={o.value} label={o.label} picked={picked.has(o.value)} correct={correctIdx.has(i + 1)} graded={graded} />
            ))}
          </ul>
        ) : null}
        {typed ? (
          <p className="mt-2 rounded-md border border-rule bg-sunken px-3 py-1.5 text-body text-ink">
            <span className="mr-2 text-caption text-ink-soft">Your answer</span>
            {typed}
          </p>
        ) : null}
        {d.kind === "explain" && block.committed ? (
          <div className="mt-2 rounded-md bg-sunken px-3 py-2">
            <Label>The answer</Label>
            <Markdown size="body" fromTool>{block.committed}</Markdown>
          </div>
        ) : null}
        {d.confidence !== undefined ? <p className="num mt-2 font-mono text-small text-ink-soft">Confidence {d.confidence}%</p> : null}
        {explanation ? (
          <div className="mt-2">
            <button type="button" aria-expanded={why} onClick={() => setWhy(!why)} className="flex items-center gap-1 text-small text-ink-soft hover:text-ink">
              <ChevronRight size={14} aria-hidden="true" className={why ? "rotate-90" : ""} />
              Why
            </button>
            {why ? <Markdown size="body" fromTool className="mt-1 pl-5">{explanation}</Markdown> : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function SkippedLine({ question }: { question: string }) {
  return <Note>{`Skipped: ${question}`}</Note>;
}

export function ProblemCard({ block }: { block: B<"problem"> }) {
  return (
    <div className="rounded-lg border border-rule p-3" data-block="problem">
      <Label>Problem</Label>
      <Markdown size="ui" fromTool>{block.statement}</Markdown>
    </div>
  );
}

const OUTCOME: Record<string, { tone: Tone; word: string }> = {
  solved: { tone: "pass", word: "Solved" },
  solvedWithHints: { tone: "hold", word: "Solved with hints" },
  movedOn: { tone: "idle", word: "Moved on" },
  surrendered: { tone: "block", word: "Surrendered" },
  dismissed: { tone: "idle", word: "Dismissed" },
};

export function ConcludedCard({ block, names }: { block: B<"concluded">; names?: Record<string, string> }) {
  const o = OUTCOME[block.outcome] ?? { tone: "idle" as Tone, word: block.outcome || "Concluded" };
  const rows: [string, string][] = [
    ["Mode", block.mode || "Not given"],
    ["Targets", block.targets.length ? block.targets.map((t) => names?.[t] ?? t).join(", ") : "None"],
    ["Outcome", o.word],
    ["Hint level", block.rung ?? "None"],
    ["Kind of miss", block.missClass ?? "None"],
    ["Retest", block.retest ? "Yes" : "No"],
  ];
  return (
    <div className="rounded-lg border border-rule bg-raised p-3" data-block="concluded">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-small font-medium text-ink-soft">Concluded</span>
        <Chip>
          <StatusDot tone={o.tone} />
          {o.word}
        </Chip>
      </div>
      {block.verdict ? <Markdown size="body" fromTool className="text-ink-soft">{block.verdict}</Markdown> : null}
      {block.solution ? (
        <div className="mt-3 border-t border-rule pt-3">
          <div className="rounded-md bg-sunken px-3 py-2">
            <Label>Model solution</Label>
            <Markdown size="body" fromTool>{block.solution}</Markdown>
          </div>
        </div>
      ) : null}
      <div className="mt-2 flex justify-end">
        <Popover
          label="Details of the problem"
          align="right"
          up
          button={({ toggle, open }) => (
            <Button variant="ghost" className="h-7 text-small" aria-expanded={open} onClick={toggle}>
              Details
            </Button>
          )}
        >
          <dl className="grid w-64 grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 p-3 text-small">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-faint">{k}</dt>
                <dd className="min-w-0 break-words text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        </Popover>
      </div>
    </div>
  );
}

export function ProbeDoneCard({ block }: { block: B<"probeDone"> }) {
  return (
    <div className="rounded-lg border border-rule p-3" data-block="probe-done">
      <Label>Probe concluded</Label>
      <p className="text-small text-ink-soft">The strands that were assessed:</p>
      <dl className="mt-1 space-y-1">
        {block.strands.map((s) => (
          <div key={s.strand}>
            <dt className="text-body font-medium text-ink">{s.strand}</dt>
            <dd className="text-body text-ink-soft">{s.assessment}</dd>
          </div>
        ))}
      </dl>
      {block.summary ? <Markdown size="body" className="mt-2">{block.summary}</Markdown> : null}
    </div>
  );
}

export function MalformedCard({ onRetry, disabledReason }: { onRetry: () => void; disabledReason: string | null }) {
  return (
    <div className="rounded-lg border border-dashed border-rule-strong p-3" data-block="malformed">
      <p className="flex items-start gap-2 text-body text-ink-soft">
        <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
        The question could not be shown. Ask for it again, or send a message.
      </p>
      <div className="mt-2">
        <Button className="h-7 text-small" disabled={!!disabledReason} title={disabledReason ?? undefined} onClick={onRetry}>
          Ask again
        </Button>
        {disabledReason ? <p className="mt-1 text-caption text-ink-soft">{disabledReason}</p> : null}
      </div>
    </div>
  );
}

export function ContextCard({ block }: { block: B<"context"> }) {
  return (
    <div className="rounded-lg border border-rule px-3 py-2 text-body text-ink-soft" data-block="context">
      {`Started from ${block.count} ${block.count === 1 ? "claim" : "claims"} of the knowledge layer`}
      {block.chains ? ` and ${block.chains} ${block.chains === 1 ? "argument" : "arguments"}.` : "."}
    </div>
  );
}

export function ResultCard({ block }: { block: B<"result"> }) {
  const [open, setOpen] = useState(false);
  const noun = block.jobKind === "pdf" ? "PDF reading" : "Research";
  if (block.aborted) return <Note>{`${noun} was stopped by you.`}</Note>;
  return (
    <div className="rounded-lg border border-rule px-3 py-2" data-block="result">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-body text-ink-soft hover:text-ink">
        <ChevronRight size={14} aria-hidden="true" className={open ? "rotate-90" : ""} />
        {`${noun} complete`}
        {block.sources.length ? <span className="num font-mono text-small">{`${block.sources.length} sources`}</span> : null}
      </button>
      {open ? (
        <div className="mt-2 pl-5">
          <Markdown size="body">{block.brief}</Markdown>
          <ul className="mt-2 space-y-0.5 text-small">
            {block.sources.map((s) => (
              <li key={s.url} className="min-w-0 truncate">
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-signal underline underline-offset-2">
                  {s.title || s.url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function TraceCard({ block }: { block: B<"trace"> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0 text-small" data-block="trace">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`flex max-w-full items-center gap-1.5 hover:text-ink ${block.isError ? "text-block" : "text-ink-faint"}`}>
        <ChevronRight size={12} aria-hidden="true" className={`shrink-0 ${open ? "rotate-90" : ""}`} />
        <span className="font-medium">{block.tool}</span>
        <span className="min-w-0 truncate font-mono">{block.headline}</span>
      </button>
      {open ? (
        <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-rule bg-sunken p-2 font-mono text-small text-ink-soft">{`${JSON.stringify(block.input, null, 2)}\n\n${block.output}`}</pre>
      ) : null}
    </div>
  );
}
