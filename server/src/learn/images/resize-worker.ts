// The worker thread of the resize step. It answers one request and the parent then ends it. The reply carries a
// type tag, because Node may post messages of its own on the same channel. Keep to erasable TypeScript here.
import { parentPort } from "node:worker_threads";
import { resizeImageInProcess } from "./resize-core.ts";

export const RESIZE_REPLY = "cortex:image-resize-response";

if (parentPort) {
  const port = parentPort;
  port.once("message", (message: { inputBytes?: unknown; mimeType?: unknown; options?: unknown }) => {
    if (!(message?.inputBytes instanceof Uint8Array) || typeof message.mimeType !== "string") {
      port.postMessage({ type: RESIZE_REPLY, error: "The resize request is not valid." });
      return;
    }
    try {
      const result = resizeImageInProcess(message.inputBytes, message.mimeType, (message.options ?? {}) as object);
      port.postMessage({ type: RESIZE_REPLY, result });
    } catch (e) {
      port.postMessage({ type: RESIZE_REPLY, error: e instanceof Error ? e.message : "The resize failed." });
    }
  });
}
