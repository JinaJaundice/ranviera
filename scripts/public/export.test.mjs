// Run from the repository root with: node --test scripts/public/export.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportTree, APACHE_SHA256 } from "./export.mjs";
import { parseDenylist } from "./check.mjs";

const CLIENT = "Zephyr" + "bank";
let tmp, repo;

function put(rel, text) {
  const full = join(repo, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "export-"));
  repo = join(tmp, "repo");
  put("package.json", JSON.stringify({ name: "cortex", private: true, version: "1.2.3", type: "module", description: "private text", scripts: { test: "x" } }));
  put("package-lock.json", JSON.stringify({ name: "cortex", lockfileVersion: 3, packages: { "": { name: "cortex" } } }));
  put("server/src/a.ts", "export const a = 1;\n");
  put("server/node_modules/x/index.js", "skipped\n");
  put("kg/cortex_kg/__pycache__/m.pyc", "skipped");
  put("kg/cortex_kg/m.py", "x = 1\n");
  put("scripts/public/check.mjs", "export {};\n");
  put("scripts/public/export.mjs", "export {};\n");
  put("scripts/public/export.test.mjs", "export {};\n");
  put("harness/CLAUDE.md", "private harness\n");
  put("docs/PRIVATE.md", "private doc\n");
  put("docs/public/ARCHITECTURE.md", "A public document.\n");
  put("public/README.md", "A public readme.\n");
  put("public/.github/workflows/ci.yml", "name: ci\n");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

const base = (extra = {}) => ({ repo, allow: ["package.json", "package-lock.json", "server", "kg/cortex_kg", "scripts/public", "ontology/missing"], skipNotices: true, ...extra });

test("only the allow list, docs/public and public reach the tree", () => {
  const r = exportTree(base({ out: join(tmp, "out1") }));
  assert.ok(existsSync(join(r.out, "server/src/a.ts")));
  assert.ok(existsSync(join(r.out, "docs/ARCHITECTURE.md")));
  assert.ok(existsSync(join(r.out, "README.md")));
  assert.ok(existsSync(join(r.out, ".github/workflows/ci.yml")));
  assert.ok(!existsSync(join(r.out, "harness")));
  assert.ok(!existsSync(join(r.out, "docs/PRIVATE.md")));
  assert.ok(!existsSync(join(r.out, "server/node_modules")));
  assert.ok(!existsSync(join(r.out, "kg/cortex_kg/__pycache__")));
  assert.ok(existsSync(join(r.out, "scripts/public/export.mjs")));
  assert.ok(existsSync(join(r.out, "scripts/public/export.test.mjs")));
  assert.deepEqual(r.missing.map((m) => m.rel), ["ontology/missing"]);
  assert.deepEqual(r.hits, []);
});

test("package.json and the lockfile take the public name and a neutral description", () => {
  const out = join(tmp, "out2");
  exportTree(base({ out }));
  const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
  assert.equal(pkg.name, "ranviera");
  assert.equal(pkg.version, "1.2.3");
  assert.equal(pkg.license, "Apache-2.0");
  assert.doesNotMatch(pkg.description, /private/);
  assert.equal(JSON.parse(readFileSync(join(out, "package-lock.json"), "utf8")).packages[""].name, "ranviera");
});

test("a private term stops the export, names each file and line, and no file is rewritten or dropped", () => {
  put("server/src/leak.ts", `const a = 1;
// agreed for ${CLIENT}
`);
  put("server/src/leak.test.ts", `expect("${CLIENT}");
`);
  const r = exportTree(base({ out: join(tmp, "out3"), denylist: parseDenylist(CLIENT) }));
  assert.equal(r.stopped, true);
  assert.deepEqual(r.hits.map((h) => `${h.file}:${h.line}`).sort(), ["server/src/leak.test.ts:1", "server/src/leak.ts:2"]);
  assert.equal(readFileSync(join(r.out, "server/src/leak.ts"), "utf8").includes(CLIENT), true);
  assert.ok(existsSync(join(r.out, "server/src/leak.test.ts")));
  rmSync(join(repo, "server/src/leak.ts"));
  rmSync(join(repo, "server/src/leak.test.ts"));
});

test("a planted secret in a source file is still reported with its file and line", () => {
  put("server/src/leak2.ts", `const a = 1;
const b = "ghp_${"a".repeat(30)}";
`);
  const r = exportTree(base({ out: join(tmp, "out3b"), denylist: [] }));
  assert.deepEqual(r.hits.map((h) => `${h.file}:${h.line}`), ["server/src/leak2.ts:2"]);
});

test("the export refuses an output folder inside the repository and a folder that is not empty", () => {
  assert.throws(() => exportTree(base({ out: join(repo, "export") })), /outside the repository/);
  const out = join(tmp, "out4");
  exportTree(base({ out }));
  assert.throws(() => exportTree(base({ out })), /not empty/);
});

test("--force moves the earlier export to an archive folder and never deletes it", () => {
  const out = join(tmp, "out5");
  exportTree(base({ out }));
  exportTree(base({ out, force: true }));
  assert.ok(readdirSync(tmp).some((n) => n.startsWith("out5.archive-")));
});

test("the LICENSE check compares the sha-256 of the Apache License 2.0 text", () => {
  assert.match(APACHE_SHA256, /^[0-9a-f]{64}$/);
  const real = join(process.cwd(), "public", "LICENSE");
  if (!existsSync(real)) return;
  mkdirSync(join(repo, "public"), { recursive: true });
  copyFileSync(real, join(repo, "public", "LICENSE"));
  const r = exportTree(base({ out: join(tmp, "out6") }));
  assert.equal(r.licenseOk, true);
  writeFileSync(join(repo, "public", "LICENSE"), "changed");
  assert.equal(exportTree(base({ out: join(tmp, "out7") })).licenseOk, false);
});
