// Route 26: a session as clean Markdown. The wording is neutral and no message
// or tool call identifier appears. A failed output call is left out, a
// dismissed problem never shows its solution, and markers render nothing.
import type { AnswerDetails, AssistantMessage, NativeMessage, SessionRecord } from "../../../../shared/learn/index.ts";
import { assistantText, resultsById, toolCallsOf } from "./scans.ts";

const heading = (tool: string, questionType?: string): string => {
  switch (tool) {
    case "quiz":
      return questionType === "predict" ? "Prediction" : "Quiz";
    case "probe":
      return "Probe";
    case "explain":
      return "Recall check";
    case "recall":
      return "Recall";
    default:
      return "Question";
  }
};

const readable = (word: string): string => {
  const spaced = word.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const quote = (text: string): string =>
  text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: unknown }).text ?? "") : "")).join("\n").trim()
    : "";

function outcomeLine(d: AnswerDetails): string {
  if (d.dismissed) return "Skipped.";
  if (d.dontKnow) return "The learner did not know.";
  if (d.kind === "explain") return d.text ? `The learner wrote: ${d.text}` : "No answer was given.";
  if (d.kind === "ask") {
    const chosen = d.answers.map((a) => a.label).join(", ");
    return [chosen && `The learner chose: ${chosen}.`, d.text && `The learner wrote: ${d.text}`, d.other && `The learner added: ${d.other}`].filter(Boolean).join(" ") || "No answer was given.";
  }
  if (d.correct === true) return "Answered correctly.";
  if (d.correct === false) return "Answered incorrectly.";
  return d.answers.length ? `The learner chose: ${d.answers.map((a) => a.label).join(", ")}.` : "Answered.";
}

/** The Markdown of a session. Pass the title as the first line unless the record has none. */
export function sessionToMarkdown(record: SessionRecord): string {
  const blocks: string[] = [`# ${record.title}`];
  const results = resultsById(record.messages);
  // the newest cleanly posed problem before each conclusion supplies its solution
  let lastPosed: { statement: string; modelSolution: string } | null = null;

  const assistantBlocks = (m: AssistantMessage): void => {
    const prose = assistantText(m);
    if (prose) blocks.push(`### Teacher\n\n${prose}`);
    for (const call of toolCallsOf(m)) {
      const r = results.get(call.id);
      const args = call.arguments;
      if (call.name === "send_to_user") {
        if (r && !r.isError && typeof args.message === "string" && args.message.trim()) blocks.push(`### Teacher\n\n${args.message.trim()}`);
        continue;
      }
      if (!r || r.isError) continue;
      if (call.name === "problem") {
        const statement = typeof args.statement === "string" ? args.statement : "";
        const solution = typeof args.modelSolution === "string" ? args.modelSolution : "";
        lastPosed = { statement, modelSolution: solution };
        if (statement) blocks.push(`### Problem\n\n${statement}`);
      } else if (call.name === "conclude") {
        const outcome = typeof args.outcome === "string" ? args.outcome : "";
        const verdict = typeof args.verdict === "string" ? args.verdict : "";
        if (outcome === "dismissed") {
          blocks.push("### Conclusion\n\nSkipped.");
        } else {
          const lines = [`### Conclusion\n\n${outcome ? `Outcome: ${readable(outcome)}.` : ""}`.trim()];
          if (verdict) lines.push(verdict);
          if (lastPosed?.modelSolution) lines.push(`Model solution:\n\n${quote(lastPosed.modelSolution)}`);
          blocks.push(lines.join("\n\n"));
        }
        lastPosed = null;
      } else if (call.name === "quiz" || call.name === "probe" || call.name === "explain" || call.name === "recall" || call.name === "ask_user_question") {
        const d = r.details as AnswerDetails | null | undefined;
        const question = typeof args.question === "string" ? args.question : d?.questionText ?? "";
        const parts = [`### ${heading(call.name, typeof args.type === "string" ? args.type : undefined)}\n\n${question}`.trim()];
        if (d && typeof d === "object" && Array.isArray(d.answers)) {
          parts.push(outcomeLine(d));
          if (d.thinking) parts.push(`The learner's reasoning: ${d.thinking}`);
        } else {
          const body = textOf(r.content);
          if (body) parts.push(body);
        }
        blocks.push(parts.join("\n\n"));
      }
    }
  };

  for (const m of record.messages as NativeMessage[]) {
    if (m.role === "user") {
      const body = typeof m.content === "string" ? m.content.trim() : m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n").trim();
      if (body) blocks.push(`### Learner\n\n${body}`);
    } else if (m.role === "assistant") {
      if (m.stopReason === "error" || m.stopReason === "aborted") continue;
      assistantBlocks(m);
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

/** A file name for the attachment, from the title. */
export function markdownFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "session"}.md`;
}
