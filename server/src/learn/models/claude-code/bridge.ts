// Claude Code provider: the tool bridge. A loopback MCP server (Streamable HTTP, 127.0.0.1, ephemeral port, random
// bearer token) exposes the tool schemas of the current request. Admission fails closed. Streamed intent never runs
// anything, and a call is admitted only when the authenticated MCP call carries the same identifier, the same name
// and deeply equal arguments as the intent in the stream. The result returns through the held MCP call.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { isDeepStrictEqual } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, type CallToolResult, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

/** The MCP server name that the CLI sees. Tool names reach the stream as mcp__learn__<name>. */
export const BRIDGE_SERVER_NAME = "learn";
export const BRIDGE_PREFIX = `mcp__${BRIDGE_SERVER_NAME}__`;
export const TOOL_USE_ID_KEY = "claudecode/toolUseId";
export const MISMATCH_MESSAGE = "The MCP call does not match its streamed tool intent.";

export interface BridgeTool {
  name: string;
  description: string;
  /** JSON Schema, passed through unchanged */
  inputSchema: Record<string, unknown>;
}

export type BridgeContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface BridgeResult {
  content: BridgeContent[];
  isError?: boolean;
}

export interface ToolIntent {
  id: string;
  /** the name without the bridge prefix */
  name: string;
  arguments: Record<string, unknown>;
}

export interface BridgeOptions {
  tools: BridgeTool[];
  /** called once, with the first violation. The owner of the process ends the turn. */
  onViolation?: (message: string) => void;
  /** called when a call is parked, admitted or cancelled */
  onChange?: () => void;
  host?: string;
}

interface Parked {
  name: string;
  args: Record<string, unknown>;
  admitted: boolean;
  settle: (r: BridgeResult) => void;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export class ToolBridge {
  readonly token: string;
  readonly port: number;
  readonly url: string;
  #server: http.Server;
  #tools: BridgeTool[];
  #opts: BridgeOptions;
  #intents = new Map<string, ToolIntent>();
  #seen = new Set<string>();
  #cancelled = new Set<string>();
  #parked = new Map<string, Parked>();
  #failure: string | null = null;
  #closed = false;

  private constructor(server: http.Server, token: string, port: number, host: string, opts: BridgeOptions) {
    this.#server = server;
    this.token = token;
    this.port = port;
    this.url = `http://${host}:${port}/mcp`;
    this.#tools = opts.tools;
    this.#opts = opts;
  }

  static async start(opts: BridgeOptions): Promise<ToolBridge> {
    const token = randomBytes(32).toString("hex");
    const host = opts.host ?? "127.0.0.1";
    const holder: { bridge?: ToolBridge } = {};
    const server = http.createServer((req, res) => {
      // A socket that the CLI drops while a call is held must not reach the process as an unhandled error event.
      req.on("error", () => undefined);
      res.on("error", () => undefined);
      if (holder.bridge) holder.bridge.#handle(req, res).catch(() => res.destroy());
      else res.writeHead(503).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        server.off("error", reject);
        // after the listen, an error of the server ends this bridge's calls and never the process
        server.on("error", () => undefined);
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;
    const bridge = new ToolBridge(server, token, port, host, opts);
    holder.bridge = bridge;
    return bridge;
  }

  /** The strict MCP configuration for the CLI. */
  mcpConfig(): { mcpServers: Record<string, { type: "http"; url: string; headers: Record<string, string> }> } {
    return { mcpServers: { [BRIDGE_SERVER_NAME]: { type: "http", url: this.url, headers: { Authorization: `Bearer ${this.token}` } } } };
  }

  get failure(): string | null {
    return this.#failure;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The names of the tools that may be called, as the CLI sees them. */
  allowedToolNames(): string[] {
    return this.#tools.map((t) => `${BRIDGE_PREFIX}${t.name}`);
  }

  /** The identifiers of calls that are parked and admitted. */
  admittedIds(): string[] {
    return [...this.#parked].filter(([, p]) => p.admitted).map(([id]) => id);
  }

  hasParked(id: string): boolean {
    return this.#parked.has(id);
  }

  /** Records the intent announced in the stream. A repeated identifier is a violation. */
  declareIntent(intent: ToolIntent): void {
    if (this.#intents.has(intent.id)) {
      this.fail("A tool call identifier repeats in the stream.");
      return;
    }
    this.#intents.set(intent.id, intent);
    this.#tryAdmit(intent.id);
  }

  /** True when every listed identifier is parked and admitted. */
  allAdmitted(ids: string[]): boolean {
    return ids.every((id) => this.#parked.get(id)?.admitted === true);
  }

  /** A parked call that no streamed intent matches is a violation once the message has ended. */
  assertNoOrphans(): void {
    for (const [id, p] of this.#parked) {
      if (!p.admitted && !this.#intents.has(id)) this.fail("An MCP call arrived with no streamed tool intent.");
    }
  }

  /** Supplies the result of an admitted call and releases its held HTTP response. */
  resolve(id: string, result: BridgeResult): void {
    const p = this.#parked.get(id);
    if (!p || !p.admitted) throw new Error(`No admitted call ${id} is waiting for a result.`);
    this.#parked.delete(id);
    p.settle(result);
  }

  /** Records a violation once, answers every held call and tells the owner. */
  fail(message: string): void {
    if (this.#failure !== null) return;
    this.#failure = message;
    for (const [id, p] of this.#parked) {
      this.#parked.delete(id);
      p.settle({ content: [{ type: "text", text: message }], isError: true });
    }
    this.#opts.onViolation?.(message);
    this.#opts.onChange?.();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, p] of this.#parked) {
      this.#parked.delete(id);
      p.settle({ content: [{ type: "text", text: "MCP bridge closed." }], isError: true });
    }
    // The answers to held calls need a moment to leave, so connections that are still open are cut after a short wait.
    const cut = setTimeout(() => this.#server.closeAllConnections?.(), 250);
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeIdleConnections?.();
    });
    clearTimeout(cut);
  }

  #tryAdmit(id: string): void {
    const p = this.#parked.get(id);
    const intent = this.#intents.get(id);
    if (!p || !intent || p.admitted) return;
    if (intent.name !== p.name || !isDeepStrictEqual(intent.arguments, p.args)) {
      this.fail(MISMATCH_MESSAGE);
      return;
    }
    p.admitted = true;
    this.#opts.onChange?.();
  }

  #authorised(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const m = /^Bearer (.+)$/.exec(header);
    if (!m) return false;
    return timingSafeEqual(digest(m[1]), digest(this.token));
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.#authorised(req)) {
      res.writeHead(401, { "content-type": "text/plain" }).end("Unauthorised");
      return;
    }
    if (req.url?.split("?")[0] !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    // One server and one transport for each request, the stateless pattern of the SDK.
    const server = new Server({ name: BRIDGE_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
    // Claude Code 2.1.316 runs MCP tools one at a time unless a tool says it only reads, and the turn needs every call of a
    // message to arrive before it can be admitted. The harness runs each tool itself after admission, so the hint changes
    // only the order in which the CLI sends its calls (2 November 2026).
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.#tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as { type: "object" }, annotations: { readOnlyHint: true } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => this.#call(request.params, res) as Promise<CallToolResult>);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.once("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" }).end("Bridge error");
    }
  }

  #call(
    params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> },
    res: http.ServerResponse,
  ): Promise<BridgeResult> {
    const reject = (message: string): never => {
      this.fail(message);
      throw new McpError(ErrorCode.InvalidParams, message);
    };
    const id = params._meta?.[TOOL_USE_ID_KEY];
    if (typeof id !== "string" || id === "") return reject("The MCP call has no tool use identifier.");
    if (this.#seen.has(id) || this.#cancelled.has(id)) return reject("The MCP call reuses a tool use identifier.");
    this.#seen.add(id);
    if (!this.#tools.some((t) => t.name === params.name)) return reject(`The tool ${params.name} is not declared.`);
    if (this.#failure !== null) return Promise.resolve({ content: [{ type: "text", text: this.#failure }], isError: true });

    return new Promise<BridgeResult>((resolve) => {
      let done = false;
      const settle = (r: BridgeResult): void => {
        if (done) return;
        done = true;
        res.off("close", onClose);
        resolve(r);
      };
      // The CLI cancels a request by closing it. Only that request is removed, and its id can never be admitted.
      const onClose = (): void => {
        if (done) return;
        this.#parked.delete(id);
        this.#cancelled.add(id);
        settle({ content: [{ type: "text", text: "MCP request cancelled." }], isError: true });
        this.#opts.onChange?.();
      };
      res.once("close", onClose);
      this.#parked.set(id, { name: params.name, args: (params.arguments ?? {}) as Record<string, unknown>, admitted: false, settle });
      this.#opts.onChange?.();
      this.#tryAdmit(id);
    });
  }

  /** True when the id was cancelled by the CLI. */
  wasCancelled(id: string): boolean {
    return this.#cancelled.has(id);
  }
}
