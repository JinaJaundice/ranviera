import { X } from "lucide-react";
import { IconButton } from "../components/IconButton";
import { dismissToast, useToasts } from "./toastStore";

export function Toasts() {
  const items = useToasts();
  return (
    <div role="status" aria-live="polite" className="pointer-events-none absolute bottom-3 right-3 z-50 flex w-80 flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border bg-overlay py-2 pl-3 pr-1 text-body text-ink ${
            t.kind === "error" ? "border-block" : "border-rule-strong"
          }`}
        >
          <p className="min-w-0 flex-1 py-1">{t.text}</p>
          <IconButton icon={X} label="Dismiss" size={14} className="h-6 w-6" onClick={() => dismissToast(t.id)} />
        </div>
      ))}
    </div>
  );
}
