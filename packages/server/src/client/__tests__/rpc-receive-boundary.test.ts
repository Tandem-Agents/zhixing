import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { createRpcClient, RpcClientClosedError, type RpcClient } from "../rpc-client.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("RPC receive boundary with a real WebSocket receiver", () => {
  let server: WebSocketServer;
  let client: RpcClient;

  afterEach(async () => {
    if (client) await client.close();
    if (server) {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  async function connect(compress = false, timeout = 2_000) {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0,
      perMessageDeflate: compress ? { threshold: 0 } : false });
    await once(server, "listening");
    const address = server.address();
    if (typeof address !== "object" || !address) throw Error("Missing test endpoint");
    const connected = once(server, "connection");
    client = createRpcClient({ url: `ws://127.0.0.1:${address.port}`, timeout });
    await client.connect();
    return (await connected)[0] as WebSocket;
  }

  function batch(socket: WebSocket, messages: string[], fragmented: boolean) {
    // Cork real ws frames into one TCP write, covering already-buffered frames
    // rather than relying on the timing of several independent socket writes.
    const transport = (socket as unknown as { _socket: Socket })._socket;
    transport.cork();
    for (const message of messages) {
      if (fragmented) {
        const middle = Math.floor(message.length / 2);
        socket.send(message.slice(0, middle), { fin: false });
        socket.send(message.slice(middle), { fin: true });
      } else socket.send(message);
    }
    transport.uncork();
  }

  it.each([
    { compress: false, fragmented: false },
    { compress: false, fragmented: true },
    { compress: true, fragmented: false },
    { compress: true, fragmented: true },
  ])("holds following response and notification until consumption: %j", async ({ compress, fragmented }) => {
    const socket = await connect(compress);
    expect(socket.extensions.includes("permessage-deflate")).toBe(compress);
    const entered = deferred(), release = deferred();
    const events: string[] = [];
    client.onNotification<string>("after", value => events.push(value));
    const first = client.consume!<{ body: string }, number>("first", {}, async result => {
      events.push("first");
      entered.resolve();
      await release.promise;
      expect(result.body).toBe("中文 material ".repeat(100));
      events.push("consumed");
      return result.body.length;
    });
    const second = client.request<string>("second").then(value => { events.push(value); return value; });
    const requests: number[] = [];
    socket.on("message", data => {
      requests.push(JSON.parse(data.toString()).id);
      if (requests.length === 2) batch(socket, [
        JSON.stringify({ jsonrpc: "2.0", id: requests[0], result: { body: "中文 material ".repeat(100) } }),
        JSON.stringify({ jsonrpc: "2.0", id: requests[1], result: "second" }),
        JSON.stringify({ jsonrpc: "2.0", method: "after", params: "notification" }),
      ], fragmented);
    });
    await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(events).toEqual(["first"]);
    release.resolve();
    expect(await first).toBe("中文 material ".repeat(100).length);
    expect(await second).toBe("second");
    await vi.waitFor(() => expect(events).toEqual(["first", "consumed", "second", "notification"]));
  });

  it("local close rejects a held consumer once and does not wait for its IO", async () => {
    const socket = await connect(true);
    const entered = deferred(), release = deferred();
    const observed = vi.fn(), closed = vi.fn();
    client.onClose!(closed);
    client.onNotification("late", observed);
    socket.on("message", data => batch(socket, [
      JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(data.toString()).id, result: {} }),
      JSON.stringify({ jsonrpc: "2.0", method: "late", params: {} }),
    ], true));
    const settled = client.consume!("held", {}, async () => {
      entered.resolve(); await release.promise; return "late result";
    }).catch(error => error);
    await entered.promise;
    await client.close();
    expect(await settled).toBeInstanceOf(RpcClientClosedError);
    expect(closed).toHaveBeenCalledOnce();
    expect(observed).not.toHaveBeenCalled();
    release.resolve();
    await new Promise(resolve => setImmediate(resolve));
    expect(closed).toHaveBeenCalledOnce();
    expect(observed).not.toHaveBeenCalled();
  });

  it("queued responses retain their original timeout and are ignored after expiry", async () => {
    const socket = await connect(false, 350);
    const entered = deferred(), release = deferred(), queuedArrived = deferred();
    let count = 0;
    let queuedId: number;
    socket.on("message", data => {
      const { id, method } = JSON.parse(data.toString()); count++;
      if (method === "queued") { queuedId = id; queuedArrived.resolve(); return; }
      batch(socket, [JSON.stringify({ jsonrpc: "2.0", id, result: count }),
        ...(method === "held" ? [JSON.stringify({ jsonrpc: "2.0", id: queuedId, result: 1 })] : []),
      ], false);
    });
    const lateConsumer = vi.fn();
    const queued = client.consume!("queued", {}, lateConsumer).catch(error => error);
    await queuedArrived.promise;
    await new Promise(resolve => setTimeout(resolve, 100));
    const first = client.consume!("held", {}, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    expect(await queued).toMatchObject({ message: "RPC request timeout after 350ms: queued" });
    release.resolve();
    await first;
    expect(await client.request("after-expiry")).toBe(3);
    expect(lateConsumer).not.toHaveBeenCalled();
    expect(count).toBe(3);
  });

  it("an unsettled consumer keeps the original deadline and closes admission on timeout", async () => {
    const socket = await connect(false, 100);
    const release = deferred();
    socket.on("message", data => socket.send(JSON.stringify({
      jsonrpc: "2.0", id: JSON.parse(data.toString()).id, result: {},
    })));
    try {
      await expect(client.consume!("held", {}, () => release.promise)).rejects.toThrow("timeout after 100ms");
      expect(client.closed).toBe(true);
      await expect(client.request("late")).rejects.toBeInstanceOf(RpcClientClosedError);
    } finally { release.resolve(); }
  });

  it("transport loss settles a held consumer without waiting for its IO", async () => {
    const socket = await connect();
    const entered = deferred(), release = deferred();
    socket.on("message", data => socket.send(JSON.stringify({
      jsonrpc: "2.0", id: JSON.parse(data.toString()).id, result: {},
    })));
    const settled = client.consume!("held", {}, async () => {
      entered.resolve(); await release.promise;
    }).catch(error => error);
    await entered.promise;
    try {
      socket.terminate();
      await vi.waitFor(() => expect(client.closed).toBe(true), { timeout: 400 });
      expect(await settled).toBeInstanceOf(RpcClientClosedError);
    } finally { release.resolve(); }
  });

  it("consumer rejection releases the boundary without closing or resending", async () => {
    const socket = await connect();
    let count = 0;
    socket.on("message", data => {
      const { id } = JSON.parse(data.toString()); count++;
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, result: count }));
    });
    await expect(client.consume!("bad-consumer", {}, () => { throw Error("disk failure"); })).rejects.toThrow("disk failure");
    expect(await client.request("next")).toBe(2);
    expect(client.closed).toBe(false);
  });

  it("keeps malformed JSON isolated and continues with the following response", async () => {
    const socket = await connect();
    socket.on("message", data => batch(socket, [
      "{invalid", JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(data.toString()).id, result: "ok" }),
    ], false));
    expect(await client.request("after-malformed")).toBe("ok");
  });

  it("decodes a compressed frame spanning many receive pages without changing its content", async () => {
    const socket = await connect(true);
    let seed = 183726;
    const bytes = Buffer.alloc(768 * 1024);
    for (let i = 0; i < bytes.length; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      bytes[i] = 33 + ((seed >>> 0) % 90);
    }
    const expected = bytes.toString("ascii");
    socket.on("message", data => socket.send(JSON.stringify({
      jsonrpc: "2.0", id: JSON.parse(data.toString()).id, result: expected,
    }), { compress: true }));
    const actual = await client.request<string>("large-compressed");
    expect(createHash("sha256").update(actual).digest("hex")).toBe(createHash("sha256").update(expected).digest("hex"));
    expect(actual.length).toBe(expected.length);
  });
});
