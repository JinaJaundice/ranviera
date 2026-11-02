import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

/** One sentence under a control. A refusal about models or keys is informational and shows in the hold tone, and a failure shows in the block tone. */
export function Notice({ text, tone }: { text: string | null; tone: "info" | "error" }) {
  if (!text) return null;
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`mt-1.5 min-w-0 break-words text-small ${tone === "error" ? "text-block" : "text-hold"}`}>
      {text}
    </p>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-small text-ink-faint">
      <Loader2 size={14} className="animate-spin" aria-hidden="true" />
      Loading {what}.
    </p>
  );
}

/** A label with its one line hint at the left and the controls at the right. */
export function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-1 items-start gap-2 py-2 @md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="text-body font-medium text-ink">{label}</div>
        {hint ? <div className="text-small text-ink-faint">{hint}</div> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A switch that reads as a checkbox with a word beside it, so that the state is always written out. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={`flex min-w-0 items-center gap-2 text-body text-ink ${disabled ? "opacity-50" : ""}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 shrink-0 accent-signal" />
      <span className="min-w-0">{label}</span>
    </label>
  );
}
