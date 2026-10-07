// Run from the repository root with: node --test scripts/public/notices.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, evaluate, render, collectPython } from "./notices.mjs";

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
