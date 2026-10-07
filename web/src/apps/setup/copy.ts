import { useStore } from "../../lib/store";
import { useSetupStore } from "./state";

// Fixed wording of the first run, Settings and About. The non-affiliation statement is verbatim from docs/DISTRIBUTION.md.
export const nonAffiliation = (name: string): string =>
  `${name} is an independent open-source project. It is not affiliated with, endorsed by or sponsored by Anthropic. It runs the Claude Code tool that you install and sign in to yourself, and your use of Claude Code is governed by your own agreement with Anthropic.`;

/** The copyright line of the licence section, naming the product shown. */
export const copyrightLine = (name: string): string => `Copyright 2026 the ${name} authors.`;

export const INSTALL_URL = "https://docs.claude.com/en/docs/claude-code/setup";

export const PRIVACY_SUMMARY =
  "The product reads your files on your own computer, sends nothing to its authors and collects no usage data. Where you run Claude Code, Claude Code sends data to Anthropic under your own agreement with Anthropic.";

export const MISSIONS_STATEMENT =
  "Each agent run uses Claude Code under your own plan and its limits. Anthropic states that Claude Code runs started by other tools draw on your subscription limits for now, and Anthropic may change that. Each run still shows its plan and needs a click to start.";

export const BRAIN_CITATION =
  "Browne, Kristen, and Heidi Schlehlein. 2024. 3D Reference Organ for Brain, Male v1.4. https://doi.org/10.48539/HBM538.NKCT.649";

export const BRAIN_CHANGES =
  "The brain model is derived from the Allen Human Brain Atlas (Ding et al. 2016). It is licensed under CC BY 4.0. The product simplified the meshes, grouped them into regions and recoloured them.";

/** What the product is called in the window, from the product key in the server status. */
export function productName(product: string | undefined): string {
  return product === "cortex" ? "Cortex" : "Ranviera";
}

/** The name shown: the product of /api/status first, then the product of the setup state. */
export function useProductName(): string {
  const fromStatus = useStore((s) => s.status?.product);
  const fromSetup = useSetupStore((s) => s.setup?.product);
  return productName(fromStatus ?? fromSetup);
}
