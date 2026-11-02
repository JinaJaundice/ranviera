// The card of a claim: statement, aliases, support, the held band, calibration, each source with its locator, and the ratify
// and reject actions of route 50. It is opaque, bordered and has no shadow. Escape closes it.
import { useEffect, useState } from "react";
import { FileText, MessageSquare, X } from "lucide-react";
import type { PropositionView } from "@shared/learn/knowledge";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { StatusDot } from "../../components/StatusDot";
import { failureText } from "../../lib/learn/http";
import { claimOf, learnKnowledge } from "../../lib/learn/knowledge";
import { pushEscape } from "../../lib/learn/escape";
import { dateWord } from "../../lib/learn/sources";
import { useFetched } from "../../lib/learn/useFetched";
import { SensitivityChip } from "../../apps/sources/SensitivityChip";
import { FIELD } from "../../apps/sources/style";
import { CARD_WIDTH, HELD_WORDS, type CardPosition, type SourceRef, calibrationWords, locatorFor, locatorWords, passageRange, supportWords } from "./card";

interface Props {
  proposition: PropositionView;
  sources: SourceRef[];
  pos: CardPosition;
  onClose: () => void;
  onOpenPassage: (source: SourceRef, range: { from: number; to?: number }) => void;
  onRatified: () => void;
}

export function NodeCard({ proposition: p, sources, pos, onClose, onOpenPassage, onRatified }: Props) {
  const close = onClose;
  useEffect(() => pushEscape(() => close()), [close]);
  const locs = useFetched(() => learnKnowledge.locators(p.id), p.id);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const held = HELD_WORDS[p.metrics.held];

  const ratify = async (status: "ratified" | "rejected") => {
    setBusy(true);
    setError(null);
    try {
      await learnKnowledge.ratify(status === "rejected" ? { claim: claimOf(p.id), status, reason: reason.trim() } : { claim: claimOf(p.id), status });
      setDone(status === "ratified" ? "Ratified. The graph is being rebuilt." : "Rejected. The graph is being rebuilt.");
      setRejecting(false);
      onRatified();
    } catch (e) {
      setError(failureText(e, "The decision could not be recorded."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label={`Claim ${p.name}`}
      style={{ ...pos, width: CARD_WIDTH }}
      className="absolute z-10 min-w-0 overflow-y-auto rounded-lg border border-rule-strong bg-overlay p-3"
    >
      <div className="flex min-w-0 items-start gap-2">
        <h3 className="min-w-0 flex-1 break-words text-ui font-medium text-ink">{p.name}</h3>
        <IconButton icon={X} label="Close the claim" onClick={close} className="-mr-1 -mt-1 h-6 w-6" size={14} />
      </div>
      <p className="mt-1 break-words text-body text-ink">{p.statement}</p>
      {p.aliases.length ? (
        <p className="mt-2 break-words text-small text-ink-soft">
          <span className="text-ink-faint">Also called </span>
          {p.aliases.join(", ")}
        </p>
      ) : null}
      <dl className="mt-3 grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-1 text-small">
        <dt className="text-ink-faint">Support</dt>
        <dd className="text-ink">{supportWords(p.metrics.support)}</dd>
        <dt className="text-ink-faint">Held</dt>
        <dd className="flex items-center gap-1.5 text-ink">
          <StatusDot tone={held.tone} />
          {held.word}
        </dd>
        <dt className="text-ink-faint">Last tested</dt>
        <dd className="text-ink">{p.metrics.lastTested ? dateWord(p.metrics.lastTested) : "Not tested"}</dd>
        <dt className="text-ink-faint">Calibration</dt>
        <dd className="text-ink">{calibrationWords(p.metrics.calibration)}</dd>
        <dt className="text-ink-faint">Sensitivity</dt>
        <dd>
          <SensitivityChip value={p.sensitivity} />
        </dd>
      </dl>
      <h4 className="mt-3 text-small font-medium text-ink">Sources</h4>
      {sources.length ? (
        <ul className="mt-1 min-w-0 divide-y divide-rule">
          {sources.map((s) => {
            const lw = s.kind === "file" && locs.data ? locatorFor(locs.data, p.id, s.id) : undefined;
            const words = locatorWords(lw);
            return (
              <li key={s.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5">
                {s.kind === "file" ? <FileText size={14} aria-hidden="true" className="shrink-0 text-ink-faint" /> : <MessageSquare size={14} aria-hidden="true" className="shrink-0 text-ink-faint" />}
                <span className="addr w-[calc(100%-1.5rem)] min-w-0 flex-none break-words text-ink" title={s.label}>
                  {s.label}
                </span>
                {s.kind === "file" ? (
                  <Button variant="ghost" className="ml-5 h-6 shrink-0 px-1 text-small text-signal" onClick={() => onOpenPassage(s, passageRange(lw))}>
                    {words ?? "Open file"}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-1 text-small text-ink-faint">No source or session is recorded for this claim.</p>
      )}
      <div className="mt-3 border-t border-rule pt-3">
        {rejecting ? (
          <div className="space-y-2">
            <label className="block min-w-0">
              <span className="mb-1 block text-small text-ink-soft">Reason for rejecting this claim</span>
              <textarea className={`${FIELD} h-16 py-1.5`} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
            </label>
            <div className="flex gap-2">
              <Button variant="secondary" className="border-block text-block" disabled={busy || !reason.trim()} onClick={() => void ratify("rejected")}>
                {busy ? "Recording" : "Reject claim"}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy || done !== null} onClick={() => void ratify("ratified")}>
              {busy ? "Recording" : "Ratify"}
            </Button>
            <Button variant="secondary" disabled={busy || done !== null} onClick={() => setRejecting(true)}>
              Reject
            </Button>
          </div>
        )}
        {done ? (
          <p role="status" className="mt-2 text-small text-ink-soft">
            {done}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 break-words text-small text-block">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

