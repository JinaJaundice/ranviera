export type Tone = "pass" | "hold" | "block" | "idle";

const TONES: Record<Tone, string> = {
  pass: "bg-pass",
  hold: "bg-hold",
  block: "bg-block",
  idle: "bg-ink-faint",
};

/** A small status dot. Give it a label where the dot is the only carrier of the state. */
export function StatusDot({ tone, label, className = "" }: { tone: Tone; label?: string; className?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${TONES[tone]} ${className}`}
    />
  );
}
