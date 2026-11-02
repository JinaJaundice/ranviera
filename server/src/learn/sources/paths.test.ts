import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SourceError } from "./errors.ts";
import { compileGlob, couldMatchBelow } from "./glob.ts";
import { KIND_DEFAULTS, effectiveGlobs } from "./kinds.ts";
import { checkRootPath, createDenyList, isSystemJunk, resolveInRoot, validRelativePath, type RootEnvironment } from "./paths.ts";
import { tmpDir, trySymlink, write } from "./testkit.ts";

describe("glob", () => {
  it("matches the anchored source globs", () => {
    expect(compileGlob("**/*.md", { ignoreCase: true })("a/b/c.MD")).toBe(true);
    expect(compileGlob("**/*.md")("c.md")).toBe(true);
    expect(compileGlob("*.jsonl")("a/b.jsonl")).toBe(false);
    expect(compileGlob("*.jsonl")("b.jsonl")).toBe(true);
    expect(compileGlob(".obsidian/**")(".obsidian/app.json")).toBe(true);
    expect(compileGlob("skills/**/SKILL.md")("skills/x/y/SKILL.md")).toBe(true);
    expect(compileGlob("*.{md,txt}")("a.txt")).toBe(true);
    expect(compileGlob("?.md")("ab.md")).toBe(false);
  });
  it("applies the file tool rules in tool mode", () => {
    expect(compileGlob("*.ts", { mode: "tool" })("a/b/c.ts")).toBe(true);
    expect(compileGlob("src/*.ts", { mode: "tool" })("x/src/a.ts")).toBe(true);
    expect(compileGlob("src/*.ts", { mode: "tool" })("x/src/y/a.ts")).toBe(false);
    expect(compileGlob("/src/*.ts", { mode: "tool" })("x/src/a.ts")).toBe(false);
    expect(compileGlob("**/a.ts", { mode: "tool" })("a.ts")).toBe(true);
  });
  it("prunes a directory that no include can reach", () => {
    expect(couldMatchBelow("rules/**/*.md", "rules/sub")).toBe(true);
    expect(couldMatchBelow("rules/**/*.md", "projects")).toBe(false);
    expect(couldMatchBelow("*.md", "any")).toBe(false);
    expect(couldMatchBelow("**/*.md", "any/deep")).toBe(true);
  });
  it("keeps the default of each kind", () => {
    expect(effectiveGlobs({ kind: "notes", include: [], exclude: ["drafts/**"] })).toEqual({
      include: KIND_DEFAULTS.notes.include,
      exclude: [...KIND_DEFAULTS.notes.exclude, "drafts/**"],
    });
    expect(effectiveGlobs({ kind: "notes", include: ["a/*.md"], exclude: [] }).include).toEqual(["a/*.md"]);
  });
});

describe("path rule", () => {
  it("accepts plain relative paths", () => {
    expect(validRelativePath("a/b/c.md")).toBe(true);
    expect(validRelativePath("é/ü.md")).toBe(true);
  });
  it.each([
    ["", "empty"],
    ["../x.md", "traversal"],
    ["a/../b.md", "inner traversal"],
    ["a//b.md", "empty segment"],
    ["./a.md", "dot segment"],
    ["/abs.md", "absolute"],
    ["C:/x.md", "drive letter"],
    ["a\\b.md", "backslash"],
    ["a\u0007b.md", "control character"],
    ["a/".repeat(600) + "b.md", "too long"],
  ])("refuses %j (%s)", (p) => {
    expect(validRelativePath(p)).toBe(false);
  });
  it("accepts 1,024 characters and refuses 1,025", () => {
    expect(validRelativePath("a".repeat(1024))).toBe(true);
    expect(validRelativePath("a".repeat(1025))).toBe(false);
  });
});

describe("deny list", () => {
  const deny = createDenyList({ dataDir: "/data/cortex" });
  it.each([
    "/home/u/.ssh/id_rsa",
    "/home/u/.ssh",
    "/home/u/.aws/credentials",
    "/home/u/.gnupg/x",
    "/home/u/.docker/config.json",
    "/home/u/.kube/config",
    "/home/u/project/.env",
    "/home/u/project/.env.local",
    "/home/u/x/auth.json",
    "/home/u/.claude/.credentials.json",
    "/home/u/.netrc",
    "/home/u/AppData/Local/Google/Chrome/User Data/Default/Cookies",
    "/Users/u/Library/Application Support/Google/Chrome/Default",
    "/Users/u/Library/Application Support/Firefox/Profiles",
    "/home/u/.mozilla/firefox",
    "/home/u/keys/server.pem",
    "/home/u/keys/server.KEY",
    "/home/u/keys/a.p12",
    "/home/u/keys/a.pfx",
    "/home/u/vault.kdbx",
    "/home/u/id_rsa.pub",
    "/home/u/id_ed25519",
    "/data/cortex/overlay/private.json",
    "/data/cortex/vault/identity.txt",
    "/data/cortex/auth.json",
  ])("denies %s", (p) => {
    expect(deny.isDenied(p)).toBe(true);
  });
  it.each(["/home/u/notes/a.md", "/home/u/env.md", "/home/u/keyboard/a.md", "/data/cortex/learn/chats/a.json", "/data/cortex/vault/other.txt"])("allows %s", (p) => {
    expect(deny.isDenied(p)).toBe(false);
  });
  it("looks through a link to a denied place", () => {
    const dir = tmpDir();
    const secret = path.posix.join(dir, ".ssh");
    fs.mkdirSync(secret);
    write(secret, "id_rsa", "x");
    const link = path.posix.join(dir, "innocent");
    if (!trySymlink(secret, link, "dir")) return;
    expect(deny.isDenied(link)).toBe(false);
    expect(deny.isDeniedReal(link)).toBe(true);
  });
  const NEW_NAMES = [".git-credentials", ".npmrc", ".pypirc", ".azure", ".claude.json", ".bash_history", ".zsh_history", "ConsoleHost_history.txt"];
  it.each(NEW_NAMES)("denies %s as given", (name) => {
    expect(deny.isDenied(`/home/u/${name}`)).toBe(true);
    expect(deny.isDenied(`/home/u/${name}/inner.txt`)).toBe(true);
  });
  it("denies .config/gh as a sequence and not .config alone", () => {
    expect(deny.isDenied("/home/u/.config/gh/hosts.yml")).toBe(true);
    expect(deny.isDenied("/home/u/.Config/GH")).toBe(true);
    expect(deny.isDenied("/home/u/.config/other/a.md")).toBe(false);
    expect(deny.isDenied("/home/u/gh/a.md")).toBe(false);
  });
  it.each([...NEW_NAMES, ".config/gh"])("looks through a link to %s", (name) => {
    const dir = tmpDir();
    const target = path.posix.join(dir, name);
    const isFile = name.includes("history") || name.endsWith("rc") || name.endsWith(".json") || name.endsWith("credentials");
    if (isFile) write(dir, name, "x");
    else write(target, "inner.txt", "x");
    const link = path.posix.join(dir, "innocent");
    if (!trySymlink(target, link, isFile ? "file" : "dir")) return;
    expect(deny.isDenied(link)).toBe(false);
    expect(deny.isDeniedReal(link)).toBe(true);
  });
  it("names system junk", () => {
    expect([".DS_Store", "Thumbs.db", "._a.md", "desktop.ini"].every(isSystemJunk)).toBe(true);
    expect(isSystemJunk(".obsidian")).toBe(false);
  });
});

describe("checkRootPath", () => {
  const home = tmpDir();
  const claudeHome = `${home}/.claude`;
  const projects = `${home}/Projects`;
  fs.mkdirSync(`${claudeHome}/projects/p1/memory`, { recursive: true });
  fs.writeFileSync(`${claudeHome}/projects/p1/memory/MEMORY.md`, "x");
  fs.mkdirSync(projects, { recursive: true });
  const env: RootEnvironment = {
    claudeHome,
    projectsRoot: projects,
    memoryDirs: () => [`${claudeHome}/projects/p1/memory`],
    learnDir: `${claudeHome}/cortex/learn`,
    deny: createDenyList({ dataDir: `${claudeHome}/cortex` }),
  };
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof SourceError ? `${e.status} ${e.code}` : String(e);
    }
    return "ok";
  };

  it("refuses a root on the deny list with forbidden_path", () => {
    const ssh = `${home}/.ssh`;
    fs.mkdirSync(ssh, { recursive: true });
    expect(code(() => checkRootPath(env, "notes", ssh))).toBe("403 forbidden_path");
    expect(code(() => checkRootPath(env, "notes", `${ssh}/..`))).toBe("ok");
    expect(code(() => checkRootPath(env, "projects-md", `${ssh}/../Projects`))).toBe("ok");
  });
  it("accepts only the paths that the table names for a kind", () => {
    expect(code(() => checkRootPath(env, "claude-transcripts", `${claudeHome}/projects/p1`))).toBe("ok");
    expect(code(() => checkRootPath(env, "claude-transcripts", `${claudeHome}/projects`))).toBe("400 bad_request");
    expect(code(() => checkRootPath(env, "claude-transcripts", projects))).toBe("400 bad_request");
    expect(code(() => checkRootPath(env, "claude-memory", `${claudeHome}/projects/p1/memory`))).toBe("ok");
    expect(code(() => checkRootPath(env, "claude-memory", projects))).toBe("400 bad_request");
    expect(code(() => checkRootPath(env, "claude-instructions", claudeHome))).toBe("ok");
    expect(code(() => checkRootPath(env, "claude-instructions", projects))).toBe("400 bad_request");
    expect(code(() => checkRootPath(env, "projects-md", projects))).toBe("ok");
    expect(code(() => checkRootPath(env, "projects-md", home))).toBe("400 bad_request");
    expect(code(() => checkRootPath(env, "learnharness", home))).toBe("400 bad_request");
  });
  it("accepts one PDF file for the kind pdf and no other file", () => {
    const f = write(home, "a.pdf", "%PDF-");
    expect(checkRootPath(env, "pdf", f).isFile).toBe(true);
    const t = write(home, "a.txt", "x");
    expect(code(() => checkRootPath(env, "pdf", t))).toBe("400 bad_request");
    expect(code(() => checkRootPath(env, "notes", f))).toBe("400 bad_request");
    expect(code(() => checkRootPath(env, "notes", `${home}/missing`))).toBe("404 not_found");
  });
  it("refuses a symlink as a root", () => {
    const real = `${home}/real`;
    fs.mkdirSync(real);
    const link = `${home}/link`;
    if (!trySymlink(real, link, "dir")) return;
    expect(code(() => checkRootPath(env, "notes", link))).toBe("400 bad_request");
  });
});

describe("resolveInRoot", () => {
  const deny = createDenyList({ dataDir: "/data/cortex" });
  it("refuses traversal, a missing file, a directory and a link inside the root", () => {
    const root = tmpDir();
    const outside = tmpDir();
    write(outside, "secret.md", "secret");
    write(root, "a/b.md", "ok");
    expect(resolveInRoot(deny, root, "a/b.md")).toBe(`${root}/a/b.md`);
    const status = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as SourceError).status;
      }
      return 0;
    };
    expect(status(() => resolveInRoot(deny, root, "../x.md"))).toBe(400);
    expect(status(() => resolveInRoot(deny, root, `${path.relative(root, outside).replace(/\\/g, "/")}/secret.md`))).toBe(400);
    expect(status(() => resolveInRoot(deny, root, "a"))).toBe(400);
    expect(status(() => resolveInRoot(deny, root, "gone.md"))).toBe(404);
    if (trySymlink(outside, `${root}/out`, "dir")) expect(status(() => resolveInRoot(deny, root, "out/secret.md"))).toBe(400);
    if (trySymlink(`${outside}/secret.md`, `${root}/l.md`, "file")) expect(status(() => resolveInRoot(deny, root, "l.md"))).toBe(400);
  });
  it("refuses a denied file under the root", () => {
    const root = tmpDir();
    write(root, ".env", "KEY=1");
    expect(() => resolveInRoot(deny, root, ".env")).toThrow(/not available/);
  });
});

describe("8.3 short names", () => {
  const deny = createDenyList({ dataDir: "/data/cortex" });
  it("refuses a short-name segment in the text of a path", () => {
    expect(deny.isDenied("/home/me/SSH~1/config")).toBe(true);
    expect(deny.isDenied("/home/me/CLAUDE~1.JSO")).toBe(true);
    expect(deny.isDenied("/home/me/notes/a~b.md")).toBe(false);
  });
  it("denies a real short-name path to a protected folder", (ctx) => {
    if (process.platform !== "win32") return ctx.skip();
    const root = tmpDir("paths-short-");
    write(root, ".aws/credentials", "secret");
    const out = execFileSync("cmd", ["/c", "dir", "/x", path.normalize(root)], { encoding: "utf8" }).split(String.fromCharCode(13)).join("");
    // A volume that makes no 8.3 names has nothing to test, so the test is skipped there and never counted as a pass.
    const m = /([^ ]+~[0-9]+) +[.]aws *$/im.exec(out);
    if (!m) return ctx.skip();
    const viaShort = path.join(root, m[1], "credentials");
    expect(fs.readFileSync(viaShort, "utf8")).toBe("secret");
    expect(createDenyList({ dataDir: "/data/other" }).isDeniedReal(viaShort)).toBe(true);
  });
});
