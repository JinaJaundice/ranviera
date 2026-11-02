// The dock is one region at the foot of the session. It is never remounted: the composer, the question and the practice
// problem are three variants inside it, and a variant that is not showing stays mounted and hidden, so that a half made
// answer or a half written message survives a scroll, a fold or a change of variant.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ChevronDown, CornerDownLeft, Play, Square } from "lucide-react";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { enterAction, composerButton, type Arrival, type DockVariant } from "./dockRules";
import { Markdown } from "./Markdown";
import { QuestionForm } from "./QuestionForm";
import { teaser, type ClientQuestion, type FormState } from "./questions";
import type { Steer } from "./model";
import { KindLabel } from "./parts";

const FIELD = "w-full min-w-0 rounded-md border border-rule-strong bg-sunken px-3 py-2 text-body text-ink placeholder:text-ink-faint";

/** One 32px bar that stands for a folded form or a form that waits behind its reveal button. */
function Bar({ icon, kind, teaserText, action, onOpen }: { icon?: ReactNode; kind: string; teaserText: string; action: string; onOpen: () => void }) {
  return (
    <div className="flex h-8 min-w-0 items-center gap-2">
      {icon}
      <Chip>{kind}</Chip>
      <span className="min-w-0 flex-1 truncate text-body text-ink-soft">{teaserText}</span>
      <Button variant="ghost" className="h-7 shrink-0 text-small" icon={action === "Answer" ? <ChevronDown size={14} aria-hidden="true" /> : undefined} onClick={onOpen}>
        {action}
      </Button>
    </div>
  );
}

export interface ComposerProps {
  hidden: boolean;
  busy: boolean;
  blocked: boolean;
  pause: boolean;
  placeholder: string;
  onSend: (text: string) => Promise<boolean>;
  onSteer: (text: string) => void;
  onStop: () => void;
  onNext: () => void;
  autoFocus: boolean;
}

export function Composer({ hidden, busy, blocked, pause, placeholder, onSend, onSteer, onStop, onNext, autoFocus }: ComposerProps) {
  const [text, setText] = useState("");
  const el = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef("");
  useEffect(() => {
    textRef.current = text;
  });
  useEffect(() => {
    if (autoFocus && !hidden) el.current?.focus();
  }, [autoFocus, hidden]);
  useEffect(() => {
    const t = el.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 192)}px`;
  }, [text]);

  const act = (kind: ReturnType<typeof enterAction>) => {
    const value = textRef.current.trim();
    if (kind === "steer" && value) {
      setText("");
      onSteer(value);
    } else if (kind === "send" && value) {
      setText("");
      // a send that failed gives the words back, so that nothing the learner wrote is lost
      void onSend(value).then((ok) => {
        if (!ok && !textRef.current) setText(value);
      });
    } else if (kind === "stop-prompt") onStop();
    else if (kind === "next") onNext();
  };
  const hasText = text.trim().length > 0;
  const button = composerButton({ busy, hasText, pause });
  return (
    <div className="flex items-end gap-2" hidden={hidden}>
      <textarea
        ref={el}
        rows={1}
        value={text}
        aria-label="Message"
        placeholder={placeholder}
        className={`${FIELD} max-h-48 min-h-10 resize-none`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          act(enterAction({ busy, hasText, blocked, pause }));
        }}
      />
      {button === "stop" ? (
        <Button className="h-10" icon={<Square size={14} aria-hidden="true" />} onClick={onStop}>
          Stop
        </Button>
      ) : button === "next" ? (
        <Button variant="primary" className="h-10" icon={<ArrowRight size={14} aria-hidden="true" />} onClick={onNext}>
          Next problem
        </Button>
      ) : (
        <Button variant="primary" className="h-10" disabled={button === "disabled" || blocked} icon={<CornerDownLeft size={14} aria-hidden="true" />} onClick={() => act(button === "steer" ? "steer" : "send")}>
          Send
        </Button>
      )}
    </div>
  );
}

function ProblemBlock({ statement, hidden, onSubmit, submitting, folded, onOpen }: { statement: string; hidden: boolean; onSubmit: (text: string) => void; submitting: boolean; folded: boolean; onOpen: () => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    const v = text.trim();
    if (!v || submitting) return;
    setText("");
    onSubmit(v);
  };
  return (
    <div hidden={hidden} data-form="problem">
      {folded ? <Bar kind="Problem" teaserText={teaser(statement)} action="Answer" onOpen={onOpen} /> : null}
      <div hidden={folded} className="flex min-w-0 flex-col gap-3">
        <KindLabel>Problem</KindLabel>
        <div className="max-h-[40vh] min-h-0 overflow-y-auto pr-1">
          <Markdown size="ui" fromTool>{statement}</Markdown>
        </div>
        <label className="block">
          <span className="mb-1 block text-small font-medium text-ink-soft">Your thinking</span>
          <textarea
            rows={3}
            value={text}
            placeholder="Work it out in your own words"
            className={`${FIELD} max-h-64 min-h-16 resize-y`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </label>
        <div className="flex justify-end">
          <Button variant="primary" disabled={!text.trim() || submitting} onClick={submit}>
            Submit thinking
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface DockProps {
  variant: DockVariant;
  composer: Omit<ComposerProps, "hidden" | "autoFocus">;
  question: { key: string; q: ClientQuestion; form: FormState; onForm: (f: FormState) => void; reading: string; onReading: (t: string) => void; arrival: Arrival; onOpen: () => void; onSubmit: () => void; submitting: boolean; maxArea?: number } | null;
  problem: { statement: string; onSubmit: (text: string) => void; submitting: boolean; folded: boolean; onOpen: () => void } | null;
  compacting: boolean;
  steers: Steer[];
  /** a chip above the composer, such as "Add a provider key" */
  notice: { text: string; onPress: () => void } | null;
  error: ReactNode;
  /** the stats row: figures at the left, controls at the right */
  stats: ReactNode;
  controls: ReactNode;
  lead?: ReactNode;
  above?: ReactNode;
}

export function Dock({ variant, composer, question, problem, compacting, steers, notice, error, stats, controls, lead, above }: DockProps) {
  const first = useRef(true);
  const [focusNonce, setFocusNonce] = useState(0);
  useEffect(() => {
    // focus moves to the first field of a new variant, and not on the first paint
    if (first.current) {
      first.current = false;
      return;
    }
    setFocusNonce((n) => n + 1);
  }, [variant, question?.key]);
  const q = question && variant === "question" ? question : null;
  const open = q?.arrival === "open";
  return (
    <div data-dock="" role="region" aria-label="Your reply" className="shrink-0 border-t border-rule bg-surface px-6 py-3">
      <div className="mx-auto flex w-full min-w-0 max-w-prose flex-col gap-2">
        {steers.map((s) => (
          <p key={s.id} data-testid="queued-steer" title={s.text} className="ml-auto max-w-60 truncate text-small text-ink-soft">
            {s.text}
          </p>
        ))}
        {notice ? (
          <div>
            <button type="button" className="inline-flex h-7 items-center rounded-md border border-dashed border-rule-strong px-2.5 text-small text-ink hover:bg-raised" onClick={notice.onPress}>
              {notice.text}
            </button>
          </div>
        ) : null}
        {above}
        {q && q.arrival === "reveal" ? (
          <label className="block rounded-md border border-rule bg-raised p-2">
            <span className="mb-1 block text-small text-ink-soft">Thinking while reading</span>
            <textarea rows={2} value={q.reading} aria-label="Thinking while reading" className={`${FIELD} resize-y`} placeholder="Note what you notice as you read" onChange={(e) => q.onReading(e.target.value)} />
          </label>
        ) : null}
        {question ? (
          <div hidden={variant !== "question"}>
            {q && q.arrival !== "open" ? <Bar icon={q.arrival === "reveal" ? <Play size={14} aria-hidden="true" className="shrink-0 text-ink-soft" /> : undefined} kind={q.q.label} teaserText={q.arrival === "reveal" ? "Check your understanding" : teaser(q.q.question)} action={q.arrival === "reveal" ? "Open" : "Answer"} onOpen={q.onOpen} /> : null}
            <div hidden={!open}>
              <QuestionForm key={question.key} q={question.q} form={question.form} onForm={question.onForm} compacting={compacting} submitting={question.submitting} onSubmit={question.onSubmit} active={variant === "question" && !!open} maxAreaHeight={question.maxArea} restoreFocus={!!open && focusNonce > 0} />
            </div>
          </div>
        ) : null}
        {problem ? <ProblemBlock key={problem.statement} statement={problem.statement} hidden={variant !== "problem"} submitting={problem.submitting} folded={problem.folded} onOpen={problem.onOpen} onSubmit={problem.onSubmit} /> : null}
        <Composer {...composer} hidden={variant !== "composer"} autoFocus={focusNonce > 0 || !question} />
        {error}
        <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {lead}
          <div className="num min-w-44 flex-1 truncate font-mono text-small text-ink-soft">{stats}</div>
          <div className="flex shrink-0 items-center gap-1.5">{controls}</div>
        </div>
      </div>
    </div>
  );
}
