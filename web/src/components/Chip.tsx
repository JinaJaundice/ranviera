import type { ReactNode } from "react";

export function Chip({ children, title, className = "" }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1.5 rounded-md border border-rule bg-raised px-2 py-0.5 text-small text-ink ${className}`}
    >
      {children}
    </span>
  );
}
