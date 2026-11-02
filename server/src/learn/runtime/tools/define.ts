// Types a tool by the schema of its parameters, so that execute receives typed
// arguments, and widens it to the list type that the agent takes. The library
// itself types a list of tools as AgentTool<any>.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

export type AnyTool = AgentTool<any>;

export function defineTool<T extends TSchema>(tool: AgentTool<T>): AnyTool {
  return tool as unknown as AnyTool;
}
