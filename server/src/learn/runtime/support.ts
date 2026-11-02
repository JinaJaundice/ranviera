// Helpers for the tests of the runtime: a scripted model, fake dependencies and
// a temporary learning folder. No test calls a network model or writes to the
// real learning folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import {
  createModels,
  fauxProvider,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import type { LearnStreamMessage, NativeMessage, ProviderClass } from "../../../../shared/learn/index.ts";
import type { ActivityProviders, ComposedAgent, KnowledgeDeletion, KnowledgeReader, ModelResolver, ResolvedModel } from "./deps.ts";
import { RuntimeError } from "./errors.ts";
import { createSessionService, type RuntimeDeps, type SessionService } from "./service.ts";
import { defineTool } from "./tools/define.ts";

export function tmpDir(prefix = "learn-runtime-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const echoTool = defineTool({
  name: "echo",
  label: "Echo",
  description: "Returns its text.",
  parameters: Type.Object({ text: Type.String() }),
  execute: async (_id, p) => ({ content: [{ type: "text", text: p.text }], details: null }),
});

export interface Env {
  dir: string;
  faux: FauxProviderHandle;
  service: SessionService;
  events: LearnStreamMessage[];
  summaries: { prompt: string }[];
  state: { providerClass: ProviderClass; contextWindow: number | null; noStrongSlot: boolean; tools: ComposedAgent["tools"]; summary: { text: string; stopReason: string } | Error };
  deletions: { id: string; mode: string }[];
  extraction: { running: boolean };
  clock: { now: number };
  deps: RuntimeDeps;
}

export function makeEnv(overrides: Partial<RuntimeDeps> & { tokensPerSecond?: number; dir?: string } = {}): Env {
  const dir = overrides.dir ?? tmpDir();
  const faux = fauxProvider({ tokensPerSecond: overrides.tokensPerSecond });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const state: Env["state"] = { providerClass: "claude-code", contextWindow: 200_000, noStrongSlot: false, tools: [echoTool], summary: { text: "Summary text.", stopReason: "stop" } };
  const events: LearnStreamMessage[] = [];
  const summaries: { prompt: string }[] = [];
  const deletions: { id: string; mode: string }[] = [];
  const extraction = { running: false };
  const clock = { now: Date.now() };

  const resolved = (): ResolvedModel => ({
    model,
    ref: { provider: "faux", id: model.id },
    thinkingLevel: "off",
    providerClass: state.providerClass,
    streamFn: (m, c, o) => models.streamSimple(m, c, o),
    contextWindow: state.contextWindow,
  });
  const resolver: ModelResolver = {
    forSession: () => {
      if (state.noStrongSlot) {
        throw new RuntimeError(503, "No model is set for this task. Choose one in Settings.", "models_not_configured", { missing: ["strong"] });
      }
      return resolved();
    },
    cheap: resolved,
    strongSlot: () => (state.noStrongSlot ? null : { model: { provider: "faux", id: model.id }, thinkingLevel: "off", providerClass: state.providerClass }),
    validate: (ref, level) => ({ ...(ref ? { model: ref } : {}), ...(level ? { thinkingLevel: level } : {}) }),
  };
  const knowledge: KnowledgeReader = {
    listSources: () => [],
    listPropositions: () => [],
    getProposition: () => null,
    contextFor: (ids) => ({
      propositions: ids.map((id) => ({ id, name: `name ${id}`, statement: `statement ${id}` })),
      chains: [],
    }),
  };
  const deletion: KnowledgeDeletion = {
    extractionRunning: () => extraction.running,
    abortExtraction: () => {
      extraction.running = false;
    },
    deleteSession: (id, mode) => {
      deletions.push({ id, mode });
      return { nodesRemoved: 0, chainsRemoved: 0, coverageRemoved: 0, checkpointsRemoved: 0 };
    },
  };
  const activity: ActivityProviders = {};
  const deps: RuntimeDeps = {
    learnDir: dir,
    models: resolver,
    composer: { compose: () => ({ role: "plain", systemPrompt: "You are a test agent.", tools: state.tools }) },
    summariser: async ({ prompt }) => {
      summaries.push({ prompt });
      if (state.summary instanceof Error) throw state.summary;
      return { text: state.summary.text, stopReason: state.summary.stopReason, usage: { inputTokens: 10, outputTokens: 5 } };
    },
    knowledge,
    deletion,
    settings: { compactionThresholdTokens: () => 150_000 },
    emit: (m) => events.push(m),
    activity,
    now: () => clock.now,
    sleep: async () => {},
    ...overrides,
  };
  const service = createSessionService(deps);
  return { dir, faux, service, events, summaries, state, deletions, extraction, clock, deps };
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until a condition holds, within a timeout. Fails with the real condition text. */
export async function until(check: () => boolean, label = "condition", timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await wait(5);
  }
}

export const userMsg = (id: string, text: string): NativeMessage => ({ role: "user", id, content: text, timestamp: 1 });

export const assistantMsg = (id: string, content: unknown[], extra: Record<string, unknown> = {}): NativeMessage =>
  ({ role: "assistant", id, content, timestamp: 1, stopReason: "stop", ...extra }) as NativeMessage;

export const resultMsg = (id: string, callId: string, name: string, text = "ok", extra: Record<string, unknown> = {}): NativeMessage =>
  ({ role: "toolResult", id, toolCallId: callId, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 1, ...extra }) as NativeMessage;

export const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall", id, name, arguments: args });
