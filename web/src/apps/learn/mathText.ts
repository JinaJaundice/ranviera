// Helpers for the text of a lesson: the reader that tells prose, code and maths apart without rewriting the source, the
// converter from the old \( \) and \[ \] forms to dollar forms, and a repair for display that undoes the damage that JSON
// and over escaping do to LaTeX inside tool call arguments. The repair works on a copy for display and never touches the
// saved record. This is a reduced form of the behaviour in brief 15: code is found by scanning fences and backtick runs,
// and the repair covers escape debris and over escaped commands, not the recovery of document layout.
import katex from "katex";

export type Span =
  | { t: "prose"; raw: string }
  | { t: "code"; raw: string }
  | { t: "math"; raw: string; open: string; body: string; close: string; display: boolean };

type Range = [number, number];

/** The offsets of fenced blocks and inline code spans. An unclosed fence runs to the end of the text. */
export function codeRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const lines = text.split("\n");
  let offset = 0;
  let fence: { ch: string; len: number; start: number } | null = null;
  const outside: Range[] = [];
  let outStart = 0;
  for (const line of lines) {
    const start = offset;
    offset += line.length + 1;
    if (fence) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line.replace(/\r$/, ""));
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) {
        ranges.push([fence.start, Math.min(text.length, offset)]);
        fence = null;
        outStart = Math.min(text.length, offset);
      }
      continue;
    }
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m && !(m[1][0] === "`" && line.slice(m[0].length).includes("`"))) {
      outside.push([outStart, start]);
      fence = { ch: m[1][0], len: m[1].length, start };
    }
  }
  if (fence) ranges.push([fence.start, text.length]);
  else outside.push([outStart, text.length]);
  for (const [a, b] of outside) {
    let i = a;
    while (i < b) {
      if (text[i] !== "`") {
        i++;
        continue;
      }
      let n = 0;
      while (text[i + n] === "`") n++;
      let j = i + n;
      let end = -1;
      while (j < b) {
        if (text.startsWith("\n\n", j)) break;
        if (text[j] === "`") {
          let m = 0;
          while (text[j + m] === "`") m++;
          if (m === n) {
            end = j + m;
            break;
          }
          j += m;
        } else j++;
      }
      if (end > 0) {
        ranges.push([i, end]);
        i = end;
      } else i += n;
    }
  }
  return ranges.sort((x, y) => x[0] - y[0]);
}

const backslashesBefore = (text: string, i: number): number => {
  let n = 0;
  while (i - 1 - n >= 0 && text[i - 1 - n] === "\\") n++;
  return n;
};

/** Splits a text into prose, code and maths so that joining the raw strings gives the text back. */
export function readSpans(text: string): Span[] {
  const code = codeRanges(text);
  const spans: Span[] = [];
  let prose = "";
  const flush = () => {
    if (prose) spans.push({ t: "prose", raw: prose });
    prose = "";
  };
  const nextBarrier = (from: number): number => code.find((r) => r[1] > from)?.[0] ?? text.length;
  let i = 0;
  while (i < text.length) {
    const r = code.find((c) => c[0] <= i && i < c[1]);
    if (r) {
      flush();
      spans.push({ t: "code", raw: text.slice(i, r[1]) });
      i = r[1];
      continue;
    }
    const ch = text[i];
    if (ch === "\\") {
      const next = text[i + 1];
      if ((next === "(" || next === "[") && backslashesBefore(text, i) % 2 === 0) {
        const closer = next === "(" ? "\\)" : "\\]";
        const limit = nextBarrier(i);
        let j = i + 2;
        let end = -1;
        while (j < limit) {
          if (text.startsWith(closer, j) && backslashesBefore(text, j) % 2 === 0) {
            end = j;
            break;
          }
          if (next === "(" && text.startsWith("\n\n", j)) break;
          j++;
        }
        if (end >= 0) {
          flush();
          spans.push({ t: "math", raw: text.slice(i, end + 2), open: `\\${next}`, body: text.slice(i + 2, end), close: closer, display: next === "[" });
          i = end + 2;
          continue;
        }
      }
      prose += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "$") {
      let n = 0;
      while (text[i + n] === "$") n++;
      const open = "$".repeat(n);
      const limit = nextBarrier(i);
      let closeAt = -1;
      let display = false;
      if (n >= 2) {
        const lineStart = text.lastIndexOf("\n", i - 1) + 1;
        const before = text.slice(lineStart, i);
        const eol = text.indexOf("\n", i);
        const rest = text.slice(i + n, eol < 0 ? text.length : eol);
        if (/^[ \t]{0,3}$/.test(before) && !rest.includes("$")) {
          let p = eol < 0 ? -1 : eol + 1;
          while (p >= 0 && p < limit) {
            const e = text.indexOf("\n", p);
            const line = text.slice(p, e < 0 ? text.length : e);
            const m = /^[ \t]{0,3}(\$+)[ \t]*\r?$/.exec(line);
            if (m && m[1].length >= n) {
              closeAt = p + line.indexOf("$");
              display = true;
              n = m[1].length > n ? n : n;
              break;
            }
            p = e < 0 ? -1 : e + 1;
          }
        }
      }
      if (closeAt < 0) {
        let j = i + n;
        while (j < limit) {
          if (text.startsWith("\n\n", j)) break;
          if (text[j] === "\\") {
            j += 2;
            continue;
          }
          if (text[j] === "$") {
            let m = 0;
            while (text[j + m] === "$") m++;
            if (m === n) {
              closeAt = j;
              break;
            }
            j += m;
          } else j++;
        }
      }
      if (closeAt >= 0) {
        const closeLen = display ? (/^\$+/.exec(text.slice(closeAt))?.[0].length ?? n) : n;
        flush();
        spans.push({ t: "math", raw: text.slice(i, closeAt + closeLen), open, body: text.slice(i + n, closeAt), close: "$".repeat(closeLen), display });
        i = closeAt + closeLen;
        continue;
      }
      prose += open;
      i += n;
      continue;
    }
    prose += ch;
    i++;
  }
  flush();
  return spans;
}


/** Replaces each escaped dollar of a single dollar span with a dollar free command, so that the span does not close early. */
function freeEscapedDollars(body: string): string {
  return body.replace(/\\\$/g, (m, at: number) => (backslashesBefore(body, at) % 2 === 0 ? "\\text{\\textdollar}" : m));
}

/**
 * Rewrites \( \) to a one line double dollar span and \[ \] to a fenced display block, and frees escaped dollars inside a
 * single dollar span. Code, currency and an unbalanced opener come back byte for byte.
 */
export function transformMathDelimiters(text: string): string {
  if (!/[\\$]/.test(text)) return text;
  const spans = readSpans(text);
  let out = "";
  spans.forEach((s, idx) => {
    if (s.t !== "math") {
      out += s.raw;
      return;
    }
    if (s.open === "$") {
      out += `$${freeEscapedDollars(s.body)}$`;
      return;
    }
    if (s.open !== "\\(" && s.open !== "\\[") {
      out += s.raw;
      return;
    }
    const body = s.body.trim();
    if (!body) {
      out += s.raw;
      return;
    }
    if (s.open === "\\(") {
      out += `$$${body}$$`;
      return;
    }
    const lineStart = out.lastIndexOf("\n") + 1;
    const prefix = out.slice(lineStart);
    if (prefix.length > 0 && /^[ \t]+$/.test(prefix)) {
      out += `$$${body.replace(/\s*\n\s*/g, " ")}$$`;
      return;
    }
    const nextRaw = spans[idx + 1]?.raw ?? "";
    const after = nextRaw === "" || nextRaw.startsWith("\n") ? "" : "\n\n";
    const lead = prefix.length === 0 ? "" : "\n\n";
    out += `${lead}$$\n${body}\n$$${after}`;
  });
  return out;
}

/* Repair for display ------------------------------------------------------------------------------------------- */

const known = new Map<string, boolean>();

/** Asks KaTeX whether a command name exists. Only a name of letters is accepted. */
export function knownTexCommand(command: string): boolean {
  if (!/^[a-zA-Z]+$/.test(command)) return false;
  const cached = known.get(command);
  if (cached !== undefined) return cached;
  let exists = true;
  try {
    katex.renderToString(`\\${command}`, { strict: false, trust: false, throwOnError: true });
  } catch (e) {
    exists = !(e instanceof Error && /Undefined control sequence/.test(e.message));
  }
  known.set(command, exists);
  return exists;
}

export function canParseTex(source: string, asDisplay: boolean): boolean {
  const options = { displayMode: asDisplay, strict: false, trust: false, throwOnError: true };
  try {
    katex.renderToString(source, options);
    return true;
  } catch {
    return false;
  }
}

const DEBRIS: Record<string, string> = { "\f": "f", "\r": "r", "\b": "b", "\v": "v", "\t": "t" };

/**
 * A command that lost its first letter to a JSON escape (a form feed before orall) is restored when the letters that follow
 * complete a command that KaTeX knows. In inline maths a newline before letters is restored the same way. Display maths keeps
 * its newlines, because they cannot be told from real line breaks.
 */
export function restoreMathEscapes(body: string, display: boolean): string {
  if (!/[\b\t\v\f\r\n]/.test(body)) return body;
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const letter = DEBRIS[ch] ?? (ch === "\n" && !display ? "n" : undefined);
    if (letter && !(ch === "\r" && body[i + 1] === "\n")) {
      const run = /^[A-Za-z]+/.exec(body.slice(i + 1))?.[0] ?? "";
      if (run && knownTexCommand(letter + run)) {
        out += `\\${letter}`;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

const ROW_ENV = /\\begin\{(matrix|pmatrix|bmatrix|vmatrix|Vmatrix|smallmatrix|cases|aligned|align\*?|array|gathered|split|eqnarray\*?)\}[\s\S]*?\\end\{\1\}/g;

/** A command whose backslash was doubled is reduced to one. Row breaks in a matrix or an aligned block, and odd runs, stay. */
export function healOverescapedCommands(body: string, display: boolean): string {
  if (!body.includes("\\\\")) return body;
  const keep: Range[] = [];
  for (const m of body.matchAll(ROW_ENV)) keep.push([m.index, m.index + m[0].length]);
  for (const m of body.matchAll(/\\substack\{/g)) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < body.length && depth > 0) {
      if (body[j] === "{") depth++;
      else if (body[j] === "}") depth--;
      j++;
    }
    keep.push([m.index, j]);
  }
  const healed = body.replace(/\\+/g, (run, at: number) => {
    if (run.length % 2 === 1 || run.length < 2) return run;
    if (keep.some(([a, b]) => at >= a && at < b)) return run;
    const rest = body.slice(at + run.length);
    const word = /^[A-Za-z]+/.exec(rest)?.[0] ?? "";
    if (word.length > 1 && knownTexCommand(word)) return "\\";
    if (/^[,;:!|{}]/.test(rest)) return "\\";
    if (rest.startsWith("%") && /\d$/.test(body.slice(0, at))) return "\\";
    return run;
  });
  if (healed === body) return body;
  return canParseTex(healed, display) || !canParseTex(body, display) ? healed : body;
}

/** The three repairs in order, applied to the maths of a text that a model wrote in a tool call. Prose and code are untouched. */
export function repairMathForDisplay(text: string): string {
  if (!/[\\$\b\t\v\f\r]/.test(text)) return text;
  const spans = readSpans(text);
  return spans
    .map((s) => {
      if (s.t !== "math") return s.raw;
      const body = healOverescapedCommands(restoreMathEscapes(s.body, s.display), s.display);
      return body === s.body ? s.raw : `${s.open}${body}${s.close}`;
    })
    .join("");
}

/** The text of a lesson as it is handed to the Markdown renderer. Tool authored text is repaired first. */
export function prepareMarkdown(text: string, fromTool = false): string {
  return transformMathDelimiters(fromTool ? repairMathForDisplay(text) : text);
}
