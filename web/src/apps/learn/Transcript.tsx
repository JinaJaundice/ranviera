// The transcript: a column of at most 65 characters, centred, in the Read mode of the kit. Blocks come from projectBlocks.
import { Loader2 } from "lucide-react";
import { Button } from "../../components/Button";
import {
  AnsweredCard,
  LearnerThinking,
  ConcludedCard,
  ContextCard,
  Divider,
  MalformedCard,
  Note,
  ProbeDoneCard,
  ProblemCard,
  ResultCard,
  SkippedLine,
  TeacherThinking,
  TraceCard,
  UserBlock,
} from "./Cards";
import { Markdown } from "./Markdown";
import { PlanBlock } from "./PlanMap";
import type { Block } from "./project";

export interface TranscriptProps {
  blocks: Block[];
  names?: Record<string, string>;
  thinking: boolean;
  compacting: boolean;
  failure: string | null;
  onRetry: (() => void) | null;
  onOpenPlan: () => void;
  onRetryQuestion: (b: Extract<Block, { kind: "malformed" }>) => void;
  retryDisabled: string | null;
}

export function Transcript({ blocks, names, thinking, compacting, failure, onRetry, onOpenPlan, onRetryQuestion, retryDisabled }: TranscriptProps) {
  return (
    <div data-find-root="" className="mx-auto flex w-full min-w-0 max-w-prose flex-col gap-4 px-6 py-6">
      {blocks.map((b) => {
        switch (b.kind) {
          case "user":
            return <UserBlock key={b.id} block={b} />;
          case "learnerThinking":
            return <LearnerThinking key={b.id} id={b.id} text={b.text} />;
          case "teacher":
            return (
              <Markdown key={b.id} streaming={b.streaming}>
                {b.text}
              </Markdown>
            );
          case "thinking":
            return <TeacherThinking key={b.id} block={b} />;
          case "answered":
            return <AnsweredCard key={b.id} block={b} />;
          case "skipped":
            return <SkippedLine key={b.id} question={b.question} />;
          case "malformed":
            return <MalformedCard key={b.id} disabledReason={retryDisabled} onRetry={() => onRetryQuestion(b)} />;
          case "problem":
            return <ProblemCard key={b.id} block={b} />;
          case "concluded":
            return <ConcludedCard key={b.id} block={b} names={names} />;
          case "problemDismissed":
            return <Note key={b.id}>Problem dismissed.</Note>;
          case "divider":
            return <Divider key={b.id} label={b.label} />;
          case "plan":
            return <PlanBlock key={b.id} details={b.details} onOpen={onOpenPlan} />;
          case "compaction":
            return <Note key={b.id}>Earlier messages were summarised here</Note>;
          case "retrying":
            return <Note key={b.id}>Trying again</Note>;
          case "trace":
            return <TraceCard key={b.id} block={b} />;
          case "probeDone":
            return <ProbeDoneCard key={b.id} block={b} />;
          case "context":
            return <ContextCard key={b.id} block={b} />;
          case "result":
            return <ResultCard key={b.id} block={b} />;
          case "next":
            return <Note key={b.id}>Next problem</Note>;
          case "failure":
            return null;
        }
      })}
      {thinking || compacting ? (
        <p role="status" className="flex items-center gap-2 text-small text-ink-soft">
          <Loader2 size={14} aria-hidden="true" className="animate-spin" />
          {compacting ? "Compacting context" : "Thinking"}
        </p>
      ) : null}
      {failure ? (
        <div role="alert" className="rounded-lg border border-block bg-block-soft p-3 text-body text-ink">
          <p className="break-words">{failure}</p>
          {onRetry ? (
            <Button className="mt-2 h-7 text-small" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
