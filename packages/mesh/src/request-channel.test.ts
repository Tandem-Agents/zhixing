import { describe, expect, it } from "vitest";
import type { DeviceIdentity } from "@zhixing/core/contracts";
import { MeshProtocolError } from "./errors.js";
import { MeshRequestChannel } from "./request-channel.js";
import { MAX_RUNTIME_TIMER_DELAY_MS } from "./runtime-time.js";
import { MeshServiceRegistry } from "./service-registry.js";
import { createSecureMeshConnection } from "./session.js";
import type { MeshFrameTransport } from "./transport.js";

describe("MeshRequestChannel", () => {
  it("multiplexes concurrent bidirectional requests through one receive loop", async () => {
    const [leftConnection, rightConnection] = connections();
    const leftRegistry = new MeshServiceRegistry();
    const rightRegistry = new MeshServiceRegistry();
    let left!: MeshRequestChannel;
    let right!: MeshRequestChannel;
    leftRegistry.register("left.decorate", {
      access: "write",
      availability: "negotiated-version",
      handler: async (payload) => Buffer.from(`left:${Buffer.from(payload).toString("utf8")}`),
    });
    rightRegistry.register("right.nested", {
      access: "write",
      availability: "negotiated-version",
      handler: async (payload) => right.request("left.decorate", payload),
    });
    left = new MeshRequestChannel(leftConnection, leftRegistry);
    right = new MeshRequestChannel(rightConnection, rightRegistry);

    const results = await Promise.all([
      left.request("right.nested", Buffer.from("one")),
      left.request("right.nested", Buffer.from("two")),
    ]);

    expect(results.map((value) => Buffer.from(value).toString("utf8"))).toEqual([
      "left:one",
      "left:two",
    ]);
    await Promise.all([left.close(), right.close()]);
  });

  it("publishes only fixed protocol failures and rejects unknown services", async () => {
    const [leftConnection, rightConnection] = connections();
    const left = new MeshRequestChannel(leftConnection, new MeshServiceRegistry());
    const registry = new MeshServiceRegistry();
    registry.register("failure.test", {
      access: "write",
      availability: "negotiated-version",
      handler: async () => {
        throw new Error("secret-token at C:\\private\\artifact");
      },
    });
    registry.register("protocol-failure.test", {
      access: "write",
      availability: "negotiated-version",
      handler: async () => {
        throw new MeshProtocolError(
          "unauthorized-peer",
          "secret-token at C:\\private\\identity",
        );
      },
    });
    const right = new MeshRequestChannel(rightConnection, registry);

    await expect(left.request("failure.test", new Uint8Array())).rejects.toMatchObject({
      code: "service-failed",
      message: "Mesh service failed",
    });
    await expect(left.request("protocol-failure.test", new Uint8Array())).rejects.toMatchObject({
      code: "unauthorized-peer",
      message: "Mesh peer is not authorized",
    });
    await expect(left.request("missing.test", new Uint8Array())).rejects.toMatchObject({
      code: "service-unavailable",
    });
    await Promise.all([left.close(), right.close()]);
  });

  it("rejects over-limit payloads before writing to the connection", async () => {
    const [leftConnection, rightConnection] = connections();
    const left = new MeshRequestChannel(leftConnection, new MeshServiceRegistry(), {
      maxPayloadBytes: 4,
    });
    const right = new MeshRequestChannel(rightConnection, new MeshServiceRegistry());

    await expect(left.request("payload.test", Buffer.from("12345"))).rejects.toBeInstanceOf(
      MeshProtocolError,
    );
    await Promise.all([left.close(), right.close()]);
  });

  it("contains an in-flight handler when its response connection closes", async () => {
    const [leftConnection, rightConnection] = connections();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new MeshServiceRegistry();
    registry.register("delayed.test", {
      access: "write",
      availability: "negotiated-version",
      handler: async () => {
        enter();
        await released;
        return Buffer.from("late");
      },
    });
    const left = new MeshRequestChannel(leftConnection, new MeshServiceRegistry());
    const right = new MeshRequestChannel(rightConnection, registry);
    const response = left.request("delayed.test", new Uint8Array());
    const rejected = expect(response).rejects.toMatchObject({ code: "connection-closed" });

    await entered;
    await left.close();
    release();
    await rejected;
    await right.closed;
  });

  it("bounds silent outbound requests and closes them at the configured deadline", async () => {
    const [leftConnection] = connections();
    const left = new MeshRequestChannel(leftConnection, new MeshServiceRegistry(), {
      maxOutboundRequests: 1,
      requestTimeoutMs: 20,
    });
    const first = left.request("silent.test", new Uint8Array());
    const firstRejection = expect(first).rejects.toMatchObject({ code: "request-timeout" });

    await expect(left.request("silent.test", new Uint8Array())).rejects.toMatchObject({
      code: "resource-exhausted",
    });
    await firstRejection;
    await left.closed;
  });

  it("closes the channel when cancellation cannot terminate an outbound send", async () => {
    const fixture = connectionFixture();
    const sendStarted = fixture.leftTransport.blockNextSend();
    const left = new MeshRequestChannel(
      fixture.leftConnection,
      new MeshServiceRegistry(),
      { maxOutboundRequests: 1 },
    );
    const controller = new AbortController();
    const pending = left.request("blocked.test", new Uint8Array(), controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ code: "request-aborted" });

    await sendStarted;
    await expect(left.request("blocked.test", new Uint8Array())).rejects.toMatchObject({
      code: "resource-exhausted",
    });
    controller.abort();

    await rejection;
    await Promise.all([left.closed, fixture.rightConnection.closed]);
    expect(fixture.leftTransport.sendAttempts).toBe(1);
    await expect(left.request("blocked.test", new Uint8Array())).rejects.toMatchObject({
      code: "connection-closed",
    });
  });

  it("bounds response sending with the inbound request deadline", async () => {
    const fixture = connectionFixture();
    const responseSendStarted = fixture.rightTransport.blockNextSend();
    const registry = new MeshServiceRegistry();
    registry.register("blocked.response", {
      access: "write",
      availability: "negotiated-version",
      handler: async () => Buffer.from("response"),
    });
    const left = new MeshRequestChannel(
      fixture.leftConnection,
      new MeshServiceRegistry(),
    );
    const right = new MeshRequestChannel(fixture.rightConnection, registry, {
      handlerTimeoutMs: 20,
    });
    const pending = left.request("blocked.response", new Uint8Array());
    const rejection = expect(pending).rejects.toMatchObject({ code: "connection-closed" });

    await responseSendStarted;
    await rejection;
    await Promise.all([left.closed, right.closed]);
    expect(fixture.rightTransport.sendAttempts).toBe(1);
  });

  it("rejects timeout values that runtime timers cannot represent", async () => {
    const legalFixture = connectionFixture();
    const legal = new MeshRequestChannel(
      legalFixture.leftConnection,
      new MeshServiceRegistry(),
      {
        requestTimeoutMs: MAX_RUNTIME_TIMER_DELAY_MS,
        handlerTimeoutMs: MAX_RUNTIME_TIMER_DELAY_MS,
      },
    );
    await legal.close();
    await legalFixture.rightConnection.closed;

    for (const options of [
      { requestTimeoutMs: MAX_RUNTIME_TIMER_DELAY_MS + 1 },
      { handlerTimeoutMs: MAX_RUNTIME_TIMER_DELAY_MS + 1 },
    ]) {
      const fixture = connectionFixture();
      expect(() => new MeshRequestChannel(
        fixture.leftConnection,
        new MeshServiceRegistry(),
        options,
      )).toThrow("runtime timer duration");
      await fixture.leftConnection.close();
      await fixture.rightConnection.closed;
    }
  });

  it("aborts a hung inbound handler and rejects overload without creating more work", async () => {
    const [leftConnection, rightConnection] = connections();
    let entered = 0;
    let observedAbort = false;
    let resolveAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    const registry = new MeshServiceRegistry();
    registry.register("hung.test", {
      access: "write",
      availability: "negotiated-version",
      handler: async (_payload, _connection, signal) => {
        entered += 1;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            observedAbort = true;
            resolveAbort();
            resolve();
          }, { once: true });
        });
        signal.throwIfAborted();
        return new Uint8Array();
      },
    });
    const left = new MeshRequestChannel(leftConnection, new MeshServiceRegistry(), {
      requestTimeoutMs: 100,
    });
    const right = new MeshRequestChannel(rightConnection, registry, {
      maxInboundRequests: 1,
      handlerTimeoutMs: 30,
    });
    const first = left.request("hung.test", new Uint8Array());
    const firstRejection = expect(first).rejects.toBeInstanceOf(MeshProtocolError);
    await Promise.resolve();
    const second = left.request("hung.test", new Uint8Array());
    const secondRejection = expect(second).rejects.toBeInstanceOf(MeshProtocolError);

    await Promise.all([firstRejection, secondRejection]);
    await aborted;
    expect(entered).toBe(1);
    expect(observedAbort).toBe(true);
    await Promise.all([left.closed, right.closed]);
  });
});

function connections() {
  const fixture = connectionFixture();
  return [fixture.leftConnection, fixture.rightConnection] as const;
}

function connectionFixture() {
  const [leftTransport, rightTransport] = memoryTransports();
  const range = { min: "1", max: "1" } as const;
  const leftConnection = createSecureMeshConnection({
    transport: leftTransport,
    connectionId: "connection-left",
    compatibility: { mode: "read-write", protocolVersion: "1" },
    localProtocolRange: range,
    peerProtocolRange: range,
    peer: identity("right"),
  });
  const rightConnection = createSecureMeshConnection({
    transport: rightTransport,
    connectionId: "connection-right",
    compatibility: { mode: "read-write", protocolVersion: "1" },
    localProtocolRange: range,
    peerProtocolRange: range,
    peer: identity("left"),
  });
  return { leftConnection, rightConnection, leftTransport, rightTransport };
}

function identity(deviceId: string): DeviceIdentity {
  return {
    deviceId,
    publicKey: `public-key-${deviceId}`,
    displayName: deviceId,
    platform: "headless",
    enrolledAt: "2026-07-21T00:00:00.000Z",
  };
}

function memoryTransports(): [MeshFrameTransport, MeshFrameTransport] {
  const state = {
    closed: false,
    endpoints: [] as MemoryTransport[],
  };
  const left = new MemoryTransport(state);
  const right = new MemoryTransport(state);
  state.endpoints.push(left, right);
  left.peer = right;
  right.peer = left;
  return [left, right];
}

type TransportWaiter = {
  resolve: (frame: Uint8Array) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

class MemoryTransport implements MeshFrameTransport {
  peer!: MemoryTransport;
  readonly #queue: Uint8Array[] = [];
  readonly #waiters: TransportWaiter[] = [];
  readonly closed: Promise<void>;
  readonly #resolveClosed: () => void;
  #sendBlock?: {
    readonly entered: () => void;
    readonly wait: Promise<void>;
    readonly reject: (error: Error) => void;
  };
  sendAttempts = 0;

  constructor(private readonly state: { closed: boolean; endpoints: MemoryTransport[] }) {
    let resolveClosed!: () => void;
    this.closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.state.closed) throw new Error("closed");
    this.sendAttempts += 1;
    const block = this.#sendBlock;
    if (block) {
      block.entered();
      try {
        await block.wait;
      } finally {
        if (this.#sendBlock === block) this.#sendBlock = undefined;
      }
    }
    if (this.state.closed) throw new Error("closed");
    this.peer.deliver(frame.slice());
  }

  blockNextSend(): Promise<void> {
    if (this.#sendBlock) throw new Error("A send is already blocked");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reject!: (error: Error) => void;
    const wait = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    this.#sendBlock = { entered, wait, reject };
    return started;
  }

  async receive(signal?: AbortSignal): Promise<Uint8Array> {
    if (this.state.closed) throw new Error("closed");
    const queued = this.#queue.shift();
    if (queued) return queued;
    return new Promise<Uint8Array>((resolve, reject) => {
      const waiter: TransportWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.state.closed) return;
    this.state.closed = true;
    for (const endpoint of this.state.endpoints) endpoint.finish();
  }

  deliver(frame: Uint8Array): void {
    const waiter = this.#waiters.shift();
    if (!waiter) {
      this.#queue.push(frame);
      return;
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve(frame);
  }

  finish(): void {
    this.#resolveClosed();
    this.#sendBlock?.reject(new Error("closed"));
    for (const waiter of this.#waiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.reject(new Error("closed"));
    }
  }
}
