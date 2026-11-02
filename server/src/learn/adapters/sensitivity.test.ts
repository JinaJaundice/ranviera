// The derived sensitivity of a session when its file tool calls used an empty or relative path (review of 2 November 2026).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRecord } from "../../../../shared/learn/index.ts";
import type { SourceRoot } from "../../../../shared/learn/sources.ts";
import type { Knowledge } from "../knowledge/index.ts";
import type { SourcesService } from "../sources/index.ts";
import { createSessionSensitivity } from "./sensitivity.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function root(id: string, dir: string, consent: string | null): SourceRoot {
  return { id, kind: "notes", path: dir.split(path.sep).join("/"), label: id, include: [], exclude: [], sensitivity: "client-confidential", mode: "manual", enabled: true, hostedConsentAt: consent, createdAt: "2026-11-02T00:00:00.000Z", lastScanAt: null };
}

function sessionReading(paths: (string | undefined)[]): SessionRecord {
  return {
    id: "chat_test_00000000",
    title: "Test",
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    messages: [
      {
        role: "assistant",
        id: "msg_a",
        content: paths.map((p, i) => ({ type: "toolCall" as const, id: `call_${i}`, name: "read", arguments: p === undefined ? {} : { path: p } })),
      },
    ],
  } as unknown as SessionRecord;
}

describe("the sensitivity of a session that read through a hosted model's relative path", () => {
  it("counts the one root that the gate allows a hosted model, when several roots are linked", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-sens-"));
    dirs.push(base);
    const consented = path.join(base, "consented");
    const closed = path.join(base, "closed");
    const home = path.join(base, "home");
    for (const d of [consented, closed, home]) fs.mkdirSync(d, { recursive: true });
    const roots = [root("root_aaaaaaaa", consented, "2026-11-02T09:00:00.000Z"), root("root_bbbbbbbb", closed, null)];
    const sens = createSessionSensitivity({
      knowledge: {} as unknown as Knowledge,
      sources: { list: () => roots } as unknown as SourcesService,
      homeDir: home,
      session: () => null,
    });
    for (const paths of [["notes.md"], [""], [undefined]]) {
      const gate = sens.of(sessionReading(paths));
      expect(gate.sensitivity).toBe("client-confidential");
      expect(gate.consented).toBe(true);
    }
  });
});
