// Glob matching for the source globs and, in "tool" mode, for the file tools of Phase 7
// (docs/CONTRACTS.md, "File tools"). A star stays within one segment, a double star crosses segments,
// a question mark is one character and one level of braces expands.

export type GlobMode = "anchored" | "tool";

/** Expands one level of braces, so that `*.{md,txt}` becomes two patterns. Nested braces stay literal. */
export function expandBraces(pattern: string): string[] {
  const from = pattern.indexOf("{");
  const to = from < 0 ? -1 : pattern.indexOf("}", from);
  if (to < 0) return [pattern];
  const prefix = pattern.slice(0, from);
  const suffix = pattern.slice(to + 1);
  return pattern
    .slice(from + 1, to)
    .split(",")
    .map((choice) => `${prefix}${choice}${suffix}`);
}

const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function segmentSource(segment: string): string {
  let out = "";
  for (const c of segment) out += c === "*" ? "[^/]*" : c === "?" ? "[^/]" : escape(c);
  return out;
}

function toRegExp(pattern: string, mode: GlobMode, ignoreCase: boolean): RegExp {
  let p = pattern.replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  const flags = ignoreCase ? "i" : "";
  if (mode === "tool" && !p.includes("/")) return new RegExp(`^(?:.*/)?${segmentSource(p)}$`, flags);
  let anyDepth = mode === "tool";
  if (p.startsWith("/")) {
    p = p.slice(1);
    anyDepth = false;
  }
  const segments = p.split("/");
  if (segments[0] === "**") anyDepth = false;
  let source = anyDepth ? "(?:.*/)?" : "";
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (seg === "**") source += last ? ".*" : "(?:[^/]+/)*";
    else source += segmentSource(seg) + (last ? "" : "/");
  });
  return new RegExp(`^${source}$`, flags);
}

/** Compiles a glob into a test on a path relative to the root, written with forward slashes. */
export function compileGlob(pattern: string, opts: { mode?: GlobMode; ignoreCase?: boolean } = {}): (rel: string) => boolean {
  const res = expandBraces(pattern).map((p) => toRegExp(p, opts.mode ?? "anchored", opts.ignoreCase ?? false));
  return (rel) => res.some((re) => re.test(rel));
}

export function compileGlobs(patterns: string[], opts: { mode?: GlobMode; ignoreCase?: boolean } = {}): (rel: string) => boolean {
  const tests = patterns.map((p) => compileGlob(p, opts));
  return (rel) => tests.some((t) => t(rel));
}

/** True when a file below the directory could match the anchored pattern, so that a walk may enter the directory. */
export function couldMatchBelow(pattern: string, dirRel: string, ignoreCase = true): boolean {
  const dir = dirRel.split("/").filter(Boolean);
  return expandBraces(pattern.replace(/\\/g, "/")).some((p) => {
    const segs = p.replace(/^\.\//, "").replace(/^\//, "").split("/");
    const walk = (pi: number, di: number): boolean => {
      if (di >= dir.length) return true;
      if (pi >= segs.length) return false;
      if (segs[pi] === "**") return true;
      if (pi === segs.length - 1) return false;
      return compileGlob(segs[pi], { ignoreCase })(dir[di]) && walk(pi + 1, di + 1);
    };
    return walk(0, 0);
  });
}
