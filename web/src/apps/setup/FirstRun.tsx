import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { Button } from "../../components/Button";
import { api } from "../../lib/api";
import { bus } from "../../lib/bus";
import { useStore } from "../../lib/store";
import { toast } from "../../shell/toastStore";
import { ClaudeConnect } from "./ClaudeConnect";
import { PRIVACY_SUMMARY, nonAffiliation, useProductName } from "./copy";
import { HooksPanel } from "./HooksPanel";
import { STEPS } from "./model";
import { ReadPanel } from "./ReadPanel";
import { applySetup, closeFirstRun, refreshHooks, setFirstRunStep, useSetupStore } from "./state";

function Welcome({ onAgree, busy, demo }: { onAgree: () => void; busy: boolean; demo: boolean }) {
  const name = useProductName();
  return (
    <div className="min-w-0">
      <p className="text-body text-ink">
        {name} reads the Claude Code set-up on this computer, which is your instructions, rules, skills, agents, settings and memory, and draws it as a graph that you can search, check and replay as Claude Code works.
      </p>
      {demo ? (
        <p className="mt-3 text-body text-ink">This installation shows the synthetic Northgate Synthetic Bank demonstrator, with invented agent runs, policies and people.</p>
      ) : null}
      <h4 className="mb-1 mt-4 text-ui font-medium text-ink">Independence from Anthropic</h4>
      <p className="text-body text-ink-soft">{nonAffiliation(name)}</p>
      <h4 className="mb-1 mt-4 text-ui font-medium text-ink">Privacy</h4>
      <p className="text-body text-ink-soft">{PRIVACY_SUMMARY}</p>
      <h4 className="mb-1 mt-4 text-ui font-medium text-ink">Licence</h4>
      <p className="text-body text-ink-soft">The product is released under the Apache License 2.0, with no warranty beyond the licence. The licence text is in the LICENSE file and in the About window.</p>
      <div className="mt-5">
        <Button variant="primary" disabled={busy} icon={<Check size={14} aria-hidden="true" />} onClick={onAgree}>
          I agree and continue
        </Button>
      </div>
    </div>
  );
}

const INTRO: Record<string, string> = {
  read: "Nothing has been read yet. When you agree, the product reads the folders below and builds the graph. Everything stays on this computer.",
  hooks:
    "Hooks let the product see each step as Claude Code works, so that the brain view can replay it. This step is optional. Without it you still have the full graph, the checks and the queries.",
  claude:
    "This step is optional. It checks that Claude Code is installed and signed in, so that the product can start agent runs for you.",
};

const INTRO_READ_DONE = "Your set-up has been read and the graph is built. Read it again after you change the projects folder.";

export function FirstRun() {
  const setup = useSetupStore((s) => s.setup);
  const step = useSetupStore((s) => s.firstRunStep);
  const [busy, setBusy] = useState(false);
  const current = STEPS[step];
  const last = step === STEPS.length - 1;

  const agree = async () => {
    setBusy(true);
    try {
      const next = await api.acceptSetup();
      applySetup(next);
      if (next.demo) {
        // the demonstrator has no Claude Code set-up to read, so the first run ends here and the Oversight window opens
        closeFirstRun();
        bus.emit("open", { app: "oversight" });
      } else {
        setFirstRunStep(1);
      }
    } catch (e) {
      toast(`Your agreement could not be recorded. ${e instanceof Error ? e.message : ""}`.trim(), "error");
    } finally {
      setBusy(false);
    }
  };

  const hasRead = setup?.read_consent_at != null;
  const name = useProductName();
  const root = useRef<HTMLDivElement>(null);
  const agreed = useRef(false);
  useEffect(() => {
    agreed.current = setup?.accepted_at != null;
  }, [setup?.accepted_at]);

  // Focus moves into the dialog when it opens and stays inside it. Escape closes nothing before the person has agreed.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const items = () => Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    (items().find((x) => x.tagName === "BUTTON" && !x.closest("nav")) ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (agreed.current) closeFirstRun();
        return;
      }
      if (e.key !== "Tab") return;
      const list = items();
      if (!list.length) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const lastEl = list[list.length - 1];
      const at = document.activeElement;
      if (!el.contains(at)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && at === first) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && at === lastEl) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div ref={root} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${name} first run`} className="fixed inset-0 z-40 flex outline-none items-center justify-center bg-void p-6">
      <div
        style={{ height: "min(640px, 100%)" }}
        className="grid w-full max-w-[880px] grid-cols-[200px_minmax(0,1fr)] overflow-hidden rounded-lg border border-rule-strong bg-surface"
      >
        <nav aria-label="First run steps" className="min-w-0 border-r border-rule bg-sunken p-4">
          <p className="mb-4 font-display text-lead font-medium text-ink">{name}</p>
          <ol className="min-w-0 space-y-1">
            {STEPS.map((s, i) => (
              <li
                key={s.id}
                aria-current={i === step ? "step" : undefined}
                className={`flex min-w-0 items-baseline gap-2 rounded-md px-2 py-1.5 text-body ${i === step ? "bg-raised font-medium text-ink" : i < step ? "text-ink-soft" : "text-ink-faint"}`}
              >
                <span className="num w-4 shrink-0 text-small">{i < step ? <Check size={12} aria-label="Done" /> : i + 1}</span>
                <span className="min-w-0">
                  {s.title}
                  {s.optional ? <span className="block text-caption text-ink-faint">Optional</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </nav>
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
            <p className="num text-small text-ink-faint">
              Step {step + 1} of {STEPS.length}
            </p>
            <h2 className="mb-3 font-display text-title font-medium text-ink">{current.title}</h2>
            {current.id !== "welcome" && current.id !== "done" ? <p className="mb-4 text-body text-ink-soft">{current.id === "read" && hasRead ? INTRO_READ_DONE : INTRO[current.id]}</p> : null}
            {current.id === "welcome" ? <Welcome onAgree={() => void agree()} busy={busy} demo={setup?.demo === true} /> : null}
            {current.id === "read" ? <ReadPanel labelAction={hasRead ? "Read again" : "Agree and read my set-up"} /> : null}
            {current.id === "hooks" ? <HooksPanel /> : null}
            {current.id === "claude" ? <ClaudeConnect /> : null}
            {current.id === "done" ? <Done /> : null}
          </div>
          {current.id !== "welcome" ? (
            <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-rule px-6 py-3">
              <Button variant="ghost" icon={<ArrowLeft size={14} aria-hidden="true" />} disabled={step <= 1} onClick={() => setFirstRunStep(step - 1)}>
                Back
              </Button>
              {last ? (
                <Button variant="primary" onClick={closeFirstRun}>
                  Open {name}
                </Button>
              ) : (
                <Button
                  variant={current.optional ? "secondary" : "primary"}
                  disabled={current.id === "read" && !hasRead}
                  icon={<ArrowRight size={14} aria-hidden="true" />}
                  onClick={() => setFirstRunStep(step + 1)}
                >
                  {current.optional ? "Skip or continue" : "Continue"}
                </Button>
              )}
            </footer>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Done() {
  const setup = useSetupStore((s) => s.setup);
  const hooks = useSetupStore((s) => s.hooks);
  const dataDir = useStore((s) => s.status?.data_dir);
  useEffect(() => {
    void refreshHooks();
  }, []);
  return (
    <div className="min-w-0 text-body text-ink-soft">
      <p className="text-ink">The set-up is complete. You can repeat any step from the Settings window.</p>
      <dl className="mt-4 grid min-w-0 grid-cols-[130px_minmax(0,1fr)] gap-x-3 gap-y-2 text-body">
        <dt className="text-ink-faint">Data folder</dt>
        <dd className="min-w-0 break-words font-mono text-small text-ink">{dataDir ?? "Shown in Settings"}</dd>
        <dt className="text-ink-faint">Graph</dt>
        <dd className="num text-ink">{setup?.counts ? `${setup.counts.nodes} nodes and ${setup.counts.edges} links` : "Not built yet"}</dd>
        <dt className="text-ink-faint">Hooks</dt>
        <dd className="min-w-0 text-ink">
          {hooks?.installed ? "Installed. Remove them at any time in Settings, and the uninstaller also offers to remove them." : "Not installed. You can add them in Settings."}
        </dd>
        <dt className="text-ink-faint">Uninstall</dt>
        <dd className="min-w-0 text-ink">Remove the hooks in Settings first, then uninstall the app as you would any other. The data folder stays until you delete it.</dd>
      </dl>
    </div>
  );
}
