// Small pieces of the Learn window: a popover that closes on Escape and on an outside press, a menu of actions, and the
// confirmation dialog. The loading line, the error line and the dialog shell come from the Sources window.
import { useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "../../components/Button";
import { useDismiss } from "./useDismiss";
import { Dialog } from "../sources/parts";

/** A panel that opens below or above its button and closes on Escape and on a press outside. */
export function Popover({ button, children, align = "left", up = false, label }: { button: (p: { open: boolean; toggle: () => void }) => ReactNode; children: ReactNode; align?: "left" | "right"; up?: boolean; label: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), root);
  return (
    <div ref={root} className="relative">
      {button({ open, toggle: () => setOpen((o) => !o) })}
      {open ? (
        <div role="group" aria-label={label} className={`absolute z-30 rounded-lg border border-rule-strong bg-overlay ${up ? "bottom-full mb-1" : "top-full mt-1"} ${align === "right" ? "right-0" : "left-0"}`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  danger?: boolean;
  onSelect: () => void;
}

/** A menu of actions below its button. Items are 28px high at 13px, and the panel sits on the overlay surface. */
export function Menu({ button, items, align = "left", label }: { button: (p: { open: boolean; toggle: () => void }) => ReactNode; items: MenuItem[]; align?: "left" | "right"; label: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), root);
  return (
    <div ref={root} className="relative">
      {button({ open, toggle: () => setOpen((o) => !o) })}
      {open ? (
        <div role="menu" aria-label={label} className={`absolute top-full z-30 mt-1 min-w-40 rounded-lg border border-rule-strong bg-overlay p-1 ${align === "right" ? "right-0" : "left-0"}`}>
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                className={`flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-body hover:bg-raised ${it.danger ? "text-block" : "text-ink-soft hover:text-ink"}`}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
              >
                {Icon ? <Icon size={14} aria-hidden="true" className="shrink-0" /> : null}
                <span className="min-w-0 truncate">{it.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** A small confirmation: a title, one line, Cancel and the action. Only the confirmation does the destructive step. */
export function ConfirmDialog({ title, body, confirm, onConfirm, onCancel, danger = true }: { title: string; body: string; confirm: string; onConfirm: () => void; onCancel: () => void; danger?: boolean }) {
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={danger ? "secondary" : "primary"} className={danger ? "border-block text-block" : ""} onClick={onConfirm}>
            {confirm}
          </Button>
        </>
      }
    >
      <p className="text-body text-ink-soft">{body}</p>
    </Dialog>
  );
}

/** The kind label above a question or a problem. */
export function KindLabel({ children }: { children: ReactNode }) {
  return <span className="text-small font-medium text-ink-soft">{children}</span>;
}
