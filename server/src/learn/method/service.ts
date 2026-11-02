// The method service: the composer, the prompt store, the grader and the
// bookkeeping after an input or a turn, behind one object. The factory takes
// explicit paths and injected dependencies and reads no global configuration.
import type { KnowledgeMetrics, OutcomeLine, SessionRecord } from "../../../../shared/learn/index.ts";
import type { AgentComposer } from "../runtime/deps.ts";
import { hasProbeDone, resultsById, toolCallsOf } from "../runtime/scans.ts";
import type { RuntimeDeps } from "../runtime/service.ts";
import type { MethodDeps } from "./deps.ts";
import { gradeAnswer } from "./questions.ts";
import { computeMetrics } from "./metrics.ts";
import { outcomesForNode, readOutcomes, syncOutcomes } from "./outcomes.ts";
import { planBlockDetails } from "./plan-tree.ts";
import { createPromptStore, type PromptStore } from "./prompt-store.ts";
import { createComposer } from "./roles.ts";
import { targetsOfCall } from "./tools/state.ts";

export const PROBE_HANDOFF_TEXT =
  "The probe is complete. Read the assessment in the probe_done call above. Draw the plan map with plan_init and present the approach in prose before any teaching.";

export interface MethodService {
  composer: AgentComposer;
  prompts: PromptStore;
  /** The outcome lines of the learning folder, newest last. */
  outcomes(): OutcomeLine[];
  /** The outcomes and the derived metrics of one proposition, or null when the proposition is unknown and has no outcome. */
  outcomesFor(nodeId: string): { outcomes: OutcomeLine[]; metrics: KnowledgeMetrics } | null;
  /** The hooks that the runtime service takes: the grader and the two callbacks. */
  runtimeHooks(): Pick<RuntimeDeps, "grader" | "onInput" | "onSettled" | "composer">;
  /** After an input is saved: writes the outcome of a graded answer. */
  afterInput(sessionId: string): void;
  /** After a turn settles: plan blocks, the probe handoff and outcomes. */
  afterTurn(sessionId: string): void;
}

export function createMethodService(deps: MethodDeps): MethodService {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const prompts = createPromptStore({ learnDir: deps.learnDir, settings: deps.settings, promptsDir: deps.promptsDir });
  const composer = createComposer(deps, prompts);

  /** One plan block for each successful plan_init call. The tree of the block is the tree that the call saved. */
  function planBlocks(record: SessionRecord): void {
    const have = new Set<string>();
    for (const m of record.messages) {
      if (m.role === "custom" && m.customType === "plan-block") {
        const id = (m.details as { planCallId?: unknown } | undefined)?.planCallId;
        if (typeof id === "string") have.add(id);
      }
    }
    const results = resultsById(record.messages);
    const missing: { callId: string; tree: NonNullable<SessionRecord["tree"]> }[] = [];
    for (const m of record.messages) {
      if (m.role !== "assistant" || m.stopReason === "error" || m.stopReason === "aborted") continue;
      for (const call of toolCallsOf(m)) {
        if (call.name !== "plan_init" || have.has(call.id)) continue;
        const r = results.get(call.id);
        const d = r?.details as { ok?: unknown; tree?: unknown } | null | undefined;
        if (!r || r.isError || d?.ok !== true || !d.tree) continue;
        missing.push({ callId: call.id, tree: d.tree as NonNullable<SessionRecord["tree"]> });
      }
    }
    if (missing.length === 0) return;
    const at = new Date(now()).toISOString();
    deps.store.appendMessages(
      record.id,
      missing.map(({ callId, tree }) => ({
        role: "custom" as const,
        id: `pb_${callId.replace(/[^A-Za-z0-9_-]/g, "_")}`,
        customType: "plan-block" as const,
        content: `Plan map, version ${tree.version}.`,
        display: true,
        details: planBlockDetails(callId, tree, record.messages, at),
        timestamp: now(),
      })),
    );
  }

  /** The handoff marker that makes the teacher start planning when the prober's turn ends. Its identifier is fixed, so it is written once. */
  function probeHandoff(record: SessionRecord): boolean {
    if (!hasProbeDone(record.messages)) return false;
    const id = `steer_probe_${record.id}`;
    if (record.messages.some((m) => m.id === id)) return false;
    deps.store.appendMessages(record.id, [
      { role: "custom", id, customType: "probe-handoff", content: PROBE_HANDOFF_TEXT, display: false, timestamp: now() },
    ]);
    return true;
  }

  function afterTurn(sessionId: string): void {
    try {
      let record = deps.store.get(sessionId);
      if (!record) return;
      planBlocks(record);
      record = deps.store.get(sessionId) ?? record;
      const handed = probeHandoff(record);
      record = deps.store.get(sessionId) ?? record;
      syncOutcomes(deps.learnDir, record, { resolver: deps.targets, events: deps.events, now });
      if (handed) deps.wake?.(sessionId);
    } catch (e) {
      log(`method after turn failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function afterInput(sessionId: string): void {
    try {
      const record = deps.store.get(sessionId);
      if (record) syncOutcomes(deps.learnDir, record, { resolver: deps.targets, events: deps.events, now });
    } catch (e) {
      log(`method after input failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    composer,
    prompts,
    outcomes: () => readOutcomes(deps.learnDir),
    outcomesFor(nodeId) {
      const outcomes = outcomesForNode(readOutcomes(deps.learnDir), nodeId);
      const known = deps.knowledge.getProposition(nodeId, "claude-code");
      if (!known && outcomes.length === 0) return null;
      return { outcomes, metrics: computeMetrics(outcomes, known ? new Set(known.sources.map((x) => x.id)).size : 0) };
    },
    runtimeHooks: () => ({
      composer,
      grader: (call, answer) => {
        // a target that a model wrote as a name is stored as the identifier in the graded details
        const target = targetsOfCall(call.arguments, deps.targets);
        const graded = gradeAnswer(target.length ? { ...call, arguments: { ...call.arguments, target } } : call, answer, now);
        return graded;
      },
      onInput: afterInput,
      onSettled: afterTurn,
    }),
    afterInput,
    afterTurn,
  };
}
