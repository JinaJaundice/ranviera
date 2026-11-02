// Finds the folder of the Markdown prompt fragments of one area. In the repository the method fragments sit in a
// folder named prompts beside the module and the extraction fragments sit beside the module that reads them. The
// packaged server is one bundle file, and scripts/build/learn-prompts.mjs copies the fragments into learn-prompts/<area>
// beside the bundle, so the module looks in both places. A folder counts only when it holds the marker file of the area.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export type PromptArea = "method" | "extract";

const REPOSITORY: Record<PromptArea, { relative: string; marker: string }> = {
  method: { relative: "./prompts/", marker: "system-prompt.md" },
  extract: { relative: "./", marker: "auditor.md" },
};

export function promptFolder(moduleUrl: string, area: PromptArea): string {
  const { relative, marker } = REPOSITORY[area];
  const candidates = [fileURLToPath(new URL(relative, moduleUrl)), fileURLToPath(new URL(`./learn-prompts/${area}/`, moduleUrl))];
  return candidates.find((c) => fs.existsSync(`${c}${marker}`) || fs.existsSync(`${c}/${marker}`)) ?? candidates[0];
}
