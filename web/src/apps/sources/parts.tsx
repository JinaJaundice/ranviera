// Small pieces shared by the Sources window and the Knowledge layer: the loading line, the error line, the dialog and the switch.
import { useEffect, useRef, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { pushEscape } from "../../lib/learn/escape";
import { Button } from "../../components/Button";

export function LoadLine({ what }: { what: string }) {
  return (
    <p role="status" className="flex items-center justify-center gap-2 px-3 py-6 text-body text-ink-faint">
      <Loader2 size={14} aria-hidden="true" className="shrink-0 animate-spin" />
      {`Loading ${what}.`}
    </p>
  );
}

/** The failure of the server, in its own sentence, with an optional retry. */
export function ErrorLine({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-3 text-body text-block">
      <span className="min-w-0 break-words">{children}</span>
      {onRetry ? (
        <Button variant="ghost" className="h-7 text-small" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="min-w-0 break-words text-small text-ink-soft">
      {children}
    </p>
  );
}

/**
 * A dialog for an irreversible step. Focus moves into it when it opens and returns to the control that opened it, Tab stays
 * inside it, and Escape closes it through the Escape stack, so that one key press closes one layer.
 */
export function Dialog({ title, onClose, children, footer, busy = false }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode; busy?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const locked = useRef(busy);
  useEffect(() => {
    close.current = onClose;
    locked.current = busy;
  });
  useEffect(() => {
    const el = root.current;
    const opener = document.activeElement as HTMLElement | null;
    const items = () => Array.from(el?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])') ?? []);
    (items()[0] ?? el)?.focus();
    const off = pushEscape(() => {
      if (!locked.current) close.current();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = items();
      if (!list.length) return;
      const at = document.activeElement;
      if (e.shiftKey && at === list[0]) {
        e.preventDefault();
        list[list.length - 1].focus();
      } else if (!e.shiftKey && at === list[list.length - 1]) {
        e.preventDefault();
        list[0].focus();
      }
    };
    el?.addEventListener("keydown", onKey);
    return () => {
      off();
      el?.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, []);
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-void/70 p-4">
      <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="flex max-h-full w-full max-w-lg min-w-0 flex-col rounded-lg border border-rule-strong bg-overlay outline-none">
        <h2 className="shrink-0 border-b border-rule px-4 py-3 text-ui font-medium text-ink">{title}</h2>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-rule px-4 py-3">{footer}</div>
      </div>
    </div>
  );
}

/** An on and off control that reads as a switch, with its state also written as a word by the caller. */
export function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-md border border-rule-strong disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-signal-soft" : "bg-sunken"}`}
    >
      <span aria-hidden="true" className={`absolute h-3.5 w-3.5 rounded-sm ${checked ? "left-[18px] bg-signal" : "left-0.5 bg-ink-faint"}`} />
    </button>
  );
}
