import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ProviderClass } from "../../../../../shared/learn/index.ts";
import type { PathPolicy } from "../deps.ts";
import { loadPhoton } from "../../images/resize-core.ts";
import { tmpDir } from "../support.ts";
import type { AnyTool } from "./define.ts";
import { isDeniedPath } from "./deny.ts";
import { FIND_LIMIT, GREP_LIMIT, LS_LIMIT, OUTPUT_LIMIT_BYTES, READ_FILE_LIMIT_BYTES, createFileTools, globMatcher, resolveToolPath, type FileToolDeps } from "./files.ts";

let base: string;
let home: string;
let dataDir: string;
let linked: string;
let second: string;

const w = (rel: string, body: string | Buffer = "x") => {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

beforeAll(() => {
  base = tmpDir("learn-files-");
  home = path.join(base, "home");
  dataDir = path.join(home, "cortex-data");
  linked = path.join(home, "projects", "linked");
  second = path.join(home, "projects", "second");
  w("home/notes/lecture-3.md", "# Lecture 3\nBond duration is the weighted average time to cash flows.\nSecond line\n");
  w("home/notes/other.txt", "nothing here");
  w("home/.ssh/id_rsa", "PRIVATE KEY MATERIAL");
  w("home/.env", "TOKEN=abc");
  w("home/.env.local", "TOKEN=def");
  w("home/cortex-data/auth.json", "{}");
  w("home/cortex-data/overlay/private.md", "client");
  w("home/cortex-data/vault/identity.txt", "AGE-SECRET");
  w("home/certs/server.pem", "pem");
  w("home/node_modules/pkg/inside.md", "hidden by the walk");
  w("home/projects/linked/readme.md", "linked readme\nbond duration appears here\n");
  w("home/projects/linked/sub/deep.md", "deep file about bond duration");
  w("home/projects/second/two.md", "second root");
  w("outside/secret.txt", "outside the linked roots");
});

const policy = (roots: string[]): PathPolicy => ({
  isDenied: (p) => isDeniedPath(p, dataDir),
  allowedRoots: () => roots.map((r, i) => ({ id: `root_${i}`, label: path.basename(r), path: r.replace(/\\/g, "/"), kind: "notes", sensitivity: "internal" as const })),
});

/** Strips the untrusted content delimiter, so the cases below read the file text itself. The delimiter has its own test. */
function unwrapFile(t: string): string {
  const lines = t.split("\n");
  const open = lines.findIndex((l) => l.startsWith("<<<UNTRUSTED FILE CONTENT "));
  const close = lines.findLastIndex((l) => l.startsWith("<<<END UNTRUSTED FILE CONTENT "));
  return open < 0 || close < open ? t : [...lines.slice(0, open), ...lines.slice(open + 1, close), ...lines.slice(close + 1)].join("\n");
}

function tools(cls: ProviderClass, roots: string[] = [linked], extra: Partial<FileToolDeps> = {}) {
  const list = createFileTools({ providerClass: cls, policy: policy(roots), homeDir: home, ...extra });
  const by = (name: string) => list.find((t) => t.name === name) as AnyTool;
  const run = async (name: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    const out = await by(name).execute("id", params as never, signal);
    const t = unwrapFile(out.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n"));
    return { text: t, isError: !!out.isError, raw: out };
  };
  return { run };
}

describe("scope", () => {
  for (const cls of ["claude-code", "local"] as const) {
    it(`reaches the home folder for ${cls}, so lecture notes are found with no path (D8)`, async () => {
      const { run } = tools(cls);
      const found = await run("find", { pattern: "lecture*" });
      expect(found.text).toContain("notes/lecture-3.md");
      const read = await run("read", { path: "notes/lecture-3.md" });
      expect(read.text).toContain("Bond duration");
      expect((await run("read", { path: "~/notes/other.txt" })).text).toBe("nothing here");
      expect((await run("read", { path: path.join(home, "outside", "x") })).isError).toBe(true);
      const abs = await run("read", { path: path.join(base, "outside", "secret.txt").replace(/\\/g, "/") });
      expect(abs.text).toContain("outside the linked roots");
      expect((await run("ls", {})).text).toContain("notes/");
    });
  }

  it("keeps a hosted session inside the linked roots", async () => {
    const { run } = tools("hosted");
    const outside = path.join(base, "outside", "secret.txt");
    for (const p of [outside, path.join(home, "notes", "other.txt"), "~/notes/other.txt", "../../../outside/secret.txt", "..\\..\\x", "/etc/hosts", "C:/Windows/win.ini"]) {
      const r = await run("read", { path: p });
      expect(r.isError, p).toBe(true);
      expect(r.text, p).not.toContain("outside the linked roots\n");
      expect(r.text, p).not.toContain("nothing here");
    }
    expect((await run("ls", { path: home })).isError).toBe(true);
    expect((await run("find", { pattern: "*.txt", path: path.join(base, "outside") })).isError).toBe(true);
    expect((await run("grep", { pattern: "secret", path: path.join(base, "outside") })).isError).toBe(true);
  });

  it("resolves a relative path against the only allowed root", async () => {
    const { run } = tools("hosted");
    expect((await run("read", { path: "readme.md" })).text).toContain("linked readme");
    expect((await run("ls", {})).text).toContain("sub/");
    expect((await run("read", { path: path.join(linked, "sub", "deep.md") })).text).toContain("deep file");
    expect((await run("read", { path: "sub/../../second/two.md" })).isError).toBe(true);
  });

  it("refuses a relative path with a list of the roots when there are several", async () => {
    const { run } = tools("hosted", [linked, second]);
    const r = await run("read", { path: "readme.md" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("linked");
    expect(r.text).toContain("second");
    expect((await run("read", { path: path.join(second, "two.md") })).text).toBe("second root");
  });

  it("refuses everything for a hosted model when no root is allowed", async () => {
    const { run } = tools("hosted", []);
    const r = await run("ls", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("No linked source");
  });

  it("does not follow a symlink out of a root", async () => {
    const link = path.join(linked, "escape");
    try {
      fs.symlinkSync(path.join(base, "outside"), link, "junction");
    } catch {
      return;
    }
    const { run } = tools("hosted");
    const r = await run("read", { path: path.join(link, "secret.txt") });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("outside the linked roots\n");
    const walked = await run("find", { pattern: "secret*" });
    expect(walked.text).not.toContain("secret.txt");
    fs.rmSync(link, { recursive: true, force: true });
  });

  it("rejects a control character in a path", () => {
    const r = resolveToolPath("a\u0000b", { providerClass: "local", policy: policy([]), homeDir: home });
    expect(r.ok).toBe(false);
  });
});

describe("deny list", () => {
  const protectedPaths = [
    ".ssh/id_rsa",
    ".env",
    ".env.local",
    "cortex-data/auth.json",
    "cortex-data/overlay/private.md",
    "cortex-data/vault/identity.txt",
    "certs/server.pem",
  ];
  for (const cls of ["claude-code", "local"] as const) {
    it(`refuses protected paths for ${cls} and does not name the rule`, async () => {
      const { run } = tools(cls);
      for (const p of protectedPaths) {
        const r = await run("read", { path: p });
        expect(r.isError, p).toBe(true);
        expect(r.text, p).toBe("That path is not available.");
        expect(r.text).not.toMatch(/ssh|env|deny|rule/i);
      }
      expect((await run("ls", { path: ".ssh" })).text).toBe("That path is not available.");
      expect((await run("grep", { pattern: "PRIVATE", path: ".ssh" })).text).toBe("That path is not available.");
    });
  }

  it("never lists or searches a denied name", async () => {
    const { run } = tools("claude-code");
    const listing = (await run("ls", {})).text;
    expect(listing).not.toContain(".ssh");
    expect(listing).not.toContain(".env");
    expect(listing).toContain("notes/");
    const found = (await run("find", { pattern: "*" })).text;
    expect(found).not.toMatch(/id_rsa|\.env|auth\.json|server\.pem|identity\.txt|private\.md/);
    const hits = (await run("grep", { pattern: "PRIVATE|TOKEN|AGE-SECRET|client" })).text;
    expect(hits).toBe("No match was found.");
  });

  it("covers the names of the contract", () => {
    for (const p of [
      "/h/.aws/credentials",
      "/h/.gnupg/x",
      "/h/.docker/config.json",
      "/h/.kube/config",
      "/h/.netrc",
      "/h/.credentials.json",
      "/h/key.p12",
      "/h/key.pfx",
      "/h/db.kdbx",
      "/h/x/id_ed25519",
      "/h/id_rsa.pub",
      "/h/AppData/Local/Google/Chrome/User Data/Default/Cookies",
      "/Users/me/Library/Application Support/Google/Chrome/Default/x",
      "/Users/me/Library/Application Support/Firefox/Profiles/x",
      "/h/.mozilla/firefox/x",
      "/h/x.key",
    ]) {
      expect(isDeniedPath(p), p).toBe(true);
    }
    expect(isDeniedPath("/h/notes/environment.md")).toBe(false);
    expect(isDeniedPath("/h/notes/keyboard.md")).toBe(false);
  });
  it("refuses the credential and history names, as given and through a link", () => {
    const names = [".git-credentials", ".npmrc", ".pypirc", ".azure", ".claude.json", ".bash_history", ".zsh_history", "ConsoleHost_history.txt", ".config/gh"];
    for (const n of names) {
      expect(isDeniedPath(`/h/${n}`), n).toBe(true);
      expect(isDeniedPath(`C:\\Users\\me\\${n.replace("/", "\\")}\\x`), n).toBe(true);
    }
    expect(isDeniedPath("/h/.config/other/a.md")).toBe(false);
    for (const n of names) {
      const root = tmpDir();
      const target = path.join(root, ...n.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const isFile = /history|rc$|\.json$|credentials$/.test(n);
      if (isFile) fs.writeFileSync(target, "x");
      else fs.mkdirSync(target);
      const link = path.join(root, "innocent");
      try {
        fs.symlinkSync(target, link, isFile ? "file" : "junction");
      } catch {
        continue;
      }
      expect(isDeniedPath(link), n).toBe(false);
      expect(isDeniedPath(fs.realpathSync.native(link)), n).toBe(true);
    }
  });
});

describe("walks", () => {
  it("skips node_modules in a walk and allows an explicit path into it", async () => {
    const { run } = tools("claude-code");
    expect((await run("find", { pattern: "inside.md" })).text).toBe("No file matched the pattern.");
    expect((await run("find", { pattern: "inside.md", path: "node_modules" })).text).toBe("pkg/inside.md");
    expect((await run("read", { path: "node_modules/pkg/inside.md" })).text).toBe("hidden by the walk");
  });

  it("stops at the deadline with a partial result", async () => {
    let t = 0;
    const { run } = tools("claude-code", [linked], { now: () => (t += 4000), walkDeadlineMs: 10_000 });
    const r = await run("find", { pattern: "*.md" });
    expect(r.text).toContain("time limit");
  });

  it("stops on abort with a partial result and no throw", async () => {
    const ac = new AbortController();
    ac.abort();
    const { run } = tools("claude-code");
    const r = await run("find", { pattern: "*.md" }, ac.signal);
    expect(r.text).toContain("stopped");
    expect(r.isError).toBe(false);
  });
});

describe("glob rules", () => {
  it("matches the base name at any depth for a pattern with no slash", () => {
    const m = globMatcher("*.md");
    expect(m("a.md")).toBe(true);
    expect(m("x/y/a.md")).toBe(true);
    expect(m("a.txt")).toBe(false);
  });
  it("keeps a star in one segment and lets two stars cross", () => {
    expect(globMatcher("src/*.ts")("src/a.ts")).toBe(true);
    expect(globMatcher("src/*.ts")("src/x/a.ts")).toBe(false);
    expect(globMatcher("src/**/*.ts")("src/x/y/a.ts")).toBe(true);
    expect(globMatcher("src/**/*.ts")("src/a.ts")).toBe(true);
    expect(globMatcher("a?c")("abc")).toBe(true);
    expect(globMatcher("a?c")("a/c")).toBe(false);
  });
  it("implies a deep prefix unless the pattern is anchored", () => {
    expect(globMatcher("docs/a.md")("x/docs/a.md")).toBe(true);
    expect(globMatcher("/docs/a.md")("x/docs/a.md")).toBe(false);
    expect(globMatcher("/docs/a.md")("docs/a.md")).toBe(true);
  });
  it("expands one level of braces", () => {
    const m = globMatcher("*.{ts,tsx}");
    expect(m("a.ts")).toBe(true);
    expect(m("a.tsx")).toBe(true);
    expect(m("a.js")).toBe(false);
  });
});

describe("output caps", () => {
  it("lists at most 500 entries, sorted without regard to case, with a notice", async () => {
    for (let i = 0; i < LS_LIMIT + 50; i++) w(`home/big/f${String(i).padStart(4, "0")}.txt`);
    w("home/big/Alpha.txt");
    w("home/big/zeta/keep.txt");
    const { run } = tools("claude-code");
    const r = await run("ls", { path: "big" });
    const lines = r.text.split("\n").filter((l) => l && !l.startsWith("["));
    expect(lines).toHaveLength(LS_LIMIT);
    expect(lines[0]).toBe("Alpha.txt");
    expect(r.text).toContain(`Showing ${LS_LIMIT} of ${LS_LIMIT + 52} entries`);
    expect((await run("ls", { path: "big/zeta" })).text).toBe("keep.txt");
    expect((await run("ls", { path: "home/none" })).isError).toBe(true);
    expect((await run("ls", { path: "notes/other.txt" })).isError).toBe(true);
  });

  it("marks folders with a trailing slash and includes dotfiles", async () => {
    w("home/dots/.hidden", "x");
    w("home/dots/folder/a", "x");
    const { run } = tools("local");
    expect((await run("ls", { path: "dots" })).text).toBe(".hidden\nfolder/");
  });

  it("stops find at 1,000 entries", async () => {
    for (let i = 0; i < FIND_LIMIT + 20; i++) w(`home/many/m${i}.dat`);
    const { run } = tools("claude-code");
    const r = await run("find", { pattern: "*.dat", path: "many" });
    expect(r.text.split("\n").filter((l) => l.endsWith(".dat"))).toHaveLength(FIND_LIMIT);
    expect(r.text).toContain(`Stopped at ${FIND_LIMIT} entries`);
  });

  it("stops grep at 100 matches, cuts a long line at 500 characters and skips large and binary files", async () => {
    w("home/g/many.txt", Array.from({ length: GREP_LIMIT + 40 }, (_, i) => `hit ${i}`).join("\n"));
    w("home/g/long.txt", `needle ${"y".repeat(900)}`);
    w("home/g/bin.dat", Buffer.concat([Buffer.from("needle"), Buffer.from([0]), Buffer.from("needle")]));
    w("home/g/huge.txt", `needle ${"z".repeat(2 * 1024 * 1024 + 10)}`);
    const { run } = tools("claude-code");
    const hits = await run("grep", { pattern: "hit", path: "g" });
    expect(hits.text.split("\n").filter((l) => l.startsWith("many.txt:"))).toHaveLength(GREP_LIMIT);
    expect(hits.text).toContain(`Stopped at ${GREP_LIMIT} matches`);
    const needle = await run("grep", { pattern: "needle", path: "g" });
    const longLine = needle.text.split("\n").find((l) => l.startsWith("long.txt:"))!;
    expect(longLine).toContain("… [truncated]");
    expect(longLine.length).toBeLessThan(540);
    expect(needle.text).not.toContain("bin.dat");
    expect(needle.text).not.toContain("huge.txt");
    expect(needle.text).toContain("2 files were skipped");
  });

  it("supports a literal, ignoreCase, a glob and context lines", async () => {
    const { run } = tools("claude-code");
    const lit = await run("grep", { pattern: "(duration)", literal: true, path: "notes" });
    expect(lit.text).toBe("No match was found.");
    const ci = await run("grep", { pattern: "BOND DURATION", ignoreCase: true, path: "notes", glob: "*.md", context: 1 });
    expect(ci.text).toContain("lecture-3.md:2: Bond duration");
    expect(ci.text).toContain("lecture-3.md-1- # Lecture 3");
    expect(ci.text).toContain("lecture-3.md-3- Second line");
    const bad = await run("grep", { pattern: "(", path: "notes" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("literal");
  });

  it("limits read to 2,000 lines and names the offset to continue from", async () => {
    w("home/r/long.txt", Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"));
    const { run } = tools("claude-code");
    const first = await run("read", { path: "r/long.txt" });
    expect(first.text).toContain("line 2000");
    expect(first.text).not.toContain("line 2001\n");
    expect(first.text).toContain("Use offset 2001 to continue");
    const next = await run("read", { path: "r/long.txt", offset: 2001 });
    expect(next.text.startsWith("line 2001")).toBe(true);
    expect(next.text).not.toContain("to continue");
    const part = await run("read", { path: "r/long.txt", offset: 10, limit: 2 });
    expect(part.text.startsWith("line 10\nline 11")).toBe(true);
    expect(part.text).toContain("Use offset 12");
    const past = await run("read", { path: "r/long.txt", offset: 5000 });
    expect(past.isError).toBe(true);
    expect(past.text).toContain("2500");
  });

  it("cuts read output at 50 KB on whole lines", async () => {
    w("home/r/wide.txt", Array.from({ length: 400 }, (_, i) => `${i}:${"w".repeat(200)}`).join("\n"));
    const { run } = tools("claude-code");
    const r = await run("read", { path: "r/wide.txt" });
    const body = r.text.split("\n\n[")[0];
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(OUTPUT_LIMIT_BYTES);
    expect(body.split("\n").every((l) => /^\d+:w{200}$/.test(l))).toBe(true);
    expect(r.text).toContain("to continue");
  });

  it("returns an image as an image part, with a note when the model takes no images", async () => {
    w("home/img/pixel.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const yes = await tools("claude-code").run("read", { path: "img/pixel.png" });
    expect(yes.raw.content.some((c) => c.type === "image")).toBe(true);
    const no = await tools("claude-code", [linked], { imageInput: false }).run("read", { path: "img/pixel.png" });
    expect(no.text).toContain("does not take images");
  });

  it("finds an image by its bytes under a text name, applies the model limits, and omits a corrupt image without the raw bytes", async () => {
    const photon = loadPhoton();
    const img = new photon.PhotonImage(new Uint8Array(4 * 4 * 4).fill(120), 4, 4);
    const png = Buffer.from(img.get_bytes());
    img.free();
    w("home/img/shot.txt", png);
    const small = await tools("claude-code", [linked], { imageLimits: { maxWidth: 2, maxHeight: 2 } }).run("read", { path: "img/shot.txt" });
    expect(small.raw.content.some((c) => c.type === "image")).toBe(true);
    expect(small.text).toContain("displayed at 2x2");
    w("home/img/cut.png", png.subarray(0, 40));
    const cut = await tools("claude-code").run("read", { path: "img/cut.png" });
    expect(cut.raw.content.some((c) => c.type === "image")).toBe(false);
    expect(cut.text).toContain("Image omitted");
  });

  it("returns a message that names the next step for a missing path and a folder", async () => {
    const { run } = tools("claude-code");
    expect((await run("read", { path: "nope.md" })).text).toContain("find");
    expect((await run("read", { path: "notes" })).text).toContain("ls");
  });
});

// Windows gives most folders an 8.3 short name such as SSH~1, which reaches the same files.
function shortNameOf(dir: string, longName: string): string | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("cmd", ["/c", "dir", "/x", path.normalize(dir)], { encoding: "utf8" });
    const m = new RegExp("(\\S+~\\d+)\\s+" + longName.split(".").join("\\.") + "\\s*$", "im").exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

describe("8.3 short names", () => {
  // a policy that reads the text of the path only, as the shared deny list does
  const textOnly: PathPolicy = {
    isDenied: (p) => p.split("\\").join("/").toLowerCase().split("/").includes(".aws"),
    allowedRoots: () => [],
  };

  it("refuses a segment of the form NAME~digits before any lookup", async () => {
    for (const cls of ["claude-code", "local"] as const) {
      const { run } = tools(cls);
      for (const p of [path.join(home, "AWS~1", "credentials"), path.join(home, "notes", "LECTUR~1.MD"), `~/SSH~1/config`]) {
        const r = await run("read", { path: p });
        expect(r.isError, p).toBe(true);
        expect(r.text, p).toBe("That path is not available.");
      }
    }
    expect(isDeniedPath("/h/SSH~1/config")).toBe(true);
    expect(isDeniedPath("/h/CLAUDE~1.JSO")).toBe(true);
    expect(isDeniedPath("/h/notes/a~b.md")).toBe(false);
  });

  it("denies the real path of a short name even when the policy reads only the text", async () => {
    w("home/.aws/credentials", "aws_secret_access_key=abc");
    const short = shortNameOf(home, ".aws");
    if (!short) return;
    const target = path.join(home, short, "credentials");
    expect(fs.readFileSync(target, "utf8")).toContain("aws_secret");
    // the tilde rule is not what refuses it here, so the policy must see the native real path
    const list = createFileTools({ providerClass: "local", policy: textOnly, homeDir: home });
    const read = list.find((t) => t.name === "read") as AnyTool;
    const out = await read.execute("id", { path: target } as never);
    const t = out.content.map((c) => (c as { text: string }).text).join("\n");
    expect(t).toBe("That path is not available.");
  });
});

describe("read size", () => {
  it("refuses a text file over the ceiling with a clear message", async () => {
    w("home/big/dump.log", Buffer.alloc(READ_FILE_LIMIT_BYTES + 1, "a"));
    const { run } = tools("claude-code");
    const r = await run("read", { path: "big/dump.log" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/larger than 10 MiB/);
    expect(r.text).toMatch(/grep/);
  });

  it("still reads a file just under the ceiling", async () => {
    w("home/big/ok.log", `${"b".repeat(100)}\n`.repeat(1000));
    const { run } = tools("claude-code");
    const r = await run("read", { path: "big/ok.log", limit: 3 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("[Showing lines 1 to 3 of 1000.");
  });
});

describe("grep deadline", () => {
  it("stops a catastrophic pattern at the deadline", async () => {
    w("home/redos/a.txt", `${"a".repeat(34)}!\n`);
    const { run } = tools("claude-code", [linked], { walkDeadlineMs: 300 });
    const started = Date.now();
    const r = await run("grep", { pattern: "(a+)+$", path: "redos" });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("time limit");
  });

  it("still finds ordinary matches through the worker", async () => {
    const { run } = tools("claude-code");
    const r = await run("grep", { pattern: "bond duration", path: "projects/linked", ignoreCase: true, context: 1 });
    expect(r.text).toContain("readme.md:2:");
    expect(r.text).toContain("deep.md:1:");
  });
});
