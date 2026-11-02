// Find in session: literal, case insensitive matching over the displayed text, with offsets in UTF-16 units.

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The start and end of each match. An empty query matches nothing, and characters of a pattern have no special meaning. */
export function findMatches(text: string, query: string): [number, number][] {
  if (!query) return [];
  const out: [number, number][] = [];
  const re = new RegExp(escapeRegExp(query), "giu");
  for (const m of text.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** One step through the matches with wrap, or minus one when there are none. */
export function stepMatch(index: number, count: number, dir: -1 | 1): number {
  if (count <= 0) return -1;
  return (index + dir + count) % count;
}

/** "2 of 7", or a plain phrase when nothing matches. */
export function countWords(index: number, count: number, query: string): string {
  if (!query) return "";
  return count === 0 ? "No matches" : `${index + 1} of ${count}`;
}

const HIDDEN = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "IFRAME", "CANVAS"]);

/** The text nodes under a root that a reader can see. A hidden subtree, a field and a marked exclusion are left out. */
export function visibleTextNodes(root: Element): Text[] {
  const out: Text[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let el = node.parentElement; el; el = el.parentElement) {
        if (HIDDEN.has(el.tagName) || el.hasAttribute("hidden") || el.hasAttribute("data-find-exclude") || el.classList.contains("katex-mathml")) return NodeFilter.FILTER_REJECT;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return NodeFilter.FILTER_REJECT;
        if (el === root) break;
      }
      return node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n as Text);
  return out;
}

/** Ranges for the matches of a query in each text node. A phrase never spans two nodes that a block boundary separates. */
export function findRanges(root: Element, query: string): Range[] {
  const ranges: Range[] = [];
  for (const node of visibleTextNodes(root)) {
    for (const [a, b] of findMatches(node.nodeValue ?? "", query)) {
      const r = document.createRange();
      r.setStart(node, a);
      r.setEnd(node, b);
      ranges.push(r);
    }
  }
  return ranges;
}
