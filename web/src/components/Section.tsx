import type { ReactNode } from "react";

/** A titled block inside a window. The heading is a noun phrase and the optional note is one sentence. */
export function Section({ title, note, action, children }: { title: string; note?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 border-b border-rule px-4 py-3 last:border-b-0">
      <div className="mb-2 flex min-w-0 items-baseline justify-between gap-3">
        <h3 className="min-w-0 truncate text-ui font-medium text-ink">{title}</h3>
        {action}
      </div>
      {note ? <p className="mb-2 text-small text-ink-soft">{note}</p> : null}
      {children}
    </section>
  );
}
