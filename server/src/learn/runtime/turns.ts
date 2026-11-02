// Turn admission and settlement. The server owns the transcript, a client sends
// one input event for each action, and only one turn runs for each session.
//
// Order of a turn: the input is checked, the model is resolved and the gates
// are applied before anything durable changes. The input is then saved before
// inference. A fresh agent is built from the record through the injected
// composer, and the loop runs in the background while any attached view
// follows the stream. The result is saved, and only then is the end of the turn
// announced. Closing a view never aborts a turn. Only an explicit abort does,
// and the partial output is saved.
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import type { InputEvent, NativeMessage, SessionRecord, TurnFrame } from "../../../../shared/learn/index.ts";
import { createCallIdUniquifier, seedIds } from "./call-ids.ts";
import type { CompactionService } from "./compaction.ts";
import type { AgentComposer, Emit, ModelResolver, ResolvedModel } from "./deps.ts";
import { DismissalPark, type ParkedDismissal } from "./dismissal.ts";
import { notFound, turnRunning } from "./errors.ts";
import { newMessageId, newTurnId } from "./ids.ts";
import { planInput, planDismissal, type InputContext } from "./inputs.ts";
import { toLlmMessages } from "./projection.ts";
import { QUESTION_TOOLS, endsOwed, needsContinuation, tailErrorText } from "./scans.ts";
import { SteeringRegistry, toSteerMessage, type Steer } from "./steering.ts";
import { DEFAULT_TITLE, titleFromPrompt, type SessionStore } from "./store.ts";
import { guardTool } from "./tools/guard.ts";
import { healTool } from "./tools/heal.ts";
import type { AnyTool } from "./tools/define.ts";
import { TurnStream, shortStream } from "./turn-stream.ts";

export const LIVENESS_GUARD_MS = 30 * 60 * 1000;

export interface TurnDeps {
  store: SessionStore;
  models: ModelResolver;
  composer: AgentComposer;
  compaction: CompactionService;
  emit: Emit;
  now?: () => number;
  guardMs?: number;
  flushMs?: number;
  toolTimeoutMs?: number;
  toolGraceMs?: number;
  /** replaces the default grader of choice answers */
  grader?: InputContext["grade"];
  /** called after an input has been saved, for example to write the outcome of an answer */
  onInput?: (sessionId: string) => void;
  /** called after a turn settles, for example to start an extraction */
  onSettled?: (sessionId: string) => void;
}

interface ActiveTurn {
  sessionId: string;
  turnId: string;
  startedAt: number;
  stream: TurnStream;
  agent: Agent | null;
  aborted: boolean;
  announced: boolean;
  delivered: Set<string>;
  done: Promise<void>;
  finish: () => void;
}

export interface SubmitResult {
  started: boolean;
}

export interface TurnService {
  submit(sessionId: string, input: InputEvent): Promise<SubmitResult>;
  isRunning(sessionId: string): boolean;
  startedAt(sessionId: string): number | null;
  /** Steers a running turn at its next boundary. False when no turn is live. Synchronous. */
  steer(sessionId: string, steer: Steer): boolean;
  /** Silent dismissal. A running turn parks it and the result says so. */
  dismiss(sessionId: string, body: ParkedDismissal): { parked: boolean };
  abort(sessionId: string): boolean;
  /** The live stream of a running turn, or the short stream when none runs. */
  attach(sessionId: string): TurnStream;
  running(): { sessionId: string; startedAt: number }[];
  /** The failure notice of the last settlement that failed, or the failure at the tail of the record. */
  turnError(record: SessionRecord): string | null;
  /** Drops the memory of a session after deletion. */
  forget(sessionId: string): void;
  /** Resolves when the turn of the session has settled. */
  whenSettled(sessionId: string): Promise<void>;
}

const text = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function createTurnService(deps: TurnDeps): TurnService {
  const now = deps.now ?? Date.now;
  const guardMs = deps.guardMs ?? LIVENESS_GUARD_MS;
  const ctx: InputContext = { now, grade: deps.grader };
  const inputSaved = (sessionId: string) => {
    try {
      deps.onInput?.(sessionId);
    } catch {
      // background work never fails an input
    }
  };
  const active = new Map<string, ActiveTurn>();
  const notices = new Map<string, string>();
  const steering = new SteeringRegistry();
  const park = new DismissalPark();

  /** The live turn of a session. An entry older than the guard is evicted silently on read. */
  function live(sessionId: string): ActiveTurn | undefined {
    const turn = active.get(sessionId);
    if (!turn) return undefined;
    if (now() - turn.startedAt > guardMs) {
      active.delete(sessionId);
      turn.aborted = true;
      try {
        turn.agent?.abort();
      } catch {
        // the entry is gone either way
      }
      return undefined;
    }
    return turn;
  }

  function claim(sessionId: string): ActiveTurn {
    let finish = () => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const turn: ActiveTurn = {
      sessionId,
      turnId: newTurnId(now()),
      startedAt: now(),
      stream: new TurnStream(deps.flushMs),
      agent: null,
      aborted: false,
      announced: false,
      delivered: new Set(),
      done,
      finish,
    };
    active.set(sessionId, turn);
    return turn;
  }

  function release(turn: ActiveTurn): void {
    if (active.get(turn.sessionId) === turn) active.delete(turn.sessionId);
    turn.finish();
  }

  async function submit(sessionId: string, input: InputEvent): Promise<SubmitResult> {
    const first = deps.store.get(sessionId);
    if (!first) throw notFound("That session does not exist.");
    if (live(sessionId)) throw turnRunning();
    // a bad input is refused before anything is claimed or written
    planInput(first.messages, input, ctx);
    const turn = claim(sessionId);
    try {
      const resolved = deps.models.forSession(first);
      await deps.compaction.whenIdle(sessionId);
      const afterWait = deps.store.get(sessionId);
      if (afterWait && deps.compaction.isOver(afterWait)) await deps.compaction.compactIfNeeded(sessionId);
      let record = deps.store.get(sessionId);
      if (!record) throw notFound("That session does not exist.");
      const plan = planInput(record.messages, input, ctx);
      if (!plan.startsTurn) {
        // an answer that leaves a sibling question open is saved and no turn starts
        if (plan.appends.length) deps.store.appendMessages(sessionId, plan.appends);
        inputSaved(sessionId);
        release(turn);
        deps.emit({ type: "learn", event: "record-changed", session: sessionId });
        return { started: false };
      }
      const firstTextInput = input.type === "text" && record.title === DEFAULT_TITLE && record.messages.length === 0;
      if (plan.appends.length) record = deps.store.appendMessages(sessionId, plan.appends);
      inputSaved(sessionId);
      if (firstTextInput && input.type === "text") record = deps.store.rename(sessionId, titleFromPrompt(input.text));
      notices.delete(sessionId);
      turn.announced = true;
      deps.emit({ type: "learn", event: "turn-started", session: sessionId, running: true });
      void run(turn, record, resolved);
      return { started: true };
    } catch (e) {
      release(turn);
      throw e;
    }
  }

  /** The loop, in the background. Settlement always runs. */
  async function run(turn: ActiveTurn, record: SessionRecord, resolved: ResolvedModel): Promise<void> {
    const collected: NativeMessage[] = [];
    let loopError: string | undefined;
    try {
      const composed = deps.composer.compose({ session: record, model: resolved, record: () => deps.store.get(turn.sessionId) ?? record });
      const uniq = createCallIdUniquifier(seedIds(record.messages));
      const tools = composed.tools.map((t): AnyTool => guardTool(healTool(t), { timeoutMs: deps.toolTimeoutMs, graceMs: deps.toolGraceMs }));
      const agent = new Agent({
        initialState: {
          systemPrompt: composed.systemPrompt,
          tools,
          model: resolved.model,
          thinkingLevel: resolved.thinkingLevel,
          messages: toLlmMessages(record.messages),
        },
        streamFn: resolved.streamFn,
        getApiKey: resolved.getApiKey,
        sessionId: record.id,
        steeringMode: "all",
        toolExecution: "sequential",
        finishTurn: composed.finishTurn,
      });
      turn.agent = agent;
      for (const parked of steering.takeParked(turn.sessionId)) agent.steer(toSteerMessage(parked, now()) as never);

      let assistantId = "";
      const resultIds = new Map<string, string>();
      const idOf = (message: { role: string; id?: unknown; toolCallId?: string }): string => {
        if (typeof message.id === "string" && message.id) return message.id;
        if (message.role === "assistant") return assistantId;
        if (message.role === "toolResult") {
          const key = message.toolCallId ?? "";
          let id = resultIds.get(key);
          if (!id) resultIds.set(key, (id = newMessageId(now())));
          return id;
        }
        return newMessageId(now());
      };
      const wire = <T extends { role: string }>(message: T): T => {
        const mapped = uniq.remap(message) as T & { id?: string; toolCallId?: string };
        return { ...mapped, id: idOf(mapped) } as T;
      };
      const push = (frame: TurnFrame) => turn.stream.push(frame);

      agent.subscribe((event: AgentEvent) => {
        try {
          switch (event.type) {
            case "message_start": {
              const m = event.message as { role: string };
              if (m.role === "assistant") {
                uniq.beginAssistant();
                assistantId = newMessageId(now());
              }
              push({ type: "message_start", message: wire(m) } as TurnFrame);
              break;
            }
            case "message_update":
              // only the full partial message travels, and the view replaces its slot
              push({ type: "message_update", message: wire(event.message as { role: string }) } as TurnFrame);
              break;
            case "message_end": {
              const m = wire(event.message as { role: string });
              if ((m as { role: string }).role !== "system") collected.push(m as unknown as NativeMessage);
              const id = (m as { id?: string }).id;
              if ((m as { role: string }).role === "user" && id) turn.delivered.add(id);
              push({ type: "message_end", message: m } as TurnFrame);
              break;
            }
            case "tool_execution_start":
            case "tool_execution_update":
            case "tool_execution_end":
              push({ ...event, toolCallId: uniq.map(event.toolCallId) } as TurnFrame);
              break;
            case "turn_end":
              push({
                type: "turn_end",
                message: wire(event.message as { role: string }),
                toolResults: event.toolResults.map((r) => wire(r)),
              } as TurnFrame);
              break;
            case "agent_end":
              push({ type: "agent_end", messages: collected } as TurnFrame);
              break;
            default:
              push(event as TurnFrame);
          }
        } catch {
          // a failing listener must never break the loop
        }
      });
      if (turn.aborted) throw new Error("Aborted before the run started.");
      await agent.continue();
    } catch (e) {
      loopError = turn.aborted ? undefined : text(e, "The turn failed.");
    }
    await settle(turn, record, resolved, collected, loopError);
  }

  async function settle(turn: ActiveTurn, record: SessionRecord, resolved: ResolvedModel, collected: NativeMessage[], loopError?: string): Promise<void> {
    let failure = loopError;
    try {
      // the placeholder result of a question tool lives in the loop only: the call stays open in the record until the learner answers
      const toSave = collected.filter((m) => !(m.role === "toolResult" && QUESTION_TOOLS.has(m.toolName) && !m.isError && m.details == null));
      if (toSave.length) deps.store.appendMessages(turn.sessionId, toSave);
      const steps = collected.flatMap((m) => {
        if (m.role !== "assistant" || m.stopReason === "aborted") return [];
        const u = m.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; reasoning?: number } | undefined;
        if (!u) return [];
        const step = {
          ...(typeof u.input === "number" ? { inputTokens: u.input } : {}),
          ...(typeof u.output === "number" ? { outputTokens: u.output } : {}),
          ...(typeof u.cacheRead === "number" ? { cacheReadTokens: u.cacheRead } : {}),
          ...(typeof u.cacheWrite === "number" ? { cacheWriteTokens: u.cacheWrite } : {}),
          ...(typeof u.cacheWrite1h === "number" ? { cacheWrite1hTokens: u.cacheWrite1h } : {}),
          ...(typeof u.reasoning === "number" ? { reasoningTokens: u.reasoning } : {}),
        };
        return Object.keys(step).length ? [step] : [];
      });
      if (steps.length) {
        const lastAssistant = [...collected].reverse().find((m) => m.role === "assistant");
        deps.store.appendTurnUsage(turn.sessionId, {
          id: turn.turnId,
          messageId: lastAssistant?.id ?? record.messages[record.messages.length - 1]?.id ?? "",
          at: new Date(now()).toISOString(),
          model: `${resolved.ref.provider}:${resolved.ref.id}`,
          steps,
        });
      }
      steering.parkUndelivered(turn.sessionId, turn.agent, turn.delivered);
      // the parked dismissal is applied against the saved record, before liveness ends
      park.apply(turn.sessionId, deps.store, deps.emit, ctx);
    } catch (e) {
      failure = text(e, "The result of the turn could not be saved.");
    }
    if (failure) notices.set(turn.sessionId, failure);
    release(turn);
    if (failure) turn.stream.push({ type: "error", errorText: failure });
    if (turn.announced) deps.emit({ type: "learn", event: "turn-settled", session: turn.sessionId, running: false });
    turn.stream.push({ type: "turn-settled" });
    turn.stream.push({ type: "done" });
    try {
      deps.compaction.kick(turn.sessionId);
      deps.onSettled?.(turn.sessionId);
    } catch {
      // background work never fails a settled turn
    }
  }

  return {
    submit,
    isRunning: (id) => !!live(id),
    startedAt: (id) => live(id)?.startedAt ?? null,
    steer(sessionId, steer) {
      const turn = live(sessionId);
      if (!turn) return false;
      return steering.steer(turn.agent, steer, now());
    },
    dismiss(sessionId, body) {
      const record = deps.store.get(sessionId);
      if (!record) throw notFound("That session does not exist.");
      if (live(sessionId)) {
        park.park(sessionId, body);
        return { parked: true };
      }
      const messages = planDismissal(record.messages, body, ctx);
      deps.store.appendMessages(sessionId, messages);
      deps.emit({ type: "learn", event: "record-changed", session: sessionId });
      return { parked: false };
    },
    abort(sessionId) {
      const turn = live(sessionId);
      if (!turn) return false;
      turn.aborted = true;
      turn.agent?.abort();
      return true;
    },
    attach(sessionId) {
      const turn = live(sessionId);
      return turn ? turn.stream : shortStream(notices.get(sessionId));
    },
    running: () => [...active.keys()].flatMap((id) => (live(id) ? [{ sessionId: id, startedAt: active.get(id)!.startedAt }] : [])),
    turnError(record) {
      if (live(record.id)) return null;
      const saved = notices.get(record.id);
      if (saved) return saved;
      const tail = tailErrorText(record.messages);
      if (tail) return tail;
      // a record that ends on a learner message with no reply holds an input that a restart interrupted
      if (endsOwed(record.messages) && !needsContinuation(record.messages) && record.messages[record.messages.length - 1]?.role === "user") {
        return "The last turn did not finish. Send a message to continue.";
      }
      return null;
    },
    forget(sessionId) {
      notices.delete(sessionId);
      steering.forget(sessionId);
      park.forget(sessionId);
    },
    whenSettled: (id) => active.get(id)?.done ?? Promise.resolve(),
  };
}
