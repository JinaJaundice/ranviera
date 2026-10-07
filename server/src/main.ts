// Cortex server: the API, the event stream and the web app on one port.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { handleApi, buildStatus, type Context } from "./api.ts";
import { loadConfig, productOf, staticDir, type Config } from "./config.ts";
import { handleAuth, tokenOk } from "./setup.ts";
import { EventHub } from "./events.ts";
import { GraphStore } from "./graph.ts";
import { MissionManager } from "./missions.ts";
import { StreamHub } from "./stream.ts";
import { hostAllowed, originAllowed, sendText } from "./util.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const NOT_BUILT_WEB = "The web app files are missing from this installation. Reinstall the app, then open it again.";

function serveStatic(cfg: Config, req: http.IncomingMessage, res: http.ServerResponse): void {
  const dist = staticDir(cfg);
  const index = path.join(dist, "index.html");
  if (!fs.existsSync(index)) return sendText(res, 503, NOT_BUILT_WEB);
  let rel: string;
  try {
    rel = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    return sendText(res, 400, "The address is not valid.");
  }
  let file = path.join(dist, rel);
  if (!path.resolve(file).startsWith(path.resolve(dist) + path.sep) && path.resolve(file) !== path.resolve(dist)) return sendText(res, 403, "That path is not allowed.");
  const isFile = (() => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  })();
  if (!isFile) {
    if (path.extname(rel)) return sendText(res, 404, "That file does not exist.");
    file = index;
  }
  const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": file === index ? "no-cache" : "public, max-age=3600" });
  fs.createReadStream(file).pipe(res);
}

export interface App {
  server: http.Server;
  ctx: Context;
  close(): Promise<void>;
}

export async function createApp(cfg: Config, dev: boolean): Promise<App> {
  const stream = new StreamHub(async () => {
    const status = await buildStatus(ctx);
    return { built: status.built ?? "", status };
  });
  const graph = new GraphStore(cfg, stream.broadcast);
  const events = new EventHub(cfg, graph, stream.broadcast);
  const missions = new MissionManager(cfg, graph, events, stream.broadcast);
  const ctx: Context = { cfg, graph, events, missions, stream };

  graph.start();
  missions.recover();
  events.start();

  let vite: { middlewares: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void; close(): Promise<void> } | null = null;
  if (dev) {
    const { createServer } = await import("vite");
    vite = await createServer({
      configFile: path.join(cfg.repo_root, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { port: cfg.port + 10 } },
      appType: "spa",
    });
  }

  const server = http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host, cfg.port)) return sendText(res, 403, "This server answers only to localhost.");
    if (req.method === "POST" && !originAllowed(req.headers.origin, req.headers.host)) {
      return sendText(res, 403, "A request from another origin is not allowed.");
    }
    if (handleAuth(cfg, req, res)) return;
    const url = req.url ?? "/";
    if ((url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")) && !tokenOk(cfg, req)) {
      return sendText(res, 401, "This request needs the access token. Open the app from its own window.");
    }
    if (url === "/api" || url.startsWith("/api/") || url.startsWith("/api?")) {
      void handleApi(ctx, req, res);
      return;
    }
    if (vite) return void vite.middlewares(req, res, () => sendText(res, 404, "That page does not exist."));
    serveStatic(cfg, req, res);
  });

  return {
    server,
    ctx,
    async close() {
      graph.stop();
      events.stop();
      stream.close();
      await vite?.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const dev = process.argv.includes("--dev");
  const app = await createApp(cfg, dev);
  app.server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") console.error(`Port ${cfg.port} is already in use. Stop the other Cortex server, then start this one again.`);
    else console.error(e.message);
    process.exit(1);
  });
  app.server.listen(cfg.port, "127.0.0.1", () => {
    // port 0 asks for a free port, so the host check and the message use the port that was given
    cfg.port = (app.server.address() as AddressInfo).port;
    console.log(`${productOf(cfg) === "cortex" ? "Cortex" : "Ranviera"} is running at http://localhost:${cfg.port}`);
    // an Electron utility process tells its parent the port once the server listens
    (process as unknown as { parentPort?: { postMessage(m: unknown): void } }).parentPort?.postMessage({ type: "ready", port: cfg.port });
  });
  const quit = () => void app.close().then(() => process.exit(0));
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

/** The server starts when it is the main module, and also when it runs in an Electron utility process, where argv[1] need not match. */
export function shouldStart(argv1: string | undefined, metaUrl: string, parentPort: unknown): boolean {
  if (parentPort) return true;
  return Boolean(argv1) && path.resolve(argv1 as string) === fileURLToPath(metaUrl);
}

if (shouldStart(process.argv[1], import.meta.url, (process as unknown as { parentPort?: unknown }).parentPort)) {
  void main();
}
