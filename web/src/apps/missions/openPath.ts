import { api } from "../../lib/api";
import { toast } from "../../shell/toastStore";

export function openPath(path: string): void {
  api.open(path).catch((e: unknown) => toast(`The file could not be opened. ${e instanceof Error ? e.message : ""}`.trim(), "error"));
}
