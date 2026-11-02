// Helpers for the tests of the method: fake dependencies, a record builder and
// a runtime service that runs the method composer. No test calls a network
// model or writes to the real learning folder.
import type { NativeMessage, PlanTree, SessionRecord } from "../../../../shared/learn/index.ts";
import type { KnowledgeReader, PathPolicy } from "../runtime/deps.ts";
import { createSessionStore } from "../runtime/store.ts";
import { makeEnv, tmpDir, type Env } from "../runtime/support.ts";
import type { LearnEvents, MethodDeps, MethodSettings, TargetResolver } from "./deps.ts";
import { createMethodService, type MethodService } from "./service.ts";
import { seedTurnState, type TurnState } from "./tools/state.ts";

export { tmpDir };

export const newRecord = (messages: NativeMessage[] = [], tree?: PlanTree, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "chat_test",
  title: "Test",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  messages,
  ...(tree ? { tree } : {}),
  ...extra,
});

export const stateOf = (record: SessionRecord, targets?: TargetResolver): TurnState => seedTurnState({ record: () => record, providerClass: "claude-code", targets });

export const treeOf = (...ids: string[]): PlanTree => ({ nodes: ids.map((id) => ({ id, title: id })), edges: [], version: 1 });

/** Runs a tool with the argument preparation that the loop applies first. */
export async function run(tool: { execute: (...a: never[]) => unknown; prepareArguments?: (a: unknown) => unknown }, args: Record<string, unknown>, id = "call_1") {
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  return (await (tool.execute as (id: string, params: unknown) => Promise<{ content: { text: string }[]; details?: unknown; isError?: boolean; terminate?: boolean }>)(id, prepared));
}

export const textOf = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join("\n");

export const fakePolicy: PathPolicy = { isDenied: () => false, allowedRoots: () => [] };

export const fakeKnowledge = (names: Record<string, string> = {}): KnowledgeReader => ({
  listSources: () => [],
  listPropositions: () => [],
  getProposition: (id) => (id in names ? { id, name: names[id], statement: `statement ${id}`, aliases: [], sources: [{ id: "chat_a", label: "A" }, { id: "src_b", label: "B" }] } : null),
  contextFor: () => ({ propositions: [], chains: [] }),
});

export const nameResolver = (names: Record<string, string>): TargetResolver => ({
  resolve: (raw) => (raw in names ? raw : (Object.entries(names).find(([, name]) => name.toLowerCase() === raw.toLowerCase())?.[0] ?? null)),
});

export interface MethodEnv extends Env {
  method: MethodService;
  switches: { tools: ReturnType<MethodSettings["tools"]>; prompts: Record<string, boolean> };
  answers: Parameters<LearnEvents["answer"]>[0][];
  wakes: string[];
  jobs: { kind: string; sessionId: string; toolCallId: string; input: Record<string, unknown> }[];
}

/** A runtime service that runs the method composer, the grader and the callbacks against fakes. */
export function makeMethodEnv(options: { names?: Record<string, string>; withJobs?: boolean } = {}): MethodEnv {
  const dir = tmpDir("learn-method-");
  const now = () => Date.now();
  const store = createSessionStore({ learnDir: dir, now });
  const switches: MethodEnv["switches"] = { tools: {}, prompts: {} };
  const answers: MethodEnv["answers"] = [];
  const wakes: string[] = [];
  const jobs: MethodEnv["jobs"] = [];
  const names = options.names ?? {};
  const deps: MethodDeps = {
    learnDir: dir,
    store,
    policy: fakePolicy,
    knowledge: fakeKnowledge(names),
    settings: {
      tools: () => switches.tools,
      promptSwitches: () => switches.prompts,
      clearPromptSwitch: (k) => {
        delete switches.prompts[k];
      },
    },
    targets: options.names ? nameResolver(names) : undefined,
    jobs: options.withJobs
      ? {
          dispatch: (req) => {
            jobs.push(req);
            return { jobId: `job_${jobs.length}` };
          },
        }
      : undefined,
    events: { answer: (e) => void answers.push(e) },
    wake: (id) => void wakes.push(id),
    now,
    homeDir: dir,
  };
  const method = createMethodService(deps);
  const env = makeEnv({ dir, ...method.runtimeHooks() });
  return { ...env, method, switches, answers, wakes, jobs };
}
