// Run from the repository root with: node --test scripts/public/check.test.mjs scripts/public/export.test.mjs scripts/public/notices.test.mjs
// The planted values are built from parts, so that this file passes the check it tests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTree, parseDenylist, buildSeed, writeSeed, denylistPath, SECRET_PATTERNS } from "./check.mjs";

const CLIENT = "Zephyr" + "bank";
const SECRET = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4";
const USER_PATH = "C:/Us" + "ers/" + "mkowal" + "ski" + "/work/app";
const EMAIL = "jdoe" + "@" + "private-example.co.uk";
const DENY = parseDenylist(`# a comment\n${CLIENT}\n\nMSA\n`);

let root, clean, tmp;

function put(base, rel, text) {
  const full = join(base, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "public-check-"));
  root = join(tmp, "dirty");
  clean = join(tmp, "clean");
  put(root, "README.md", `# Notes\n\nThe pricing was agreed with ${CLIENT.toLowerCase()} last year.\n`);
  put(root, "src/config.ts", `const token = "${SECRET}";\n`);
  put(root, "src/paths.ts", `const home = "${USER_PATH}";\n`);
  put(root, "docs/contact.md", `Write to ${EMAIL} for details.\n`);
  put(root, "big/data.txt", "x".repeat(2048));
  put(clean, "README.md", "# Notes\n\nA person installs the app and signs in to Claude Code.\n");
  put(clean, "src/paths.ts", 'const home = "C:/Users/<name>/.claude"; const mac = "/Users/you/.claude"; const l = "/home/runner/work";\n');
  put(clean, "docs/contact.md", "Report a fault to 53195433+someone@users.noreply.github.com or open an issue. Pin pkg@1.2.3.\n");
  put(clean, "src/ok.ts", 'const token = process.env.API_TOKEN; const password = "{{PASSWORD}}";\n');
  put(clean, "web/public/brain/brain.glb", "model");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const kinds = (hits) => new Set(hits.map((h) => h.kind));

test("the dirty fixture fails on a client name, a secret, a user path, an e-mail address and a large file", () => {
  const hits = checkTree(root, { denylist: DENY, maxBytes: 1024 });
  assert.deepEqual([...kinds(hits)].sort(), ["denylist", "email", "secret", "size", "user-path"]);
  const byFile = (kind) => hits.filter((h) => h.kind === kind).map((h) => `${h.file}:${h.line}`);
  assert.deepEqual(byFile("denylist"), ["README.md:3"]);
  assert.deepEqual(byFile("secret"), ["src/config.ts:1"]);
  assert.deepEqual(byFile("user-path"), ["src/paths.ts:1"]);
  assert.deepEqual(byFile("email"), ["docs/contact.md:1"]);
  assert.deepEqual(byFile("size"), ["big/data.txt:0"]);
});

test("a hit names the user of the path and the pattern of the secret, and never the secret itself", () => {
  const hits = checkTree(root, { denylist: DENY, maxBytes: 1024 });
  assert.ok(hits.find((h) => h.kind === "user-path").detail.includes("mkowalski"));
  assert.equal(hits.find((h) => h.kind === "secret").detail, "GitHub token");
  assert.ok(!JSON.stringify(hits).includes(SECRET));
});

test("the clean fixture passes", () => {
  assert.deepEqual(checkTree(clean, { denylist: DENY }), []);
});

test("a file name that holds a private term is a hit", () => {
  const dir = join(tmp, "named");
  put(dir, `notes-${CLIENT}.md`, "Nothing here.\n");
  assert.equal(checkTree(dir, { denylist: DENY }).length, 1);
});

test("the brain model may exceed the limit and any other file may not", () => {
  const dir = join(tmp, "limit");
  put(dir, "web/public/brain/brain.glb", "x".repeat(2048));
  put(dir, "web/public/other.glb", "x".repeat(2048));
  const hits = checkTree(dir, { maxBytes: 1024 });
  assert.deepEqual(hits.map((h) => h.file), ["web/public/other.glb"]);
});

test("a short term is matched with its case and a long term in any case", () => {
  const dir = join(tmp, "case");
  put(dir, "a.md", "The msa clause and the " + "MS" + "A clause.\n");
  put(dir, "b.md", `A visit to ${CLIENT.toUpperCase()} offices.\n`);
  const hits = checkTree(dir, { denylist: DENY });
  assert.deepEqual(hits.map((h) => `${h.file}:${h.line}`).sort(), ["a.md:1", "b.md:1"]);
});

test("every secret pattern compiles and rejects ordinary prose", () => {
  for (const [, re] of SECRET_PATTERNS) assert.equal(re.test("The person signs in to Claude Code in a terminal."), false);
});

test("the seed reads the overlay and the client list, and writes only outside a git working tree", () => {
  const data = join(tmp, "data");
  put(data, "overlay/vocab/people.json", JSON.stringify({ concepts: [{ prefLabel: "Ada Examplar", altLabels: ["Ada E"] }] }));
  put(data, "overlay/assertions/seed.json", JSON.stringify({ assertions: [{ s: "client:acme-holdings", r: "x", t: "project:widgetworks" }] }));
  put(data, "overlay/private_values.json", JSON.stringify({ "{{PRIVATE:00000001}}": "Quillon Hall" }));
  put(data, "overlay/private_terms.json", JSON.stringify(["Brindle Works"]));
  const repo = join(tmp, "repo");
  put(repo, "kg/cortex_kg/privacy.py", 'CLIENT_NAME = re.compile(r"\\b(?:Foo|Bar Bank)\\b", re.I)\n');
  const seed = buildSeed({ dataDir: data, repoRoot: repo, names: ["Jane Q Public"] });
  for (const t of ["Ada Examplar", "Ada E", "acme-holdings", "widgetworks", "Foo", "Bar Bank", "Jane Q Public", "Public", "Quillon Hall", "Brindle Works"]) assert.ok(seed.has(t), t);
  const written = writeSeed({ dataDir: data, names: [], terms: ["Extra"], repoRoot: repo });
  assert.equal(written.file, denylistPath(data));
  assert.ok(readFileSync(written.file, "utf8").includes("Extra"));
  assert.throws(() => writeSeed({ dataDir: data, names: [], terms: [], repoRoot: repo }), /exists/);
  const gitData = join(tmp, "gitdata");
  mkdirSync(join(gitData, ".git"), { recursive: true });
  assert.throws(() => writeSeed({ dataDir: gitData, names: [], terms: [], repoRoot: repo }), /outside a git working tree/);
  assert.ok(!existsSync(denylistPath(gitData)));
});

test("placeholder user names, reserved e-mail domains and marked test secrets pass, and nothing else is lifted", () => {
  const base = join(tmp, "synthetic");
  put(base, "src/a.ts", 'const p = "C:/Users/test/.claude"; const q = "C:/Users/jdoe/x"; const r = "C:/Users/p/y";\n');
  put(base, "docs/b.md", "Write to a.person@mail.test, to person@example.com or to noreply@anthropic.com.\n");
  put(base, "kg/tests/test_scan.py", `"""Tests of the scan.\n\npublic-check: synthetic-secrets\n"""\nBAD = "${SECRET}"\n`);
  put(base, "src/c.ts", `// public-check: synthetic-secrets\nconst t = "${SECRET}";\n`);
  const hits = checkTree(base, { denylist: DENY });
  assert.deepEqual(hits.map((h) => `${h.kind} ${h.file}:${h.line}`), ["secret src/c.ts:2"]);
});
