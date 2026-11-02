// Find in session. It matches the text that is on show, marks every match with the highlight registry of the browser and
// steps through them. One Escape closes it, and only after a menu or a dialog above it has closed.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import { pushEscape } from "../../lib/learn/escape";
import { countWords, findRanges, stepMatch } from "./find";

const STYLE_ID = "cx-find-style";

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = "::highlight(cx-find){background-color:color-mix(in srgb,var(--color-signal) 25%,transparent);}::highlight(cx-find-active){background-color:var(--color-signal);color:var(--color-on-signal);}";
  document.head.appendChild(el);
}

type HighlightRegistry = { set: (k: string, v: unknown) => void; delete: (k: string) => void };
const registry = (): HighlightRegistry | null => (typeof CSS !== "undefined" && "highlights" in CSS ? ((CSS as unknown as { highlights: HighlightRegistry }).highlights) : null);
const makeHighlight = (ranges: Range[]): unknown => {
  const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  return H ? new H(...ranges) : null;
};

export function FindBar({ root, onClose, refresh }: { root: React.RefObject<HTMLElement | null>; onClose: () => void; refresh: number }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    input.current?.focus();
    ensureStyle();
    const off = pushEscape(() => {
      closeRef.current();
    });
    return () => {
      off();
      registry()?.delete("cx-find");
      registry()?.delete("cx-find-active");
    };
  }, []);

  // matches are found again when the query or the content changes, and the active one is kept in range
  useEffect(() => {
    const el = root.current?.querySelector("[data-find-root]");
    ranges.current = el && query ? findRanges(el, query) : [];
    const reg = registry();
    if (reg) {
      const all = makeHighlight(ranges.current);
      if (all && ranges.current.length) reg.set("cx-find", all);
      else reg.delete("cx-find");
    }
    // the count and the active match follow the content that is on show
    setCount(ranges.current.length);
    setIndex((i) => Math.min(i, Math.max(0, ranges.current.length - 1)));
  }, [query, root, refresh]);

  useEffect(() => {
    const reg = registry();
    const r = ranges.current[index];
    if (!reg) return;
    if (r) {
      const h = makeHighlight([r]);
      if (h) reg.set("cx-find-active", h);
      r.startContainer.parentElement?.scrollIntoView({ block: "center" });
    } else reg.delete("cx-find-active");
  }, [index, count, query]);

  const step = (dir: -1 | 1) => setIndex((i) => stepMatch(i, count, dir));
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-rule bg-surface px-3" role="search">
      <Search size={14} aria-hidden="true" className="shrink-0 text-ink-faint" />
      <input
        ref={input}
        aria-label="Find in this session"
        value={query}
        placeholder="Find in this session"
        className="h-6 min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-faint"
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            step(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="num w-16 shrink-0 text-right font-mono text-small text-ink-soft" role="status">
        {countWords(index, count, query)}
      </span>
      <IconButton icon={ChevronUp} label="Previous match" size={14} className="h-6 w-6" disabled={count === 0} onClick={() => step(-1)} />
      <IconButton icon={ChevronDown} label="Next match" size={14} className="h-6 w-6" disabled={count === 0} onClick={() => step(1)} />
      <IconButton icon={X} label="Close find" size={14} className="h-6 w-6" onClick={onClose} />
    </div>
  );
}
