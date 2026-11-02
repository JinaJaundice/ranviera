// A new session: what a first send creates, the memory that stops a retry from creating a second session, and the words of
// the notices that stop a send before anything durable changes.
import type { CreateSession } from "@shared/learn/sessions";

export interface Draft {
  text: string;
  kind: "teach" | "practice";
  picks: string[];
}

export const MAX_PICKS = 64;
export const TITLE_MAX = 80;

/** The title of a session is its first message, kept to one line. */
export function titleOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 3).trimEnd()}...` : flat;
}

/** The body of the create route. A teaching session sends no kind, the server stamps the model settings, and picks travel only with a practice session. */
export function buildCreate(d: Draft): CreateSession {
  const body: CreateSession = { title: titleOf(d.text) };
  if (d.kind === "practice") {
    body.kind = "practice";
    const picks = [...new Set(d.picks)].slice(0, MAX_PICKS);
    if (picks.length) body.graphContext = { propositions: picks };
  }
  return body;
}

/** An empty message creates nothing. */
export const canStart = (d: Draft): boolean => d.text.trim().length > 0;

export const draftKey = (d: Draft): string => JSON.stringify([d.text.trim(), d.kind, [...new Set(d.picks)].sort()]);

/** Remembers the session that an unchanged draft created, so that a retry after a failed hand over does not create another one. */
export class Starter {
  private made: { key: string; id: string } | null = null;

  async start(d: Draft, create: (body: CreateSession) => Promise<{ id: string }>): Promise<string | null> {
    if (!canStart(d)) return null;
    const key = draftKey(d);
    if (this.made && this.made.key === key) return this.made.id;
    const { id } = await create(buildCreate(d));
    this.made = { key, id };
    return id;
  }

  forget(): void {
    this.made = null;
  }
}

export type SetupGap = "keys" | "models" | null;

/** The chip above the composer when a session cannot start. */
export function setupNotice(gap: SetupGap): string | null {
  return gap === "keys" ? "Add a provider key" : gap === "models" ? "Choose your models" : null;
}

/** A refusal that is informational: it names what is missing and the window links to Settings. */
export function isSetupRefusal(code: string | undefined): boolean {
  return code === "models_not_configured" || code === "provider_key_missing" || code === "claude_code_unavailable" || code === "consent_required";
}
