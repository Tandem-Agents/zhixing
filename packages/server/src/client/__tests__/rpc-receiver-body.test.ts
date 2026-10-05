import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { RpcMessagePump } from "../rpc-message-pump.js";
import type { RpcReceiverEdge } from "../rpc-receiver-body.js";

describe("pinned receiver body storage", () => {
  let server: WebSocketServer;
  let client: WebSocket;
  let pump: RpcMessagePump;
  afterEach(async () => {
    pump?.close();
    client?.terminate();
    for (const socket of server?.clients ?? []) socket.terminate();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  });

  async function connect(dispatch: (text: string) => void, maxPayload?: number) {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: { threshold: 0 } });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing endpoint");
    const peer = once(server, "connection");
    client = new WebSocket(`ws://127.0.0.1:${address.port}`, maxPayload ? { maxPayload } : {});
    client.on("error", () => {});
    await once(client, "open");
    pump = new RpcMessagePump(client, dispatch, () => client.terminate());
    client.on("message", data => pump.accept(data));
    client.on("close", () => pump.close());
    return (await peer)[0] as WebSocket;
  }

  it("retains the default 100 MiB cap and validates UTF-8 after tiny fragments with control interleaving", async () => {
    const done = Promise.withResolvers<string>();
    const peer = await connect(done.resolve);
    const receiver = (client as unknown as { _receiver: RpcReceiverEdge })._receiver;
    expect(receiver._maxPayload).toBe(100 * 1024 * 1024);
    const input = Buffer.from("中文🙂".repeat(800));
    let pongs = 0;
    peer.on("pong", () => pongs++);
    for (let i = 0; i < input.length; i++) {
      peer.send(input.subarray(i, i + 1), { binary: false, compress: false, fin: i === input.length - 1 });
      if (i === 100) peer.ping("alive");
    }
    expect(await done.promise).toBe(input.toString());
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(pongs).toBe(1);
  });

  it.each([false, true])("keeps the existing payload rejection for compress=%s", async compress => {
    let deliveries = 0;
    const peer = await connect(() => deliveries++, 4096);
    const ended = new Promise<number>(resolve => client.once("close", code => resolve(code)));
    peer.send("x".repeat(4097), { compress });
    await ended;
    expect(deliveries).toBe(0);
  });

  it("retains ws invalid UTF-8 rejection", async () => {
    let deliveries = 0;
    const peer = await connect(() => deliveries++);
    const ended = new Promise<number>(resolve => client.once("close", code => resolve(code)));
    peer.send(Buffer.from([0xc3, 0x28]), { binary: false, compress: false });
    await ended;
    expect(deliveries).toBe(0);
  });

  it('keeps the retired workspace until the actual inflater callback returns', async () => {
    const dispatch = vi.fn(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const peer = await connect(dispatch);
    const receiver = (client as unknown as { _receiver: RpcReceiverEdge })._receiver;
    const extension = receiver._extensions['permessage-deflate']!, original = extension.decompress;
    let returned = false;
    extension.decompress = function(data, fin, done) {
      original.call(this, data, fin, (error, decoded) => {
        entered.resolve();
        void release.promise.then(() => { done(error, decoded); returned = true; });
      });
    };
    peer.send('x'.repeat(256 * 1024), { compress: true });
    await entered.promise; pump.close();
    let drained = false; const draining = pump.drain().then(() => { drained = true; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      expect(drained).toBe(false); expect(returned).toBe(false);
    } finally { release.resolve(); }
    await draining; expect(returned).toBe(true); expect(dispatch).not.toHaveBeenCalled();
  });

  it('lets an interrupted real inflater callback return before WebSocket cleanup', async () => {
    const dispatch = vi.fn(), entered = Promise.withResolvers<void>();
    const peer = await connect(dispatch);
    const receiver = (client as unknown as { _receiver: RpcReceiverEdge })._receiver;
    const extension = receiver._extensions['permessage-deflate']!, original = extension.decompress;
    let callbackReturned = false, draining: Promise<void> | undefined;
    extension.decompress = function(data, fin, done) {
      original.call(this, data, fin, (error, decoded) => { done(error, decoded); callbackReturned = true; });
      queueMicrotask(() => { pump.close(); draining = pump.drain(); entered.resolve(); });
    };
    // events.once(close) rejects on the intentional Receiver teardown error;
    // observe the actual close receipt and assert that error separately.
    const errors: Error[] = [];
    client.on('error', error => { errors.push(error); });
    const closed = new Promise<void>(resolve => client.once('close', () => resolve()));
    peer.send('x'.repeat(256 * 1024), { compress: true });
    await entered.promise; await closed; await draining;
    expect(callbackReturned).toBe(true); expect(dispatch).not.toHaveBeenCalled();
    expect(errors.map(error => error.message)).toEqual(['RPC receive boundary closed']);
  });
});
