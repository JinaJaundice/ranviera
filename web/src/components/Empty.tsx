import type { ReactNode } from "react";

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-6 text-center text-body text-ink-faint">{children}</p>;
}
