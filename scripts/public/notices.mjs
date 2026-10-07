// Generates THIRD_PARTY_NOTICES.md from the licences of the installed packages and fails on a licence outside the
// allow list of docs/DISTRIBUTION.md.
//
// Usage: node scripts/public/notices.mjs [--out <file>] [--root <repository>] [--check] [--accept <package>=<licence>]...
//   --check   reports the licences and writes nothing
//   --accept  records a decision about one package whose licence is outside the list, for example one that the
//             owner of the repository has reviewed. The accepted package is named in the output with the words 'accepted by decision'.
// npm packages come from license-checker-rseidelsohn (production dependencies of the root package). Python packages
// come from pip-licenses, for the packages that the compiler bundles and everything they require.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");

// The packages that the PyInstaller spec of the compiler collects. Their requirements are added at run time.
export const COMPILER_PACKAGES = ["rdflib", "pyshacl", "owlrl", "nemo_python", "pyrage", "prettytable", "packaging"];

// Licences whose declared form differs from one tool to the next. Each entry has the pattern of the declared form,
// the name used in the output and, where the licence applies to one kind of package only, the packages it covers.
const ALLOWED = [
  { re: /^(MIT|MIT License|The MIT License|MIT-0)$/i, name: "MIT" },
  { re: /^ISC( License)?$/i, name: "ISC" },
  { re: /^(BSD|BSD License|BSD-[0-9]-Clause.*|[0-9]-Clause BSD.*|New BSD License)$/i, name: "BSD" },
  { re: /^(Apache-2\.0|Apache Software License|Apache License,? (Version )?2\.0|Apache 2\.0)$/i, name: "Apache-2.0" },
  { re: /^0BSD$/i, name: "0BSD" },
  { re: /^(Python-2\.0|PSF(-2\.0)?|Python Software Foundation License)$/i, name: "Python-2.0 or PSF" },
  { re: /^(MPL-2\.0|Mozilla Public License 2\.0.*)$/i, name: "MPL-2.0 (file-level terms, files used unmodified)" },
  { re: /^W3C(-20150513)?( Software (and|and Document) License)?$/i, name: "W3C-20150513 (permissive W3C Software and Document Licence)" },
  { re: /^CC-BY-4\.0$/i, name: "CC-BY-4.0 (data only)", only: /^$/ },
  { re: /^(OFL-1\.1|SIL OFL 1\.1|SIL Open Font License.*)$/i, name: "OFL-1.1 (fonts only)", only: /^@fontsource/ },
];

// The licence of a package whose metadata does not state one, taken from the upstream repository.
export const DECLARED = {
  "nemo-python": { license: "MIT OR Apache-2.0", source: "the upstream repository (knowsys/nemo), because the wheel carries no licence metadata" },
};

export const PYINSTALLER_NOTE =
  "The compiler executable is built with PyInstaller, which is licensed under GPL-2.0-or-later with an exception " +
  "that allows a program built with it to be distributed under any licence. PyInstaller is a build tool and no part " +
  "of it other than its bootloader is included in the executable.";

export const ELECTRON_NOTE =
  "The installers contain Electron, which is licensed under MIT, and the Chromium and Node.js code inside it, which " +
  "carry their own licences. Electron ships them in the files LICENSE and LICENSES.chromium.html in the application folder.";

const PYINSTALLER = /^pyinstaller(-hooks-contrib)?$/i;

/** Splits a licence expression into alternatives (OR), each a list of terms that all apply (AND). */
function parseExpression(expr) {
  const clean = String(expr ?? "").replace(/[()*]/g, "").trim();
  return clean.split(/\s+OR\s+/i).map((alt) => alt.split(/\s+AND\s+/i).map((t) => t.trim()).filter(Boolean));
}

/** Whether a package may be shipped under the licence. Returns { ok, name, reason }. */
export function classify(pkg, expr) {
  if (PYINSTALLER.test(pkg) && /GPL/i.test(String(expr))) return { ok: true, name: "GPL-2.0-or-later with the PyInstaller exception" };
  const alternatives = parseExpression(expr);
  const outcomes = alternatives.map((terms) => {
    const names = [];
    for (const t of terms) {
      const rule = ALLOWED.find((a) => a.re.test(t));
      if (!rule) return { ok: false, reason: `the licence '${t}' is not on the allow list` };
      if (rule.only && !rule.only.test(pkg)) return { ok: false, reason: `the licence '${t}' is allowed for ${rule.name.split("(")[1]?.replace(")", "") ?? "one kind of package"} and ${pkg} is not one` };
      names.push(rule.name);
    }
    return { ok: terms.length > 0, name: names.join(" and "), reason: "no licence is stated" };
  });
  const good = outcomes.find((o) => o.ok);
  return good ? { ok: true, name: good.name } : { ok: false, name: String(expr ?? "UNKNOWN"), reason: outcomes[0]?.reason ?? "no licence is stated" };
}

// ---------------------------------------------------------------- collecting

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function collectNpm(root) {
  const script = join(root, "node_modules", "license-checker-rseidelsohn", "bin", "license-checker-rseidelsohn.js");
  if (!existsSync(script)) throw new Error("license-checker-rseidelsohn is not installed. Run npm install first.");
  const out = run(process.execPath, [script, "--production", "--json", "--excludePrivatePackages", "--start", root]);
  const data = JSON.parse(out);
  return Object.entries(data)
    .map(([key, v]) => {
      const at = key.lastIndexOf("@");
      const text = v.licenseFile && existsSync(v.licenseFile) ? readFileSync(v.licenseFile, "utf8") : "";
      return { ecosystem: "npm", name: key.slice(0, at), version: key.slice(at + 1), license: Array.isArray(v.licenses) ? v.licenses.join(" AND ") : String(v.licenses ?? "UNKNOWN"), url: v.repository ?? "", text: isLicenceText(v.licenseFile, text) ? text : "" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// license-checker falls back to a README when a package has no licence file, and a README is not a licence text.
function isLicenceText(file, text) {
  return Boolean(file) && /licen[cs]e|copying|notice/i.test(String(file).split(/[\\/]/).pop() ?? "") && text.trim().length > 0;
}

const PY_CLOSURE = `
import json, re, sys
from importlib.metadata import distribution, requires, PackageNotFoundError
seen, todo = {}, list(json.loads(sys.argv[1]))
while todo:
    n = todo.pop()
    k = re.sub(r"[-_.]+", "-", n).lower()
    if k in seen:
        continue
    try:
        d = distribution(n)
    except PackageNotFoundError:
        continue
    seen[k] = d.metadata["Name"]
    for r in requires(n) or []:
        if "extra ==" in r:
            continue
        todo.append(re.split(r"[ ;<>=!~\\[(]", r)[0])
print(json.dumps(sorted(seen.values())))
`;

export function collectPython(packages = COMPILER_PACKAGES, python = process.platform === "win32" ? "python" : "python3") {
  const names = JSON.parse(run(python, ["-c", PY_CLOSURE, JSON.stringify(packages)]));
  const args = ["-m", "piplicenses", "--packages", ...names, "--with-system", "--format=json", "--with-urls", "--with-license-file", "--no-license-path"];
  const data = JSON.parse(run(python, args));
  return data
    .map((p) => {
      const declared = DECLARED[String(p.Name).toLowerCase()];
      let license = p.License;
      let text = String(p.LicenseText ?? "").trim() === "UNKNOWN" ? "" : String(p.LicenseText ?? "");
      if (/^UNKNOWN$/i.test(license) && declared) license = declared.license;
      else if (/^UNKNOWN$/i.test(license) && /^\s*The MIT License|^\s*MIT License/i.test(text)) license = "MIT";
      return { ecosystem: "pip", name: p.Name, version: p.Version, license, url: p.URL === "UNKNOWN" ? "" : p.URL, text, declared: declared && license === declared.license ? declared.source : "" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- output

export function evaluate(packages, accepted = {}) {
  const rows = packages.map((p) => {
    const c = classify(p.name, p.license);
    const decision = accepted[p.name];
    return { ...p, ok: c.ok || Boolean(decision), shown: c.ok ? c.name : decision ? `${decision} (accepted by decision)` : p.license, reason: c.reason };
  });
  return { rows, failures: rows.filter((r) => !r.ok) };
}

const tableRows = (rows) => rows.map((r) => `| ${r.name} | ${r.version} | ${r.shown} | ${r.url || "not stated"} |`).join("\n");

export function render(npmRows, pipRows, generated) {
  const texts = [...npmRows, ...pipRows].filter((r) => r.text.trim());
  const lines = [
    "# Third-party notices",
    "",
    `This file lists the third-party packages that the application contains or needs when it runs, with the licence of each. It was generated on ${generated} by \`scripts/public/notices.mjs\` from the lockfile and the installed Python packages, and CI checks it for a licence outside the allow list (MIT, ISC, BSD, Apache-2.0, 0BSD, Python-2.0, PSF, MPL-2.0 for files only, CC-BY-4.0 for data and OFL-1.1 for fonts and W3C-20150513 for the owlrl package).`,
    "",
    "## Packages of the web app and the server (npm)",
    "",
    "| Package | Version | Licence | Source |",
    "|---|---|---|---|",
    tableRows(npmRows),
    "",
    "## Packages of the compiler (Python)",
    "",
    "| Package | Version | Licence | Source |",
    "|---|---|---|---|",
    tableRows(pipRows),
    "",
  ];
  const declared = pipRows.filter((r) => r.declared);
  if (declared.length) lines.push(...declared.map((r) => `The wheel of ${r.name} carries no licence metadata, so its licence is taken from ${r.declared}.`), "");
  lines.push("## Tools that are bundled or used to build", "", ELECTRON_NOTE, "", PYINSTALLER_NOTE, "");
  lines.push("## Brain model and fonts", "", "The brain model and the fonts have their own notices in the file `NOTICE`.", "", "## Licence texts", "");
  // An e-mail address in a copyright line is masked, because the public content check rejects any address.
  const mask = (s) => s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[e-mail address removed]");
  for (const r of texts) lines.push(`### ${r.name} ${r.version}`, "", "```text", mask(r.text.trim()), "```", "");
  return lines.join("\n");
}

export function generate({ root = REPO, accepted = {}, python } = {}) {
  const npm = evaluate(collectNpm(root), accepted);
  const pip = evaluate(collectPython(COMPILER_PACKAGES, python), accepted);
  const generated = new Date().toISOString().slice(0, 10);
  return { markdown: render(npm.rows, pip.rows, generated), failures: [...npm.failures, ...pip.failures], counts: { npm: npm.rows.length, pip: pip.rows.length } };
}

export function main(argv) {
  const accepted = {};
  let out = null;
  let root = REPO;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = resolve(argv[++i]);
    else if (argv[i] === "--root") root = resolve(argv[++i]);
    else if (argv[i] === "--check") check = true;
    else if (argv[i] === "--accept") {
      const [k, ...v] = argv[++i].split("=");
      accepted[k] = v.join("=");
    }
  }
  const r = generate({ root, accepted });
  // Without --out nothing is written, so a run cannot overwrite a file of the repository by accident.
  if (!check && out) writeFileSync(out, r.markdown.replace(/\r?\n/g, "\n") + "\n", "utf8");
  else if (!check) console.log("No --out file was given, so no notices were written.");
  console.log(`${r.counts.npm} npm packages and ${r.counts.pip} Python packages checked${check ? "" : ", notices written"}.`);
  for (const f of r.failures) console.log(`NOT ALLOWED: ${f.name} ${f.version} (${f.ecosystem}) is under '${f.license}', and ${f.reason}.`);
  return r.failures.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
