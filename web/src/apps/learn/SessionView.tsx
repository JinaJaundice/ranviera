// One session: the 32px row, the find bar, the transcript (the scroller) and the dock. The state of the turn lives in the
// SessionModel, and this component reads it, shows it and passes the learner's actions to it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { ChevronsDown } from "lucide-react";
import type { ModelCatalogResponse } from "@shared/learn/models";
import type { ThinkingLevel } from "@shared/learn/sessions";
import { IconButton } from "../../components/IconButton";
import { bus } from "../../lib/bus";
import { pushEscape } from "../../lib/learn/escape";
import { learnKnowledge } from "../../lib/learn/knowledge";
import { learnModels } from "../../lib/learn/models";
import { learnSessions } from "../../lib/learn/sessions";
import { useFetched } from "../../lib/learn/useFetched";
import { useStore } from "../../lib/store";
import { Dock } from "./Dock";
import { FindBar } from "./FindBar";
import { isSetupRefusal, setupNotice } from "./draft";
import { MUTE_MS, arrival, areaCeiling, dockVariant, escTarget, foldDecision, type Arrival } from "./dockRules";
import { SessionBar } from "./SessionBar";
import { Transcript } from "./Transcript";
import { PlanPopup } from "./PlanMap";
import { ErrorLine } from "../sources/parts";
import { ConfirmDialog, Popover } from "./parts";
import { activeProblem, contextTokens, derivePhase, planBlockOf, planStatuses, practicePause, projectBlocks } from "./project";
import { buildAnswer, emptyForm, pendingQuestionOf, type FormState } from "./questions";
import { cacheWords, contextWords, costWords } from "./stats";
import { modelFor, useOpenSession, useSessionState } from "./useSession";
import { toggleAllThinking } from "./thinkingStore";

type Confirm = "turn" | "question" | "problem" | null;
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const SELECT = "h-7 max-w-40 min-w-0 truncate rounded-md border border-rule-strong bg-sunken px-1.5 text-small text-ink";

export interface SessionViewProps {
  id: string;
  onChanged: () => void;
  onToggleSidebar: (() => void) | null;
  onRunning: (id: string, running: boolean) => void;
  renameSignal: number;
}

export function SessionView({ id, onChanged, onToggleSidebar, onRunning, renameSignal }: SessionViewProps) {
  const model = useMemo(() => modelFor(id), [id]);
  useOpenSession(model, onRunning);
  const state = useSessionState(model);
  const signals = useStore((s) => s.learnSignals);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [distance, setDistance] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [rename, setRename] = useState(renameSignal);
  const [extracting, setExtracting] = useState(false);
  const [height, setHeight] = useState(700);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const content = useRef<HTMLDivElement>(null);
  const mutedUntil = useRef(0);
  const stick = useRef(true);

  const detail = useFetched(() => learnSessions.detail(id), id, (signals["turn-settled"] ?? 0) + (signals["record-changed"] ?? 0) + (signals["compaction-changed"] ?? 0) + (signals["sessions-changed"] ?? 0));
  const catalog = useFetched<ModelCatalogResponse>(() => learnModels.catalog(), "catalog", signals["models-changed"] ?? 0);
  const graph = useFetched(() => learnKnowledge.graph(), "graph", signals["graph-changed"] ?? 0);

  // notify, then fetch: each learning event that concerns a session makes the model read the record again
  const seen = useRef({ ...signals });
  useEffect(() => {
    const prev = seen.current;
    for (const name of ["turn-started", "turn-settled", "record-changed", "compaction-changed"] as const) {
      if ((signals[name] ?? 0) !== (prev[name] ?? 0)) void model.onEvent(name);
    }
    seen.current = { ...signals };
  }, [signals, model]);

  const names = useMemo(() => Object.fromEntries((graph.data?.propositions ?? []).map((p) => [p.id, p.name])), [graph.data]);
  const session = detail.data?.session;
  const kind = session?.kind ?? "teach";
  const practice = kind === "practice";
  const messages = state.messages;
  const blocks = useMemo(() => projectBlocks(messages, state.streamingIds), [messages, state.streamingIds]);
  const pending = useMemo(() => pendingQuestionOf(messages, state.streamingIds), [messages, state.streamingIds]);
  const problem = useMemo(() => (practice ? activeProblem(messages) : null), [messages, practice]);
  const pause = practice && practicePause(messages);
  const live = state.status === "submitted" || state.status === "streaming";
  const busy = live || state.turnInFlight;
  const phase = useMemo(() => derivePhase(messages), [messages]);
  const plan = useMemo(() => planBlockOf(messages), [messages]);
  const sessionTree = session?.tree;
  const tree = useMemo(() => (sessionTree && sessionTree.nodes.length ? sessionTree : plan ? { nodes: plan.nodes, edges: plan.edges } : null), [sessionTree, plan]);
  const statuses = useMemo(() => (tree ? planStatuses(tree, messages) : {}), [tree, messages]);

  /* the dock: how a question arrives, and when it folds */
  const [dockState, setDockState] = useState<{ key: string | null; mode: Arrival }>({ key: null, mode: "open" });
  const [prevKey, setPrevKey] = useState<string | null>(null);
  const key = pending?.key ?? problem?.callId ?? null;
  if (key !== dockState.key) {
    const q = pending?.question ?? null;
    const mode: Arrival = pending && q ? arrival({ collapsedKind: q.collapsed, atBottom, followsQuestion: prevKey !== null }) : "open";
    setDockState({ key, mode });
    setPrevKey(key);
  }

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const d = el.scrollHeight - el.scrollTop - el.clientHeight;
    setDistance(d);
    const bottom = d <= 16;
    setAtBottom(bottom);
    stick.current = bottom;
    if (!key) return;
    const decision = foldDecision({ distance: d, atBottom: bottom, folded: dockState.mode === "folded", mutedUntil: mutedUntil.current, now: Date.now() });
    if (decision === "fold" && dockState.mode === "open") setDockState({ key, mode: "folded" });
    else if (decision === "expand" && dockState.mode === "folded") {
      setDockState({ key, mode: "open" });
      requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
    }
  };
  const jump = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, []);
  // content that settles after the first paint (fonts, formulas) keeps a reader at the bottom where they were
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) jump();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [jump, session]);
  // the transcript sticks to the bottom while the reader is there, and a change of geometry mutes the fold for a moment
  useLayoutEffect(() => {
    mutedUntil.current = Date.now() + MUTE_MS;
    if (stick.current) jump();
  }, [blocks, state.steers.length, jump]);

  /* forms and drafts, kept in the model by question key */
  const qkey = pending?.key ?? "";
  const form: FormState = (qkey && model.draft(qkey)?.form) || emptyForm();
  const reading = (qkey && model.draft(qkey)?.reading) || "";
  const setForm = (f: FormState) => {
    if (qkey) model.saveDraft(qkey, { form: f });
    bump();
  };
  const setReading = (t: string) => {
    if (qkey) model.saveDraft(qkey, { reading: t });
    bump();
  };
  const [submitting, setSubmitting] = useState(false);
  const submitAnswer = async () => {
    if (!pending?.question || submitting) return;
    setSubmitting(true);
    model.saveDraft(pending.key, { form, reading });
    await model.send({ type: "answer", toolCallId: pending.toolCallId, answer: buildAnswer(form, pending.question, reading) }, { questionKey: pending.key });
    setSubmitting(false);
    bump();
  };

  /* Escape: the window level fallback, below every layer that opens above it */
  const target = escTarget({ confirmOpen: confirm !== null, plan: planOpen, setup: false, question: !!pending, problem: !!problem, busy });
  const escRef = useRef(target);
  useEffect(() => {
    escRef.current = target;
  });
  useEffect(() => {
    const off = pushEscape(() => {
      if (!root.current?.contains(document.activeElement) && document.activeElement !== document.body) return false;
      const t = escRef.current;
      if (t === "turn" || t === "question" || t === "problem") {
        setConfirm(t);
        return true;
      }
      return false;
    });
    return off;
  }, []);

  /* keys of the window: find, rename and the switch for the thinking rows */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!root.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      } else if (e.key === "F2") {
        e.preventDefault();
        setRename((n) => n + 1);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") {
        e.preventDefault();
        toggleAllThinking();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const confirmAction = async () => {
    const c = confirm;
    setConfirm(null);
    if (c === "turn") await model.abort();
    else if (c === "question" && pending) {
      await model.dismissQuestion({ toolCallId: pending.toolCallId, questionKey: pending.key, readingThinking: reading });
      if (busy) await model.abort();
    } else if (c === "problem" && problem) {
      await model.dismissProblem(problem.callId);
      if (busy) await model.abort();
    }
    onChanged();
  };

  /* stats and controls */
  const modelRef = session?.settings?.model ?? catalog.data?.defaults ?? null;
  const entry = catalog.data?.models.find((m) => m.provider === modelRef?.provider && m.id === modelRef?.id);
  const level = session?.settings?.thinkingLevel ?? "off";
  const stats = (
    <Popover
      label="Session stats"
      up
      button={({ toggle, open }) => (
        <button type="button" aria-expanded={open} className="max-w-full truncate rounded-md px-1 text-left hover:bg-raised hover:text-ink" onClick={toggle}>
          {contextWords(contextTokens(messages), entry?.contextWindow ?? null)} · {costWords(detail.data?.pricing.cost ?? null)}
        </button>
      )}
    >
      <dl className="grid w-72 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 p-3 font-sans text-small">
        <dt className="text-ink-soft">Context</dt>
        <dd className="num font-mono text-ink">{contextWords(contextTokens(messages), entry?.contextWindow ?? null)}</dd>
        <dt className="text-ink-soft">Cost</dt>
        <dd className="num font-mono text-ink">{costWords(detail.data?.pricing.cost ?? null)}</dd>
        <dt className="text-ink-soft">Cache hits</dt>
        <dd className="num font-mono text-ink">{cacheWords(detail.data?.pricing.cacheHitRate ?? null)}</dd>
        <dt className="text-ink-soft">Turns</dt>
        <dd className="num font-mono text-ink">{session?.turns?.length ?? 0}</dd>
      </dl>
    </Popover>
  );
  const controls = (
    <>
      <select
        aria-label="Model"
        className={SELECT}
        value={modelRef ? `${modelRef.provider}:${modelRef.id}` : ""}
        onChange={(e) => {
          const [provider, ...rest] = e.target.value.split(":");
          void learnSessions.settings(id, { model: { provider, id: rest.join(":") }, thinkingLevel: level }).then(detail.reload);
        }}
      >
        {!modelRef ? <option value="">Choose a model</option> : null}
        {(catalog.data?.models ?? []).map((m) => (
          <option key={`${m.provider}:${m.id}`} value={`${m.provider}:${m.id}`}>
            {m.name}
          </option>
        ))}
      </select>
      <select
        aria-label="Thinking level"
        className={SELECT}
        value={level}
        onChange={(e) => {
          if (modelRef) void learnSessions.settings(id, { model: modelRef, thinkingLevel: e.target.value as ThinkingLevel }).then(detail.reload);
        }}
      >
        {(entry?.supportedLevels?.length ? entry.supportedLevels : THINKING_LEVELS).map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
    </>
  );

  const refusal = state.refusal && isSetupRefusal(state.refusal.code) ? state.refusal : null;
  const notice = refusal
    ? { text: refusal.code === "provider_key_missing" ? "Add a provider key" : refusal.code === "claude_code_unavailable" || refusal.code === "consent_required" ? "Set up Claude Code" : "Choose your models", onPress: () => bus.emit("open", { app: "settings" }) }
    : catalog.data && !catalog.data.slots.strong
      ? { text: setupNotice(catalog.data.models.length === 0 ? "keys" : "models") ?? "Choose your models", onPress: () => bus.emit("open", { app: "settings" }) }
      : null;

  const malformedReason = pending ? "Answer or dismiss the question that is waiting first." : state.compacting ? "Wait until the session has been compacted." : null;
  const dockFolded = dockState.mode === "folded";
  const variant = dockVariant({ pendingQuestion: !!pending?.question, activeProblem: !!problem });

  return (
    <div ref={root} className="relative flex h-full min-h-0 min-w-0 flex-col">
      <SessionBar
        title={session?.title ?? "Session"}
        onRename={(t) => void learnSessions.rename(id, t).then(() => { detail.reload(); onChanged(); })}
        practice={practice}
        phase={phase}
        hasPlan={!!tree}
        onPlan={() => setPlanOpen(true)}
        coverage={detail.data?.coverage ?? null}
        extracting={extracting}
        onExtract={() => {
          setExtracting(true);
          void learnSessions.extract(id).finally(() => { setExtracting(false); detail.reload(); });
        }}
        onToggleSidebar={onToggleSidebar}
        renameSignal={rename}
      />
      {findOpen ? <FindBar root={scroller} refresh={state.version} onClose={() => setFindOpen(false)} /> : null}
      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="h-full min-h-0 overflow-y-auto">
          {detail.error && !session ? <ErrorLine onRetry={detail.reload}>{`The session could not load. ${detail.error}`}</ErrorLine> : null}
          {!session && !detail.error ? <p role="status" className="px-6 py-6 text-center text-body text-ink-faint">Loading the session.</p> : null}
          {session && blocks.length === 0 && !busy ? <p className="px-6 py-10 text-center text-body text-ink-faint">Nothing has been said yet. Write below to begin.</p> : null}
          <div ref={content}>
          <Transcript
            blocks={blocks}
            names={names}
            thinking={state.status === "submitted" || (live && blocks.length > 0 && blocks[blocks.length - 1].kind === "user")}
            compacting={state.compacting}
            failure={state.failure}
            onRetry={state.failure && !busy ? () => void model.send({ type: "retry" }) : null}
            onOpenPlan={() => setPlanOpen(true)}
            retryDisabled={malformedReason}
            onRetryQuestion={(b) => void model.send({ type: "retry-question", messageId: b.messageId, contentIndex: b.contentIndex, toolCallId: b.callId })}
          />
          </div>
        </div>
        {distance > 96 ? (
          <div className="absolute bottom-3 right-4">
            <IconButton icon={ChevronsDown} label="Jump to latest" className="border border-rule-strong bg-surface" onClick={jump} />
          </div>
        ) : null}
        {planOpen && tree ? <PlanPopup nodes={tree.nodes.map((n) => ({ id: n.id, title: n.title, status: statuses[n.id] ?? "upcoming" }))} edges={tree.edges} statuses={statuses} onClose={() => setPlanOpen(false)} /> : null}
      </div>
      <Dock
        variant={variant}
        compacting={state.compacting}
        steers={state.steers}
        notice={notice}
        error={state.error ? <ErrorLine>{state.error}</ErrorLine> : null}
        stats={stats}
        controls={controls}
        composer={{
          busy,
          blocked: state.compacting,
          pause,
          placeholder: pause ? "Ask anything, or press Enter for the next problem" : "Ask, answer or steer the lesson",
          onSend: async (t) => model.send({ type: "text", text: t }),
          onSteer: (t) => void model.steer(t),
          onStop: () => setConfirm("turn"),
          onNext: () => void model.send({ type: "next" }),
        }}
        question={
          pending?.question
            ? {
                key: pending.key,
                q: pending.question,
                form,
                onForm: setForm,
                reading,
                onReading: setReading,
                arrival: dockState.mode,
                onOpen: () => setDockState({ key, mode: "open" }),
                onSubmit: () => void submitAnswer(),
                submitting,
                maxArea: areaCeiling(height, 90),
              }
            : null
        }
        problem={problem ? { statement: problem.statement, submitting, folded: dockFolded, onOpen: () => setDockState({ key, mode: "open" }), onSubmit: (t) => void model.send({ type: "thinking", problemCallId: problem.callId, text: t }) } : null}
      />
      {confirm ? (
        <ConfirmDialog
          title={confirm === "turn" ? "Abort this turn?" : confirm === "question" ? "Dismiss this question?" : "Discard this problem?"}
          body={confirm === "turn" ? "The partial answer stays." : confirm === "question" ? "The teacher moves on." : "No solution is revealed."}
          confirm={confirm === "turn" ? "Abort" : confirm === "question" ? "Dismiss" : "Discard"}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmAction()}
        />
      ) : null}
      <span className="sr-only" aria-live="polite">{state.steers.length ? "A message is waiting for the teacher." : ""}</span>
    </div>
  );
}
