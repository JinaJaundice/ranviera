// The agent composer of the learning method. It picks the role for each turn
// from the record: the prober until a successful probe_done, then the teacher,
// and the practice agent for a practice session. The swap is a construction
// branch for each request and not a screen. Each role has its own system prompt
// and its own tool set, and both are built again on every turn.
import type { AgentTurnContext, AgentTurnDecision } from "@earendil-works/pi-agent-core";
import type { AgentComposer, ComposedAgent } from "../runtime/deps.ts";
import { hasProbeDone } from "../runtime/scans.ts";
import { createFileTools } from "../runtime/tools/files.ts";
import { graphReaderTools, listSourcesTool } from "../runtime/tools/graph-readers.ts";
import type { AnyTool } from "../runtime/tools/define.ts";
import type { MethodDeps } from "./deps.ts";
import type { PromptStore, PromptAgent } from "./prompt-store.ts";
import { proberQuestionTools, teacherQuestionTools } from "./tools/questions.ts";
import { concludeTool, planInitTool, probeDoneTool, problemTool } from "./tools/flow.ts";
import { isClaudeModel, pdfTool, researchTool, sendToUserTool } from "./tools/extras.ts";
import { seedTurnState } from "./tools/state.ts";

/** A clean call of one of these ends the run, because the learner cannot answer while a turn runs. */
const ENDS_THE_RUN = new Set(["probe", "recall", "quiz", "explain", "ask_user_question", "problem", "probe_done"]);

export function endsRun(turn: Pick<AgentTurnContext, "toolResults">): AgentTurnDecision | undefined {
  return turn.toolResults.some((r) => !r.isError && ENDS_THE_RUN.has(r.toolName)) ? { action: "end" } : undefined;
}

export const roleFor = (session: { kind?: "teach" | "practice" }, messages: Parameters<typeof hasProbeDone>[0]): PromptAgent =>
  session.kind === "practice" ? "practice" : hasProbeDone(messages) ? "teacher" : "prober";

export function createComposer(deps: MethodDeps, prompts: PromptStore): AgentComposer {
  return {
    compose({ session, model, record }): ComposedAgent {
      const role = roleFor(session, record().messages);
      const tools = deps.settings.tools();
      const state = seedTurnState({ record, providerClass: model.providerClass, targets: deps.targets });
      const explain = tools.explain === true;
      const files = createFileTools({
        providerClass: model.providerClass,
        policy: deps.policy,
        homeDir: deps.homeDir,
        imageInput: Array.isArray(model.model.input) && model.model.input.includes("image"),
        now: deps.now,
      });
      const sources = listSourcesTool({ policy: deps.policy, providerClass: model.providerClass });
      const readers = graphReaderTools({ reader: deps.knowledge, policy: deps.policy, providerClass: model.providerClass });
      const jobTools: AnyTool[] = [];
      if (tools.research === true) jobTools.push(researchTool(state, deps.jobs));
      if (tools.pdf !== false) jobTools.push(pdfTool(state, deps.jobs));
      const extras: AnyTool[] = isClaudeModel(model.ref.provider, model.ref.id) ? [sendToUserTool()] : [];

      let set: AnyTool[];
      if (role === "prober") {
        set = [...proberQuestionTools(state, { explain }), probeDoneTool(state), ...files, sources, ...readers, ...jobTools, ...extras];
      } else if (role === "teacher") {
        set = [...teacherQuestionTools(state, { explain }), planInitTool(state, deps), ...files, sources, ...jobTools, ...extras];
      } else {
        set = [problemTool(state), concludeTool(state), ...files, sources, ...readers, ...jobTools, ...extras];
      }
      return { role, systemPrompt: prompts.compose(role), tools: set, finishTurn: endsRun };
    },
  };
}
