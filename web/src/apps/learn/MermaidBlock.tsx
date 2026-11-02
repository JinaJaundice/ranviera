// A Mermaid diagram in a lesson. The library loads only when a diagram is shown, the security level is strict, and a diagram
// that does not render shows an error card with its source and a retry. While the fence is still streaming nothing is parsed.
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { IconButton } from "../../components/IconButton";
import { Button } from "../../components/Button";
import { chartWidth } from "./diagram";
import { token } from "../../lib/theme";

const FONT = '"Inter Variable", ui-sans-serif, system-ui, sans-serif';
let serial = 0;

interface Result {
  key: string;
  svg?: string;
  error?: string;
}

export function MermaidBlock({ chart, streaming = false }: { chart: string; streaming?: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const [res, setRes] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);
  const dark = typeof document !== "undefined" && document.documentElement.dataset.theme !== "light";
  const key = `${chart}\u0000${attempt}\u0000${dark ? "d" : "l"}`;
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (streaming) return;
    let live = true;
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        // the colours are the tokens of the live theme, so a diagram sits in the page like the rest of it
        const c = (name: string) => token(`--color-${name}`);
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          fontFamily: FONT,
          themeVariables: { fontSize: "16px", dropShadow: "none", darkMode: dark, background: c("surface"), primaryColor: c("raised"), primaryBorderColor: c("rule-strong"), primaryTextColor: c("ink"), secondaryColor: c("sunken"), tertiaryColor: c("surface"), lineColor: c("ink-soft"), textColor: c("ink"), mainBkg: c("raised"), nodeBorder: c("rule-strong"), clusterBkg: c("sunken"), edgeLabelBackground: c("surface") },
        });
        const out = await mermaid.render(`cx-mermaid-${Date.now().toString(36)}${(serial++).toString(36)}`, chart);
        if (live) setRes({ key, svg: out.svg });
      })
      .catch((e: unknown) => {
        if (live) setRes({ key, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [chart, streaming, dark, key]);

  const copy = () => {
    void navigator.clipboard
      ?.writeText(chart)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  const mine = res && res.key === key ? res : null;
  if (mine?.error) {
    return (
      <div role="alert" data-find-exclude className="my-3 min-w-0 rounded-lg border border-block bg-block-soft p-3 text-body">
        <p className="font-medium text-block">The diagram could not be drawn.</p>
        <p className="mt-1 min-w-0 break-words font-mono text-small text-ink-soft">{mine.error}</p>
        <details className="mt-2">
          <summary className="cursor-pointer text-small text-ink-soft">Show the diagram source</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-rule bg-sunken p-2 font-mono text-small text-ink">{chart}</pre>
        </details>
        <Button className="mt-2 h-7 text-small" onClick={() => setAttempt((a) => a + 1)}>
          Try again
        </Button>
      </div>
    );
  }
  if (!mine?.svg) {
    return (
      <div aria-busy="true" role="status" className="my-3 flex h-24 items-center justify-center gap-2 rounded-md border border-rule bg-sunken text-small text-ink-faint">
        <Loader2 size={14} aria-hidden="true" className="animate-spin" />
        {streaming ? "Waiting for the end of the diagram" : "Drawing the diagram"}
      </div>
    );
  }
  return (
    <div className="group/md relative my-3 min-w-0 overflow-x-auto rounded-md border border-rule bg-surface p-3">
      <div className="absolute right-1 top-1 opacity-0 focus-within:opacity-100 group-hover/md:opacity-100">
        <IconButton icon={copied ? Check : Copy} label={copied ? "Copied" : "Copy the diagram source"} size={14} className="h-6 w-6" onClick={copy} />
      </div>
      <div ref={holder} data-find-exclude className="mx-auto [&_svg]:h-auto [&_svg]:max-w-full" style={{ maxWidth: chartWidth(mine.svg) }} dangerouslySetInnerHTML={{ __html: mine.svg }} />
    </div>
  );
}
