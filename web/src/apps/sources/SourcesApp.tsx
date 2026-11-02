// The Sources window: linked roots, then folders, then files, with the state of each file and the actions of each root. It
// fetches again when the learning stream says that the sources changed (notify, then fetch).
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, FolderPlus, FolderSymlink, Search } from "lucide-react";
import type { FileRecord, RootSummary } from "@shared/learn/sources";
import { Button } from "../../components/Button";
import { StatusDot } from "../../components/StatusDot";
import { moveFocus, ensureFocus, type NavKey, type NavRow } from "../../lib/learn/nav";
import { learnSources, STATE_WORDS } from "../../lib/learn/sources";
import { useFetched } from "../../lib/learn/useFetched";
import { useStore } from "../../lib/store";
import { AddRootForm } from "./AddRootForm";
import { FileDetail, FolderDetail, RootDetail } from "./Detail";
import { SensitivityChip } from "./SensitivityChip";
import { UnlinkDialog } from "./UnlinkDialog";
import { ErrorLine, LoadLine } from "./parts";
import { FIELD } from "./style";
import { buildTree, matchingFiles, nodeIndex, selectedPaths, summaryCounts, toggleSelection, triState, visibleRows, type TreeNode } from "./tree";
import { STATE_TONE, extractWords, resultWords, countsWords, summaryWords } from "./words";
import { failureText } from "../../lib/learn/http";

interface Loaded {
  roots: RootSummary[];
  files: Record<string, FileRecord[]>;
}

async function loadAll(): Promise<Loaded> {
  const roots = await learnSources.roots();
  const lists = await Promise.all(roots.map((r) => learnSources.files(r.id)));
  return { roots, files: Object.fromEntries(roots.map((r, i) => [r.id, lists[i]])) };
}

const COLS = "grid-cols-[20px_minmax(0,1fr)] @min-[720px]:grid-cols-[20px_minmax(0,1fr)_132px_minmax(0,1.1fr)]";

function Check({ state, label, onChange, disabled }: { state: "none" | "some" | "all"; label: string; onChange: () => void; disabled: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return <input ref={ref} type="checkbox" aria-label={label} className="accent-signal" tabIndex={-1} checked={state === "all"} disabled={disabled} onChange={onChange} onClick={(e) => e.stopPropagation()} />;
}

export function SourcesApp() {
  const signal = useStore((s) => s.learnSignals["sources-changed"] ?? 0);
  const load = useFetched(loadAll, "all", signal);
  const data = load.data;
  const forest = useMemo(() => (data ? buildTree(data.roots, data.files) : []), [data]);
  const index = useMemo(() => nodeIndex(forest), [forest]);

  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const treeEl = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => matchingFiles(forest, query), [forest, query]);
  const rows = useMemo(() => visibleRows(forest, opened, closed, matches), [forest, opened, closed, matches]);
  const navRows: NavRow[] = useMemo(() => rows.map((r) => ({ id: r.node.id, parentId: r.node.parentId, hasChildren: r.node.children.length > 0, open: r.open })), [rows]);
  const active = ensureFocus(navRows, focus);
  const shown = (current && index.get(current)) || null;
  const firstRoot = forest[0]?.id ?? null;
  // the first root is the detail until a row is chosen
  const detailNode = shown ?? (firstRoot ? (index.get(firstRoot) ?? null) : null);
  const totals = summaryCounts(forest);

  useEffect(() => {
    if (active) document.getElementById(`sr-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const setOpen = (id: string, open: boolean) => {
    if (matches) {
      const next = new Set(closed);
      if (open) next.delete(id);
      else next.add(id);
      setClosed(next);
    } else {
      const next = new Set(opened);
      if (open) next.add(id);
      else next.delete(id);
      setOpened(next);
    }
  };
  const choose = (n: TreeNode) => {
    setFocus(n.id);
    setCurrent(n.id);
    setAdding(false);
  };
  const say = (tone: "info" | "error", text: string) => setNotice({ tone, text });

  const extractRoot = async (rootId: string, paths?: string[], confirm?: boolean) => {
    const r = await learnSources.extract(rootId, { ...(paths ? { paths } : {}), ...(confirm ? { confirm } : {}) });
    say("info", extractWords(r.started, r.queued));
    load.reload();
  };
  const extractSelected = async () => {
    const roots = forest.filter((r) => selectedPaths(forest, r.id, selected).length);
    try {
      let started = 0;
      let queued = 0;
      for (const r of roots) {
        const res = await learnSources.extract(r.id, { paths: selectedPaths(forest, r.id, selected) });
        started += res.started;
        queued += res.queued;
      }
      say("info", extractWords(started, queued));
      setSelected(new Set());
      load.reload();
    } catch (e) {
      say("error", failureText(e, "Extraction could not be started."));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const r = moveFocus(navRows, active, e.key as NavKey);
      if (r.toggle) setOpen(r.toggle.id, r.toggle.open);
      setFocus(r.focus);
    } else if (e.key === " ") {
      const n = active ? index.get(active) : null;
      if (n && n.selectable.length) {
        e.preventDefault();
        setSelected(toggleSelection(n, selected));
      }
    } else if (e.key === "Enter") {
      const n = active ? index.get(active) : null;
      if (n) {
        e.preventDefault();
        choose(n);
      }
    }
  };

  const unlinkRoot = unlinking ? (data?.roots.find((r) => r.id === unlinking) ?? null) : null;
  const selectedCount = selected.size;

  let body: React.ReactNode;
  if (load.error && !data) body = <ErrorLine onRetry={load.reload}>{`The linked sources could not load. ${load.error}`}</ErrorLine>;
  else if (!data) body = <LoadLine what="the linked sources" />;
  else if (forest.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-3 px-4 py-10">
        <p className="text-center text-body text-ink-faint">No sources are linked yet. Link a folder of notes to start the graph.</p>
        <Button variant="primary" icon={<FolderPlus size={14} aria-hidden="true" />} onClick={() => { setAdding(true); }}>
          Link a source
        </Button>
      </div>
    );
  } else if (rows.length === 0) body = <p className="px-4 py-8 text-center text-body text-ink-faint">No matching files.</p>;
  else {
    body = (
      <div
        ref={treeEl}
        role="tree"
        tabIndex={0}
        aria-label="Linked roots, folders and files"
        aria-multiselectable="true"
        aria-activedescendant={active ? `sr-${active}` : undefined}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {rows.map(({ node: n, open }) => {
          const tri = triState(n, selected);
          const on = n.id === active;
          const pad = { paddingLeft: 8 + n.depth * 16 };
          const isFile = n.kind === "file";
          const Chev = open ? ChevronDown : ChevronRight;
          const Icon = n.kind === "root" ? FolderSymlink : n.kind === "folder" ? (open ? FolderOpen : Folder) : FileText;
          return (
            <div
              key={n.id}
              id={`sr-${n.id}`}
              role="treeitem"
              aria-level={n.depth + 1}
              aria-expanded={n.children.length ? open : undefined}
              aria-selected={tri === "all"}
              onClick={() => {
                choose(n);
                if (n.children.length) setOpen(n.id, !open);
              }}
              className={`grid ${COLS} min-h-8 cursor-pointer items-center gap-2 border-b border-rule pr-3 ${on ? "bg-raised" : "hover:bg-raised"} ${current === n.id ? "border-l-2 border-l-signal" : ""}`}
            >
              <span className="pl-2">
                <Check state={tri} label={`Select ${n.label}`} disabled={n.selectable.length === 0} onChange={() => setSelected(toggleSelection(n, selected))} />
              </span>
              <div className="flex min-w-0 items-center gap-1.5 py-1" style={pad}>
                {n.children.length ? <Chev size={14} aria-hidden="true" className="shrink-0 text-ink-faint" /> : <span className="w-3.5 shrink-0" />}
                <Icon size={14} aria-hidden="true" className="shrink-0 text-ink-faint" />
                <span className={`min-w-0 truncate text-body ${isFile ? "text-ink" : "font-medium text-ink"}`} title={n.label}>
                  {n.label}
                </span>
                {n.root && !n.root.enabled ? <span className="shrink-0 rounded-md border border-rule px-1.5 py-0.5 text-caption text-ink-soft">Off</span> : null}
              </div>
              <div className="hidden min-w-0 items-center gap-1.5 text-small text-ink-soft @min-[720px]:flex">
                {n.file ? (
                  <>
                    <StatusDot tone={STATE_TONE[n.file.state]} />
                    <span className="truncate">{STATE_WORDS[n.file.state]}</span>
                  </>
                ) : n.root ? (
                  <SensitivityChip value={n.root.sensitivity} />
                ) : (
                  <span className="num truncate">{n.counts.files} {n.counts.files === 1 ? "file" : "files"}</span>
                )}
              </div>
              <p className="hidden min-w-0 truncate text-small text-ink-soft @min-[720px]:block" title={n.file ? resultWords(n.file) : countsWords(n.counts)}>
                {n.file ? resultWords(n.file) : countsWords(n.counts)}
              </p>
            </div>
          );
        })}
      </div>
    );
  }

  const detail = adding ? (
    <AddRootForm
      onCancel={() => setAdding(false)}
      onAdded={(root) => {
        setAdding(false);
        setCurrent(root.id);
        say("info", `${root.label} is linked. Scan it to list its files.`);
        load.reload();
      }}
    />
  ) : detailNode ? (
    detailNode.kind === "root" ? (
      <RootDetail
        key={detailNode.id}
        node={detailNode}
        selectedPaths={selectedPaths(forest, detailNode.id, selected)}
        actions={{
          scan: async () => {
            const r = await learnSources.scan(detailNode.id);
            const c = r.counts;
            say("info", `Scan finished. ${c.new} new, ${c.changed} changed, ${c.moved} moved, ${c.missing} not found and ${c.unchanged} unchanged.`);
            load.reload();
          },
          extract: (paths, confirm) => extractRoot(detailNode.id, paths, confirm),
          changed: load.reload,
          unlink: () => setUnlinking(detailNode.id),
          notice: say,
        }}
      />
    ) : detailNode.kind === "folder" ? (
      <FolderDetail node={detailNode} />
    ) : (
      <FileDetail key={detailNode.id} node={detailNode} onExtract={() => extractRoot(detailNode.rootId, [detailNode.file!.path]).catch((e: unknown) => say("error", failureText(e, "Extraction could not be started.")))} />
    )
  ) : (
    <p className="px-4 py-8 text-center text-body text-ink-faint">Select a root, folder or file to see its details.</p>
  );

  return (
    <div className="@container relative flex h-full min-h-0 min-w-0 flex-col bg-surface text-ink">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule px-4 py-2">
        <Button variant="primary" icon={<FolderPlus size={14} aria-hidden="true" />} onClick={() => { setAdding(true); }}>
          Link a source
        </Button>
        <div className="relative min-w-40 flex-1 @min-[720px]:max-w-72">
          <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2 top-2.5 text-ink-faint" />
          <input
            ref={search}
            type="search"
            aria-label="Search sources"
            placeholder="Search sources"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setFocus(ensureFocus(navRows, null));
                treeEl.current?.focus();
              }
            }}
            className={`${FIELD} pl-7`}
          />
        </div>
        <p className="num ml-auto text-small text-ink-soft">{summaryWords(totals.roots, totals.files)}</p>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] @min-[720px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] @min-[720px]:grid-rows-1" onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); search.current?.focus(); } }}>
        <div className="flex min-h-0 min-w-0 flex-col">
          {rows.length > 0 ? (
            <div className={`grid ${COLS} items-center gap-2 border-b border-rule bg-raised pr-3 text-small font-medium text-ink-soft`}>
              <span />
              <span className="py-1.5 pl-2">Name</span>
              <span className="hidden @min-[720px]:block">State</span>
              <span className="hidden @min-[720px]:block">Result</span>
            </div>
          ) : null}
          {body}
        </div>
        <div className="min-h-0 min-w-0 overflow-y-auto border-t border-rule @min-[720px]:border-l @min-[720px]:border-t-0">
          {detail}
        </div>
      </div>
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-rule bg-raised px-4 py-1">
        <p className="num text-small text-ink-soft">{selectedCount ? `${selectedCount} ${selectedCount === 1 ? "file" : "files"} selected` : "No files selected"}</p>
        <Button variant="ghost" className="h-6 px-2 text-small" disabled={!selectedCount} onClick={() => setSelected(new Set())}>
          Clear
        </Button>
        <Button variant="primary" className="h-6 px-2 text-small" disabled={!selectedCount} onClick={() => void extractSelected()}>
          Extract selected
        </Button>
        {notice ? (
          <p role={notice.tone === "error" ? "alert" : "status"} className={`min-w-0 flex-1 basis-60 break-words text-small ${notice.tone === "error" ? "text-block" : "text-ink-soft"}`}>
            {notice.text}
          </p>
        ) : (
          <span role="status" className="sr-only" />
        )}
      </div>
      {unlinkRoot ? (
        <UnlinkDialog
          root={unlinkRoot}
          onClose={() => setUnlinking(null)}
          onDone={() => {
            setUnlinking(null);
            setCurrent(null);
            setSelected(new Set());
            say("info", `${unlinkRoot.label} is unlinked.`);
            load.reload();
          }}
        />
      ) : null}
    </div>
  );
}
