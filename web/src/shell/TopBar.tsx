import { useEffect, useRef, useState } from "react";
import { Monitor, Moon, Search, Sun } from "lucide-react";
import { Kbd } from "../components/Kbd";
import { StatusDot, type Tone } from "../components/StatusDot";
import { IconButton } from "../components/IconButton";
import { useStore } from "../lib/store";
import { THEMES, setTheme, useTheme } from "./useTheme";
import { productName } from "../apps/setup/copy";
import { claudeSummary } from "../apps/setup/model";
import { refreshClaude, useSetupStore } from "../apps/setup/state";

const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);
  return <span className="num text-small text-ink-soft">{hhmm(now)}</span>;
}

function ThemeMenu() {
  const pref = useTheme();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  const Icon = pref === "light" ? Sun : pref === "dark" ? Moon : Monitor;
  return (
    <div ref={box} className="relative">
      <IconButton icon={Icon} label="Theme" size={14} className="h-7 w-7" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      {open ? (
        <div role="menu" aria-label="Theme" className="absolute right-0 top-8 z-50 w-32 rounded-lg border border-rule-strong bg-overlay p-1">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="menuitemradio"
              aria-checked={pref === t.value}
              onClick={() => {
                setTheme(t.value);
                setOpen(false);
              }}
              className={`flex h-7 w-full items-center rounded-sm px-2 text-body hover:bg-raised ${pref === t.value ? "text-ink" : "text-ink-soft"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const status = useStore((s) => s.status);
  const graph = useStore((s) => s.graph);
  const health = useStore((s) => s.health);
  const connected = useStore((s) => s.connected);

  const violations = health?.counts.violation ?? graph?.health.errors ?? 0;
  const warnings = health?.counts.warning ?? graph?.health.warnings ?? 0;
  const stale = health?.stale === true;
  const tone: Tone = stale ? "hold" : violations > 0 ? "block" : warnings > 0 ? "hold" : "pass";
  const toneLabel = stale ? "Health: report is for an older build" : violations > 0 ? "Health: violations found" : warnings > 0 ? "Health: warnings only" : "Health: no violations";

  const nodes = graph?.stats.nodes ?? status?.nodes ?? 0;
  const edges = graph?.stats.edges ?? status?.edges ?? 0;
  const builtRaw = graph?.built ?? status?.built ?? null;
  const built = builtRaw && !Number.isNaN(Date.parse(builtRaw)) ? hhmm(new Date(builtRaw)) : "not yet";

  // The window and tab title name the product that /api/status reports (the page title of web/index.html is neutral).
  const product = status ? productName(status.product ?? "cortex") : null;
  useEffect(() => {
    if (product) document.title = product;
  }, [product]);

  const claude = useSetupStore((s) => s.claude);
  useEffect(() => {
    void refreshClaude();
    const t = setInterval(() => void refreshClaude(), 30000);
    return () => clearInterval(t);
  }, []);
  // GET /api/claude is the source of the state, and the status route is the fallback for an older server.
  const claudeLabel = claude
    ? claudeSummary(claude).label
    : status?.claude.logged_in
      ? "Claude Code signed in"
      : "Claude Code sign-in needed";
  const claudeOk = claude ? claude.installed && claude.signed_in : (status?.claude.logged_in ?? false);

  return (
    <header className="cx-topbar absolute inset-x-0 top-0 z-20 grid h-9 grid-cols-[1fr_minmax(0,420px)_1fr] items-center gap-3 border-b border-rule bg-surface px-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="font-display text-lead font-medium text-ink">{product ?? ""}</span>
        <StatusDot tone={tone} label={toneLabel} />
        <span className="num truncate text-small text-ink-soft">
          {nodes} nodes, {edges} edges, built {built}
        </span>
      </div>
      <button
        type="button"
        onClick={onOpenPalette}
        className="flex h-7 min-w-0 items-center gap-2 rounded-md border border-rule-strong bg-sunken px-2 text-small text-ink-soft hover:text-ink"
      >
        <Search size={14} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">Search the graph or start a mission</span>
        <Kbd>Ctrl K</Kbd>
      </button>
      <div className="flex min-w-0 items-center justify-end gap-3 text-small text-ink-soft">
        <span className="num hidden truncate 2xl:inline">{status?.events_today ?? 0} events today</span>
        <span className="num hidden truncate 2xl:inline">{status?.missions_running ?? 0} missions running</span>
        <span className={`truncate ${claudeOk ? "" : "text-hold"}`}>{claudeLabel}</span>
        <StatusDot tone={connected ? "pass" : "block"} label={connected ? "Stream connected" : "Stream disconnected"} />
        <ThemeMenu />
        <Clock />
      </div>
    </header>
  );
}
