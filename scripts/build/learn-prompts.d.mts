// Types of learn-prompts.mjs for the packaging test in server/src/learn/packaging.test.ts.
export interface PromptArea {
  area: "method" | "extract";
  from: string;
  to: string;
}
export const PROMPT_AREAS: PromptArea[];
export function markdownFiles(dir: string): string[];
export function bundleList(root?: string): { from: string; to: string }[];
export function copyPromptFragments(outDir: string, root?: string): string[];
