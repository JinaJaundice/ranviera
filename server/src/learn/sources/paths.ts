// Path rules and the deny list of docs/CONTRACTS.md ("Limits" and "File tools"). The file tools of Phase 7
// reuse createDenyList, validRelativePath and resolveInRoot, so that one rule serves every reader of the disk.
import fs from "node:fs";
import path from "node:path";
import type { SourceKind } from "../../../../shared/learn/sources.ts";
import { expandHome, isUnder, norm } from "../../util.ts";
import { badRequest, forbiddenPath, notFound } from "./errors.ts";

export { forbiddenPath };

export const MAX_PATH_LENGTH = 1024;

/** True when the text holds a control character (0x00 to 0x1f or 0x7f). */
export function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** The path rule of "Limits": no backslash, colon or control character, and no empty, `.` or `..` segment. */
export function validRelativePath(p: string): boolean {
  if (!p || p.length > MAX_PATH_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\\:\u0000-\u001f\u007f]/.test(p)) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

const DENIED_SEGMENTS = new Set([
  ".ssh", ".aws", ".gnupg", ".docker", ".kube", ".mozilla", "user data", "auth.json", ".credentials.json", ".netrc",
  ".git-credentials", ".npmrc", ".pypirc", ".azure", ".claude.json", ".bash_history", ".zsh_history", "consolehost_history.txt",
]);
const DENIED_SEQUENCES = [
  ["application support", "google", "chrome"],
  ["application support", "firefox"],
  [".config", "gh"],
];
// A Windows 8.3 short name such as SSH~1 or CLAUDE~1.JSO reaches a protected folder under a different text.
const SHORT_NAME = /~\d+(?:\.[^.]*)?$/;
const KEY_STORE = /^(?:.*\.(?:pem|key|p12|pfx|kdbx)|id_rsa.*|id_ed25519.*)$/i;

export interface DenyList {
  /** True when the path names or lies inside something on the deny list. Works on the text of the path only. */
  isDenied(p: string): boolean;
  /** As isDenied, and again on the native real path, so that a symlink or a short name cannot lead into a denied place. */
  isDeniedReal(p: string): boolean;
}

/** The deny list of "File tools". It names the private files of the Cortex data folder through dataDir. */
export function createDenyList(opts: { dataDir: string }): DenyList {
  const dataDir = norm(opts.dataDir);
  const overlay = `${dataDir}/overlay`;
  const identity = `${dataDir}/vault/identity.txt`;
  const authFile = `${dataDir}/auth.json`;
  const sameFile = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

  function isDenied(p: string): boolean {
    const abs = path.resolve(expandHome(p)).replace(/\\/g, "/");
    if (isUnder(abs, overlay) || sameFile(abs, identity) || sameFile(abs, authFile)) return true;
    const segs = abs.toLowerCase().split("/").filter(Boolean);
    for (const s of segs) {
      if (DENIED_SEGMENTS.has(s) || SHORT_NAME.test(s) || s === ".env" || s.startsWith(".env.") || KEY_STORE.test(s)) return true;
    }
    return DENIED_SEQUENCES.some((seq) => {
      for (let i = 0; i + seq.length <= segs.length; i++) if (seq.every((s, j) => segs[i + j] === s)) return true;
      return false;
    });
  }

  function isDeniedReal(p: string): boolean {
    if (isDenied(p)) return true;
    try {
      return isDenied(fs.realpathSync.native(p));
    } catch {
      return false;
    }
  }

  return { isDenied, isDeniedReal };
}

/** Names that a scan ignores because the operating system makes them. */
export function isSystemJunk(name: string): boolean {
  return (
    name === ".DS_Store" ||
    name === "Thumbs.db" ||
    name === "desktop.ini" ||
    name === ".Spotlight-V100" ||
    name === ".Trashes" ||
    name === ".fseventsd" ||
    name === "$RECYCLE.BIN" ||
    name === "System Volume Information" ||
    name.startsWith("._")
  );
}

/** The folders that decide which paths a kind may link. Claude supplies them at merge from the configuration. */
export interface RootEnvironment {
  claudeHome: string;
  projectsRoot: string | null;
  /** the memory folders that this app finds, as absolute paths */
  memoryDirs: () => string[];
  /** the learning folder of this Cortex, which a learnharness root may not name */
  learnDir: string;
  deny: DenyList;
}

const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Checks the path of a new root against the deny list and the rules of its kind.
 * Returns the normalised path and whether it is one file. Throws forbidden_path or bad_request.
 */
export function checkRootPath(env: RootEnvironment, kind: SourceKind, raw: string): { path: string; isFile: boolean } {
  if (typeof raw !== "string" || !raw.trim()) throw badRequest("The path of a linked source must be given.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw badRequest("The path of a linked source holds a control character.");
  const abs = norm(raw.trim());
  if (env.deny.isDenied(abs)) throw forbiddenPath();
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    throw notFound("The folder or file to link does not exist.");
  }
  if (st.isSymbolicLink()) throw badRequest("A linked source may not be a symbolic link. Give the real path.");
  if (env.deny.isDeniedReal(abs)) throw forbiddenPath();
  const isFile = st.isFile();
  if (kind === "pdf") {
    if (!isFile && !st.isDirectory()) throw badRequest("A PDF source must be a folder or one PDF file.");
    if (isFile && !/\.pdf$/i.test(abs)) throw badRequest("A PDF source that names one file must end in .pdf.");
    return { path: abs, isFile };
  }
  if (!st.isDirectory()) throw badRequest("This kind of source must be a folder.");
  switch (kind) {
    case "claude-transcripts": {
      const projects = `${norm(env.claudeHome)}/projects`;
      if (!same(path.posix.dirname(abs), projects)) throw badRequest("A transcript source must be one folder directly under the projects folder of Claude.");
      break;
    }
    case "claude-memory":
      if (!env.memoryDirs().some((d) => same(norm(d), abs))) throw badRequest("A memory source must be one of the memory folders that this app finds.");
      break;
    case "claude-instructions":
      if (!same(abs, norm(env.claudeHome))) throw badRequest("An instructions source must be the Claude folder itself.");
      break;
    case "projects-md":
      if (!env.projectsRoot || !same(abs, norm(env.projectsRoot))) throw badRequest("A Projects source must be the Projects folder named in the configuration.");
      break;
    case "learnharness":
      if (same(abs, norm(env.learnDir))) throw badRequest("The learning folder of this app cannot be imported into itself.");
      if (!fs.existsSync(path.join(abs, "graph")) && !fs.existsSync(path.join(abs, "chats"))) throw badRequest("That folder does not look like a LearnHarness data folder, because it has no graph or chats folder.");
      break;
    default:
      break;
  }
  return { path: abs, isFile: false };
}

/**
 * Resolves a path relative to a root and refuses anything that escapes it, passes through a symlink or lies on the deny list.
 * Returns the absolute path of an existing regular file.
 */
export function resolveInRoot(deny: DenyList, rootPath: string, rel: string, rootIsFile = false): string {
  if (!validRelativePath(rel)) throw badRequest("The path is not valid.");
  const abs = rootIsFile ? rootPath : path.posix.join(rootPath, rel);
  if (!rootIsFile && !isUnder(abs, rootPath)) throw badRequest("The path leaves the linked folder.");
  if (deny.isDenied(abs)) throw forbiddenPath();
  // Every step below the root is checked, because a symlinked folder in the middle would lead out of the root.
  if (!rootIsFile) {
    let cur = rootPath;
    for (const seg of rel.split("/")) {
      cur = path.posix.join(cur, seg);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(cur);
      } catch {
        throw notFound("The file no longer exists.");
      }
      if (st.isSymbolicLink()) throw badRequest("The path passes through a symbolic link.");
    }
  }
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    throw notFound("The file no longer exists.");
  }
  if (!st.isFile()) throw badRequest("The path is not a file.");
  if (deny.isDeniedReal(abs)) throw forbiddenPath();
  return abs;
}
