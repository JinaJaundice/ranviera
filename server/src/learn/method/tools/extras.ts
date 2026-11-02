// The switchable tools research and pdf, and send_to_user for Claude models.
// Research and pdf call the injected job dispatcher. Until the jobs phase is
// wired they answer that they are not available, so that the agent carries on
// with what it knows.
import { Type } from "typebox";
import { defineTool, type AnyTool } from "../../runtime/tools/define.ts";
import type { JobDispatcher } from "../deps.ts";
import { accepted, type TurnState } from "./state.ts";

const NOT_AVAILABLE = "Background jobs are not available in this build, so this request was not started. Carry on with what you know and tell the learner that the claim is unchecked.";

const text = (t: string, details: unknown) => ({ content: [{ type: "text" as const, text: t }], details });

export function researchTool(state: TurnState, jobs: JobDispatcher | undefined): AnyTool {
  return defineTool({
    name: "research",
    label: "Research a question",
    description:
      "Starts a background job that searches the web for one specific question and reports a short brief with sources later. The call returns at once with a job identifier. The worker sees only this brief, so give one question and one or two sentences of context.",
    parameters: Type.Object({ question: Type.String(), context: Type.Optional(Type.String()) }),
    execute: async (id: string, params: { question: string; context?: string }) => {
      if (!jobs) return text(NOT_AVAILABLE, { ok: false, available: false });
      const input: Record<string, unknown> = { question: params.question, ...(params.context ? { context: params.context } : {}) };
      const result = await jobs.dispatch({ kind: "research", sessionId: state.sessionId, toolCallId: id, input });
      if ("refused" in result) return text(result.refused, { ok: false, refused: true });
      const { jobId } = result;
      return accepted(`Research job ${jobId} started. Keep teaching without waiting. The result arrives as a message.`, { ok: true, jobId });
    },
  });
}

export function pdfTool(state: TurnState, jobs: JobDispatcher | undefined): AnyTool {
  return defineTool({
    name: "pdf",
    label: "Read a PDF",
    description:
      "Starts a background job that reads one PDF file for one question and reports a brief with page citations later. The call returns at once with a job identifier.",
    parameters: Type.Object({ path: Type.String(), question: Type.String() }),
    execute: async (id: string, params: { path: string; question: string }) => {
      if (!jobs) return text(NOT_AVAILABLE, { ok: false, available: false });
      const result = await jobs.dispatch({ kind: "pdf", sessionId: state.sessionId, toolCallId: id, input: { path: params.path, question: params.question } });
      if ("refused" in result) return text(result.refused, { ok: false, refused: true });
      const { jobId } = result;
      return accepted(`PDF job ${jobId} started. Keep teaching without waiting. The result arrives as a message.`, { ok: true, jobId });
    },
  });
}

/** True for a Claude model, which may send a short message to the learner during a run. */
export const isClaudeModel = (provider: string, id: string): boolean => provider === "anthropic" || provider === "claude-code" || /claude/i.test(id);

export function sendToUserTool(): AnyTool {
  return defineTool({
    name: "send_to_user",
    label: "Send a message",
    description: "Sends one short message to the learner while the run continues, for example to say what is about to happen.",
    parameters: Type.Object({ message: Type.String({ minLength: 1 }) }),
    execute: async (_id: string, params: { message: string }) => accepted("The message was sent.", { ok: true, message: params.message }),
  });
}
