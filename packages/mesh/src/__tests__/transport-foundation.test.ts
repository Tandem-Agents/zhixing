import { constants } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { Duplex, PassThrough } from "node:stream";
import {
  connect as connectNet,
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
import type { Server as TlsServer, TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeBlindRelay } from "../blind-relay.js";
import { DeviceKey, enrollDeviceIdentity } from "../device-identity.js";
import type { TrustedMeshPeer } from "../handshake.js";
import { OutboundMeshTunnel } from "../outbound-tunnel.js";
import { HandshakeReplayWindow } from "../replay-window.js";
import { MAX_RUNTIME_TIMER_DELAY_MS } from "../runtime-time.js";
import {
  type MeshServiceDefinition,
  MeshServiceRegistry,
} from "../service-registry.js";
import { SecureMeshConnection } from "../session.js";
import { SocketFrameTransport } from "../socket-transport.js";
import * as meshPublicApi from "../index.js";
import { createLiveTlsTestHarness } from "./live-tls-test-harness.js";

const LIVE_TLS_TIME = createLiveTlsTestHarness();
const NOW = LIVE_TLS_TIME.timestamp;
const openServers: Array<NetServer | TlsServer> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer));
});

describe("mesh transport foundation", () => {
  it("keeps the business service registry empty by default", () => {
    const registry = new MeshServiceRegistry();
    expect(registry.list()).toEqual([]);
    expect(() =>
      registry.register("invalid.write", {
        access: "write",
        availability: "version-independent",
        handler: async () => new Uint8Array(),
      } as unknown as MeshServiceDefinition),
    ).toThrow("Mesh service definition is invalid");
  });

  it("does not expose raw framed sockets outside authenticated mesh factories", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, unknown> };

    expect(manifest.exports).not.toHaveProperty("./socket-transport");
    expect(meshPublicApi).not.toHaveProperty("SocketFrameTransport");
    expect(meshPublicApi).not.toHaveProperty("SecureMeshConnection");
  });

  it("rejects constructor and prototype forgery at every authenticated consumer", async () => {
    const transport = {
      closed: Promise.resolve(),
      send: async () => {},
      receive: async () => new Uint8Array(),
      close: async () => {},
    };
    const options = {
      transport,
      connectionId: "forged",
      compatibility: {
        mode: "read-write" as const,
        protocolVersion: "1",
      },
      localProtocolRange: { min: "1", max: "1" },
      peerProtocolRange: { min: "1", max: "1" },
      peer: {
        deviceId: "forged",
        publicKey: "forged",
        displayName: "forged",
        platform: "headless" as const,
        enrolledAt: new Date(0).toISOString(),
      },
    };
    const RuntimeConstructor = SecureMeshConnection as unknown as new (
      options: typeof options,
    ) => SecureMeshConnection;

    expect(() => new RuntimeConstructor(options)).toThrow(
      "Secure mesh sessions can only be created after authentication",
    );

    const forged = Object.create(SecureMeshConnection.prototype) as SecureMeshConnection;
    expect(() => forged.send(new Uint8Array())).toThrow(
      "Mesh operation requires an authenticated session",
    );
    const registry = new MeshServiceRegistry();
    registry.register("forgery-test", {
      access: "read",
      availability: "version-independent",
      handler: async () => new Uint8Array(),
    });
    await expect(
      registry.dispatch(
        "forgery-test",
        new Uint8Array(),
        forged,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Mesh operation requires an authenticated session");

    const forgedClose = vi.fn(async () => {});
    Object.defineProperty(forged, "close", { value: forgedClose });
    const controller = new AbortController();
    const onConnection = vi.fn();
    const tunnel = new OutboundMeshTunnel({
      open: async () => forged,
      onConnection,
      sleep: async () => controller.abort(),
    });
    await tunnel.run(controller.signal);
    expect(onConnection).not.toHaveBeenCalled();
    expect(forgedClose).not.toHaveBeenCalled();
  });

  it("keeps fragmented input linear and forces non-cooperative sockets closed", async () => {
    const socket = new AuthenticatedSocketDouble();
    const transport = new SocketFrameTransport(socket as unknown as TLSSocket, {
      maxFrameBytes: 64 * 1024,
      maxBufferedBytes: 128 * 1024,
      maxBufferedFrames: 4,
      closeTimeoutMs: 20,
    });
    const payload = Buffer.alloc(32 * 1024, 0x7b);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.byteLength, 0);
    const packet = Buffer.concat([header, payload]);
    const received = transport.receive();

    for (const byte of packet) socket.emit("data", Buffer.of(byte));

    expect(Buffer.from(await received)).toEqual(payload);
    await transport.close();
    expect(socket.destroyed).toBe(true);
  });

  it("delivers every complete buffered frame before surfacing orderly EOF", async () => {
    const socket = new AuthenticatedSocketDouble();
    const transport = new SocketFrameTransport(socket as unknown as TLSSocket, {
      maxFrameBytes: 64,
      maxBufferedBytes: 1_024,
      maxBufferedFrames: 8,
    });
    const payloads = Array.from({ length: 7 }, (_, index) => Buffer.alloc(8, index));
    const encoded = payloads.map((payload) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.byteLength, 0);
      return Buffer.concat([header, payload]);
    });

    socket.emit("data", Buffer.concat(encoded));
    expect(socket.pause).toHaveBeenCalled();
    socket.emit("end");
    socket.emit("close");
    await transport.closed;

    for (const payload of payloads) {
      expect(Buffer.from(await transport.receive())).toEqual(payload);
    }
    await expect(transport.receive()).rejects.toMatchObject({ code: "connection-closed" });
  });

  it("rejects a truncated final frame instead of treating it as orderly EOF", async () => {
    const socket = new AuthenticatedSocketDouble();
    const transport = new SocketFrameTransport(socket as unknown as TLSSocket, {
      maxFrameBytes: 64,
      maxBufferedBytes: 1_024,
    });
    const truncated = Buffer.alloc(6);
    truncated.writeUInt32BE(8, 0);

    socket.emit("data", truncated);
    socket.emit("end");

    await expect(transport.closed).resolves.toBeUndefined();
    await expect(transport.receive()).rejects.toMatchObject({ code: "invalid-frame" });
    expect(socket.destroyed).toBe(true);
  });

  it("creates an inert TLS server factory without implicitly opening a listener", async () => {
    const initiator = await createDevice("initiator");
    const responder = await createDevice("responder");
    const server = await meshServer(responder, [initiator.peer], () => {});

    expect(server.listening).toBe(false);
  });

  it("rejects credentials that do not belong to the configured mesh identity", async () => {
    const initiator = await createDevice("initiator");
    const responder = await createDevice("responder");

    await expect(
      LIVE_TLS_TIME.createUnboundAuthenticatedServer(
        {
          identity: {
            deviceId: initiator.key.deviceId,
            issueTlsCredential: responder.key.issueTlsCredential.bind(responder.key),
          },
          trustedPeers: [initiator.peer],
          protocolRange: { min: "1", max: "1" },
          authorizePeer: () => true,
          replayWindow: new HandshakeReplayWindow(),
          now: LIVE_TLS_TIME.now,
        },
        () => {},
      ),
    ).rejects.toMatchObject({ code: "identity-mismatch" });
  });

  it("rotates credentials without changing the validated TLS security profile", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const initiator = await createDevice("initiator");
      const responder = await createDevice("responder");
      const trustedPeer = {
        identity: { ...initiator.peer.identity },
        rootCertificatePem: initiator.peer.rootCertificatePem,
      };
      const trustedRoot = trustedPeer.rootCertificatePem;
      const server = await LIVE_TLS_TIME.createUnboundAuthenticatedServer(
        {
          identity: responder.key,
          trustedPeers: [trustedPeer],
          protocolRange: { min: "1", max: "1" },
          authorizePeer: () => true,
          replayWindow: new HandshakeReplayWindow(),
          tlsCredentialValidityMs: 5 * 60_000,
          now: Date.now,
        },
        () => {},
      );
      trustedPeer.rootCertificatePem = "mutated after server construction";

      await vi.advanceTimersByTimeAsync(4 * 60_000);

      expect(server.secureContextUpdates).toHaveLength(1);
      expect(server.secureContextUpdates[0]).toEqual(
        expect.objectContaining({
          ca: [trustedRoot],
          minVersion: "TLSv1.3",
          maxVersion: "TLSv1.3",
          honorCipherOrder: true,
          secureOptions: constants.SSL_OP_NO_TICKET,
          sessionIdContext: expect.stringMatching(/^[a-f0-9]{32}$/),
        }),
      );
      server.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects timer durations that Node.js cannot represent faithfully", async () => {
    const unsupportedDelay = MAX_RUNTIME_TIMER_DELAY_MS + 1;
    const socket = new AuthenticatedSocketDouble();
    expect(
      () =>
        new SocketFrameTransport(socket as unknown as TLSSocket, {
          closeTimeoutMs: unsupportedDelay,
        }),
    ).toThrow(TypeError);

    const left = new PassThrough();
    const right = new PassThrough();
    await expect(
      bridgeBlindRelay(left, right, { drainTimeoutMs: unsupportedDelay }),
    ).rejects.toThrow(TypeError);
    left.destroy();
    right.destroy();

    expect(
      () =>
        new OutboundMeshTunnel({
          open: async () => {
            throw new Error("not called");
          },
          onConnection: () => {},
          retry: { maxDelayMs: unsupportedDelay },
        }),
    ).toThrow(TypeError);

    const initiator = await createDevice("initiator");
    const responder = await createDevice("responder");
    await expect(
      LIVE_TLS_TIME.createUnboundAuthenticatedServer(
        {
          identity: responder.key,
          trustedPeers: [initiator.peer],
          protocolRange: { min: "1", max: "1" },
          authorizePeer: () => true,
          replayWindow: new HandshakeReplayWindow(),
          handshakeTimeoutMs: unsupportedDelay,
        },
        () => {},
      ),
    ).rejects.toThrow(TypeError);
  });

  it("keeps long credential schedules bounded without renewing early", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const validityMs = 365 * 24 * 60 * 60_000;
    try {
      const initiator = await createDevice("initiator");
      const responder = await createDevice("responder");
      const server = await LIVE_TLS_TIME.createUnboundAuthenticatedServer(
        {
          identity: responder.key,
          trustedPeers: [initiator.peer],
          protocolRange: { min: "1", max: "1" },
          authorizePeer: () => true,
          replayWindow: new HandshakeReplayWindow(),
          tlsCredentialValidityMs: validityMs,
          now: Date.now,
        },
        () => {},
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(server.secureContextUpdates).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(validityMs - validityMs / 5 - 1);
      expect(server.secureContextUpdates).toHaveLength(1);
      server.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries credential renewal even when failure diagnostics throw", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const validityMs = 5 * 60_000;
    try {
      const initiator = await createDevice("initiator");
      const responder = await createDevice("responder");
      const onHandshakeError = vi
        .fn<() => void | Promise<void>>()
        .mockImplementationOnce(() => {
          throw new Error("synchronous diagnostic failure");
        })
        .mockImplementationOnce(async () => {
          throw new Error("asynchronous diagnostic failure");
        });
      const issueCredential = vi.fn(
        responder.key.issueTlsCredential.bind(responder.key),
      );
      const server = await LIVE_TLS_TIME.createUnboundAuthenticatedServer(
        {
          identity: {
            deviceId: responder.key.deviceId,
            issueTlsCredential: issueCredential,
          },
          trustedPeers: [initiator.peer],
          protocolRange: { min: "1", max: "1" },
          authorizePeer: () => true,
          replayWindow: new HandshakeReplayWindow(),
          tlsCredentialValidityMs: validityMs,
          now: Date.now,
          onHandshakeError,
        },
        () => {},
      );
      issueCredential.mockClear();
      issueCredential
        .mockRejectedValueOnce(new Error("first renewal failure"))
        .mockRejectedValueOnce(new Error("second renewal failure"));
      await vi.advanceTimersByTimeAsync(validityMs - 60_000);
      expect(issueCredential).toHaveBeenCalledTimes(1);
      expect(server.secureContextUpdates).toHaveLength(0);
      expect(onHandshakeError).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(validityMs / 20);
      expect(issueCredential).toHaveBeenCalledTimes(2);
      expect(server.secureContextUpdates).toHaveLength(0);
      expect(onHandshakeError).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(validityMs / 20);
      expect(issueCredential).toHaveBeenCalledTimes(3);
      expect(server.secureContextUpdates).toHaveLength(1);
      server.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops credential renewal cleanly when the server closes during issuance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const validityMs = 5 * 60_000;
    try {
      const initiator = await createDevice("initiator");
      const responder = await createDevice("responder");
      const onHandshakeError = vi.fn();
      const issueCredential = vi.fn(
        responder.key.issueTlsCredential.bind(responder.key),
      );
      const server = await LIVE_TLS_TIME.createUnboundAuthenticatedServer(
        {
          identity: {
            deviceId: responder.key.deviceId,
            issueTlsCredential: issueCredential,
          },
          trustedPeers: [initiator.peer],
          protocolRange: { min: "1", max: "1" },
          authorizePeer: () => true,
          replayWindow: new HandshakeReplayWindow(),
          tlsCredentialValidityMs: validityMs,
          now: Date.now,
          onHandshakeError,
        },
        () => {},
      );
      const pendingCredential = deferred<
        Awaited<ReturnType<DeviceKey["issueTlsCredential"]>>
      >();
      issueCredential.mockClear();
      issueCredential.mockImplementationOnce(() => pendingCredential.promise);
      await vi.advanceTimersByTimeAsync(validityMs - 60_000);
      expect(issueCredential).toHaveBeenCalledTimes(1);
      server.close();
      pendingCredential.reject(new Error("issuance finished after shutdown"));

      await vi.advanceTimersByTimeAsync(validityMs / 20);
      expect(issueCredential).toHaveBeenCalledTimes(1);
      expect(server.secureContextUpdates).toHaveLength(0);
      expect(onHandshakeError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("establishes end-to-end TLS through a blind relay without exposing identity or payload", async () => {
    const initiator = await createDevice("private-device-name-alpha");
    const responder = await createDevice("private-device-name-beta");
    const accepted = deferred<SecureMeshConnection>();
    const target = await meshServer(responder, [initiator.peer], accepted.resolve);
    const targetPort = await listen(target);
    const relayBytes: Buffer[] = [];
    const relayDone = deferred<void>();
    const relayShutdown = new AbortController();
    const relay = createNetServer((downstream) => {
      const upstream = connectNet({ host: "127.0.0.1", port: targetPort });
      downstream.on("data", (chunk) => relayBytes.push(Buffer.from(chunk)));
      upstream.on("data", (chunk) => relayBytes.push(Buffer.from(chunk)));
      void bridgeBlindRelay(downstream, upstream, { signal: relayShutdown.signal }).then(
        relayDone.resolve,
        relayDone.reject,
      );
    });
    const relayPort = await listen(relay);

    const client = await connectClient(initiator, responder.peer, relayPort);
    const server = await accepted.promise;
    const secret = Buffer.from("relay-must-never-see-this");
    await client.send(secret);
    expect(Buffer.from(await server.receive())).toEqual(secret);

    const relayView = Buffer.concat(relayBytes).toString("utf8");
    for (const privateValue of [
      secret.toString("utf8"),
      initiator.peer.identity.deviceId,
      responder.peer.identity.deviceId,
      initiator.peer.identity.displayName,
      responder.peer.identity.displayName,
      initiator.peer.identity.publicKey,
      responder.peer.identity.publicKey,
    ]) {
      expect(relayView).not.toContain(privateValue);
    }
    await client.close();
    relayShutdown.abort();
    await relayDone.promise;
  });

  it("drains both directions when one relay side half-closes after its final bytes", async () => {
    const payload = Buffer.alloc(64 * 1024, 0x5a);
    const target = createNetServer({ allowHalfOpen: true }, (socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      socket.on("end", () => socket.end(Buffer.concat(chunks)));
    });
    const targetPort = await listen(target);
    const relayDone = deferred<void>();
    const relay = createNetServer({ allowHalfOpen: true }, (downstream) => {
      const upstream = connectNet({
        host: "127.0.0.1",
        port: targetPort,
        allowHalfOpen: true,
      });
      void bridgeBlindRelay(downstream, upstream).then(relayDone.resolve, relayDone.reject);
    });
    const relayPort = await listen(relay);
    const client = connectNet({
      host: "127.0.0.1",
      port: relayPort,
      allowHalfOpen: true,
    });
    const echoed: Buffer[] = [];
    client.on("data", (chunk) => echoed.push(Buffer.from(chunk)));
    await once(client, "connect");

    client.end(payload);
    await once(client, "end");
    await relayDone.promise;

    expect(Buffer.concat(echoed)).toEqual(payload);
    client.destroy();
  });

  it("forces a blind relay closed when the peer never completes its half-close", async () => {
    const cooperative = new PassThrough();
    const nonCooperative = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const relay = bridgeBlindRelay(cooperative, nonCooperative, {
      drainTimeoutMs: 20,
    });

    cooperative.end(Buffer.from("final-bytes"));

    await expect(relay).rejects.toMatchObject({
      code: "connection-closed",
      message: "Blind relay peer did not finish within the drain deadline",
    });
    expect(cooperative.destroyed).toBe(true);
    expect(nonCooperative.destroyed).toBe(true);
  });

  it("reconnects only by creating fresh mutually authenticated sessions", async () => {
    const initiator = await createDevice("initiator");
    const responder = await createDevice("responder");
    const inbound: SecureMeshConnection[] = [];
    const server = await meshServer(responder, [initiator.peer], (connection) => {
      inbound.push(connection);
    });
    const port = await listen(server);
    const controller = new AbortController();
    const connected: SecureMeshConnection[] = [];
    const delays: number[] = [];
    const open = vi
      .fn<(signal: AbortSignal) => Promise<SecureMeshConnection>>()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockImplementation((signal) => connectClient(initiator, responder.peer, port, signal));
    const tunnel = new OutboundMeshTunnel({
      open,
      onConnection: async (session) => {
        connected.push(session);
        await session.close();
        if (connected.length === 2) controller.abort();
      },
      stableConnectionMs: 0,
      random: () => 0.5,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    await tunnel.run(controller.signal);

    expect(open).toHaveBeenCalledTimes(3);
    expect(connected).toHaveLength(2);
    expect(inbound).toHaveLength(2);
    expect(connected[0]).toBeInstanceOf(connected[1]!.constructor);
    expect(connected[0]!.connectionId).not.toBe(connected[1]!.connectionId);
    expect(delays).toEqual([125, 125]);
  });

  it("closes the active authenticated session when tunnel shutdown is requested", async () => {
    const initiator = await createDevice("initiator");
    const responder = await createDevice("responder");
    const inbound = deferred<SecureMeshConnection>();
    const server = await meshServer(responder, [initiator.peer], inbound.resolve);
    const port = await listen(server);
    const controller = new AbortController();
    const tunnel = new OutboundMeshTunnel({
      open: (signal) => connectClient(initiator, responder.peer, port, signal),
      onConnection: () => controller.abort(),
    });

    await tunnel.run(controller.signal);

    await expect((await inbound.promise).closed).resolves.toBeUndefined();
  });
});

interface TestDevice {
  readonly key: DeviceKey;
  readonly peer: TrustedMeshPeer;
}

async function createDevice(name: string): Promise<TestDevice> {
  const key = await DeviceKey.generate({ now: LIVE_TLS_TIME.now });
  return {
    key,
    peer: {
      identity: enrollDeviceIdentity(key, {
        displayName: name,
        platform: "headless",
        enrolledAt: new Date(NOW).toISOString(),
      }),
      rootCertificatePem: key.rootCertificatePem,
    },
  };
}

async function meshServer(
  local: TestDevice,
  peers: readonly TrustedMeshPeer[],
  onConnection: (connection: SecureMeshConnection) => void,
): Promise<TlsServer> {
  return await LIVE_TLS_TIME.createAuthenticatedServer(
    {
      identity: local.key,
      trustedPeers: peers,
      protocolRange: { min: "1", max: "1" },
      authorizePeer: () => true,
      replayWindow: new HandshakeReplayWindow(),
    },
    onConnection,
  );
}

async function connectClient(
  local: TestDevice,
  peer: TrustedMeshPeer,
  port: number,
  signal?: AbortSignal,
): Promise<SecureMeshConnection> {
  return await LIVE_TLS_TIME.openAuthenticatedConnection({
    host: "127.0.0.1",
    port,
    identity: local.key,
    trustedPeer: peer,
    protocolRange: { min: "1", max: "1" },
    authorizePeer: () => true,
    signal,
  });
}

async function listen(server: NetServer | TlsServer): Promise<number> {
  openServers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener address");
  return address.port;
}

async function closeServer(server: NetServer | TlsServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class AuthenticatedSocketDouble extends EventEmitter {
  readonly encrypted = true;
  readonly authorized = true;
  readonly alpnProtocol = "zhixing-mesh";
  destroyed = false;
  writableEnded = false;
  readonly pause = vi.fn(() => this);
  readonly resume = vi.fn(() => this);

  getProtocol(): string {
    return "TLSv1.3";
  }

  write(_packet: Uint8Array, callback: (error?: Error) => void): boolean {
    callback();
    return true;
  }

  end(): this {
    this.writableEnded = true;
    return this;
  }

  destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (error) this.emit("error", error);
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}
