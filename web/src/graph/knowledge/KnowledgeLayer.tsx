// The Knowledge layer of the Graph window: a side panel, a toolbar and the canvas of claims. It reads GET /api/learn/graph and
// fetches again after the learning stream says that the graph, the sources or the activity changed (notify, then fetch).
import { useEffect, useMemo, useRef, useState } from "react";
import { Layers, Maximize, PanelLeft, Search, SlidersHorizontal, Table2, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "../../components/Button";
import { Empty } from "../../components/Empty";
import { IconButton } from "../../components/IconButton";
import { Section } from "../../components/Section";
import { StatusDot } from "../../components/StatusDot";
import { ErrorLine, LoadLine } from "../../apps/sources/parts";
import { PassageView } from "../../apps/sources/PassageView";
import { bus } from "../../lib/bus";
import { pushEscape } from "../../lib/learn/escape";
import { failureText } from "../../lib/learn/http";
import { costWords, learnKnowledge, statusWords } from "../../lib/learn/knowledge";
import { useFetched } from "../../lib/learn/useFetched";
import { useStore } from "../../lib/store";
import { X } from "lucide-react";
import { cardPosition, sourcesOf, type CardPosition, type SourceRef } from "./card";
import { searchClaims, tableCounts } from "./chains";
import { ChainTable } from "./ChainTable";
import type { Pt } from "./geometry";
import { KnowledgeCanvas, type CanvasHandle } from "./KnowledgeCanvas";
import { LayerSwitch } from "./LayerSwitch";
import { NodeCard } from "./NodeCard";
import { buildScene } from "./scene";
import { SettingsPanel } from "./SettingsPanel";
import { readSettings } from "./settings";
import type { RenderSettings } from "@shared/learn/knowledge";

const TOKEN_DOT: Record<string, string> = {
  "--color-fam-instruction": "bg-fam-instruction",
  "--color-fam-machinery": "bg-fam-machinery",
  "--color-fam-record": "bg-fam-record",
  "--color-fam-work": "bg-fam-work",
  "--color-fam-world": "bg-fam-world",
  "--color-fam-language": "bg-fam-language",
};

const FIELD = "h-8 w-full min-w-0 rounded-md border border-rule-strong bg-sunken px-2 text-body text-ink placeholder:text-ink-faint";
const SAVE_DELAY = 400;

export function KnowledgeLayer() {
  const signals = useStore((s) => s.learnSignals);
  const cap = useStore((s) => s.graphView.cap);
  const graphSignal = (signals["graph-changed"] ?? 0) + (signals["sources-changed"] ?? 0);
  const liveSignal = graphSignal + (signals["activity-changed"] ?? 0) + (signals["jobs-changed"] ?? 0);
  const snapLoad = useFetched(() => learnKnowledge.graph(cap), `graph:${cap}`, graphSignal);
  const settingsLoad = useFetched(() => learnKnowledge.renderSettings(), "render-settings", signals["settings-changed"] ?? 0);
  const statusLoad = useFetched(() => learnKnowledge.status(), "status", liveSignal);
  const costLoad = useFetched(() => learnKnowledge.costs(), "costs", liveSignal);

  const snap = snapLoad.data;
  const [draft, setDraft] = useState<RenderSettings | null>(null);
  const settings = useMemo(() => draft ?? readSettings(settingsLoad.data), [draft, settingsLoad.data]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );
  const changeSettings = (next: RenderSettings) => {
    setDraft(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      learnKnowledge.saveRenderSettings(next).then(
        () => setSaveError(null),
        (e: unknown) => setSaveError(failureText(e, "The settings could not be saved.")),
      );
    }, SAVE_DELAY);
  };

  const [moved, setMoved] = useState<{ rev: number; pos: Record<string, Pt> } | null>(null);
  const override = snap && moved && moved.rev === snap.revision ? moved.pos : undefined;
  const scene = useMemo(() => (snap ? buildScene(snap, settings.nodeSize, override) : null), [snap, settings.nodeSize, override]);

  const canvas = useRef<CanvasHandle>(null);
  const area = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<{ id: string; pos: CardPosition } | null>(null);
  const [passage, setPassage] = useState<{ source: SourceRef; range: { from: number; to?: number } } | null>(null);
  const [table, setTable] = useState(false);
  const [panel, setPanel] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [lit, setLit] = useState<{ cluster: string; ids: ReadonlySet<string> } | null>(null);

  useEffect(() => (passage ? pushEscape(() => setPassage(null)) : undefined), [passage]);
  useEffect(() => (panel ? pushEscape(() => setPanel(false)) : undefined), [panel]);

  const propById = useMemo(() => new Map((snap?.propositions ?? []).map((p) => [p.id, p])), [snap]);
  const hits = useMemo(() => (snap ? searchClaims(snap, query) : []), [snap, query]);

  const place = (id: string, at: Pt | null) => {
    const r = area.current?.getBoundingClientRect();
    if (!r || !at || !propById.has(id)) return setCard(null);
    setCard({ id, pos: cardPosition(at, { w: r.width, h: r.height }) });
  };
  const pickClaim = (id: string) => {
    setTable(false);
    const at = canvas.current?.focus(id) ?? null;
    place(id, at);
  };

  if (snapLoad.error && !snap) {
    return (
      <div className="h-full min-h-0 min-w-0 bg-surface">
        <ErrorLine onRetry={snapLoad.reload}>{`The knowledge graph could not load. ${snapLoad.error}`}</ErrorLine>
      </div>
    );
  }
  if (!snap || !scene)
    return (
      <div className="h-full min-h-0 min-w-0 bg-surface">
        <LoadLine what="the knowledge graph" />
      </div>
    );

  const counts = tableCounts(snap);
  const cardClaim = card ? propById.get(card.id) : undefined;
  const status = statusLoad.data;
  const running = !!status && status.length > 0;

  const side = (
    <>
      <div className="flex items-end justify-between gap-2 px-4 py-3">
        <LayerSwitch />
        <IconButton icon={X} label="Close the side panel" onClick={() => setSideOpen(false)} className="h-6 w-6 @min-[720px]:hidden" size={14} />
      </div>
      <Section title="Find a claim">
        <div className="relative">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2 top-2.5 text-ink-faint" />
          <input
            type="search"
            aria-label="Search claims by name, alias or statement"
            placeholder="Search claims"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hits[0]) pickClaim(hits[0]);
            }}
            className={`${FIELD} pl-7`}
          />
        </div>
        {query.trim() ? (
          hits.length ? (
            <ul className="mt-2 divide-y divide-rule">
              {hits.map((id) => (
                <li key={id}>
                  <button type="button" onClick={() => pickClaim(id)} className="block w-full min-w-0 rounded-sm px-1 py-1.5 text-left hover:bg-raised">
                    <span className="block truncate text-body text-ink">{propById.get(id)?.name}</span>
                    <span className="block truncate text-small text-ink-soft">{propById.get(id)?.statement}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-small text-ink-faint">No claim matches that text.</p>
          )
        ) : null}
      </Section>
      <Section title="Sources" note="Each area on the map holds the claims first read from one source. A source with fewer than three claims has no area.">
        {scene.clusters.length ? (
          <ul className="space-y-0.5">
            {scene.clusters.map((c) => {
              const on = lit?.cluster === c.id;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      if (on) return setLit(null);
                      setLit({ cluster: c.id, ids: new Set(c.members) });
                      if (c.members[0]) canvas.current?.focus(c.members[0]);
                    }}
                    className={`flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-raised ${on ? "bg-raised" : ""}`}
                  >
                    <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${TOKEN_DOT[c.token]}`} />
                    <span className="min-w-0 flex-1 truncate text-body text-ink" title={c.label}>
                      {c.label}
                    </span>
                    <span className="num text-small text-ink-soft">{c.members.length}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-small text-ink-faint">No source has three claims yet, so no area is drawn.</p>
        )}
      </Section>
      <Section title="Summary">
        <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-1 text-body">
          <dt className="text-ink-faint">Claims</dt>
          <dd className="num text-ink">{counts.claims}</dd>
          <dt className="text-ink-faint">Chains</dt>
          <dd className="num text-ink">{counts.chains}</dd>
          <dt className="text-ink-faint">Sources</dt>
          <dd className="num text-ink">{Object.keys(snap.sessions).length + Object.keys(snap.fileSources).length}</dd>
        </dl>
      </Section>
    </>
  );

  return (
    <div className="@container h-full min-h-0 min-w-0">
      <div className="relative grid h-full min-h-0 min-w-0 grid-cols-1 bg-surface text-ink @min-[720px]:grid-cols-[260px_minmax(0,1fr)]">
        <aside
          className={`min-h-0 min-w-0 overflow-y-auto border-r border-rule bg-surface ${sideOpen ? "absolute inset-y-0 left-0 z-30 block w-64 @min-[720px]:static @min-[720px]:w-auto" : "hidden @min-[720px]:block"}`}
        >
          {side}
        </aside>
        <div className="relative flex min-h-0 min-w-0 flex-col">
          <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-rule bg-surface px-2 py-0.5">
            <IconButton
              icon={PanelLeft}
              label={sideOpen ? "Hide the side panel" : "Show the side panel"}
              active={sideOpen}
              onClick={() => setSideOpen((v) => !v)}
              className="h-6 w-6 @min-[720px]:hidden"
              size={14}
            />
            <p className="flex min-w-0 flex-1 items-center gap-1.5 text-small text-ink-soft" role="status">
              <StatusDot tone={running ? "pass" : "idle"} />
              <span className="min-w-0 truncate">{statusLoad.error ? "Status not read" : statusWords(status)}</span>
            </p>
            <span className="num shrink-0 rounded-md border border-rule px-2 py-0.5 text-small text-ink-soft" title="Cost of the newest ten extraction runs">
              {costLoad.error ? "Cost not read" : costWords(costLoad.data)}
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              <IconButton icon={ZoomOut} label="Zoom out" onClick={() => canvas.current?.zoomBy(0.8)} className="h-6 w-6" size={14} />
              <IconButton icon={ZoomIn} label="Zoom in" onClick={() => canvas.current?.zoomBy(1.25)} className="h-6 w-6" size={14} />
              <IconButton icon={Maximize} label="Fit the graph" onClick={() => canvas.current?.fit()} className="h-6 w-6" size={14} />
              <IconButton icon={Table2} label="Chain table" active={table} onClick={() => setTable((v) => !v)} className="h-6 w-6" size={14} />
              <IconButton icon={SlidersHorizontal} label="Render settings" active={panel} onClick={() => setPanel((v) => !v)} className="h-6 w-6" size={14} />
            </div>
          </div>
          <div ref={area} className="relative min-h-0 flex-1">
            {snap.nodes.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 bg-sunken px-4">
                <Layers size={20} aria-hidden="true" className="text-ink-faint" />
                <Empty>No claims yet. Link a folder of notes in the Sources window and extract it, or finish a lesson.</Empty>
                <Button variant="secondary" onClick={() => bus.emit("open", { app: "sources" })}>
                  Open Sources
                </Button>
              </div>
            ) : (
              <KnowledgeCanvas
                ref={canvas}
                scene={scene}
                settings={settings}
                selectedId={card?.id ?? null}
                bright={lit?.ids ?? null}
                onPick={(id, at) => (id ? place(id, at) : setCard(null))}
                onMove={() => setCard(null)}
                onCommit={(positions) => {
                  setMoved({ rev: snap.revision, pos: positions });
                  learnKnowledge.commitPositions(positions).catch(() => setSaveError("The new positions could not be saved."));
                }}
              />
            )}
            {card && cardClaim ? (
              <NodeCard
                key={card.id}
                proposition={cardClaim}
                sources={sourcesOf(cardClaim, snap)}
                pos={card.pos}
                onClose={() => setCard(null)}
                onOpenPassage={(source, range) => setPassage({ source, range })}
                onRatified={snapLoad.reload}
              />
            ) : null}
            {panel ? <SettingsPanel settings={settings} onChange={changeSettings} onClose={() => setPanel(false)} error={saveError} /> : null}
            {table ? <ChainTable snap={snap} onClose={() => setTable(false)} onPickClaim={pickClaim} /> : null}
            {passage ? (
              <div
                role="dialog"
                aria-label={`Passage from ${passage.source.label}`}
                className="absolute inset-y-0 right-0 z-30 flex w-full max-w-md min-w-0 flex-col border-l border-rule-strong bg-overlay"
              >
                <div className="flex h-8 shrink-0 items-center gap-2 border-b border-rule pl-3 pr-1">
                  <p className="addr min-w-0 flex-1 truncate" title={passage.source.label}>
                    {passage.source.label}
                  </p>
                  <IconButton icon={X} label="Close the passage" onClick={() => setPassage(null)} className="h-6 w-6" size={14} />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <PassageView key={`${passage.source.id}:${passage.range.from}`} source={passage.source.id} from={passage.range.from} to={passage.range.to} />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
