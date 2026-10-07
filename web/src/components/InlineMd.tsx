// Renders the inline marks used in the rule and reference files (**bold** and `code`) as React elements. No HTML is
// parsed, so text from the files cannot inject markup.
import type { ReactNode } from "react";

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`)/g;

export function InlineMd({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<strong key={i++} className="font-semibold text-ink">{tok.slice(2, -2)}</strong>);
    else parts.push(<code key={i++} className="rounded-sm bg-sunken px-1 font-mono text-small text-ink-soft">{tok.slice(1, -1)}</code>);
    last = at + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** Plain words for the modal verb of a rule (docs/ONTOLOGY.md). */
export const MODAL_WORDS: Record<string, string> = {
  must: "Must",
  should: "Should",
  may: "May",
  will: "Will",
  imperative: "Instruction",
  none: "Statement",
};
