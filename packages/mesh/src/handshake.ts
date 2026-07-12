import { constants, createHash, randomBytes, X509Certificate } from "node:crypto";
import type { DeviceIdentity } from "@zhixing/core/contracts";
import {
  connect as connectTls,
  createServer as createTlsServer,
  type DetailedPeerCertificate,
  type SecureContextOptions,
  type Server as TlsServer,
  type TLSSocket,
} from "node:tls";
import type { Socket } from "node:net";
import { canonicalize, protocolDigest } from "./canonical.js";
import {
  type DeviceTlsCredential,
  type DeviceTlsCredentialOptions,
  validateDeviceTrustRoot,
} from "./device-identity.js";
import { MeshProtocolError } from "./errors.js";
import {
  type MeshProtocolCompatibility,
  type MeshProtocolRange,
  negotiateMeshProtocol,
  sameMeshProtocolCompatibility,
  snapshotMeshProtocolRange,
} from "./protocol-version.js";
import { HandshakeReplayWindow } from "./replay-window.js";
import {
  assertRuntimeTimerDelay,
  MAX_RUNTIME_TIMER_DELAY_MS,
} from "./runtime-time.js";
import { createSecureMeshConnection, type SecureMeshConnection } from "./session.js";
import {
  MESH_ALPN_PROTOCOL,
  SocketFrameTransport,
} from "./socket-transport.js";

export type {
  MeshProtocolCompatibility,
  MeshProtocolRange,
} from "./protocol-version.js";

const DEFAULT_MAX_CLOCK_SKEW_MS = 120_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

export interface TrustedMeshPeer {
  readonly identity: DeviceIdentity;
  readonly rootCertificatePem: string;
}

export interface MeshDeviceIdentity {
  readonly deviceId: string;
  issueTlsCredential(options?: DeviceTlsCredentialOptions): Promise<DeviceTlsCredential>;
}

export interface MeshConnectionSecurityOptions {
  readonly identity: MeshDeviceIdentity;
  readonly protocolRange: MeshProtocolRange;
  readonly authorizePeer: (
    identity: DeviceIdentity,
    signal: AbortSignal,
  ) => boolean | Promise<boolean>;
  readonly maxClockSkewMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly tlsCredentialValidityMs?: number;
  readonly now?: () => number;
}

export interface MeshClientConnectionOptions extends MeshConnectionSecurityOptions {
  readonly host: string;
  readonly port: number;
  readonly trustedPeer: TrustedMeshPeer;
  readonly signal?: AbortSignal;
}

export interface MeshServerOptions extends MeshConnectionSecurityOptions {
  readonly trustedPeers: readonly TrustedMeshPeer[];
  readonly replayWindow: HandshakeReplayWindow;
  readonly onHandshakeError?: (error: Error) => void | Promise<void>;
}

interface ProtocolHello {
  readonly kind: "protocol-hello";
  readonly v: 1;
  readonly connectionId: string;
  readonly protocolRange: MeshProtocolRange;
  readonly nonce: string;
  readonly issuedAt: string;
}

interface ProtocolAccepted {
  readonly kind: "protocol-accepted";
  readonly v: 1;
  readonly connectionId: string;
  readonly compatibility: MeshProtocolCompatibility;
  readonly responderProtocolRange: MeshProtocolRange;
  readonly helloDigest: string;
  readonly acceptedAt: string;
}

interface MeshServerSecurityProfile {
  readonly ca: readonly string[];
  readonly minVersion: "TLSv1.3";
  readonly maxVersion: "TLSv1.3";
  readonly honorCipherOrder: true;
  readonly secureOptions: number;
  readonly sessionIdContext: string;
}

/** Opens an outbound TLS 1.3 connection and returns only after mutual authorization. */
export async function connectAuthenticatedMesh(
  options: MeshClientConnectionOptions,
): Promise<SecureMeshConnection> {
  const clientOptions = snapshotClientOptions(options);
  validateCommonOptions(clientOptions);
  validateEndpoint(clientOptions.host, clientOptions.port);
  const deadline = new HandshakeDeadline(
    handshakeTimeout(clientOptions),
    clientOptions.signal,
  );
  let tlsSocket: TLSSocket | undefined;
  try {
    const trustedPeer = clientOptions.trustedPeer;
    const peerRoot = validateTrustedPeer(trustedPeer, (clientOptions.now ?? Date.now)());
    const credential = await deadline.run(
      issueMeshTlsCredential(clientOptions.identity, {
        now: clientOptions.now,
        validityMs: clientOptions.tlsCredentialValidityMs,
      }),
    );
    tlsSocket = connectTls({
      host: clientOptions.host,
      port: clientOptions.port,
      key: credential.privateKeyPem,
      cert: credential.certificateChainPem,
      ca: trustedPeer.rootCertificatePem,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ALPNProtocols: [MESH_ALPN_PROTOCOL],
      rejectUnauthorized: true,
      servername: MESH_ALPN_PROTOCOL,
      checkServerIdentity: () => undefined,
      secureOptions: constants.SSL_OP_NO_TICKET,
    });
    await waitForTlsClient(tlsSocket, deadline.signal);
    assertTlsState(tlsSocket);
    const peer = resolveAuthenticatedPeer(
      tlsSocket.getPeerCertificate(true),
      [trustedPeer],
    );
    if (peer.identity.deviceId !== trustedPeer.identity.deviceId) {
      throw new MeshProtocolError("identity-mismatch", "TLS peer is not the expected device");
    }
    assertCertificateRoot(tlsSocket.getPeerCertificate(true), peerRoot);
    await authorize(peer.identity, clientOptions.authorizePeer, deadline.signal);

    const transport = new SocketFrameTransport(tlsSocket);
    const now = clientOptions.now ?? Date.now;
    const hello: ProtocolHello = {
      kind: "protocol-hello",
      v: 1,
      connectionId: randomBytes(16).toString("base64url"),
      protocolRange: clientOptions.protocolRange,
      nonce: randomBytes(32).toString("base64url"),
      issuedAt: new Date(now()).toISOString(),
    };
    await deadline.run(transport.send(encodeFrame(hello)));
    const accepted = parseAccepted(
      await transport.receive(deadline.signal),
    );
    assertAccepted(
      accepted,
      hello,
      clientOptions.protocolRange,
      now(),
      clientOptions.maxClockSkewMs,
    );
    const connection = createSecureMeshConnection({
      transport,
      connectionId: hello.connectionId,
      compatibility: accepted.compatibility,
      localProtocolRange: clientOptions.protocolRange,
      peerProtocolRange: accepted.responderProtocolRange,
      peer: peer.identity,
    });
    deadline.dispose();
    return connection;
  } catch (error) {
    tlsSocket?.destroy();
    throw normalizeTlsError(error);
  } finally {
    deadline.dispose();
  }
}

/** Creates a mutually authenticated TLS server without binding or listening on a port. */
export async function createAuthenticatedMeshServer(
  options: MeshServerOptions,
  onConnection: (connection: SecureMeshConnection) => void | Promise<void>,
): Promise<TlsServer> {
  validateCommonOptions(options);
  if (options.trustedPeers.length === 0) {
    throw new TypeError("Mesh server requires at least one trusted peer");
  }
  const trustedPeers = validateTrustedPeers(
    options.trustedPeers,
    (options.now ?? Date.now)(),
  );
  const serverOptions = snapshotServerOptions(options, [...trustedPeers.values()]);
  const credential = await issueMeshTlsCredential(serverOptions.identity, {
    now: serverOptions.now,
    validityMs: serverOptions.tlsCredentialValidityMs,
  });
  const connectionDeadlines = new Map<string, HandshakeDeadline>();
  const timeoutMs = handshakeTimeout(serverOptions);
  const trustedPeerSnapshot = [...trustedPeers.values()];
  const securityProfile = createMeshServerSecurityProfile(
    serverOptions.identity.deviceId,
    trustedPeerSnapshot,
  );
  const server = createTlsServer(
    {
      ...credentialContext(securityProfile, credential),
      ALPNProtocols: [MESH_ALPN_PROTOCOL],
      requestCert: true,
      rejectUnauthorized: true,
      handshakeTimeout: timeoutMs,
    },
    (socket) => {
      const key = connectionKey(socket);
      const deadline = connectionDeadlines.get(key) ?? new HandshakeDeadline(timeoutMs);
      void establishInboundConnection(socket, serverOptions, trustedPeers, deadline.signal)
        .then((connection) => {
          deadline.dispose();
          connectionDeadlines.delete(key);
          return onConnection(connection);
        })
        .catch((error: unknown) => {
          deadline.dispose();
          connectionDeadlines.delete(key);
          const normalized = normalizeTlsError(error);
          socket.destroy();
          deadline.report(normalized, serverOptions.onHandshakeError);
        });
    },
  );
  server.on("connection", (socket: Socket) => {
    const key = connectionKey(socket);
    const deadline = new HandshakeDeadline(timeoutMs);
    connectionDeadlines.set(key, deadline);
    const onAbort = () => {
      deadline.report(abortReason(deadline.signal), serverOptions.onHandshakeError);
      socket.destroy();
    };
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    socket.once("close", () => {
      deadline.signal.removeEventListener("abort", onAbort);
      if (connectionDeadlines.get(key) === deadline) {
        connectionDeadlines.delete(key);
        deadline.dispose();
      }
    });
  });
  server.on("tlsClientError", (error, socket) => {
    const key = socket ? connectionKey(socket) : undefined;
    const deadline = key ? connectionDeadlines.get(key) : undefined;
    deadline?.dispose();
    if (key) connectionDeadlines.delete(key);
    const normalized = normalizeTlsError(error);
    if (deadline) deadline.report(normalized, serverOptions.onHandshakeError);
    else reportHandshakeError(normalized, serverOptions.onHandshakeError);
  });
  maintainServerCredential(server, serverOptions, securityProfile, credential.expiresAt);
  return server;
}

function maintainServerCredential(
  server: TlsServer,
  options: MeshServerOptions,
  securityProfile: MeshServerSecurityProfile,
  expiresAt: string,
): void {
  const now = options.now ?? Date.now;
  const validityMs = options.tlsCredentialValidityMs ?? 24 * 60 * 60_000;
  const renewalLeadMs = Math.max(60_000, Math.floor(validityMs / 5));
  const retryMs = Math.max(1_000, Math.min(60_000, Math.floor(validityMs / 20)));
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const setTimer = (callback: () => void, delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(callback, Math.min(delayMs, MAX_RUNTIME_TIMER_DELAY_MS));
    timer.unref();
  };
  const scheduleAt = (refreshAt: number) => {
    if (stopped) return;
    const remaining = refreshAt - now();
    if (remaining <= 0) {
      setTimer(() => void refresh(), 0);
      return;
    }
    setTimer(() => {
      if (refreshAt <= now()) void refresh();
      else scheduleAt(refreshAt);
    }, remaining);
  };
  const schedule = (currentExpiry: string) => {
    scheduleAt(Date.parse(currentExpiry) - renewalLeadMs);
  };
  const scheduleRetry = () => {
    setTimer(() => void refresh(), retryMs);
  };
  const refresh = async () => {
    if (stopped) return;
    try {
      const credential = await issueMeshTlsCredential(options.identity, {
        now: options.now,
        validityMs: options.tlsCredentialValidityMs,
      });
      if (stopped) return;
      server.setSecureContext(credentialContext(securityProfile, credential));
      schedule(credential.expiresAt);
    } catch (error) {
      if (stopped) return;
      const failure =
        error instanceof Error ? error : new Error("TLS credential renewal failed");
      scheduleRetry();
      reportHandshakeError(
        failure,
        options.onHandshakeError,
      );
    }
  };

  server.once("close", () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  });
  schedule(expiresAt);
}

async function establishInboundConnection(
  socket: TLSSocket,
  options: MeshServerOptions,
  trustedPeers: ReadonlyMap<string, TrustedMeshPeer>,
  signal: AbortSignal,
): Promise<SecureMeshConnection> {
  assertTlsState(socket);
  const peer = resolveAuthenticatedPeer(socket.getPeerCertificate(true), [
    ...trustedPeers.values(),
  ]);
  await authorize(peer.identity, options.authorizePeer, signal);
  const transport = new SocketFrameTransport(socket);
  const now = options.now ?? Date.now;
  const hello = parseHello(
    await transport.receive(signal),
  );
  assertFresh(hello.issuedAt, now(), options.maxClockSkewMs);
  options.replayWindow.claim(peer.identity.deviceId, hello.nonce, now());
  const compatibility = negotiateMeshProtocol(
    options.protocolRange,
    hello.protocolRange,
  );
  const accepted: ProtocolAccepted = {
    kind: "protocol-accepted",
    v: 1,
    connectionId: hello.connectionId,
    compatibility,
    responderProtocolRange: options.protocolRange,
    helloDigest: protocolDigest("MeshProtocolHello", 1, hello),
    acceptedAt: new Date(now()).toISOString(),
  };
  await raceWithSignal(transport.send(encodeFrame(accepted)), signal);
  return createSecureMeshConnection({
    transport,
    connectionId: hello.connectionId,
    compatibility,
    localProtocolRange: options.protocolRange,
    peerProtocolRange: hello.protocolRange,
    peer: peer.identity,
  });
}

function validateTrustedPeers(
  peers: readonly TrustedMeshPeer[],
  now: number,
): ReadonlyMap<string, TrustedMeshPeer> {
  const result = new Map<string, TrustedMeshPeer>();
  const roots = new Set<string>();
  for (const candidate of peers) {
    const peer = snapshotTrustedPeer(candidate);
    const root = validateTrustedPeer(peer, now);
    if (result.has(peer.identity.deviceId)) {
      throw new TypeError(`Duplicate trusted device ${peer.identity.deviceId}`);
    }
    if (roots.has(root.fingerprint256)) {
      throw new TypeError("A device trust root cannot identify multiple peers");
    }
    result.set(peer.identity.deviceId, peer);
    roots.add(root.fingerprint256);
  }
  return result;
}

function snapshotTrustedPeer(peer: TrustedMeshPeer): TrustedMeshPeer {
  return Object.freeze({
    identity: Object.freeze({ ...peer.identity }),
    rootCertificatePem: peer.rootCertificatePem,
  });
}

function snapshotClientOptions(
  options: MeshClientConnectionOptions,
): MeshClientConnectionOptions {
  return Object.freeze({
    ...options,
    identity: snapshotMeshDeviceIdentity(options.identity),
    protocolRange: snapshotMeshProtocolRange(options.protocolRange),
    trustedPeer: snapshotTrustedPeer(options.trustedPeer),
  });
}

function snapshotServerOptions(
  options: MeshServerOptions,
  trustedPeers: readonly TrustedMeshPeer[],
): MeshServerOptions {
  return Object.freeze({
    ...options,
    identity: snapshotMeshDeviceIdentity(options.identity),
    protocolRange: snapshotMeshProtocolRange(options.protocolRange),
    trustedPeers: Object.freeze([...trustedPeers]),
  });
}

function snapshotMeshDeviceIdentity(identity: MeshDeviceIdentity): MeshDeviceIdentity {
  return Object.freeze({
    deviceId: identity.deviceId,
    issueTlsCredential: identity.issueTlsCredential.bind(identity),
  });
}

async function issueMeshTlsCredential(
  identity: MeshDeviceIdentity,
  options: DeviceTlsCredentialOptions,
): Promise<DeviceTlsCredential> {
  const now = options.now ?? Date.now;
  const credential = await identity.issueTlsCredential(options);
  if (credential.deviceId !== identity.deviceId) {
    throw new MeshProtocolError(
      "identity-mismatch",
      "TLS credential does not belong to the configured mesh identity",
    );
  }
  const expiresAt = Date.parse(credential.expiresAt);
  if (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== credential.expiresAt ||
    expiresAt <= now()
  ) {
    throw new TypeError("Mesh TLS credential must report a canonical future expiry");
  }
  return credential;
}

function createMeshServerSecurityProfile(
  deviceId: string,
  trustedPeers: readonly TrustedMeshPeer[],
): MeshServerSecurityProfile {
  return Object.freeze({
    ca: Object.freeze(trustedPeers.map((peer) => peer.rootCertificatePem)),
    minVersion: "TLSv1.3" as const,
    maxVersion: "TLSv1.3" as const,
    honorCipherOrder: true as const,
    secureOptions: constants.SSL_OP_NO_TICKET,
    sessionIdContext: createHash("sha256")
      .update(`zhixing-mesh:${deviceId}`, "utf8")
      .digest("hex")
      .slice(0, 32),
  });
}

function credentialContext(
  profile: MeshServerSecurityProfile,
  credential: DeviceTlsCredential,
): SecureContextOptions {
  return {
    key: credential.privateKeyPem,
    cert: credential.certificateChainPem,
    ca: [...profile.ca],
    minVersion: profile.minVersion,
    maxVersion: profile.maxVersion,
    honorCipherOrder: profile.honorCipherOrder,
    secureOptions: profile.secureOptions,
    sessionIdContext: profile.sessionIdContext,
  };
}

function validateTrustedPeer(peer: TrustedMeshPeer, now = Date.now()): X509Certificate {
  return validateDeviceTrustRoot(peer.identity, peer.rootCertificatePem, now);
}

function resolveAuthenticatedPeer(
  certificate: DetailedPeerCertificate,
  trustedPeers: readonly TrustedMeshPeer[],
): TrustedMeshPeer {
  const rootFingerprint = certificateRootFingerprint(certificate);
  for (const peer of trustedPeers) {
    const root = validateTrustedPeer(peer);
    if (root.fingerprint256 === rootFingerprint) return peer;
  }
  throw new MeshProtocolError("unauthorized-peer", "TLS peer root is not trusted");
}

function assertCertificateRoot(
  certificate: DetailedPeerCertificate,
  expectedRoot: X509Certificate,
): void {
  if (certificateRootFingerprint(certificate) !== expectedRoot.fingerprint256) {
    throw new MeshProtocolError("identity-mismatch", "TLS peer root changed during connection");
  }
}

function certificateRootFingerprint(certificate: DetailedPeerCertificate): string {
  if (!certificate.raw) {
    throw new MeshProtocolError("unauthorized-peer", "TLS peer did not present a certificate");
  }
  let current = certificate;
  const seen = new Set<string>();
  while (current.issuerCertificate?.raw) {
    const fingerprint = createHash("sha256").update(current.raw).digest("hex");
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);
    const issuerFingerprint = createHash("sha256")
      .update(current.issuerCertificate.raw)
      .digest("hex");
    current = current.issuerCertificate;
    if (fingerprint === issuerFingerprint) break;
  }
  return new X509Certificate(current.raw).fingerprint256;
}

function assertTlsState(socket: TLSSocket): void {
  if (!socket.authorized) {
    throw new MeshProtocolError(
      "unauthorized-peer",
      String(socket.authorizationError ?? "TLS peer authorization failed"),
    );
  }
  if (socket.getProtocol() !== "TLSv1.3" || socket.alpnProtocol !== MESH_ALPN_PROTOCOL) {
    throw new MeshProtocolError("incompatible-version", "Mesh requires TLS 1.3 and its ALPN");
  }
}

async function authorize(
  identity: DeviceIdentity,
  authorizePeer: MeshConnectionSecurityOptions["authorizePeer"],
  signal: AbortSignal,
): Promise<void> {
  const allowed = await raceWithSignal(
    Promise.resolve().then(() => authorizePeer(identity, signal)),
    signal,
  );
  if (!allowed) {
    throw new MeshProtocolError("unauthorized-peer", "Device is not authorized for this mesh");
  }
}

function assertAccepted(
  accepted: ProtocolAccepted,
  hello: ProtocolHello,
  localRange: MeshProtocolRange,
  now: number,
  maxClockSkewMs = DEFAULT_MAX_CLOCK_SKEW_MS,
): void {
  if (
    accepted.connectionId !== hello.connectionId ||
    accepted.helloDigest !== protocolDigest("MeshProtocolHello", 1, hello) ||
    !sameMeshProtocolCompatibility(
      accepted.compatibility,
      negotiateMeshProtocol(localRange, accepted.responderProtocolRange),
    )
  ) {
    throw new MeshProtocolError("incompatible-version", "Protocol acceptance was altered");
  }
  assertFresh(accepted.acceptedAt, now, maxClockSkewMs);
}

function assertFresh(value: string, now: number, maxClockSkewMs = DEFAULT_MAX_CLOCK_SKEW_MS): void {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new MeshProtocolError(
      "invalid-frame",
      "Mesh handshake timestamp must use canonical ISO format",
    );
  }
  if (Math.abs(now - timestamp) > maxClockSkewMs) {
    throw new MeshProtocolError("clock-skew", "Mesh handshake timestamp is outside its window");
  }
}

function validateCommonOptions(options: MeshConnectionSecurityOptions): void {
  snapshotMeshProtocolRange(options.protocolRange);
  const maxClockSkewMs = options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxClockSkewMs) || maxClockSkewMs < 0) {
    throw new TypeError("Mesh clock skew limit must be a non-negative integer");
  }
  assertRuntimeTimerDelay(handshakeTimeoutMs, "Mesh handshake timeout");
}

function handshakeTimeout(options: MeshConnectionSecurityOptions): number {
  return options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
}

function validateEndpoint(host: string, port: number): void {
  if (!host) throw new TypeError("Mesh host is required");
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new TypeError("Mesh port is invalid");
  }
}

function encodeFrame(value: ProtocolHello | ProtocolAccepted): Uint8Array {
  return Buffer.from(canonicalize(value), "utf8");
}

function parseHello(encoded: Uint8Array): ProtocolHello {
  const value = parseFrame(encoded, [
    "kind",
    "v",
    "connectionId",
    "protocolRange",
    "nonce",
    "issuedAt",
  ]);
  if (
    value.kind !== "protocol-hello" ||
    value.v !== 1 ||
    typeof value.connectionId !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.issuedAt !== "string"
  ) {
    invalidFrame();
  }
  decodeBase64Url(value.connectionId as string, 16, "connection id");
  decodeBase64Url(value.nonce as string, 32, "nonce");
  const protocolRange = parseRange(value.protocolRange);
  return { ...(value as unknown as ProtocolHello), protocolRange };
}

function parseAccepted(encoded: Uint8Array): ProtocolAccepted {
  const value = parseFrame(encoded, [
    "kind",
    "v",
    "connectionId",
    "compatibility",
    "responderProtocolRange",
    "helloDigest",
    "acceptedAt",
  ]);
  if (
    value.kind !== "protocol-accepted" ||
    value.v !== 1 ||
    typeof value.connectionId !== "string" ||
    typeof value.helloDigest !== "string" ||
    typeof value.acceptedAt !== "string"
  ) {
    invalidFrame();
  }
  decodeBase64Url(value.connectionId as string, 16, "connection id");
  return {
    ...(value as unknown as ProtocolAccepted),
    compatibility: parseCompatibility(value.compatibility),
    responderProtocolRange: parseRange(value.responderProtocolRange),
  };
}

function parseCompatibility(value: unknown): MeshProtocolCompatibility {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidFrame();
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  if (
    record.mode === "read-write" &&
    fields.length === 2 &&
    fields[0] === "mode" &&
    fields[1] === "protocolVersion" &&
    typeof record.protocolVersion === "string"
  ) {
    try {
      const range = snapshotMeshProtocolRange({
        min: record.protocolVersion,
        max: record.protocolVersion,
      });
      return Object.freeze({
        mode: "read-write",
        protocolVersion: range.min,
      });
    } catch {
      invalidFrame();
    }
  }
  if (
    record.mode === "read-only" &&
    record.reason === "incompatible-version" &&
    fields.length === 2 &&
    fields[0] === "mode" &&
    fields[1] === "reason"
  ) {
    return Object.freeze({
      mode: "read-only",
      reason: "incompatible-version",
    });
  }
  invalidFrame();
}

function parseFrame(
  encoded: Uint8Array,
  fields: readonly string[],
): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  } catch {
    invalidFrame();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalidFrame();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidFrame();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index]) ||
    canonicalize(value) !== text
  ) {
    invalidFrame();
  }
  return record;
}

function parseRange(value: unknown): MeshProtocolRange {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidFrame();
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  if (fields.length !== 2 || fields[0] !== "max" || fields[1] !== "min") invalidFrame();
  try {
    if (typeof record.min !== "string" || typeof record.max !== "string") {
      invalidFrame();
    }
    return snapshotMeshProtocolRange(record as unknown as MeshProtocolRange);
  } catch {
    invalidFrame();
  }
}

function decodeBase64Url(value: string, length: number, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalidFrame();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== length || decoded.toString("base64url") !== value) {
    throw new MeshProtocolError("invalid-frame", `Invalid mesh ${label}`);
  }
}

function invalidFrame(): never {
  throw new MeshProtocolError(
    "invalid-frame",
    "Mesh protocol frame has missing, invalid or unknown fields",
  );
}

function waitForTlsClient(
  socket: TLSSocket,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onSecure = () => finish();
    const onError = (error: Error) => finish(error);
    const onAbort = () => finish(abortReason(signal));
    const finish = (error?: Error) => {
      socket.removeListener("secureConnect", onSecure);
      socket.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    socket.once("secureConnect", onSecure);
    socket.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class HandshakeDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private readonly parentSignal: AbortSignal | undefined;
  private readonly onParentAbort: (() => void) | undefined;
  private errorReported = false;

  constructor(timeoutMs: number, parentSignal?: AbortSignal) {
    this.signal = this.controller.signal;
    this.parentSignal = parentSignal;
    this.timer = setTimeout(() => {
      this.controller.abort(
        new MeshProtocolError("connection-closed", "Mesh handshake timed out"),
      );
    }, timeoutMs);
    this.timer.unref();
    if (parentSignal) {
      this.onParentAbort = () => this.controller.abort(abortReason(parentSignal));
      if (parentSignal.aborted) this.onParentAbort();
      else parentSignal.addEventListener("abort", this.onParentAbort, { once: true });
    }
  }

  run<T>(operation: Promise<T>): Promise<T> {
    return raceWithSignal(operation, this.signal);
  }

  report(error: Error, reporter: MeshServerOptions["onHandshakeError"]): void {
    if (this.errorReported) return;
    this.errorReported = true;
    reportHandshakeError(error, reporter);
  }

  dispose(): void {
    clearTimeout(this.timer);
    if (this.parentSignal && this.onParentAbort) {
      this.parentSignal.removeEventListener("abort", this.onParentAbort);
    }
  }
}

function reportHandshakeError(
  error: Error,
  reporter: MeshServerOptions["onHandshakeError"],
): void {
  try {
    const result = reporter?.(error);
    if (result) void Promise.resolve(result).catch(() => {});
  } catch {
    // Diagnostics must never keep a rejected connection alive or crash the TLS server.
  }
}

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => finish(reject, abortReason(signal));
    const finish = (settle: (value: never) => void, value: T | Error) => {
      signal.removeEventListener("abort", onAbort);
      settle(value as never);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(resolve as (value: never) => void, value),
      (error: unknown) => finish(reject, error instanceof Error ? error : new Error(String(error))),
    );
  });
}

function connectionKey(socket: Socket): string {
  return [
    socket.localAddress ?? "",
    socket.localPort ?? "",
    socket.remoteAddress ?? "",
    socket.remotePort ?? "",
  ].join("|");
}

function normalizeTlsError(error: unknown): Error {
  if (error instanceof MeshProtocolError) return error;
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code?.includes("CERT") ||
      code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
      code === "DEPTH_ZERO_SELF_SIGNED_CERT"
    ) {
      return new MeshProtocolError("unauthorized-peer", "TLS peer certificate is not trusted");
    }
    return error;
  }
  return new Error("Unknown mesh TLS failure");
}

function abortError(): Error {
  return new DOMException("Operation aborted", "AbortError");
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : abortError();
}
