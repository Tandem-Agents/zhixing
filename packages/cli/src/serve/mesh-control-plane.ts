import { once } from "node:events";
import {
  connect as connectNet,
  type Server as NetServer,
  type Socket,
} from "node:net";
import type {
  DeviceRole,
  HomeTrustRecord,
  MeshEndpointDescriptor,
  MeshRoleBootConfig,
  SecretStorePort,
} from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import {
  currentAndPreviousRendezvousKeys,
  MeshConnectionRegistry,
  MeshEndpointDirectory,
  MESH_ENDPOINT_SERVICE_ID,
  registerMeshEndpointService,
} from "@zhixing/mesh/bootstrap";
import { encodeBlindRendezvousHello } from "@zhixing/mesh/blind-rendezvous";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { MeshProtocolError } from "@zhixing/mesh/errors";
import {
  acceptAuthenticatedMeshSocket,
  connectAuthenticatedMesh,
  createAuthenticatedMeshServer,
  type TrustedMeshPeer,
} from "@zhixing/mesh/handshake";
import { OutboundMeshTunnel } from "@zhixing/mesh/outbound-tunnel";
import { HandshakeReplayWindow } from "@zhixing/mesh/replay-window";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import type { SecureMeshConnection } from "@zhixing/mesh/transport";
import { fulfillConnectionLifetimeObligation } from "./connection-lifetime-obligation.js";
import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";

const PROTOCOL_RANGE = { min: "1", max: "1" } as const;
const RELAY_HELLO_TTL_MS = 60_000;

export interface ProductionMeshControlPlaneOptions {
  readonly localIdentity: DeviceKey;
  readonly trust: HomeTrustRecord;
  readonly configuration: MeshRoleBootConfig;
  readonly endpoints: MeshEndpointDirectory;
  readonly transportPeers: readonly TrustedMeshPeer[];
  readonly secretStore: SecretStorePort;
  readonly bootstrapStore: FileMeshBootstrapStore;
  readonly services: MeshServiceRegistry;
  readonly terminalOnly?: {
    readonly services: MeshServiceRegistry;
    readonly authorizePeer: (deviceId: string) => boolean;
  };
  readonly connections?: MeshConnectionRegistry;
  readonly localEndpoint?: MeshEndpointDescriptor;
  readonly onConnection?: (
    connection: SecureMeshConnection,
  ) => void | Promise<void>;
  readonly onTrustReconciled?: (
    record: HomeTrustRecord,
  ) => void | Promise<void>;
  readonly onConnectionError?: (error: Error) => void;
  readonly watchTrust?: boolean;
  readonly recoveryEvidencePeerIds?: readonly string[];
  readonly credentialRouteGuard?: {
    assertRoute(input: {
      readonly ref: { readonly kind: "rendezvous"; readonly bindingId: string };
      readonly service: "rendezvous";
    }): Promise<void>;
  };
}

/** Owns direct listeners, relay registrations and the non-anchor reconnect loop. */
export class ProductionMeshControlPlane {
  readonly connections: MeshConnectionRegistry;
  readonly #abort = new AbortController();
  readonly #tasks = new Set<Promise<void>>();
  readonly #peerControllers = new Map<string, AbortController>();
  readonly #peers = new Map<string, TrustedMeshPeer>();
  readonly #roles: ReadonlySet<string>;
  readonly #replayWindow = new HandshakeReplayWindow();
  #trust: HomeTrustRecord;
  #directServer: NetServer | undefined;
  #disposeEndpointService: (() => void) | undefined;
  #started = false;

  constructor(private readonly options: ProductionMeshControlPlaneOptions) {
    this.connections = options.connections ?? new MeshConnectionRegistry();
    this.#trust = options.trust;
    for (const peer of options.transportPeers) {
      this.#peers.set(peer.identity.deviceId, peer);
    }
    const member = options.trust.members.find((candidate) =>
      candidate.device.deviceId === options.localIdentity.deviceId);
    if (!member || member.state !== "active") {
      throw new Error("Mesh control plane requires an active local trust member");
    }
    this.#roles = new Set(options.configuration.enabledRoles);
    this.#disposeEndpointService = registerMeshEndpointService(
      options.services,
      options.endpoints,
      async (descriptor) => {
        return await options.bootstrapStore.acceptEndpoint(descriptor);
      },
    );
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.options.onTrustReconciled?.(this.#trust);
    if (this.options.recoveryEvidencePeerIds !== undefined) {
      this.#startRecoveryEvidenceDialers();
    } else if (this.#isCurrentAnchor()) {
      await this.#startAnchor();
    } else {
      this.#startDialer();
    }
    if (this.options.watchTrust !== false) this.#track(this.#watchTrust());
  }

  async stop(): Promise<void> {
    if (!this.#started) {
      this.#disposeEndpointService?.();
      this.#disposeEndpointService = undefined;
      return;
    }
    this.#started = false;
    this.#abort.abort(new Error("Mesh control plane stopped"));
    await this.#closeTransport();
    await Promise.all([...this.#tasks].map((task) => task.catch(() => undefined)));
    this.#disposeEndpointService?.();
    this.#disposeEndpointService = undefined;
  }

  currentTrust(): HomeTrustRecord {
    return this.#trust;
  }

  async reconcileTrust(record: HomeTrustRecord): Promise<void> {
    if (record.homeId !== this.#trust.homeId || record.trustEpoch < this.#trust.trustEpoch) {
      throw new Error("Mesh trust reconciliation rejected another home or epoch rollback");
    }
    if (
      record.trustEpoch === this.#trust.trustEpoch &&
      record.chainHead.seq < this.#trust.chainHead.seq
    ) {
      throw new Error("Mesh trust reconciliation rejected a chain rollback");
    }
    const trustChanged = canonicalize(record) !== canonicalize(this.#trust);
    const peersChanged = await this.#refreshTransportPeers();
    if (!trustChanged && !peersChanged) return;
    this.#trust = record;
    await this.options.onTrustReconciled?.(record);
    const local = record.members.find((member) =>
      member.device.deviceId === this.options.localIdentity.deviceId);
    if (
      !local ||
      local.state !== "active" ||
      [...this.#roles].some((role) => !local.roles.includes(role as "anchor" | "executor" | "surface"))
    ) {
      await this.#disable(new Error("Local mesh role authorization was revoked"));
      return;
    }
    const requiredPeerRoles = this.#compatiblePeerRoles();
    const active = new Set(
      record.members
        .filter((member) =>
          member.state === "active" &&
          requiredPeerRoles.some((role) => member.roles.includes(role)))
        .map((member) => member.device.deviceId),
    );
    for (const peerId of this.#peers.keys()) {
      if (!active.has(peerId)) {
        this.#stopPeerTask(peerId, new Error("Mesh peer trust was revoked"));
        await this.connections.disconnect(peerId, new Error("Mesh peer trust was revoked"));
        if (!this.#isTerminalOnlyPeer(peerId)) {
          await this.options.secretStore.delete({
            kind: "rendezvous",
            bindingId: peerId,
          });
        }
      }
    }
    const requiredPeers = record.members.filter((member) =>
      member.state === "active" &&
      member.device.deviceId !== this.options.localIdentity.deviceId &&
      requiredPeerRoles.some((role) => member.roles.includes(role)));
    if (requiredPeers.some((member) => !this.#peers.has(member.device.deviceId))) {
      return;
    }
    await this.#restartTransport();
  }

  async #watchTrust(): Promise<void> {
    while (!this.#abort.signal.aborted) {
      await abortableDelay(1_000, this.#abort.signal).catch(() => undefined);
      if (this.#abort.signal.aborted) return;
      try {
        const record = await this.options.bootstrapStore.loadTrustRecord();
        if (record) await this.reconcileTrust(record);
      } catch (error) {
        const reason = asError(error);
        await this.#disable(reason);
        throw reason;
      }
    }
  }

  async #disable(reason: Error): Promise<void> {
    this.#abort.abort(reason);
    await this.#closeTransport(reason);
  }

  async #closeTransport(reason?: Error): Promise<void> {
    const server = this.#directServer;
    this.#directServer = undefined;
    const closed = server
      ? once(server, "close").then(() => undefined, () => undefined)
      : Promise.resolve();
    server?.close();
    await this.connections.close(reason);
    await closed;
  }

  async #restartTransport(): Promise<void> {
    for (const peerId of [...this.#peerControllers.keys()]) {
      this.#stopPeerTask(peerId, new Error("Mesh trust topology changed"));
    }
    await this.#closeTransport(new Error("Mesh trust topology changed"));
    if (this.#isCurrentAnchor()) {
      await this.#startAnchor();
    } else {
      this.#startDialer();
    }
  }

  async #refreshTransportPeers(): Promise<boolean> {
    let changed = false;
    for (const peer of await this.options.bootstrapStore.loadTransportPeers()) {
      const deviceId = peer.identity.deviceId;
      const current = this.#peers.get(deviceId);
      if (current && canonicalize(current) !== canonicalize(peer)) {
        throw new Error(`Mesh transport identity changed for ${deviceId}`);
      }
      if (!current) {
        this.#peers.set(deviceId, peer);
        changed = true;
      }
    }
    return changed;
  }

  async #startAnchor(): Promise<void> {
    const trustedPeers = this.#authorizedPeers(["anchor", "executor", "surface"]);
    if (trustedPeers.length === 0) return;
    const listen = this.options.configuration.anchorListen;
    if (listen) {
      const server = await createAuthenticatedMeshServer(
        this.#serverSecurity(trustedPeers),
        (connection) => this.#accept(connection),
      );
      this.#directServer = server;
      server.listen(listen.bind.port, listen.bind.host);
      await once(server, "listening");
    }
    const relay = this.options.configuration.relayRegistration;
    if (!relay) return;
    for (const peer of trustedPeers) {
      const ref = {
        kind: "rendezvous",
        bindingId: peer.identity.deviceId,
      } as const;
      await this.options.credentialRouteGuard?.assertRoute({ ref, service: "rendezvous" });
      const secret = await this.options.secretStore.get(ref);
      if (!secret) continue;
      this.#trackPeerTask(peer.identity.deviceId, (signal) =>
        this.#maintainRelayWindows(peer, secret, relay, signal));
    }
  }

  async #maintainRelayWindows(
    peer: TrustedMeshPeer,
    secret: string,
    relay: { readonly host: string; readonly port: number },
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      const window = new AbortController();
      const abortWindow = () => window.abort(signal.reason);
      signal.addEventListener("abort", abortWindow, { once: true });
      const tunnels = [0, 1].map((offset) => new OutboundMeshTunnel({
        open: async (signal) => {
          try {
            const keys = currentAndPreviousRendezvousKeys(secret);
            const socket = await openRelaySocket(relay, keys[offset]!, signal);
            return await acceptAuthenticatedMeshSocket(this.#serverSecurity([peer]), socket);
          } catch (error) {
            this.#report(error);
            throw error;
          }
        },
        onConnection: (connection) => this.#accept(connection),
      }).run(window.signal));
      try {
        await Promise.race([
          Promise.all(tunnels),
          abortableDelay(millisecondsUntilNextUtcDay(), signal),
        ]);
      } finally {
        window.abort(new Error("Mesh rendezvous window rotated"));
        await Promise.all(tunnels.map((task) => task.catch(() => undefined)));
        signal.removeEventListener("abort", abortWindow);
      }
    }
  }

  #startDialer(): void {
    const anchors = this.#authorizedPeers(["anchor"]);
    const issuerId = this.#trust.issuer.deviceId;
    const anchor = anchors.find((candidate) => candidate.identity.deviceId === issuerId);
    if (!anchor) throw new Error("Mesh executor has no active issuer anchor peer");
    if (!this.options.endpoints.get(anchor.identity.deviceId)) {
      throw new Error("Mesh executor has no durable anchor endpoint");
    }
    const tunnel = new OutboundMeshTunnel({
      open: async (signal) => {
        try {
          const descriptor = this.options.endpoints.get(anchor.identity.deviceId);
          if (!descriptor) throw new Error("Mesh executor has no durable anchor endpoint");
          return await this.#openAnchor(anchor, descriptor, signal);
        } catch (error) {
          this.#report(error);
          throw error;
        }
      },
      onConnection: (connection) => this.#accept(connection),
    });
    this.#trackPeerTask(anchor.identity.deviceId, (signal) => tunnel.run(signal));
  }

  #startRecoveryEvidenceDialers(): void {
    const deviceIds = [...new Set(this.options.recoveryEvidencePeerIds ?? [])].sort();
    for (const deviceId of deviceIds) {
      const peer = this.#peers.get(deviceId);
      const descriptor = this.options.endpoints.get(deviceId);
      if (!peer || !descriptor) continue;
      const tunnel = new OutboundMeshTunnel({
        open: (signal) => this.#openPeer(peer, descriptor, signal),
        onConnection: (connection) => this.#accept(connection),
      });
      this.#trackPeerTask(deviceId, (signal) => tunnel.run(signal));
    }
  }

  async #openAnchor(
    anchor: TrustedMeshPeer,
    descriptor: MeshEndpointDescriptor,
    signal: AbortSignal,
  ): Promise<SecureMeshConnection> {
    return this.#openPeer(anchor, descriptor, signal);
  }

  async #openPeer(
    peer: TrustedMeshPeer,
    descriptor: MeshEndpointDescriptor,
    signal: AbortSignal,
  ): Promise<SecureMeshConnection> {
    const failures: Error[] = [];
    const ordered = [
      ...descriptor.transports.filter((transport) => transport.kind === "direct"),
      ...descriptor.transports.filter((transport) => transport.kind === "blind-relay"),
    ];
    for (const transport of ordered) {
      try {
        if (transport.kind === "direct") {
          return await connectAuthenticatedMesh({
            host: transport.host,
            port: transport.port,
            trustedPeer: peer,
            identity: this.options.localIdentity,
            protocolRange: PROTOCOL_RANGE,
            authorizePeer: (identity) => this.#isAuthorized(identity.deviceId, ["anchor"]),
            signal,
          });
        }
        const ref = {
          kind: "rendezvous",
          bindingId: peer.identity.deviceId,
        } as const;
        await this.options.credentialRouteGuard?.assertRoute({ ref, service: "rendezvous" });
        const secret = await this.options.secretStore.get(ref);
        if (!secret) throw new Error("Anchor relay rendezvous secret is unavailable");
        for (const key of currentAndPreviousRendezvousKeys(secret)) {
          try {
            const socket = await openRelaySocket(transport.relay, key, signal);
            return await connectAuthenticatedMesh({
              socket,
              trustedPeer: peer,
              identity: this.options.localIdentity,
              protocolRange: PROTOCOL_RANGE,
              authorizePeer: (identity) => this.#isAuthorized(identity.deviceId, ["anchor"]),
              signal,
            });
          } catch (error) {
            failures.push(asError(error));
          }
        }
      } catch (error) {
        failures.push(asError(error));
      }
    }
    throw new AggregateError(failures, "All authenticated mesh peer endpoints failed");
  }

  async #accept(connection: SecureMeshConnection): Promise<void> {
    const active = this.#isAuthorized(connection.peer.deviceId, this.#compatiblePeerRoles());
    const terminalOnly = !active && this.#isTerminalOnlyPeer(connection.peer.deviceId);
    if (!active && !terminalOnly) {
      await connection.close(new Error("Mesh peer is no longer authorized"));
      return;
    }
    this.connections.attach(
      connection,
      terminalOnly ? this.options.terminalOnly!.services : this.options.services,
      { diagnosable: active },
    );
    if (active && this.options.localEndpoint) {
      const payload = Buffer.from(canonicalize(this.options.localEndpoint), "utf8");
      this.#track(fulfillConnectionLifetimeObligation({
        connectionClosed: connection.closed,
        stopSignal: this.#abort.signal,
        attempt: async (signal) => {
          await this.connections.client(connection.peer.deviceId).request(
            MESH_ENDPOINT_SERVICE_ID,
            payload,
            signal,
          );
        },
        shouldRetry: isEndpointPublishRetryable,
        onError: (error) => this.#report(error),
      }));
    }
    if (active) await this.options.onConnection?.(connection);
  }

  #authorizedPeers(roles: readonly DeviceRole[]): TrustedMeshPeer[] {
    const active = this.#trust.members
      .filter((member) =>
        member.state === "active" &&
        member.device.deviceId !== this.options.localIdentity.deviceId &&
        roles.some((role) => member.roles.includes(role)))
      .map((member) => member.device.deviceId);
    const historical = [...this.#peers.keys()].filter((deviceId) =>
      deviceId !== this.options.localIdentity.deviceId && this.#isTerminalOnlyPeer(deviceId));
    return [...new Set([...active, ...historical])].sort().map((deviceId) => {
      const peer = this.#peers.get(deviceId);
      if (!peer) {
        throw new Error(
          `Authorized mesh peer ${deviceId} has no authenticated transport identity`,
        );
      }
      return peer;
    });
  }

  #isAuthorized(deviceId: string, requiredRoles?: readonly DeviceRole[]): boolean {
    if (this.options.recoveryEvidencePeerIds !== undefined) {
      return this.options.recoveryEvidencePeerIds.includes(deviceId) && this.#peers.has(deviceId);
    }
    const member = this.#trust.members.find((candidate) =>
      candidate.device.deviceId === deviceId);
    return Boolean(
      member &&
      member.state === "active" &&
      (!requiredRoles || requiredRoles.some((role) => member.roles.includes(role))),
    );
  }

  #isTerminalOnlyPeer(deviceId: string): boolean {
    return this.options.terminalOnly?.authorizePeer(deviceId) === true && this.#peers.has(deviceId);
  }

  #serverSecurity(trustedPeers: readonly TrustedMeshPeer[]) {
    return {
      identity: this.options.localIdentity,
      protocolRange: PROTOCOL_RANGE,
      trustedPeers,
      replayWindow: this.#replayWindow,
      authorizePeer: (identity: { deviceId: string }) =>
        this.#isAuthorized(identity.deviceId, this.#compatiblePeerRoles()) ||
        this.#isTerminalOnlyPeer(identity.deviceId),
      onHandshakeError: (error: Error) => this.#report(error),
    };
  }

  #compatiblePeerRoles(): readonly DeviceRole[] {
    if (this.options.recoveryEvidencePeerIds !== undefined) {
      return ["anchor", "executor", "surface"];
    }
    return this.#isCurrentAnchor()
      ? ["anchor", "executor", "surface"]
      : ["anchor"];
  }

  #isCurrentAnchor(): boolean {
    return this.#roles.has("anchor") &&
      this.#trust.issuer.deviceId === this.options.localIdentity.deviceId;
  }

  #track(task: Promise<void>): void {
    this.#tasks.add(task);
    void task.catch((error) => this.#report(error)).finally(() => this.#tasks.delete(task));
  }

  #trackPeerTask(
    peerDeviceId: string,
    run: (signal: AbortSignal) => Promise<void>,
  ): void {
    if (this.#peerControllers.has(peerDeviceId)) return;
    const controller = new AbortController();
    const abort = () => controller.abort(this.#abort.signal.reason);
    this.#abort.signal.addEventListener("abort", abort, { once: true });
    this.#peerControllers.set(peerDeviceId, controller);
    const task = run(controller.signal).finally(() => {
      this.#abort.signal.removeEventListener("abort", abort);
      if (this.#peerControllers.get(peerDeviceId) === controller) {
        this.#peerControllers.delete(peerDeviceId);
      }
    });
    this.#track(task);
  }

  #stopPeerTask(peerDeviceId: string, reason: Error): void {
    const controller = this.#peerControllers.get(peerDeviceId);
    if (!controller) return;
    this.#peerControllers.delete(peerDeviceId);
    controller.abort(reason);
  }

  #report(error: unknown): void {
    if (!this.#abort.signal.aborted) this.options.onConnectionError?.(asError(error));
  }
}

async function openRelaySocket(
  endpoint: { readonly host: string; readonly port: number },
  key: `rzv:${string}`,
  signal: AbortSignal,
): Promise<Socket> {
  if (signal.aborted) throw asError(signal.reason);
  const socket = connectNet({
    host: endpoint.host,
    port: endpoint.port,
    signal,
  });
  try {
    await once(socket, "connect");
    await writeSocket(
      socket,
      encodeBlindRendezvousHello({ v: 1, key, ttlMs: RELAY_HELLO_TTL_MS }),
      signal,
    );
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function writeSocket(socket: Socket, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(asError(signal.reason));
  return new Promise((resolve, reject) => {
    const onAbort = () => finish(asError(signal.reason));
    const finish = (error?: Error | null) => {
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.write(bytes, finish);
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isEndpointPublishRetryable(error: unknown): boolean {
  if (error instanceof MeshProtocolError) return error.code === "service-failed";
  return error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: unknown }).code === "service-failed";
}

function millisecondsUntilNextUtcDay(now = Date.now()): number {
  const current = new Date(now);
  const next = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate() + 1,
  );
  return Math.max(1, next - now);
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(asError(signal.reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(), milliseconds);
    const onAbort = () => finish(asError(signal.reason));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
