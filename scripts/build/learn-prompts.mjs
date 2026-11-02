// The Markdown prompt fragments of the learning upgrade. The server reads them from files, and the packaged server is
// one bundle, so the build copies them into learn-prompts/<area> beside the bundle. server/src/learn/prompt-folder.ts
// looks in that folder when the repository folder is absent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The source folder of each area and its folder beside the bundle. */
export const PROMPT_AREAS = [
  { area: "method", from: "server/src/learn/method/prompts", to: "learn-prompts/method" },
  { area: "extract", from: "server/src/learn/extract/prompts", to: "learn-prompts/extract" },
];

/** Every Markdown file under a folder, as paths relative to it with forward slashes. */
export function markdownFiles(dir) {
  const out = [];
  const walk = (d, prefix) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(d, entry.name), rel);
      else if (entry.name.endsWith(".md")) out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** The bundle list: each fragment as the path it has beside the bundle, relative to the output folder. */
export function bundleList(root = ROOT) {
  return PROMPT_AREAS.flatMap((a) => markdownFiles(path.join(root, a.from)).map((f) => ({ from: path.join(root, a.from, f), to: `${a.to}/${f}` })));
}

/** Copies every fragment into the output folder of the bundle and returns the list of the paths written. */
export function copyPromptFragments(outDir, root = ROOT) {
  const list = bundleList(root);
  for (const item of list) {
    const target = path.join(outDir, item.to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(item.from, target);
  }
  return list.map((i) => i.to);
}
