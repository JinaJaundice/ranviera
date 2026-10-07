import { Settings } from "lucide-react";
import { Button } from "../../components/Button";
import { bus } from "../../lib/bus";

/** Shown in the Missions window while agent runs are not allowed. It names the reason and links to Settings. */
export function RunsNotice({ reason }: { reason: string }) {
  return (
    <div role="status" className="mb-4 flex min-w-0 items-start gap-3 rounded-lg border border-hold bg-hold-soft px-3 py-2 text-body text-ink">
      <p className="min-w-0 flex-1">
        Agent runs are not allowed yet. {reason} The Settings window shows what is needed, and you can still plan a task here.
      </p>
      <Button icon={<Settings size={14} aria-hidden="true" />} onClick={() => bus.emit("open", { app: "settings" })}>
        Open Settings
      </Button>
    </div>
  );
}
