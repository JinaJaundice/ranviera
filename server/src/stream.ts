// Server-Sent Events: the clients, the hello message and the heartbeat.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StreamMessage } from "../../shared/types.ts";

export function formatMessage(msg: StreamMessage): string {
  return `event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`;
}

export class StreamHub {
  private clients = new Set<ServerResponse>();
  private timer: NodeJS.Timeout;
  private getHello: () => Promise<{ built: string; status: unknown }>;

  constructor(getHello: () => Promise<{ built: string; status: unknown }>, heartbeatMs = 15000) {
    this.getHello = getHello;
    this.timer = setInterval(() => this.broadcast({ type: "heartbeat", ts: new Date().toISOString() }), heartbeatMs);
    this.timer.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  async add(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
    try {
      const hello = await this.getHello();
      res.write(formatMessage({ type: "hello", built: hello.built, status: hello.status }));
    } catch {
      // the client still receives later messages
    }
  }

  broadcast = (msg: StreamMessage): void => {
    const text = formatMessage(msg);
    for (const c of this.clients) {
      try {
        c.write(text);
      } catch {
        this.clients.delete(c);
      }
    }
  };

  close(): void {
    clearInterval(this.timer);
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}
