// The passage of a file through route 38: at most 200 lines, with the nearest heading and a note when the file changed
// after it was read. The reader pages forwards and backwards through the file in blocks of 200 lines.
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import { learnSources } from "../../lib/learn/sources";
import { useFetched } from "../../lib/learn/useFetched";
import { ErrorLine, LoadLine } from "./parts";

const PAGE = 200;

export function PassageView({ source, from = 1, to }: { source: string; from?: number; to?: number }) {
  const [start, setStart] = useState(Math.max(1, from));
  const end = start === from && to ? Math.min(to, start + PAGE - 1) : start + PAGE - 1;
  const load = useFetched(() => learnSources.passage(source, start, end), `${source}:${start}:${end}`);
  const p = load.data;
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 border-b border-rule px-3 py-1.5">
        <p className="num min-w-0 flex-1 truncate text-small text-ink-soft" title={p?.path}>
          {p ? `${p.path}, lines ${p.from} to ${p.to}` : `Lines ${start} to ${end}`}
        </p>
        <IconButton icon={ChevronLeft} label="Earlier lines" disabled={start <= 1} onClick={() => setStart(Math.max(1, start - PAGE))} />
        <IconButton icon={ChevronRight} label="Later lines" disabled={!p || p.lines.length < PAGE} onClick={() => setStart(start + PAGE)} />
      </div>
      {load.error ? <ErrorLine onRetry={load.reload}>{load.error}</ErrorLine> : null}
      {!p && !load.error ? <LoadLine what="the text" /> : null}
      {p ? (
        <>
          {p.heading ? <p className="border-b border-rule px-3 py-1.5 text-small text-ink-soft">{`Under the heading ${p.heading}`}</p> : null}
          {p.fileChanged ? (
            <p role="status" className="border-b border-rule bg-hold-soft px-3 py-1.5 text-small text-ink">
              The file has changed since it was read, so these line numbers may not match the claims drawn from it.
            </p>
          ) : null}
          <ol className="min-w-0 py-1" start={p.from}>
            {p.lines.map((line, i) => (
              <li key={p.from + i} className="flex min-w-0 gap-3 px-3 text-body">
                <span className="num w-10 shrink-0 select-none text-right text-small text-ink-faint">{p.from + i}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink">{line || " "}</span>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}
