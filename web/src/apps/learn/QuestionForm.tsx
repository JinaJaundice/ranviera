// The question form of the dock: option rows, the not known option, Other, the confidence control, the thinking field and the
// submit button. It is controlled, so that the owner can keep a half made answer across a scroll, a fold or a remount.
import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import { Button } from "../../components/Button";
import { Markdown } from "./Markdown";
import {
  CONFIDENCE_STOPS,
  DONT_KNOW,
  OTHER,
  actOnRow,
  hasAnswer,
  isTextMode,
  rowIds,
  stepStop,
  stopFromFraction,
  thinkingLabel,
  toggleDontKnow,
  toggleOther,
  toggleValue,
  typeOther,
  walkRows,
  type ClientQuestion,
  type FormState,
} from "./questions";
import { KindLabel } from "./parts";
import { useState } from "react";

/** the height that the confidence control and a two-line thinking field take below the options, in pixels */
const PINNED_FIELDS_PX = 136;
const FIELD = "w-full min-w-0 rounded-md border border-rule-strong bg-sunken px-3 py-2 text-body text-ink placeholder:text-ink-faint";

/** The confidence control: a rail with six stops, a thumb, and the value as a number. Colour is never the code. */
export function ConfidenceControl({ index, onChange, disabled }: { index: number; onChange: (i: number) => void; disabled: boolean }) {
  const rail = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const value = CONFIDENCE_STOPS[index];
  const fromEvent = (e: React.PointerEvent) => {
    const r = rail.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    onChange(stopFromFraction((e.clientX - r.left) / r.width));
  };
  return (
    <div role="group" aria-label="Confidence" aria-disabled={disabled} className={`flex min-w-0 items-center gap-3 ${disabled ? "opacity-50" : ""}`}>
      <span className="w-20 shrink-0 text-small text-ink-soft">Confidence</span>
      <div
        ref={rail}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Confidence"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`${value} percent`}
        aria-disabled={disabled}
        className="relative mx-2 h-6 min-w-0 flex-1 cursor-pointer touch-none"
        onPointerDown={(e) => {
          if (disabled) return;
          dragging.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          fromEvent(e);
        }}
        onPointerMove={(e) => dragging.current && fromEvent(e)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowLeft" || e.key === "ArrowDown") onChange(stepStop(index, -1));
          else if (e.key === "ArrowRight" || e.key === "ArrowUp") onChange(stepStop(index, 1));
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-sm border border-rule-strong bg-sunken">
          <div className="h-full rounded-sm bg-signal" style={{ width: `${value}%` }} />
          {CONFIDENCE_STOPS.map((s) => (
            <span key={s} aria-hidden="true" className="absolute -top-px h-1.5 w-px bg-rule-strong" style={{ left: `${s}%` }} />
          ))}
        </div>
        <span aria-hidden="true" className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-on-signal bg-signal" style={{ left: `${value}%` }} />
      </div>
      <span className="num w-16 shrink-0 text-right font-mono text-small text-ink">{disabled ? "Not given" : `${value}%`}</span>
    </div>
  );
}

function Indicator({ multi, on }: { multi: boolean; on: boolean }) {
  const base = "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border";
  return (
    <span aria-hidden="true" className={`${base} ${multi ? "rounded-sm" : "rounded-full"} ${on ? "border-signal bg-signal text-on-signal" : "border-ink-soft"}`}>
      {on ? multi ? <Check size={12} /> : <span className="h-1.5 w-1.5 rounded-full bg-on-signal" /> : null}
    </span>
  );
}

interface RowProps {
  role: "radio" | "checkbox";
  on: boolean;
  walked: boolean;
  dashed?: boolean;
  onPress: () => void;
  children: React.ReactNode;
  multi: boolean;
  id: string;
}

function Row({ role, on, walked, dashed, onPress, children, multi, id }: RowProps) {
  return (
    <div
      id={id}
      role={role}
      aria-checked={on}
      tabIndex={-1}
      onClick={onPress}
      className={`flex min-h-8 w-full cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-left text-body ${dashed ? "border-dashed" : ""} ${on ? "border-signal bg-signal-soft" : "border-rule-strong bg-surface hover:bg-raised"} ${walked ? "outline outline-2 outline-offset-1 outline-signal" : ""}`}
    >
      <Indicator multi={multi} on={on} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export interface QuestionFormProps {
  q: ClientQuestion;
  form: FormState;
  onForm: (f: FormState) => void;
  compacting: boolean;
  submitting: boolean;
  onSubmit: () => void;
  /** false while the form is folded or behind its reveal bar: it stays mounted and takes no keys */
  active: boolean;
  maxAreaHeight?: number;
  restoreFocus?: boolean;
}

export function QuestionForm({ q, form, onForm, compacting, submitting, onSubmit, active, maxAreaHeight, restoreFocus }: QuestionFormProps) {
  const [walk, setWalk] = useState<string | null>(null);
  const rows = rowIds(q);
  const text = isTextMode(q);
  const multi = q.multiSelect;
  const field = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef(form);
  const walkRef = useRef(walk);
  const canSubmit = hasAnswer(form, q) && !compacting && !submitting;
  const submitRef = useRef({ canSubmit, onSubmit });
  useEffect(() => {
    formRef.current = form;
    walkRef.current = walk;
    submitRef.current = { canSubmit, onSubmit };
  });

  // keys of the form: arrows walk the rows, Space acts on the walked row, Enter submits once an answer exists
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const inField = !!t && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable);
      if (inField || t?.getAttribute("role") === "slider") return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!rows.length) return;
        e.preventDefault();
        setWalk((cur) => walkRows(rows, cur, e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === " " && walkRef.current) {
        if (t?.tagName === "BUTTON") return;
        e.preventDefault();
        onForm(actOnRow(formRef.current, q, walkRef.current));
      } else if (e.key === "Enter" && submitRef.current.canSubmit && t?.tagName !== "BUTTON") {
        e.preventDefault();
        submitRef.current.onSubmit();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, rows.join("|"), q]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (active && restoreFocus) field.current?.focus({ preventScroll: true });
  }, [active, restoreFocus]);

  const options = q.options ?? [];
  // The confidence control and the thinking field stay in view below the scrolling options, because the thinking is the
  // main evidence that the agents read (docs/LEARNING.md, "Confidence and thinking fields"). Their room comes out of the
  // height budget of the options.
  const area = maxAreaHeight ? { maxHeight: Math.max(96, maxAreaHeight - PINNED_FIELDS_PX) } : undefined;
  return (
    <div className="flex min-w-0 flex-col" hidden={!active} data-form="question">
      <div className="min-h-0 min-w-0 space-y-3 overflow-y-auto pr-1" style={area}>
        <div className="flex items-baseline gap-2">
          <KindLabel>{q.label}</KindLabel>
          {multi ? <span className="text-small text-ink-faint">Select all that apply</span> : null}
        </div>
        <Markdown size="ui" fromTool className="font-medium">{q.question}</Markdown>
        {q.details ? <Markdown size="body" fromTool className="text-ink-soft">{q.details}</Markdown> : null}
        {!text ? (
          <div role={multi ? "group" : "radiogroup"} aria-label={q.label} className="space-y-1.5">
            {options.map((o) => (
              <Row key={o.value} id={`opt-${o.value}`} role={multi ? "checkbox" : "radio"} multi={multi} on={form.selected.includes(o.value)} walked={walk === o.value} onPress={() => { setWalk(o.value); onForm(toggleValue(form, q, o.value)); }}>
                <Markdown size="body" fromTool>{o.label}</Markdown>
              </Row>
            ))}
            {q.kind === "quiz" ? (
              <Row id="opt-dont-know" role={multi ? "checkbox" : "radio"} multi={multi} dashed on={form.dontKnow} walked={walk === DONT_KNOW} onPress={() => { setWalk(DONT_KNOW); onForm(toggleDontKnow(form)); }}>
                <span className="text-body text-ink-soft">I do not know</span>
              </Row>
            ) : (
              <Row id="opt-other" role={multi ? "checkbox" : "radio"} multi={multi} dashed on={form.otherSelected} walked={walk === OTHER} onPress={() => { setWalk(OTHER); onForm(toggleOther(form, q)); }}>
                <input
                  type="text"
                  aria-label="Other"
                  value={form.otherText}
                  placeholder="Type your own answer"
                  className="w-full min-w-0 bg-transparent text-body text-ink outline-none placeholder:text-ink-faint"
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => onForm(typeOther(form, q, e.target.value))}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") (e.target as HTMLInputElement).blur();
                    e.stopPropagation();
                  }}
                />
              </Row>
            )}
          </div>
        ) : null}
      </div>
      <div className="mt-3 min-w-0 space-y-3">
        {q.kind === "quiz" ? <ConfidenceControl index={form.confidenceIdx} disabled={form.dontKnow} onChange={(i) => onForm({ ...form, confidenceIdx: i })} /> : null}
        <label className="block">
          <span className="mb-1 block text-small font-medium text-ink-soft">{thinkingLabel(q)}</span>
          <textarea
            ref={field}
            rows={text ? 3 : 2}
            value={text ? form.text : form.thinking}
            placeholder={text ? "Write your answer" : "Say how you got there"}
            className={`${FIELD} max-h-48 resize-y`}
            onChange={(e) => onForm(text ? { ...form, text: e.target.value } : { ...form, thinking: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (canSubmit) onSubmit();
              }
            }}
          />
        </label>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="min-w-0 text-caption text-ink-soft">{compacting ? "Compacting the session" : "Enter submits. Shift and Enter add a line."}</p>
        <Button variant="primary" className="shrink-0 whitespace-nowrap" disabled={!canSubmit} onClick={onSubmit}>
          {submitting ? "Sending" : "Submit answer"}
        </Button>
      </div>
    </div>
  );
}
