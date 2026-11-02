// Scores the extraction pipeline against the hand written claims of kg/tests/fixtures/extraction_eval.
//
// A person runs this by hand. It calls the model that Settings names for the cheap slot, so it spends money or time on
// that model, and no test runs it. It copies the notes to a temporary folder and extracts them into a temporary
// learning folder, so it never changes the real graph. It reads the keys file and settings.json of the configured
// learning folder and writes to neither.
//
//   node scripts/learn/eval-extraction.mjs [--fixtures <dir>] [--out <report.json>] [--dry-run]
//
// --dry-run scores the expected claims against themselves. It needs no model and checks the plumbing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

const fixtures = path.resolve(option("--fixtures") ?? path.join(root, "kg", "tests", "fixtures", "extraction_eval"));
const { formatReport, loadExpected, scoreExtraction } = await import("../../server/src/learn/extract/eval.ts");
const expected = loadExpected(fixtures);

function finish(score, extra = {}) {
  console.log(formatReport(score));
  const out = option("--out");
  if (out) fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), score, ...extra }, null, "\t") + "\n");
}

if (flag("--dry-run")) {
  const own = Object.entries(expected.files).flatMap(([file, spec]) => spec.claims.map((c) => ({ file, statement: c.text })));
  console.log("Dry run: the expected claims are scored against themselves, and no model is called.");
  finish(scoreExtraction(expected, own), { dryRun: true });
  process.exit(0);
}

const { loadConfig } = await import("../../server/src/config.ts");
const { createModelsService } = await import("../../server/src/learn/models/index.ts");
const { claudeCodeStatus, createClaudeCodeProvider, findClaudeExecutable } = await import("../../server/src/learn/models/claude-code/index.ts");
const { createKnowledge } = await import("../../server/src/learn/knowledge/index.ts");
const { createSources } = await import("../../server/src/learn/sources/index.ts");
const { Semaphore } = await import("../../server/src/learn/extract/semaphore.ts");
const { createExtractModels } = await import("../../server/src/learn/extract/engines.ts");
const { ExtractService } = await import("../../server/src/learn/extract/pipeline.ts");

const cfg = loadConfig();
const learnDir = cfg.learn_dir ?? `${cfg.data_dir}/learn`;
const authFile = cfg.auth_file ?? `${cfg.data_dir}/auth.json`;
const findExe = () => findClaudeExecutable({ claudeCmd: cfg.claude_cmd ?? null });
let models = null;
const claudeCode = createClaudeCodeProvider({ findExecutable: findExe, injectedNames: () => models?.keys.injectedNames() ?? [] });
models = createModelsService({
  authFile,
  learnDir,
  extraProviders: [claudeCode.provider],
  claudeCodeStatus: () => claudeCodeStatus({ exe: findExe(), enabled: true, allowBackground: false }),
});
const stage = createExtractModels(models);
const refusal = await stage.preflight();
if (refusal) {
  console.error(`The model layer refused the run: ${refusal.message}`);
  claudeCode.dispose();
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-eval-")).split(path.sep).join("/");
try {
  const notes = `${work}/notes`;
  fs.mkdirSync(notes, { recursive: true });
  for (const file of Object.keys(expected.files)) fs.copyFileSync(path.join(fixtures, file), `${notes}/${file}`);
  const scratch = `${work}/data/learn`;
  const sources = createSources({ learnDir: scratch, dataDir: `${work}/data`, claudeHome: `${work}/claude`, projectsRoot: null });
  const knowledge = createKnowledge({ learnDir: scratch });
  const service = new ExtractService({ knowledge, sources, models: stage, semaphore: new Semaphore(3) });
  const root_ = sources.add({ kind: "notes", path: notes, label: "Notes", sensitivity: "public" });
  await sources.scan(root_.id);
  const results = {};
  for (const f of sources.files(root_.id)) {
    console.log(`Extracting ${f.path} ...`);
    results[f.path] = await service.fileResult(f.sourceId);
  }
  const pathOf = new Map(sources.files(root_.id).map((f) => [f.sourceId, f.path]));
  const produced = [];
  const ledger = path.join(scratch, "graph", "nodes.jsonl");
  const seen = new Set();
  for (const line of fs.existsSync(ledger) ? fs.readFileSync(ledger, "utf8").split("\n").filter(Boolean) : []) {
    const n = JSON.parse(line);
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    produced.push({ file: pathOf.get(n.provenance[0]?.chatId) ?? "", statement: n.statement, aliases: n.aliases });
  }
  for (const [file, r] of Object.entries(results)) if (r.outcome !== "completed") console.log(`${file}: ${r.outcome}${r.notice ? `. ${r.notice}` : ""}`);
  finish(scoreExtraction(expected, produced), { results, costs: service.costs(), produced });
} finally {
  claudeCode.dispose();
  fs.rmSync(work, { recursive: true, force: true });
}
