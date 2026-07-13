import { constants } from "node:crypto";
import { once } from "node:events";
import { connect as connectNet } from "node:net";
import type { Server as TlsServer, TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../canonical.js";
import {
  DeviceKey,
  enrollDeviceIdentity,
} from "../device-identity.js";
import { MeshProtocolError } from "../errors.js";
import type { MeshProtocolRange, TrustedMeshPeer } from "../handshake.js";
import { HandshakeReplayWindow } from "../replay-window.js";
import { MeshServiceRegistry } from "../service-registry.js";
import { SocketFrameTransport } from "../socket-transport.js";
import type { SecureMeshConnection } from "../transport.js";
import {
  createLiveTlsTestHarness,
  type CurrentLiveTlsCredential,
  type ExpiredLiveTlsCredential,
} from "./live-tls-test-harness.js";

const LIVE_TLS_TIME = createLiveTlsTestHarness();
const NOW = LIVE_TLS_TIME.timestamp;
const RANGE = { min: "1", max: "1" } as const;
const openServers: TlsServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer));
});

describe("mutually authenticated mesh transport", () => {
  it("authenticates both device roots with TLS 1.3 and exchanges application frames", async () => {
    const devices = await createDevices();
    const accepted = deferred<SecureMeshConnection>();
    const server = await startServer(devices.responder, [devices.initiator.peer], {
      onConnection: accepted.resolve,
    });
    const client = await connectClient(devices.initiator, devices.responder.peer, server.port);
    const inbound = await accepted.promise;

    expect(client.peer).toEqual(devices.responder.peer.identity);
    expect(inbound.peer).toEqual(devices.initiator.peer.identity);
    expect(client.connectionId).toBe(inbound.connectionId);
    expect(Object.isFrozen(client)).toBe(true);
    expect(Object.isFrozen(client.peer)).toBe(true);
    await client.send(Buffer.from("owner-control payload"));
    await inbound.send(Buffer.from("executor response"));
    expect(Buffer.from(await inbound.receive())).toEqual(Buffer.from("owner-control payload"));
    expect(Buffer.from(await client.receive())).toEqual(Buffer.from("executor response"));
    await client.close();
  });

  it("keeps authenticated incompatible peers in read-only degraded mode", async () => {
    const devices = await createDevices();
    const accepted = deferred<SecureMeshConnection>();
    const onHandshakeError = vi.fn();
    const server = await startServer(devices.responder, [devices.initiator.peer], {
      protocolRange: { min: "1", max: "1" },
      onConnection: accepted.resolve,
      onHandshakeError,
    });

    const client = await connectClient(
      devices.initiator,
      devices.responder.peer,
      server.port,
      { protocolRange: { min: "2", max: "2" } },
    );
    const inbound = await accepted.promise;

    expect(client.compatibility).toEqual({
      mode: "read-only",
      reason: "incompatible-version",
    });
    expect(inbound.compatibility).toEqual(client.compatibility);
    expect(client.localProtocolRange).toEqual({ min: "2", max: "2" });
    expect(client.peerProtocolRange).toEqual({ min: "1", max: "1" });
    expect(inbound.localProtocolRange).toEqual({ min: "1", max: "1" });
    expect(inbound.peerProtocolRange).toEqual({ min: "2", max: "2" });
    expect(onHandshakeError).not.toHaveBeenCalled();
    const registry = new MeshServiceRegistry();
    registry.register("compatibility.info", {
      access: "read",
      availability: "version-independent",
      handler: async (payload) => payload,
    });
    registry.register("history.read", {
      access: "read",
      availability: "negotiated-version",
      handler: async (payload) => payload,
    });
    registry.register("session.write", {
      access: "write",
      availability: "negotiated-version",
      handler: async (payload) => payload,
    });
    await expect(
      registry.dispatch("compatibility.info", Buffer.from("info"), inbound),
    ).resolves.toEqual(Buffer.from("info"));
    await expect(
      registry.dispatch("history.read", Buffer.from("history"), inbound),
    ).rejects.toMatchObject({ code: "incompatible-version" });
    await expect(
      registry.dispatch("session.write", Buffer.from("input"), inbound),
    ).rejects.toMatchObject({ code: "incompatible-version" });
    await client.close();
  });

  it("accepts the highest shared version when peer ranges overlap asymmetrically", async () => {
    const devices = await createDevices();
    const accepted = deferred<SecureMeshConnection>();
    const server = await startServer(devices.responder, [devices.initiator.peer], {
      protocolRange: { min: "1", max: "1" },
      onConnection: accepted.resolve,
    });

    const client = await connectClient(
      devices.initiator,
      devices.responder.peer,
      server.port,
      { protocolRange: { min: "1", max: "2" } },
    );

    expect(client.compatibility).toEqual({
      mode: "read-write",
      protocolVersion: "1",
    });
    expect((await accepted.promise).compatibility).toEqual(
      client.compatibility,
    );
    const registry = new MeshServiceRegistry();
    registry.register("session.write", {
      access: "write",
      availability: "negotiated-version",
      handler: async (payload) => payload,
    });
    await expect(
      registry.dispatch(
        "session.write",
        Buffer.from("compatible-input"),
        client,
      ),
    ).resolves.toEqual(Buffer.from("compatible-input"));
    await client.close();
  });

  it("freezes client security options before asynchronous credential issuance", async () => {
    const devices = await createDevices();
    const accepted = deferred<SecureMeshConnection>();
    const server = await startServer(devices.responder, [devices.initiator.peer], {
      onConnection: accepted.resolve,
    });
    const protocolRange = { min: "1", max: "1" };

    const connecting = LIVE_TLS_TIME.openAuthenticatedConnection({
      identity: devices.initiator.key,
      trustedPeer: devices.responder.peer,
      host: "127.0.0.1",
      port: server.port,
      protocolRange,
      authorizePeer: () => true,
    });
    protocolRange.min = "2";
    protocolRange.max = "2";
    const client = await connecting;

    expect(client.compatibility).toEqual({
      mode: "read-write",
      protocolVersion: "1",
    });
    expect((await accepted.promise).compatibility).toEqual(
      client.compatibility,
    );
    await client.close();
  });

  it("rejects a trusted certificate when the current authorization state revokes it", async () => {
    const devices = await createDevices();
    const error = deferred<Error>();
    const onConnection = vi.fn();
    const server = await startServer(devices.responder, [devices.initiator.peer], {
      authorizePeer: () => false,
      onConnection,
      onHandshakeError: error.resolve,
    });

    await expect(
      connectClient(devices.initiator, devices.responder.peer, server.port),
    ).rejects.toBeInstanceOf(Error);
    await expect(error.promise).resolves.toMatchObject({ code: "unauthorized-peer" });
    expect(onConnection).not.toHaveBeenCalled();
  });

  it("does not disclose the client certificate to an active server with an untrusted root", async () => {
    const devices = await createDevices();
    const rogue = await createDevice("rogue");
    const credential = await LIVE_TLS_TIME.issueCredential(rogue.key);
    const observedPeer = deferred<ReturnType<TLSSocket["getPeerCertificate"]>>();
    const rogueServer = LIVE_TLS_TIME.createRawServer(credential, {
      ca: devices.initiator.peer.rootCertificatePem,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ALPNProtocols: ["zhixing-mesh"],
      requestCert: true,
      rejectUnauthorized: false,
      secureOptions: constants.SSL_OP_NO_TICKET,
    });
    rogueServer.on("tlsClientError", (_error, socket) => {
      observedPeer.resolve(socket.getPeerCertificate(true));
    });
    const port = await listen(rogueServer);

    await expect(
      connectClient(devices.initiator, devices.responder.peer, port),
    ).rejects.toMatchObject({ code: "unauthorized-peer" });
    const peerCertificate = await observedPeer.promise;
    expect(peerCertificate).toBeNull();
  });

  it("claims replay nonces only after TLS authentication and isolates peer capacity", async () => {
    const devices = await createDevices();
    const replayWindow = new HandshakeReplayWindow({ maxEntriesPerPeer: 1 });
    const error = deferred<Error>();
    const accepted: SecureMeshConnection[] = [];
    const server = await startServer(
      devices.responder,
      [devices.initiator.peer, devices.other.peer],
      {
        replayWindow,
        onConnection: (connection) => accepted.push(connection),
        onHandshakeError: error.resolve,
      },
    );
    const hello = protocolHello("fixed-replay-nonce", RANGE, NOW);

    const first = await rawProtocolHandshake(
      devices.initiator.key,
      devices.responder.peer,
      server.port,
      hello,
    );
    await first.close();
    await expect(
      rawProtocolHandshake(
        devices.initiator.key,
        devices.responder.peer,
        server.port,
        hello,
      ),
    ).rejects.toBeInstanceOf(Error);
    await expect(error.promise).resolves.toMatchObject({ code: "replay-detected" });

    const other = await rawProtocolHandshake(
      devices.other.key,
      devices.responder.peer,
      server.port,
      protocolHello("other-device-nonce", RANGE, NOW),
    );
    expect(accepted).toHaveLength(2);
    await other.close();
  });

  it("rejects stale protocol hellos without weakening the TLS trust boundary", async () => {
    const devices = await createDevices();
    const error = deferred<Error>();
    const server = await startServer(devices.responder, [devices.initiator.peer], {
      onHandshakeError: error.resolve,
    });

    await expect(
      rawProtocolHandshake(
        devices.initiator.key,
        devices.responder.peer,
        server.port,
        protocolHello("stale-nonce", RANGE, NOW - 120_001),
      ),
    ).rejects.toBeInstanceOf(Error);
    await expect(error.promise).resolves.toMatchObject({ code: "clock-skew" });
  });

  it("rejects non-canonical handshake timestamps before negotiation", async () => {
    const devices = await createDevices();
    const error = deferred<Error>();
    const server = await startServer(devices.responder, [devices.initiator.peer], {
      onHandshakeError: error.resolve,
    });

    await expect(
      rawProtocolHandshake(
        devices.initiator.key,
        devices.responder.peer,
        server.port,
        protocolHello(
          "non-canonical-time",
          RANGE,
          NOW,
          new Date(NOW).toISOString().replace(/\.\d{3}Z$/u, "Z"),
        ),
      ),
    ).rejects.toBeInstanceOf(Error);
    await expect(error.promise).resolves.toMatchObject({ code: "invalid-frame" });
  });

  it("rejects expired TLS leaf certificates before application authorization", async () => {
    const leafIssuedAt = NOW - 2 * 24 * 60 * 60_000;
    const initiatorKey = await DeviceKey.generate({ now: () => leafIssuedAt });
    const initiator: TestDevice = {
      key: initiatorKey,
      peer: {
        identity: enrollDeviceIdentity(initiatorKey, {
          displayName: "laptop",
          platform: "headless",
          enrolledAt: new Date(leafIssuedAt).toISOString(),
        }),
        rootCertificatePem: initiatorKey.rootCertificatePem,
      },
    };
    const responder = await createDevice("anchor");
    const onConnection = vi.fn();
    const error = deferred<Error>();
    const server = await startServer(responder, [initiator.peer], {
      onConnection,
      onHandshakeError: error.resolve,
    });
    const expired = LIVE_TLS_TIME.acceptExpiredCredential(
      await initiator.key.issueTlsCredential({
        now: () => leafIssuedAt,
        validityMs: 60 * 60_000,
      }),
    );

    const rejectedSocket = await openRawTls(expired, responder.peer, server.port);
    await once(rejectedSocket, "close");
    await expect(error.promise).resolves.toBeInstanceOf(Error);
    expect(onConnection).not.toHaveBeenCalled();
  });

  it("enforces one deadline across TLS, authorization, and protocol negotiation", async () => {
    const devices = await createDevices();
    const error = deferred<Error>();
    const onHandshakeError = vi.fn(error.resolve);
    const server = await startServer(devices.responder, [devices.initiator.peer], {
      authorizePeer: () => new Promise<boolean>(() => {}),
      handshakeTimeoutMs: 100,
      onHandshakeError,
    });

    await expect(
      connectClient(devices.initiator, devices.responder.peer, server.port, {
        handshakeTimeoutMs: 500,
      }),
    ).rejects.toBeInstanceOf(Error);
    await expect(error.promise).resolves.toMatchObject({
      code: "connection-closed",
      message: "Mesh handshake timed out",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onHandshakeError).toHaveBeenCalledTimes(1);
  });

  it("terminates clients that never complete the TLS handshake within the same deadline", async () => {
    const devices = await createDevices();
    const error = deferred<Error>();
    const onHandshakeError = vi.fn(error.resolve);
    const server = await startServer(devices.responder, [devices.initiator.peer], {
      handshakeTimeoutMs: 100,
      onHandshakeError,
    });
    const socket = connectNet({ host: "127.0.0.1", port: server.port });
    socket.on("error", () => {});
    const closed = once(socket, "close");

    await expect(error.promise).resolves.toBeInstanceOf(Error);
    socket.destroy();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onHandshakeError).toHaveBeenCalledTimes(1);
  });

  it("bounds authenticated frame buffering and resumes only after consumers catch up", async () => {
    const devices = await createDevices();
    const credential = await LIVE_TLS_TIME.issueCredential(devices.responder.key);
    const accepted = deferred<{
      transport: SocketFrameTransport;
      pause: ReturnType<typeof vi.spyOn>;
      resume: ReturnType<typeof vi.spyOn>;
    }>();
    const rawServer = LIVE_TLS_TIME.createRawServer(
      credential,
      {
        ca: devices.initiator.peer.rootCertificatePem,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        ALPNProtocols: ["zhixing-mesh"],
        requestCert: true,
        rejectUnauthorized: true,
        secureOptions: constants.SSL_OP_NO_TICKET,
      },
      (socket) => {
        const pause = vi.spyOn(socket, "pause");
        const resume = vi.spyOn(socket, "resume");
        accepted.resolve({
          transport: new SocketFrameTransport(socket, {
            maxFrameBytes: 64,
            maxBufferedBytes: 256,
            maxBufferedFrames: 4,
          }),
          pause,
          resume,
        });
      },
    );
    const port = await listen(rawServer);
    const clientCredential = await LIVE_TLS_TIME.issueCredential(devices.initiator.key);
    const clientSocket = await openRawTls(clientCredential, devices.responder.peer, port);
    const client = new SocketFrameTransport(clientSocket, {
      maxFrameBytes: 64,
      maxBufferedBytes: 256,
      maxBufferedFrames: 4,
    });
    const inbound = await accepted.promise;

    for (let index = 0; index < 4; index += 1) {
      await client.send(Buffer.alloc(32, index));
    }
    await vi.waitFor(() => expect(inbound.pause).toHaveBeenCalled());

    for (let index = 0; index < 3; index += 1) {
      expect(Buffer.from(await inbound.transport.receive())).toEqual(Buffer.alloc(32, index));
    }
    await vi.waitFor(() => expect(inbound.resume).toHaveBeenCalled());
    expect(Buffer.from(await inbound.transport.receive())).toEqual(Buffer.alloc(32, 3));
    await client.close();
  });

  it("rejects TLS sockets that are encrypted but not authenticated for mesh use", async () => {
    const rogue = await createDevice("rogue");
    const credential = await LIVE_TLS_TIME.issueCredential(rogue.key);
    const server = LIVE_TLS_TIME.createRawServer(credential, {
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ALPNProtocols: ["zhixing-mesh"],
    });
    const port = await listen(server);
    const socket = await LIVE_TLS_TIME.openUnauthenticatedConnection({
      host: "127.0.0.1",
      port,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ALPNProtocols: ["zhixing-mesh"],
      rejectUnauthorized: false,
    });

    expect(socket.authorized).toBe(false);
    expect(() => new SocketFrameTransport(socket)).toThrow(
      "Mesh frames require an authenticated TLS 1.3 mesh socket",
    );
    socket.destroy();
  });

  it("rejects mismatched identity and trust-root combinations before connecting", async () => {
    const devices = await createDevices();
    await expect(
      LIVE_TLS_TIME.openAuthenticatedConnection({
        host: "127.0.0.1",
        port: 1,
        identity: devices.initiator.key,
        trustedPeer: {
          identity: devices.responder.peer.identity,
          rootCertificatePem: devices.other.peer.rootCertificatePem,
        },
        protocolRange: RANGE,
        authorizePeer: () => true,
      }),
    ).rejects.toMatchObject({ code: "identity-mismatch" });
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

async function createDevices() {
  return {
    initiator: await createDevice("laptop"),
    responder: await createDevice("anchor"),
    other: await createDevice("other"),
  };
}

interface StartServerOverrides {
  readonly protocolRange?: MeshProtocolRange;
  readonly replayWindow?: HandshakeReplayWindow;
  readonly authorizePeer?: (
    identity: TrustedMeshPeer["identity"],
  ) => boolean | Promise<boolean>;
  readonly handshakeTimeoutMs?: number;
  readonly onConnection?: (connection: SecureMeshConnection) => void;
  readonly onHandshakeError?: (error: Error) => void;
}

async function startServer(
  local: TestDevice,
  peers: readonly TrustedMeshPeer[],
  overrides: StartServerOverrides = {},
): Promise<{ server: TlsServer; port: number }> {
  const server = await LIVE_TLS_TIME.createAuthenticatedServer(
    {
      identity: local.key,
      trustedPeers: peers,
      protocolRange: overrides.protocolRange ?? RANGE,
      authorizePeer: overrides.authorizePeer ?? (() => true),
      handshakeTimeoutMs: overrides.handshakeTimeoutMs,
      replayWindow: overrides.replayWindow ?? new HandshakeReplayWindow(),
      onHandshakeError: overrides.onHandshakeError,
    },
    overrides.onConnection ?? (() => {}),
  );
  return { server, port: await listen(server) };
}

async function connectClient(
  local: TestDevice,
  peer: TrustedMeshPeer,
  port: number,
  overrides: {
    readonly protocolRange?: MeshProtocolRange;
    readonly handshakeTimeoutMs?: number;
  } = {},
): Promise<SecureMeshConnection> {
  return await LIVE_TLS_TIME.openAuthenticatedConnection({
    host: "127.0.0.1",
    port,
    identity: local.key,
    trustedPeer: peer,
    protocolRange: overrides.protocolRange ?? RANGE,
    authorizePeer: () => true,
    handshakeTimeoutMs: overrides.handshakeTimeoutMs,
  });
}

async function listen(server: TlsServer): Promise<number> {
  openServers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener address");
  return address.port;
}

async function closeServer(server: TlsServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function rawProtocolHandshake(
  key: DeviceKey,
  trustedPeer: TrustedMeshPeer,
  port: number,
  hello: Uint8Array,
): Promise<SocketFrameTransport> {
  const credential = await LIVE_TLS_TIME.issueCredential(key);
  const socket = await openRawTls(credential, trustedPeer, port);
  const transport = new SocketFrameTransport(socket);
  await transport.send(hello);
  await transport.receive();
  return transport;
}

async function openRawTls(
  credential: CurrentLiveTlsCredential | ExpiredLiveTlsCredential,
  trustedPeer: TrustedMeshPeer,
  port: number,
): Promise<TLSSocket> {
  return await LIVE_TLS_TIME.openRawConnection(credential, {
    host: "127.0.0.1",
    port,
    ca: trustedPeer.rootCertificatePem,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    ALPNProtocols: ["zhixing-mesh"],
    rejectUnauthorized: true,
    servername: "zhixing-mesh",
    checkServerIdentity: () => undefined,
    secureOptions: constants.SSL_OP_NO_TICKET,
  });
}

function protocolHello(
  nonceSeed: string,
  range: MeshProtocolRange,
  issuedAt: number,
  issuedAtText = new Date(issuedAt).toISOString(),
): Uint8Array {
  const digest = Buffer.from(nonceSeed.padEnd(32, "0").slice(0, 32)).toString("base64url");
  return Buffer.from(
    canonicalize({
      kind: "protocol-hello",
      v: 1,
      connectionId: Buffer.from(`${nonceSeed}-connection`.padEnd(16, "0").slice(0, 16)).toString(
        "base64url",
      ),
      protocolRange: range,
      nonce: digest,
      issuedAt: issuedAtText,
    }),
  );
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
