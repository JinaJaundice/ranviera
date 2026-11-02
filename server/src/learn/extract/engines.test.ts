import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LearnSettings } from "../../../../shared/learn/models.ts";
import { createModelsService, type ModelsService } from "../models/index.ts";
import { createExtractModels } from "./engines.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-engines-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function service(): { svc: ModelsService; reply: () => void } {
  const faux = fauxProvider({ provider: "claude-code", models: [{ id: "sonnet", reasoning: true }] });
  const svc = createModelsService({
    authFile: path.join(dir, "auth.json"),
    learnDir: path.join(dir, "learn"),
    env: {},
    extraProviders: [faux.provider],
    claudeCodeStatus: async () => ({ state: "meets-minimum", version: "2.1.320", minimumVersion: "2.1.316", enabled: true, allowBackground: false }),
  });
  return { svc, reply: () => faux.setResponses([fauxAssistantMessage("ok")]) };
}

const cheap = (extra: Partial<LearnSettings> = {}): LearnSettings => ({ version: 1, models: { cheap: { model: { provider: "claude-code", id: "sonnet" } } }, ...extra });

describe("the engines of the extraction stages", () => {
  it("refuses a cheap slot with no model before anything else", async () => {
    const { svc } = service();
    const refused = await createExtractModels(svc).preflight();
    expect(refused).toMatchObject({ status: 503, code: "models_not_configured" });
  });

  it("asks for background consent when the cheap slot is Claude Code", async () => {
    const { svc } = service();
    svc.settings.write(cheap({ claudeCode: { enabled: true } }));
    const m = createExtractModels(svc);
    expect(await m.preflight()).toMatchObject({ status: 403, code: "consent_required", extra: { consent: "claude-code-background" } });
    svc.settings.write(cheap({ claudeCode: { enabled: true, allowBackground: true } }));
    expect(await m.preflight()).toBeNull();
  });

  it("resolves both stages from the cheap slot, lets a role pin win and classes the provider", async () => {
    const { svc } = service();
    svc.settings.write(cheap({ claudeCode: { enabled: true, allowBackground: true } }));
    const m = createExtractModels(svc);
    const ex = m.engine("extractor");
    const au = m.engine("auditor");
    expect(ex?.ref).toEqual({ provider: "claude-code", id: "sonnet" });
    expect(au?.engine.model.id).toBe("sonnet");
    expect(m.providerClassOf(ex!.ref)).toBe("claude-code");
    expect(m.price("claude-code", "sonnet")?.id).toBe("sonnet");
    svc.settings.write({ ...svc.settings.read(), models: {} });
    expect(m.engine("extractor")).toBeNull();
  });
});
