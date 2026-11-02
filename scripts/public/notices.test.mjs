// Run from the repository root with: node --test scripts/public/notices.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, evaluate, render, collectPython, loadDecisions, mergeDecisions, cleanUrl } from "./notices.mjs";

test("the allowed licences pass in the forms that npm and pip report them", () => {
  for (const l of ["MIT", "ISC", "BSD-3-Clause", "BSD License", "Apache-2.0", "Apache Software License", "0BSD", "Python-2.0", "PSF-2.0", "MPL-2.0", "MIT OR Apache-2.0", "Apache-2.0 OR BSD-2-Clause", "(MIT)*"]) {
    assert.equal(classify("some-package", l).ok, true, l);
  }
});

test("a licence outside the list fails, and so does one that is missing", () => {
  for (const l of ["GPL-3.0", "AGPL-3.0-only", "UNKNOWN", "EUPL-1.2", "CC-BY-NC-4.0", "", undefined]) {
    assert.equal(classify("some-package", l).ok, false, String(l));
  }
});

test("a choice between licences needs one allowed alternative, and a conjunction needs all of them", () => {
  assert.equal(classify("p", "GPL-3.0 OR MIT").ok, true);
  assert.equal(classify("p", "MIT AND GPL-3.0").ok, false);
});

test("a font licence is allowed for a font package only, and CC BY 4.0 for no package", () => {
  assert.equal(classify("@fontsource-variable/inter", "OFL-1.1").ok, true);
  assert.equal(classify("left-pad", "OFL-1.1").ok, false);
  assert.equal(classify("left-pad", "CC-BY-4.0").ok, false);
});

test("the PyInstaller exception is allowed for PyInstaller only", () => {
  assert.equal(classify("pyinstaller", "GPL-2.0-or-later WITH Bootloader-exception").ok, true);
  assert.equal(classify("other", "GPL-2.0-or-later WITH Bootloader-exception").ok, false);
});

test("an accepted decision lets a package through and is shown in the output", () => {
  const pkgs = [{ ecosystem: "pip", name: "somepkg", version: "1", license: "EUPL-1.2", url: "", text: "" }];
  assert.equal(evaluate(pkgs).failures.length, 1);
  const accepted = evaluate(pkgs, { somepkg: "EUPL-1.2" });
  assert.equal(accepted.failures.length, 0);
  assert.match(render([], accepted.rows, "2026-10-06"), /accepted by decision/);
});

test("the notices hold no machine path", () => {
  const md = render([], collectPython(["rdflib"]).map((r) => ({ ...r, ok: true, shown: r.license })), "2026-10-06");
  assert.doesNotMatch(md, /[A-Za-z]:[\\/]+Users/i);
  assert.match(md, /rdflib/);
});

test("the W3C licence of owlrl is on the allow list", () => {
  assert.equal(classify("owlrl", "W3C-20150513").ok, true);
});

test("the committed decisions file records who decided, when and for which build", () => {
  const decisions = loadDecisions();
  for (const name of ["elkjs", "fast-sha256", "robust-predicates"]) {
    const d = decisions[name];
    assert.ok(d, name);
    assert.ok(d.licence && d.decidedBy && d.scope, name);
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/, name);
  }
  assert.equal(decisions.elkjs.licence, "EPL-2.0");
  assert.match(decisions.elkjs.source, /github\.com\/kieler\/elkjs/);
  assert.match(decisions.elkjs.scope, /public/);
});

test("decisions from a file and from flags are merged, and a flag wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "notices-"));
  const file = join(dir, "decisions.json");
  writeFileSync(file, JSON.stringify([{ package: "somepkg", licence: "EUPL-1.2", decidedBy: "the maintainer", date: "2026-11-02", scope: "private and public builds" }]));
  const merged = mergeDecisions(loadDecisions(file), { somepkg: "EUPL-1.2 by flag", other: "Unlicense" });
  assert.equal(merged.somepkg.licence, "EUPL-1.2 by flag");
  const withFlag = mergeDecisions(loadDecisions(), { elkjs: "EPL-2.0" });
  assert.match(withFlag.elkjs.source, /github\.com\/kieler\/elkjs/);
  assert.equal(merged.other, "Unlicense");
  assert.equal(loadDecisions(join(dir, "missing.json")).somepkg, undefined);
  const pkgs = [{ ecosystem: "npm", name: "somepkg", version: "1", license: "EUPL-1.2", url: "", text: "" }];
  assert.equal(evaluate(pkgs, mergeDecisions(loadDecisions(file), {})).failures.length, 0);
});

test("the notices name where the source of an EPL-2.0 package can be obtained", () => {
  const pkgs = [{ ecosystem: "npm", name: "elkjs", version: "0.9.3", license: "EPL-2.0", url: "https://github.com/kieler/elkjs", text: "" }];
  const md = render(evaluate(pkgs, loadDecisions()).rows, [], "2026-11-02");
  assert.match(md, /Source code of packages under the Eclipse Public Licence/);
  assert.match(md, /elkjs 0\.9\.3.*https:\/\/github\.com\/kieler\/elkjs/);
});

test("a repository address loses its git prefix, its git scheme and the user before the host", () => {
  assert.equal(cleanUrl("git://git@example.com/owner/repo"), "https://example.com/owner/repo");
  assert.equal(cleanUrl("git+https://someone@example.com/owner/repo.git"), "https://example.com/owner/repo");
  assert.equal(cleanUrl("https://github.com/a/b"), "https://github.com/a/b");
  assert.equal(cleanUrl(undefined), "");
});
