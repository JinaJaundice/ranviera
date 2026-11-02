// A stand in for the claude command in the tests. It prints stream JSON lines and, in the tool scenarios, calls the
// MCP tool of the bridge over HTTP with the bearer token that it finds in the MCP configuration file. It calls no
// model and signs in to nothing. The scenario comes from FAKE_CLAUDE_SCENARIO and a log of what it saw goes to
// FAKE_CLAUDE_LOG, one JSON line for each fact.
import fs from "node:fs";
import readline from "node:readline";

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "text";
const logFile = process.env.FAKE_CLAUDE_LOG;
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const log = (o) => {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify(o)}\n`);
};
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const promptFile = flag("--system-prompt-file");
const mcpFile = flag("--mcp-config");
const modeOf = (f) => (f ? (fs.statSync(f).mode & 0o777).toString(8) : null);
log({
  kind: "start",
  args,
  cwd: process.cwd(),
  cwdEntries: fs.readdirSync(process.cwd()),
  systemPrompt: promptFile ? fs.readFileSync(promptFile, "utf8") : null,
  promptMode: modeOf(promptFile),
  mcpMode: modeOf(mcpFile),
  env: {
    MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT,
    CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: process.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT,
    saved: process.env.FAKE_SAVED_KEY ?? null,
    kept: process.env.FAKE_KEPT_VAR ?? null,
  },
});

const usage = { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, output_tokens: 1 };
let n = 0;
const messageStart = () => out({ type: "stream_event", event: { type: "message_start", message: { id: `msg_${++n}`, model: "claude-test", usage } } });
const block = (index, content_block) => out({ type: "stream_event", event: { type: "content_block_start", index, content_block } });
const delta = (index, d) => out({ type: "stream_event", event: { type: "content_block_delta", index, delta: d } });
const stop = (index) => out({ type: "stream_event", event: { type: "content_block_stop", index } });
const messageEnd = (reason, outputTokens) => {
  out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: outputTokens } } });
  out({ type: "stream_event", event: { type: "message_stop" } });
};
const result = (text) => out({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 7 } });

const textMessage = (text) => {
  messageStart();
  block(0, { type: "thinking", thinking: "" });
  delta(0, { type: "thinking_delta", thinking: "Considering " });
  delta(0, { type: "thinking_delta", thinking: "it." });
  stop(0);
  block(1, { type: "text", text: "" });
  delta(1, { type: "text_delta", text: text.slice(0, 6) });
  delta(1, { type: "text_delta", text: text.slice(6) });
  stop(1);
  messageEnd("end_turn", 7);
  result(text);
};

const toolMessage = (id, name, inputJson) => {
  messageStart();
  block(0, { type: "text", text: "" });
  delta(0, { type: "text_delta", text: "Asking." });
  stop(0);
  block(1, { type: "tool_use", id, name, input: {} });
  const half = Math.floor(inputJson.length / 2);
  delta(1, { type: "input_json_delta", partial_json: inputJson.slice(0, half) });
  delta(1, { type: "input_json_delta", partial_json: inputJson.slice(half) });
  stop(1);
  messageEnd("tool_use", 12);
};

async function callBridge(id, name, argumentsObject) {
  const cfg = JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServers.learn;
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { ...cfg.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: argumentsObject, _meta: { "claudecode/toolUseId": id } } }),
  });
  const body = await res.text();
  const line = body.split("\n").find((l) => l.startsWith("data:"));
  const json = JSON.parse(line ? line.slice(5) : body);
  log({ kind: "bridge-reply", status: res.status, json });
  return json;
}

async function handleUser(text) {
  log({ kind: "user", text });
  if (scenario === "signed-out") {
    out({ type: "assistant", error: "authentication_failed", message: { id: "x", content: [] } });
    out({ type: "result", subtype: "success", is_error: true, result: "Not logged in. Please run /login" });
    return;
  }
  if (scenario === "result-error") {
    out({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["first problem", "second problem"] });
    return;
  }
  if (scenario === "exit-mid") {
    messageStart();
    process.stderr.write("secret stderr text");
    await sleep(20);
    process.exit(3);
  }
  if (scenario === "malformed") {
    process.stdout.write("this is not json\n");
    return;
  }
  if (scenario === "native-tool") {
    toolMessage("toolu_N", "Bash", '{"command":"ls"}');
    return;
  }
  if (scenario === "hang") {
    messageStart();
    await sleep(60000);
    return;
  }
  if (scenario === "self-answer") {
    toolMessage("toolu_A", "mcp__learn__ask", JSON.stringify({ question: "why?" }));
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A", is_error: true, content: [{ type: "text", text: "<tool_use_error>Error calling tool: MCP tool none was not found.</tool_use_error>" }] }] } });
    await sleep(20);
    process.exit(0);
  }
  if (text.includes("[tool result")) {
    textMessage("Replayed answer");
    await sleep(20);
    process.exit(0);
  }
  if (scenario === "tool" || scenario === "tool-mismatch" || scenario === "tool-reuse" || scenario === "tool-rate-limit") {
    const intent = { question: "why?" };
    toolMessage("toolu_A", "mcp__learn__ask", JSON.stringify(intent));
    if (scenario === "tool-rate-limit") {
      out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1793630000 } });
      out({ type: "tool_progress", tool_use_id: "toolu_A", tool_name: "mcp__learn__ask", elapsed_time_seconds: 1 });
    }
    const sent = scenario === "tool-mismatch" ? { question: "different" } : intent;
    const reply = await callBridge("toolu_A", "ask", sent);
    if (scenario === "tool-reuse") await callBridge("toolu_A", "ask", sent);
    const answer = reply.result?.content?.map((c) => c.text ?? "").join("") ?? "no result";
    textMessage(`Got: ${answer}`);
    await sleep(20);
    process.exit(0);
  }
  textMessage("Hello world");
  await sleep(20);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.type === "control_request") {
    log({ kind: "control", subtype: msg.request.subtype });
    if (process.env.FAKE_CLAUDE_NO_PROBE === "1") return;
    const response = msg.request.subtype === "get_context_usage" ? { maxTokens: 200000 } : {};
    out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response } });
    return;
  }
  if (msg.type === "user") {
    const blocks = msg.message.content;
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
    log({ kind: "blocks", types: blocks.map((b) => b.type) });
    void handleUser(text);
  }
});
rl.on("close", () => {
  log({ kind: "stdin-closed" });
});
process.on("SIGTERM", () => {
  log({ kind: "sigterm" });
  process.exit(143);
});
