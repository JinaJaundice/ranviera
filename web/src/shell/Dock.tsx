import { APPS } from "../apps/registry";
import { IconButton } from "../components/IconButton";
import { useWindows, windowStore } from "./windows";

export function Dock() {
  const set = useWindows();
  return (
    <nav
      aria-label="Windows"
      className="absolute bottom-0 left-0 top-9 z-30 flex w-13 flex-col items-center gap-1 border-r border-rule bg-surface py-2"
    >
      {APPS.map((app) => {
        const win = set.wins.find((w) => w.app === app.id);
        const focused = set.focused === app.id && !!win && !win.minimised;
        const label = app.key ? `${app.title} (Alt ${app.key})` : app.title;
        return (
          <div key={app.id} className="relative flex h-9 w-full items-center justify-center">
            <span
              aria-hidden="true"
              className={`absolute left-0 w-0.5 rounded-sm bg-signal ${focused ? "h-5" : win ? "h-2" : "h-0"}`}
            />
            <IconButton
              icon={app.icon}
              label={label}
              active={focused}
              size={18}
              className="h-9 w-9"
              onClick={() => (win && focused ? windowStore.minimise(app.id) : windowStore.open(app.id))}
            />
          </div>
        );
      })}
    </nav>
  );
}
