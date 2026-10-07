export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded-sm border border-rule-strong bg-sunken px-1.5 font-mono text-caption text-ink-soft">{children}</kbd>
  );
}
