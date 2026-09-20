import { Readable, Writable } from "node:stream";
import { createEventBus } from "../events/index.js";
import { ExtensionPeer } from "../extensions/protocol.js";
import type { ChannelAdapter, ChannelConfig, ChannelEventMap, HttpHandler } from "./types.js";
import { isChallengeChannel } from "./capabilities.js";

/** Adapter-side Channel contract. Only IPC crosses the process boundary. */
export function serveChannelExtension(create: (instanceId: string) => ChannelAdapter): void {
  if (!process.send) throw new Error("Managed extension IPC is required");
  const controller = new AbortController();
  const routes = new Map<string, HttpHandler>();
  let adapter: ChannelAdapter | undefined;
  let ready = false;
  const peer = new ExtensionPeer((frame) => process.send!(frame), async (method, payload) => {
    if (method === "control.start") {
      controller.signal.throwIfAborted();
      if (adapter) throw new Error("Already started");
      const start = payload as { protocol: number; type: string; contract: number; projection: { id: string; config: ChannelConfig } };
      if (start.protocol !== 1 || start.type !== "channel" || start.contract !== 1) throw new Error("Protocol mismatch");
      adapter = create(start.projection.id);
      const registrations: Promise<unknown>[] = [];
      await adapter.connect({
        config: start.projection.config, abortSignal: controller.signal,
        eventBus: createEventBus<ChannelEventMap>(),
        // SDK diagnostics stay in the process; never forward credential-bearing errors.
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        onMessage: async (message) => { await peer.call("channel.message", message); },
        onChallengeAction: async (action) => { await peer.call("channel.challenge-action", action); },
        registerHttpRoute: (path, handler) => {
          if (routes.has(path)) throw new Error("Duplicate callback route");
          routes.set(path, handler);
          registrations.push(peer.call("channel.register-route", { path }));
        },
      });
      await Promise.all(registrations);
      controller.signal.throwIfAborted();
      ready = true;
      await peer.call("channel.ready", { challenges: isChallengeChannel(adapter), bindingPolicy: adapter.bindingPolicy });
      return { protocol: 1 };
    }
    if (method === "control.health") return ready ? adapter?.health?.() ?? "ready" : "starting";
    if (method === "control.stop") {
      ready = false;
      controller.abort();
      await adapter?.disconnect();
      routes.clear();
      setImmediate(() => { peer.close(); process.disconnect(); });
      return null;
    }
    if (!ready || !adapter) throw new Error("Channel not ready");
    if (method === "channel.send") {
      const request = payload as { target: Parameters<ChannelAdapter["send"]>[0]; content: Parameters<ChannelAdapter["send"]>[1]; meta?: Parameters<ChannelAdapter["send"]>[2] };
      return adapter.send(request.target, request.content, request.meta);
    }
    if (method === "channel.send-challenge" && isChallengeChannel(adapter)) {
      return adapter.sendChallenge(payload as Parameters<typeof adapter.sendChallenge>[0]);
    }
    if (method === "channel.http") {
      const request = payload as { path: string; method: string; headers: Record<string, string>; body: Uint8Array };
      const handler = routes.get(request.path);
      if (!handler) throw new Error("Callback route unavailable");
      const req = Object.assign(Readable.from([Buffer.from(request.body)]), { url: request.path, method: request.method, headers: request.headers });
      const res = new BufferedResponse();
      await handler(req, res);
      await res.finished;
      return { status: res.statusCode, headers: res.headers, body: Buffer.concat(res.chunks) };
    }
    throw new Error("Unknown Channel operation");
  });
  process.on("message", (frame) => peer.accept(frame));
  process.once("disconnect", () => {
    ready = false;
    controller.abort();
    peer.close();
    void adapter?.disconnect().finally(() => process.exit(0));
  });
}

class BufferedResponse extends Writable {
  statusCode = 200;
  readonly headers: Record<string, string> = {};
  readonly chunks: Buffer[] = [];
  readonly finished: Promise<void>;
  constructor() {
    super();
    this.finished = new Promise((resolve, reject) => { this.once("finish", resolve); this.once("error", reject); });
  }
  setHeader(name: string, value: string): this { this.headers[name] = value; return this; }
  getHeader(name: string): string | undefined { return this.headers[name]; }
  writeHead(status: number, headers?: Record<string, string>): this { this.statusCode = status; Object.assign(this.headers, headers); return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk)); callback();
  }
}
