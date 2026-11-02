// Identifiers of CONTRACTS "Conventions".
import { randomUUID } from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function isSafeId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 200 && SAFE_ID.test(id);
}

const eight = () => randomUUID().replace(/-/g, "").slice(0, 8);

export const newSessionId = (now = Date.now()) => `chat_${now.toString(36)}_${eight()}`;
export const newMessageId = (now = Date.now()) => `msg_${now.toString(36)}${eight()}`;
export const newTurnId = (now = Date.now()) => `turn_${now.toString(36)}${eight()}`;
