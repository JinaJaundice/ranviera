// The restricted diagram parser of the plan tool. It accepts a header line
// (graph or flowchart, with an optional direction), comment lines, nodes as a
// bare identifier, as id[title] or as id("title"), and the three arrow forms
// -->, ==> and -.-> which all mean that the first node is a prerequisite of the
// second. Every problem is reported with its line number in one reply, so that
// the model can correct them all in one retry.

export interface ParsedPlan {
  nodes: { id: string; title: string }[];
  edges: { from: string; to: string }[];
}

export interface ParseProblem {
  line: number;
  message: string;
}

export type ParseResult = { ok: true; plan: ParsedPlan } | { ok: false; problems: ParseProblem[] };

export const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const ARROWS = ["-.->", "-->", "==>"];
const UNSUPPORTED = new Map<string, string>([
  ["subgraph", "Subgraphs are not supported. List the nodes and edges at the top level."],
  ["end", "The word end closes a subgraph, and subgraphs are not supported."],
  ["style", "Styles are not supported."],
  ["classdef", "Classes are not supported."],
  ["class", "Classes are not supported."],
  ["linkstyle", "Link styles are not supported."],
  ["click", "Click handlers are not supported."],
  ["direction", "A direction line inside the block is not supported. Put the direction in the header."],
]);

const stripFence = (src: string): string => {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first < 0) return "";
  if (!/^```/.test(lines[first].trim())) return lines.join("\n");
  const body = lines.slice(first + 1);
  const close = body.findIndex((l) => /^```\s*$/.test(l.trim()));
  // blank lines stay in place so that line numbers count from the first line of the fence content
  return (close >= 0 ? body.slice(0, close) : body).join("\n");
};

interface Cursor {
  s: string;
  i: number;
}

const skipSpace = (c: Cursor) => {
  while (c.i < c.s.length && /\s/.test(c.s[c.i])) c.i++;
};

const startsWithArrow = (c: Cursor): string | null => ARROWS.find((a) => c.s.startsWith(a, c.i)) ?? null;

/** Reads an identifier. A hyphen belongs to the identifier unless it starts an arrow. */
function readId(c: Cursor): string {
  const start = c.i;
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (/[A-Za-z0-9_]/.test(ch)) c.i++;
    else if (ch === "-" && !startsWithArrow(c)) c.i++;
    else break;
  }
  return c.s.slice(start, c.i);
}

/** Reads the title after an opening bracket, up to the matching closer, respecting double quotes. */
function readTitle(c: Cursor, open: string, close: string): { title: string } | { error: string } {
  c.i++; // the opener
  let out = "";
  let quoted = false;
  let depth = 1;
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === open) depth++;
    else if (!quoted && ch === close && --depth === 0) {
      c.i++;
      const title = out.trim().replace(/^"(.*)"$/s, "$1").trim();
      return title ? { title } : { error: "A node title is empty." };
    }
    out += ch;
    c.i++;
  }
  return { error: `A node title is missing its closing ${close}.` };
}

interface NodeRef {
  id: string;
  title?: string;
}

/** Parses one statement: node (arrow node)*. Returns the problems found on this line. */
function parseStatement(raw: string, lineNo: number, nodes: Map<string, { title: string | null; line: number; titled: string | null }>, edges: Map<string, number>, problems: ParseProblem[], order: { nodes: string[]; edges: { from: string; to: string }[] }) {
  const c: Cursor = { s: raw.trim().replace(/;+\s*$/, ""), i: 0 };
  const refs: NodeRef[] = [];
  const bad = (message: string) => problems.push({ line: lineNo, message });
  let expectNode = true;
  while (true) {
    skipSpace(c);
    if (c.i >= c.s.length) {
      if (expectNode && refs.length > 0) bad("An arrow has no node after it.");
      break;
    }
    if (!expectNode) {
      const arrow = startsWithArrow(c);
      if (!arrow) {
        if (c.s[c.i] === "-" || c.s[c.i] === "=" || c.s[c.i] === ".") {
          bad("The arrow form is not supported. Use -->, ==> or -.-> only.");
        } else if (c.s[c.i] === "&") {
          bad("The & form is not supported. Write one edge for each pair.");
        } else {
          bad(`Unexpected text "${c.s.slice(c.i, c.i + 12)}". Separate nodes with an arrow.`);
        }
        return;
      }
      c.i += arrow.length;
      skipSpace(c);
      if (c.s[c.i] === "|") {
        bad("Edge labels are not supported. Name the relationship in the node titles.");
        return;
      }
      expectNode = true;
      continue;
    }
    const id = readId(c);
    if (!id) {
      bad(`Expected a node identifier at "${c.s.slice(c.i, c.i + 12)}".`);
      return;
    }
    let title: string | undefined;
    const open = c.s[c.i];
    if (open === "[" || open === "(") {
      const read = readTitle(c, open, open === "[" ? "]" : ")");
      if ("error" in read) {
        bad(read.error);
        return;
      }
      title = read.title;
    }
    refs.push({ id, title });
    expectNode = false;
  }

  for (const ref of refs) {
    if (!SLUG.test(ref.id)) {
      bad(`The node identifier "${ref.id}" is not a valid slug. Use lower case letters and digits, with parts joined by a hyphen or an underscore.`);
      continue;
    }
    const known = nodes.get(ref.id);
    if (!known) {
      nodes.set(ref.id, { title: ref.title ?? null, line: lineNo, titled: ref.title ?? null });
      order.nodes.push(ref.id);
    } else if (ref.title !== undefined) {
      if (known.titled === null) {
        known.title = ref.title;
        known.titled = ref.title;
      } else if (known.titled !== ref.title) {
        bad(`The node "${ref.id}" is declared twice with different titles (line ${known.line} and line ${lineNo}). Each identifier names one node.`);
      }
    }
  }
  for (let k = 0; k + 1 < refs.length; k++) {
    const from = refs[k].id;
    const to = refs[k + 1].id;
    if (!SLUG.test(from) || !SLUG.test(to)) continue;
    if (from === to) {
      bad(`The node "${from}" points to itself. A self loop is not allowed.`);
      continue;
    }
    const key = `${from}>${to}`;
    const first = edges.get(key);
    if (first !== undefined) {
      bad(`The edge ${from} to ${to} appears twice (line ${first} and line ${lineNo}).`);
      continue;
    }
    edges.set(key, lineNo);
    order.edges.push({ from, to });
  }
}

/** Finds one cycle and returns the identifiers along it, or null. */
export function findCycle(nodes: string[], edges: { from: string; to: string }[]): string[] | null {
  const next = new Map<string, string[]>();
  for (const n of nodes) next.set(n, []);
  for (const e of edges) next.get(e.from)?.push(e.to);
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const m of next.get(n) ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!state.has(m)) {
        const found = visit(m);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of nodes) {
    if (!state.has(n)) {
      const found = visit(n);
      if (found) return found;
    }
  }
  return null;
}

export function parsePlan(source: string): ParseResult {
  const text = stripFence(String(source ?? ""));
  const lines = text.split("\n");
  const problems: ParseProblem[] = [];
  const nodes = new Map<string, { title: string | null; line: number; titled: string | null }>();
  const edges = new Map<string, number>();
  const order = { nodes: [] as string[], edges: [] as { from: string; to: string }[] };
  let header = false;

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("%%")) return;
    if (!header) {
      if (!/^(graph|flowchart)(\s+(td|tb|bt|lr|rl))?\s*;?$/i.test(line)) {
        problems.push({ line: lineNo, message: "The block must start with a header line such as graph TD or flowchart LR." });
        // keep reading, so that the later problems are reported in the same reply
      }
      header = true;
      return;
    }
    const word = line.split(/\s+/)[0].toLowerCase();
    const unsupported = UNSUPPORTED.get(word);
    if (unsupported && !/(-->|==>|-\.->)/.test(line)) {
      problems.push({ line: lineNo, message: unsupported });
      return;
    }
    parseStatement(line, lineNo, nodes, edges, problems, order);
  });

  if (!header) problems.push({ line: 1, message: "The block is empty. Start with a header line such as graph TD." });
  else if (order.nodes.length === 0 && problems.length === 0) problems.push({ line: 1, message: "The map has no nodes." });

  if (problems.length === 0) {
    const cycle = findCycle(order.nodes, order.edges);
    if (cycle) {
      const closing = edges.get(`${cycle[cycle.length - 2]}>${cycle[cycle.length - 1]}`) ?? 1;
      problems.push({ line: closing, message: `The edges form a cycle (${cycle.join(" to ")}). A prerequisite map has no cycles.` });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    plan: {
      nodes: order.nodes.map((id) => ({ id, title: nodes.get(id)?.title ?? id })),
      edges: order.edges,
    },
  };
}

export const describeProblems = (problems: ParseProblem[]): string =>
  problems.map((p) => `Line ${p.line}: ${p.message}`).join("\n");
