// The 32px row under the title bar: the session title (renamed on a press or F2), the plan chip, the coverage ring and the phase.
import { useEffect, useRef, useState } from "react";
import { Dumbbell, ListTree, PanelLeft } from "lucide-react";
import type { CoverageBlock } from "@shared/learn/sessions";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { IconButton } from "../../components/IconButton";
import { Popover } from "./parts";
import { coverageFill } from "./stats";
import { PHASE_WORDS, type PhaseWord } from "./project";

function Ring({ fill }: { fill: number }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-rule-strong" />
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-signal" strokeDasharray={`${c * fill} ${c}`} transform="rotate(-90 8 8)" />
    </svg>
  );
}

export interface SessionBarProps {
  title: string;
  onRename: (title: string) => void;
  practice: boolean;
  phase: PhaseWord;
  hasPlan: boolean;
  onPlan: () => void;
  coverage: CoverageBlock | null;
  onExtract: () => void;
  extracting: boolean;
  onToggleSidebar: (() => void) | null;
  renameSignal: number;
}

export function SessionBar({ title, onRename, practice, phase, hasPlan, onPlan, coverage, onExtract, extracting, onToggleSidebar, renameSignal }: SessionBarProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  const seen = useRef(renameSignal);
  useEffect(() => {
    if (renameSignal !== seen.current) {
      seen.current = renameSignal;
      setDraft(title);
      setEditing(true);
    }
  }, [renameSignal, title]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const commit = () => {
    const v = draft.trim();
    setEditing(false);
    if (v && v !== title) onRename(v);
  };
  const fill = coverageFill(coverage);
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-rule px-3">
      {onToggleSidebar ? (
        <span className="@min-[720px]:hidden">
          <IconButton icon={PanelLeft} label="Show the sessions" size={14} className="h-6 w-6" onClick={onToggleSidebar} />
        </span>
      ) : null}
      {editing ? (
        <input
          ref={input}
          aria-label="Session title"
          value={draft}
          className="h-6 min-w-0 flex-1 rounded-md border border-rule-strong bg-sunken px-2 text-ui font-medium text-ink"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : (
        <button type="button" title="Rename the session" className="min-w-0 flex-1 truncate text-left text-ui font-medium text-ink hover:text-signal" onClick={() => { setDraft(title); setEditing(true); }}>
          {title}
        </button>
      )}
      {hasPlan ? (
        <button type="button" onClick={onPlan} className="shrink-0">
          <Chip className="hover:bg-sunken">
            <ListTree size={12} aria-hidden="true" />
            Plan
          </Chip>
        </button>
      ) : null}
      {!practice && coverage ? (
        <Popover
          label="Extraction coverage"
          align="right"
          button={({ toggle, open }) => (
            <button type="button" aria-expanded={open} aria-label="Extraction coverage" title="Extraction coverage" className={`flex h-6 w-6 items-center justify-center rounded-md hover:bg-raised ${coverage.running ? "animate-pulse" : ""}`} onClick={toggle}>
              <Ring fill={fill} />
            </button>
          )}
        >
          <div className="w-64 p-3 text-small">
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
              <dt className="text-ink-soft">Covered</dt>
              <dd className="num font-mono text-ink">{`${coverage.coveredTokens.toLocaleString("en-GB")} tokens`}</dd>
              <dt className="text-ink-soft">Not yet covered</dt>
              <dd className="num font-mono text-ink">{`${coverage.uncoveredTokens.toLocaleString("en-GB")} tokens`}</dd>
              <dt className="text-ink-soft">Threshold</dt>
              <dd className="num font-mono text-ink">{`${coverage.threshold.toLocaleString("en-GB")} tokens`}</dd>
              <dt className="text-ink-soft">Last extraction</dt>
              <dd className="text-ink">{coverage.lastFoldedAt ? new Date(coverage.lastFoldedAt).toLocaleString("en-GB") : "None yet"}</dd>
            </dl>
            <Button className="mt-3 h-7 w-full text-small" disabled={coverage.running || extracting} onClick={onExtract}>
              {coverage.running || extracting ? "Running" : "Extract now"}
            </Button>
          </div>
        </Popover>
      ) : null}
      <span className="hidden shrink-0 items-center gap-1.5 text-small text-ink-soft @min-[480px]:flex">
        {practice ? <Dumbbell size={12} aria-hidden="true" /> : null}
        {practice ? "Practice" : PHASE_WORDS[phase]}
      </span>
    </div>
  );
}
