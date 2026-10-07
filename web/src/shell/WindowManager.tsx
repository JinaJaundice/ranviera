import { useEffect, useState } from "react";
import { Window } from "./Window";
import { windowStore, useWindows, type Viewport } from "./windows";

function useViewport(): Viewport {
  const [vp, setVp] = useState<Viewport>({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => {
      setVp({ w: window.innerWidth, h: window.innerHeight });
      windowStore.reclamp();
    };
    window.addEventListener("resize", onResize);
    windowStore.reclamp();
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return vp;
}

/** Renders every open window. Minimised windows stay mounted but hidden, so their state is kept. */
export function WindowManager() {
  const set = useWindows();
  const vp = useViewport();
  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      {set.wins.map((w) => (
        <Window key={w.app} win={w} vp={vp} focused={set.focused === w.app} />
      ))}
    </div>
  );
}
