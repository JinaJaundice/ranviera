// The deny list of CONTRACTS "File tools", as a reference implementation of the
// PathPolicy method isDenied. The linked sources phase exports the shared
// version, and the merge may replace this one with it. The list always applies.
import path from "node:path";

const DENIED_DIRS = new Set([".ssh", ".aws", ".gnupg", ".docker", ".kube", ".mozilla", ".azure"]);
const DENIED_FILES = new Set([
  "auth.json", ".credentials.json", ".netrc", ".env",
  ".git-credentials", ".npmrc", ".pypirc", ".claude.json",
  ".bash_history", ".zsh_history", "consolehost_history.txt",
]);
const KEY_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".kdbx"];
// A Windows 8.3 short name such as SSH~1 or CLAUDE~1.JSO reaches a protected folder under a different text.
const SHORT_NAME = /~\d+(?:\.[^.]*)?$/;

function segmentsOf(p: string): string[] {
  return p.replace(/\\/g, "/").split("/").filter(Boolean).map((s) => s.toLowerCase());
}

function hasSequence(segments: string[], sequence: string[]): boolean {
  for (let i = 0; i + sequence.length <= segments.length; i++) {
    if (sequence.every((s, k) => segments[i + k] === s)) return true;
  }
  return false;
}

/** True when the path names or lies inside a protected location. */
export function isDeniedPath(absPath: string, dataDir?: string): boolean {
  const segments = segmentsOf(absPath);
  for (const s of segments) {
    if (DENIED_DIRS.has(s) || SHORT_NAME.test(s)) return true;
    if (DENIED_FILES.has(s) || s.startsWith(".env.")) return true;
    if (KEY_SUFFIXES.some((k) => s.endsWith(k))) return true;
    if (s.startsWith("id_rsa") || s.startsWith("id_ed25519")) return true;
  }
  if (hasSequence(segments, ["user data"])) return true;
  if (hasSequence(segments, [".config", "gh"])) return true;
  if (hasSequence(segments, ["application support", "google", "chrome"])) return true;
  if (hasSequence(segments, ["application support", "firefox"])) return true;
  if (dataDir) {
    const base = segmentsOf(path.resolve(dataDir));
    const under = (rest: string[]) => base.length + rest.length <= segments.length && [...base, ...rest].every((s, i) => segments[i] === s);
    if (under(["overlay"]) || under(["vault", "identity.txt"]) || under(["auth.json"])) return true;
  }
  return false;
}
