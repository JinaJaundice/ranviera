// A new session before it exists. Nothing is created until the first message is sent, so an empty draft leaves no session
// behind, and a refusal keeps the words in the field.
import { useMemo, useRef, useState } from "react";
import { Dumbbell, GraduationCap, PanelLeft } from "lucide-react";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { Segmented } from "../../components/Segmented";
import { bus } from "../../lib/bus";
import { failureText } from "../../lib/learn/http";
import { fuzzyFilter } from "../../lib/learn/fuzzy";
import { learnKnowledge } from "../../lib/learn/knowledge";
import { learnModels, setupGap } from "../../lib/learn/models";
import { learnSessions } from "../../lib/learn/sessions";
import { useFetched } from "../../lib/learn/useFetched";
import { useStore } from "../../lib/store";
import { Dock } from "./Dock";
import { Dialog, ErrorLine } from "../sources/parts";
import { MAX_PICKS, Starter, setupNotice } from "./draft";
import { stashOpening } from "./useSession";

function PickDialog({ picks, onChange, onClose }: { picks: string[]; onChange: (p: string[]) => void; onClose: () => void }) {
  const graph = useFetched(() => learnKnowledge.graph(), "pick");
  const [query, setQuery] = useState("");
  const rows = useMemo(() => fuzzyFilter(graph.data?.propositions ?? [], query, (p) => [p.name, p.statement, ...p.aliases]), [graph.data, query]);
  const chosen = new Set(picks);
  const toggle = (id: string) => onChange(chosen.has(id) ? picks.filter((x) => x !== id) : picks.length >= MAX_PICKS ? picks : [...picks, id]);
  return (
    <Dialog
      title="Pick claims"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" disabled={picks.length === 0} onClick={() => onChange([])}>
            Clear
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <input type="search" aria-label="Search claims" value={query} placeholder="Search claims" className="mb-2 h-8 w-full min-w-0 rounded-md border border-rule-strong bg-sunken px-2 text-body text-ink placeholder:text-ink-faint" onChange={(e) => setQuery(e.target.value)} />
      {graph.error ? <ErrorLine onRetry={graph.reload}>{`The claims could not load. ${graph.error}`}</ErrorLine> : null}
      {graph.loading && !graph.data ? <p role="status" className="py-4 text-center text-body text-ink-faint">Loading the claims.</p> : null}
      {graph.data && graph.data.propositions.length === 0 ? <p className="py-4 text-center text-body text-ink-faint">The graph holds no claims yet. Link a folder in the Sources window first.</p> : null}
      {graph.data && graph.data.propositions.length > 0 && rows.length === 0 ? <p className="py-4 text-center text-body text-ink-faint">No claims match.</p> : null}
      <ul className="max-h-72 space-y-0.5 overflow-y-auto">
        {rows.map((p) => (
          <li key={p.id}>
            <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-raised">
              <input type="checkbox" className="mt-1 accent-signal" checked={chosen.has(p.id)} onChange={() => toggle(p.id)} />
              <span className="min-w-0">
                <span className="block text-body font-medium text-ink">{p.name}</span>
                <span className="block text-small text-ink-soft">{p.statement}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="num mt-2 font-mono text-small text-ink-soft">{`${picks.length} of ${MAX_PICKS} picked`}</p>
    </Dialog>
  );
}

export function DraftView({ initialKind, onCreated, onToggleSidebar }: { initialKind: "teach" | "practice"; onCreated: (id: string) => void; onToggleSidebar: () => void }) {
  const [kind, setKind] = useState(initialKind);
  const [picks, setPicks] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const starter = useRef(new Starter());
  const signals = useStore((s) => s.learnSignals);
  const catalog = useFetched(() => learnModels.catalog(), "catalog", signals["models-changed"] ?? 0);
  const gap = catalog.data ? setupGap(catalog.data) : null;
  const notice = setupNotice(gap);
  const practice = kind === "practice";

  const start = async (text: string): Promise<boolean> => {
    setError(null);
    if (gap) {
      bus.emit("open", { app: "settings" });
      return false;
    }
    try {
      const id = await starter.current.start({ text, kind, picks }, async (body) => ({ id: (await learnSessions.create(body)).id }));
      if (!id) return false;
      stashOpening(id, text);
      onCreated(id);
      return true;
    } catch (e) {
      setError(`The session could not be started. Your message is still here. ${failureText(e, "")}`.trim());
      return false;
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-rule px-3 text-ui font-medium text-ink">
        <span className="@min-[720px]:hidden">
          <IconButton icon={PanelLeft} label="Show the sessions" size={14} className="h-6 w-6" onClick={onToggleSidebar} />
        </span>
        {practice ? "New practice session" : "New session"}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6">
        <div className="max-w-prose text-center">
          {practice ? <Dumbbell size={20} aria-hidden="true" className="mx-auto mb-3 text-ink-faint" /> : <GraduationCap size={20} aria-hidden="true" className="mx-auto mb-3 text-ink-faint" />}
          <h2 className="text-title font-medium text-ink">{practice ? "What do you want to practise?" : "What do you want to learn?"}</h2>
          <p className="mt-2 text-body text-ink-soft">
            {practice
              ? "Pick claims from the knowledge layer, write a topic, or give the path of a file. The teacher poses one problem at a time."
              : "Describe the subject. The teacher asks a few questions first to see what you already hold, then plans the lessons."}
          </p>
        </div>
      </div>
      <Dock
        variant="composer"
        compacting={false}
        steers={[]}
        notice={notice ? { text: notice, onPress: () => bus.emit("open", { app: "settings" }) } : null}
        error={error ? <ErrorLine>{error}</ErrorLine> : null}
        above={
          practice || picks.length ? (
            <div className="flex items-center gap-2">
              <button type="button" className="inline-flex h-7 items-center rounded-md border border-dashed border-rule-strong px-2.5 text-small text-ink hover:bg-raised" onClick={() => setPicking(true)}>
                {picks.length ? `${picks.length} ${picks.length === 1 ? "claim" : "claims"} selected` : "Pick claims"}
              </button>
              {picks.length ? (
                <Button variant="ghost" className="h-7 text-small" onClick={() => setPicks([])}>
                  Clear
                </Button>
              ) : null}
            </div>
          ) : null
        }
        lead={
          <Segmented<"teach" | "practice">
            label="Mode"
            value={kind}
            onChange={setKind}
            options={[
              { value: "teach", label: "Teach" },
              { value: "practice", label: "Practice" },
            ]}
          />
        }
        stats="No turns yet"
        controls={null}
        composer={{ busy: false, blocked: false, pause: false, placeholder: practice ? "What do you want to practise?" : "What do you want to learn?", onSend: start, onSteer: () => undefined, onStop: () => undefined, onNext: () => undefined }}
        question={null}
        problem={null}
      />
      {picking ? <PickDialog picks={picks} onChange={setPicks} onClose={() => setPicking(false)} /> : null}
    </div>
  );
}
