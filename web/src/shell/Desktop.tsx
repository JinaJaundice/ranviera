import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { APPS } from "../apps/registry";
import { FirstRun } from "../apps/setup/FirstRun";
import { refreshSetup, useSetupStore } from "../apps/setup/state";
import { bus } from "../lib/bus";
import { CommandPalette } from "./CommandPalette";
import { Dock } from "./Dock";
import { Toasts } from "./Toasts";
import { TopBar } from "./TopBar";
import { WindowManager } from "./WindowManager";
import { windowStore } from "./windows";

// The graph canvas is written by another builder. It is loaded lazily so the shell does not wait for it.
const NeuralGraph = lazy(() => import("../graph/NeuralGraph").then((m) => ({ default: m.NeuralGraph })));

export function Desktop() {
  const [palette, setPalette] = useState(false);
  const firstRun = useSetupStore((s) => s.firstRunOpen);
  const firstRunRef = useRef(false);
  useEffect(() => {
    firstRunRef.current = firstRun;

  }, [firstRun]);

  // The first run opens when the server reports that the person has not yet agreed to the welcome step.
  useEffect(() => {
    void refreshSetup();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The palette and the shortcuts stay off while the first-run dialog is open.
      if (firstRunRef.current) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        const m = /^Digit([0-9])$/.exec(e.code);
        const app = m ? APPS.find((a) => a.key === m[1]) : undefined;
        if (app) {
          e.preventDefault();
          windowStore.open(app.id);
        }
        return;
      }
      if (e.key === "Escape") setPalette(false);
    };
    window.addEventListener("keydown", onKey);
    const off = bus.on("open", ({ app, params }) => windowStore.open(app, params));
    return () => {
      window.removeEventListener("keydown", onKey);
      off();
    };
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden bg-void text-ink">
      <div className="absolute inset-0 z-0 bg-void">
        <Suspense fallback={null}>
          <NeuralGraph className="h-full w-full" />
        </Suspense>
      </div>
      <TopBar onOpenPalette={() => setPalette(true)} />
      <Dock />
      <WindowManager />
      {palette && !firstRun ? <CommandPalette onClose={() => setPalette(false)} /> : null}
      <Toasts />
      {firstRun ? <FirstRun /> : null}
    </div>
  );
}
