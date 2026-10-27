import type { CurrentTrustProjection } from "@zhixing/mesh/trust-chain";
import type { MeshRequestChannelOptions, MeshServiceClient } from "@zhixing/mesh/request-channel";
import { once } from "node:events";
import {
  connect as connectNet,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { randomBytes } from "node:crypto";
import type {
  DeviceRole,
  MeshEndpointDescriptor,
  MeshRoleBootConfig,
  SecretStorePort,
} from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import {
  currentAndPreviousDiscoveryRendezvousKeys,
  currentAndPreviousRendezvousKeys,
  currentAndPreviousTerminalRendezvousKeys,
  MeshConnectionRegistry,
  MeshEndpointDirectory,
  MESH_ENDPOINT_SERVICE_ID,
  persistPairwiseRendezvousSecret,
  registerMeshEndpointService,
} from "@zhixing/mesh/bootstrap";
import { encodeBlindRendezvousHello } from "@zhixing/mesh/blind-rendezvous";
import type { DeviceKey } from "@zhixing/mesh/device-identity";
import { MeshProtocolError } from "@zhixing/mesh/errors";
import {
  acceptAuthenticatedMeshSocket,
  connectAuthenticatedMesh,
  createAuthenticatedMeshServer,
  type MeshConnectionRoute,
  type MeshRouteResolution,
  type TrustedMeshPeer,
} from "@zhixing/mesh/handshake";
import {
  openHomeDiscovery,
  serveHomeDiscovery,
  type HomeDiscoveryBudget,
  type HomeDiscoveryClientSession,
  type HomeDiscoveryLocalChain,
  type HomeDiscoveryPurpose,
  type HomeDiscoveryResumePoint,
  type HomeDiscoveryServerPorts,
  type VerifiedHomeDiscovery,
  type VerifiedHomeDiscoveryProgress,
} from "@zhixing/mesh/home-discovery";
import { OutboundMeshTunnel } from "@zhixing/mesh/outbound-tunnel";
import { HandshakeReplayWindow } from "@zhixing/mesh/replay-window";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import type { SecureMeshConnection } from "@zhixing/mesh/transport";
import { fulfillConnectionLifetimeObligation } from "./connection-lifetime-obligation.js";
import type {
  MeshEndpointDirectoryPersistencePort,
  MeshTransportPeerDirectoryPersistencePort,
} from "./mesh-bootstrap-projection.js";

const PROTOCOL_RANGE = { min: "1", max: "1" } as const;
const RELAY_HELLO_TTL_MS = 60_000;
/** 中继上的终态接入注册：当前与前一时间窗各 2 条，数量与历史移除数无关。 */
const TERMINAL_SLOTS_PER_WINDOW = 2;
const TERMINAL_ROUTE_TASK = "terminal-route";
/** 中继上的家级发现入口：每种用途当前与前一时间窗各 2 条，数量与迁居、移除历史无关。 */
const DISCOVERY_SLOTS_PER_WINDOW = 2;
const DISCOVERY_TASK = "home-discovery";
const ISSUER_DIALER_TASK = "issuer-dialer";
/** 成员在认证连接上向现任提交新的逐对会合秘密；现任写入并读回后答复，成员再写入并切换。 */
export const MESH_PAIRWISE_RENEGOTIATE_SERVICE_ID = "mesh.pairwise-renegotiate";

/**
 * 现任侧的逐对重协商服务：只由完整运行时显式注册（受限的根恢复建立、恢复证据运行时只暴露各自的窄服务）。
 * 请求方取自已认证连接的对端。
 */
export function registerPairwiseRenegotiationService(
  services: MeshServiceRegistry,
  control: Pick<ProductionMeshControlPlane, "authorizesPairwiseRenegotiation" | "adoptPairwiseSecret">,
): () => void {
  return services.register(MESH_PAIRWISE_RENEGOTIATE_SERVICE_ID, {
    access: "write",
    availability: "negotiated-version",
    authorize: (connection) => control.authorizesPairwiseRenegotiation(connection.peer.deviceId),
    handler: async (payload, connection) => {
      const request = JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>;
      if (!request || request.v !== 1 || typeof request.secret !== "string" || Object.keys(request).length !== 2) {
        throw new TypeError("Pairwise renegotiation request is invalid");
      }
      await control.adoptPairwiseSecret(connection.peer.deviceId, request.secret);
      return Buffer.from("{}", "utf8");
    },
  });
}
const MAX_CONCURRENT_TERMINAL_ROUTES = 8;

function activeTrust(record: CurrentTrustProjection): CurrentTrustProjection {
  const { homeId, trustEpoch, anchorEpoch, chainHead, issuer, recoveryRootPublicKey, recoveryBackupPublicKey,
    recoveryActivationDigest, pendingResetEvent } = record;
  return { homeId, trustEpoch, anchorEpoch, chainHead, issuer,
    ...(recoveryRootPublicKey === undefined ? {} : { recoveryRootPublicKey }),
    ...(recoveryBackupPublicKey === undefined ? {} : { recoveryBackupPublicKey }),
    ...(recoveryActivationDigest === undefined ? {} : { recoveryActivationDigest }),
    ...(pendingResetEvent === undefined ? {} : { pendingResetEvent }),
    members: record.members.filter(member => member.state === "active") };
}

export interface MeshControlPlaneTrustProjectionPort {
  readonly loadCurrentTrust: () => Promise<CurrentTrustProjection | undefined>;
}

export interface ProductionMeshControlPlaneOptions {
  readonly logging?: MeshRequestChannelOptions;
  readonly localIdentity: DeviceKey;
  readonly trust: CurrentTrustProjection;
  readonly configuration: MeshRoleBootConfig;
  readonly endpoints: MeshEndpointDirectory;
  readonly transportPeers: readonly TrustedMeshPeer[];
  readonly secretStore: SecretStorePort;
  readonly endpointDirectory: MeshEndpointDirectoryPersistencePort;
  readonly transportPeerDirectory: MeshTransportPeerDirectoryPersistencePort;
  readonly trustProjection: MeshControlPlaneTrustProjectionPort;
  readonly services: MeshServiceRegistry;
  /**
   * 终态入口：握手携带终态定位的连接按请求解析身份，只挂这里的注册表；
   * 命令与连接绑定的 operation 由领域核对。
   */
  readonly terminalRoutes?: {
    readonly services: MeshServiceRegistry;
    /** 按定位精确解析可信身份与 operation 绑定，只做本机读。 */
    readonly resolve: (locator: string, signal: AbortSignal) => Promise<MeshRouteResolution | undefined>;
    /** issuer 自有的终态路由秘密，用于派生中继终态接入键；本机不是移除 issuer 时为空。 */
    readonly secret: () => Promise<string | undefined>;
  };
  /**
   * 家级发现入口：只有当前 issuer 提供两种用途各自的家级秘密与证明端口；不是 issuer 时返回 undefined。
   * 被撤销的 target 与离线后回来的成员凭耐久的家级秘密经此找到现任，验过继任证明后在同一连接上进入 TLS。
   */
  readonly discovery?: () => Promise<{
    readonly secrets: Readonly<Record<HomeDiscoveryPurpose, string>>;
    readonly ports: HomeDiscoveryServerPorts;
    /** 每次发现会话的发送预算；缺省按协议默认值。 */
    readonly budget?: HomeDiscoveryBudget;
  } | undefined>;
  /**
   * 成员发现（非值班成员）：拨现任不通或缺现任的传输身份时，凭配对时取得的家级 discovery 秘密经已知中继
   * 找到现任；adopt 把验过的继任后缀与现任的公开连接资料耐久化（不授予任何成员资格，资格仍只看 trust）。
   */
  readonly memberDiscovery?: {
    readonly secret: () => Promise<string | undefined>;
    /** 本机信任链端口（按键读所需的点，不整读本机链）。 */
    readonly localChain: () => Promise<HomeDiscoveryLocalChain | undefined>;
    /** 本机耐久的已验证发现进度（上次未完会话）：作为下一次会话的第一候选。 */
    readonly resume?: () => Promise<HomeDiscoveryResumePoint | undefined>;
    /** 耐久本次会话验过的内容：未完时按组导入或按页暂存并记进度，完整时接续并记现任连接资料。 */
    readonly adopt: (verified: VerifiedHomeDiscovery | VerifiedHomeDiscoveryProgress) => Promise<void>;
    /** 连上现任之后（含重协商之后）：例如上报本机被取代的旧分支独有事实；失败只报告，不断开。 */
    readonly onIssuerConnected?: (peerDeviceId: string, client: MeshServiceClient) => Promise<void>;
  };
  /** trust 进入控制面处叠加的准入限制（例如现任尚未收束的旧分支撤销/降权）；只减不加。 */
  readonly restrictTrust?: (record: CurrentTrustProjection) => CurrentTrustProjection;
  readonly connections?: MeshConnectionRegistry;
  readonly localEndpoint?: MeshEndpointDescriptor;
  readonly onConnection?: (
    connection: SecureMeshConnection,
  ) => void | Promise<void>;
  readonly onTrustReconciled?: (
    record: CurrentTrustProjection,
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
  /** 终态入口的连接单独登记，不顶替同一设备的成员连接，也不承载对它的反向调用。 */
  readonly terminalConnections: MeshConnectionRegistry;
  readonly #abort = new AbortController();
  readonly #tasks = new Set<Promise<void>>();
  readonly #peerControllers = new Map<string, AbortController>();
  readonly #peers = new Map<string, TrustedMeshPeer>();
  readonly #roles: ReadonlySet<string>;
  readonly #replayWindow = new HandshakeReplayWindow();
  #trust: CurrentTrustProjection;
  /** 未叠加限制的最新 trust：限制变化时据此重算。 */
  #source: CurrentTrustProjection;
  #directServer: NetServer | undefined;
  #disposeEndpointService: (() => void) | undefined;
  #started = false;

  constructor(private readonly options: ProductionMeshControlPlaneOptions) {
    this.connections = options.connections ?? new MeshConnectionRegistry({ logging: options.logging });
    this.terminalConnections = new MeshConnectionRegistry({ logging: options.logging });
    this.#source = options.trust;
    this.#trust = activeTrust(this.#restricted(options.trust));
    for (const peer of options.transportPeers) {
      this.#peers.set(peer.identity.deviceId, peer);
    }
    const member = options.trust.members.find((candidate) =>
      candidate.device.deviceId === options.localIdentity.deviceId);
    if (!member || member.state !== "active") {
      throw new Error("Mesh control plane requires an active local trust member");
    }
    this.#roles = new Set(options.configuration.enabledRoles);
    const disposeEndpoint = registerMeshEndpointService(
      options.services,
      options.endpoints,
      async (descriptor) => {
        return await options.endpointDirectory.acceptEndpoint(descriptor);
      },
    );
    this.#disposeEndpointService = disposeEndpoint;
  }

  /** 重协商服务的授权：本机是现任 issuer，对端是 active 成员。 */
  authorizesPairwiseRenegotiation(peerDeviceId: string): boolean {
    return this.#isCurrentAnchor() && this.#isAuthorized(peerDeviceId);
  }

  /** 现任写入成员提交的逐对秘密（读回核对），并按新秘密重起该成员的逐对中继窗口。 */
  async adoptPairwiseSecret(peerDeviceId: string, secret: string): Promise<void> {
    if (!this.authorizesPairwiseRenegotiation(peerDeviceId)) {
      throw new Error("Pairwise renegotiation is only served by the current duty device to an active member");
    }
    await persistPairwiseRendezvousSecret(this.options.secretStore, peerDeviceId, secret);
    const peer = this.#peers.get(peerDeviceId);
    const relay = this.options.configuration.relayRegistration;
    if (!peer || !relay || !this.#started) return;
    this.#stopPeerTask(peerDeviceId, new Error("Mesh pairwise rendezvous secret was renegotiated"));
    this.#trackPeerTask(peerDeviceId, (signal) => this.#maintainRelayWindows(peer, secret, relay, signal));
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    // 限制可能在构造之后才载入：启动时按当前限制重算一次
    this.#trust = activeTrust(this.#restricted(this.#source));
    await this.options.onTrustReconciled?.(this.#trust);
    if (this.options.recoveryEvidencePeerIds !== undefined) {
      this.#startRecoveryEvidenceDialers();
    } else if (this.#isCurrentAnchor()) {
      await this.#startAnchor();
    } else {
      await this.#startDialer();
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

  currentTrust(): CurrentTrustProjection {
    return this.#trust;
  }

  #restricted(record: CurrentTrustProjection): CurrentTrustProjection {
    return this.options.restrictTrust ? this.options.restrictTrust(record) : record;
  }

  async reconcileTrust(record: CurrentTrustProjection): Promise<void> {
    this.#source = record;
    record = activeTrust(this.#restricted(record));
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
    const peersChanged = await this.#ensureMemberTransportPeers(record);
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
    // 只有曾是成员的对端在这里：撤销即停窗口、断连接、删 pairwise secret 并移出常驻集合。
    for (const peerId of [...this.#peers.keys()]) {
      if (!active.has(peerId)) {
        this.#stopPeerTask(peerId, new Error("Mesh peer trust was revoked"));
        await this.connections.disconnect(peerId, new Error("Mesh peer trust was revoked"));
        await this.options.secretStore.delete({
          kind: "rendezvous",
          bindingId: peerId,
        });
        this.#peers.delete(peerId);
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
        const record = await this.options.trustProjection.loadCurrentTrust();
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
    await this.terminalConnections.close(reason);
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
      await this.#startDialer();
    }
  }

  /** 只为缺传输身份的 active 成员按设备精确补读；稳态下每次轮询零读取。 */
  async #ensureMemberTransportPeers(record: CurrentTrustProjection): Promise<boolean> {
    let changed = false;
    for (const member of record.members) {
      const deviceId = member.device.deviceId;
      if (member.state !== "active" || deviceId === this.options.localIdentity.deviceId || this.#peers.has(deviceId)) {
        continue;
      }
      const peer = await this.options.transportPeerDirectory.transportPeer(deviceId);
      if (!peer) continue;
      if (peer.identity.deviceId !== deviceId) {
        throw new Error(`Mesh transport identity changed for ${deviceId}`);
      }
      this.#peers.set(deviceId, peer);
      changed = true;
    }
    return changed;
  }

  async #startAnchor(): Promise<void> {
    const trustedPeers = await this.#authorizedPeers(["anchor", "executor", "surface"]);
    const routes = this.options.terminalRoutes;
    if (trustedPeers.length === 0 && !routes) return;
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
    const secret = routes ? await routes.secret() : undefined;
    if (secret !== undefined) {
      this.#trackPeerTask(TERMINAL_ROUTE_TASK, (signal) =>
        this.#maintainTerminalWindows(secret, relay, signal));
    }
    const discovery = await this.options.discovery?.();
    if (discovery) {
      for (const purpose of ["member", "terminal"] as const) {
        this.#trackPeerTask(`${DISCOVERY_TASK}:${purpose}`, (signal) =>
          this.#maintainDiscoveryWindows(purpose, discovery.secrets[purpose], discovery.ports, discovery.budget, relay, signal));
      }
    }
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
            const socket = await openRelaySocket(relay, keys[offset]!, "accept", signal);
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

  /**
   * 中继上固定数量的终态接入注册：只接经终态定位握手的连接，每条被消费或断开后由出站隧道重挂，
   * 退避沿用既有策略，槽位随隧道结束释放。
   */
  async #maintainTerminalWindows(
    secret: string,
    relay: { readonly host: string; readonly port: number },
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      const window = new AbortController();
      const abortWindow = () => window.abort(signal.reason);
      signal.addEventListener("abort", abortWindow, { once: true });
      const offsets = [0, 1].flatMap((offset) => Array.from({ length: TERMINAL_SLOTS_PER_WINDOW }, () => offset));
      const tunnels = offsets.map((offset) => new OutboundMeshTunnel({
        open: async (signal) => {
          try {
            const keys = currentAndPreviousTerminalRendezvousKeys(secret);
            const socket = await openRelaySocket(relay, keys[offset]!, "accept", signal);
            return await acceptAuthenticatedMeshSocket(this.#serverSecurity([]), socket);
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
        window.abort(new Error("Mesh terminal rendezvous window rotated"));
        await Promise.all(tunnels.map((task) => task.catch(() => undefined)));
        signal.removeEventListener("abort", abortWindow);
      }
    }
  }

  /**
   * 中继上固定数量的家级发现入口：交换由 serveHomeDiscovery 完成（客户端先验继任证明，再发后续内容），
   * 之后同一连接进入 TLS——成员用途按 active 成员认证、终态用途按定位解析，连接按原有入口登记。
   */
  async #maintainDiscoveryWindows(
    purpose: HomeDiscoveryPurpose,
    secret: string,
    ports: HomeDiscoveryServerPorts,
    budget: HomeDiscoveryBudget | undefined,
    relay: { readonly host: string; readonly port: number },
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      const window = new AbortController();
      const abortWindow = () => window.abort(signal.reason);
      signal.addEventListener("abort", abortWindow, { once: true });
      const offsets = [0, 1].flatMap((offset) => Array.from({ length: DISCOVERY_SLOTS_PER_WINDOW }, () => offset));
      const tunnels = offsets.map((offset) => new OutboundMeshTunnel({
        open: async (signal) => {
          try {
            const keys = currentAndPreviousDiscoveryRendezvousKeys(secret, purpose);
            for (;;) {
              const relaySocket = await openRelaySocket(relay, keys[offset]!, "accept", signal);
              const socket = await serveHomeDiscovery({ socket: relaySocket, purpose, secret, ports, ...(budget ? { budget } : {}), signal });
              // 超出本次会话预算的交换已截断结束：同一槽位继续服务客户端的下一次会话
              if (!socket) continue;
              const peers = purpose === "member" ? this.#knownAuthorizedPeers() : [];
              return await acceptAuthenticatedMeshSocket(this.#serverSecurity(peers), socket);
            }
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
        window.abort(new Error("Mesh discovery rendezvous window rotated"));
        await Promise.all(tunnels.map((task) => task.catch(() => undefined)));
        signal.removeEventListener("abort", abortWindow);
      }
    }
  }

  /** 成员发现入口的 TLS 只信任已有传输身份的 active 成员；缺身份的成员连不上，不影响其他成员。 */
  #knownAuthorizedPeers(): TrustedMeshPeer[] {
    return this.#trust.members
      .filter((member) => member.state === "active" && member.device.deviceId !== this.options.localIdentity.deviceId)
      .map((member) => this.#peers.get(member.device.deviceId))
      .filter((peer): peer is TrustedMeshPeer => peer !== undefined);
  }

  async #startDialer(): Promise<void> {
    if (this.options.memberDiscovery) {
      this.#startDiscoveringDialer();
      return;
    }
    // 执行端只拨当前 issuer：只要它的传输身份，缺其他值班候选的身份不挡启动
    const issuerId = this.#trust.issuer.deviceId;
    const issuer = this.#trust.members.find((member) =>
      member.device.deviceId === issuerId &&
      member.state === "active" &&
      member.roles.includes("anchor"));
    if (!issuer || issuerId === this.options.localIdentity.deviceId) {
      throw new Error("Mesh executor has no active issuer anchor peer");
    }
    const anchor = this.#peers.get(issuerId);
    if (!anchor) {
      throw new Error(`Authorized mesh peer ${issuerId} has no authenticated transport identity`);
    }
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

  /**
   * 有成员发现时的拨号：先按已知的现任身份与端点拨；缺身份、缺端点或全部不通时做成员发现。发现得到的连接
   * 先登记为成员连接，再在其上重协商逐对秘密，最后重载信任（现任已换时随之重拨）。
   */
  #startDiscoveringDialer(): void {
    let discovered = false;
    const tunnel = new OutboundMeshTunnel({
      open: async (signal) => {
        const issuerId = this.#trust.issuer.deviceId;
        const anchor = this.#peers.get(issuerId);
        const descriptor = this.options.endpoints.get(issuerId);
        if (anchor && descriptor && this.#isAuthorized(issuerId, ["anchor"])) {
          try {
            discovered = false;
            return await this.#openAnchor(anchor, descriptor, signal);
          } catch (error) {
            this.#report(error);
          }
        }
        try {
          const connection = await this.#discoverIssuer(signal);
          discovered = true;
          return connection;
        } catch (error) {
          this.#report(error);
          throw error;
        }
      },
      onConnection: async (connection) => {
        await this.#accept(connection);
        if (discovered) await this.#renegotiateWith(connection.peer.deviceId);
        const hook = this.options.memberDiscovery?.onIssuerConnected;
        if (hook) await hook(connection.peer.deviceId, this.connections.client(connection.peer.deviceId)).catch((error) => this.#report(error));
      },
    });
    this.#trackPeerTask(ISSUER_DIALER_TASK, (signal) => tunnel.run(signal));
  }

  async #discoverIssuer(signal: AbortSignal): Promise<SecureMeshConnection> {
    const discovery = this.options.memberDiscovery!;
    const secret = await discovery.secret();
    if (!secret) throw new Error("Mesh member has no home discovery material");
    const relays = new Map<string, { readonly host: string; readonly port: number }>();
    for (const descriptor of this.options.endpoints.list()) {
      for (const transport of descriptor.transports) {
        if (transport.kind === "blind-relay") relays.set(`${transport.relay.host}:${transport.relay.port}`, transport.relay);
      }
    }
    const failures: Error[] = [];
    for (const relay of relays.values()) {
      for (const key of currentAndPreviousDiscoveryRendezvousKeys(secret, "member")) {
        try {
          // 后缀超出单次会话预算时连续开会话：每次耐久已验证的前缀，下一次从进度接着，直到拿到完整证明
          for (let reached = -1; ;) {
            const local = await discovery.localChain();
            if (!local) throw new Error("Mesh member has no local trust chain");
            const resume = await discovery.resume?.();
            const socket = await openRelaySocket(relay, key, "connect", signal);
            const session = await openHomeDiscovery({ socket, purpose: "member", secret, local, ...(resume ? { resume } : {}), signal });
            const verified = session.verified;
            if (!verified.complete) {
              if (verified.projection.chainHead.seq <= reached) throw new Error("Home discovery made no progress");
              reached = verified.projection.chainHead.seq;
              await discovery.adopt(verified);
              continue;
            }
            return await this.#connectDiscovered(session, verified, signal);
          }
        } catch (error) {
          failures.push(asError(error));
        }
      }
    }
    throw new AggregateError(failures, "The current duty device could not be discovered");
  }

  async #connectDiscovered(
    session: HomeDiscoveryClientSession,
    verified: VerifiedHomeDiscovery,
    signal: AbortSignal,
  ): Promise<SecureMeshConnection> {
    const discovery = this.options.memberDiscovery!;
    try {
      const { issuer, endpoint } = verified;
      await discovery.adopt(verified);
      this.#peers.set(issuer.identity.deviceId, issuer);
      if (endpoint) this.options.endpoints.accept(endpoint);
      const upgraded = await session.upgrade();
      return await connectAuthenticatedMesh({
        socket: upgraded,
        trustedPeer: issuer,
        identity: this.options.localIdentity,
        protocolRange: PROTOCOL_RANGE,
        authorizePeer: (identity) => identity.deviceId === issuer.identity.deviceId,
        signal,
      });
    } catch (error) {
      session.close();
      throw error;
    }
  }

  /** 在刚建立的认证连接上提交新的逐对秘密：现任写入并读回后答复，本机再写入并读回；随后重载信任。 */
  async #renegotiateWith(peerDeviceId: string): Promise<void> {
    const secret = randomBytes(32).toString("base64url");
    await this.connections.client(peerDeviceId).request(
      MESH_PAIRWISE_RENEGOTIATE_SERVICE_ID,
      Buffer.from(canonicalize({ v: 1, secret }), "utf8"),
      this.#abort.signal,
    );
    await persistPairwiseRendezvousSecret(this.options.secretStore, peerDeviceId, secret);
    const record = await this.options.trustProjection.loadCurrentTrust();
    if (record) await this.reconcileTrust(record);
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
            const socket = await openRelaySocket(transport.relay, key, "connect", signal);
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
    // 入口用途由握手绑定到连接：终态入口只挂终态注册表，不看对端是否仍是成员。
    if (connection.route) {
      if (connection.route.kind !== "terminal" || !this.options.terminalRoutes) {
        await connection.close(new Error("Mesh route is not served here"));
        return;
      }
      this.terminalConnections.attach(connection, this.options.terminalRoutes.services, { diagnosable: false });
      return;
    }
    const active = this.#isAuthorized(connection.peer.deviceId, this.#compatiblePeerRoles());
    if (!active) {
      await connection.close(new Error("Mesh peer is no longer authorized"));
      return;
    }
    this.connections.attach(connection, this.options.services, { diagnosable: true });
    if (this.options.localEndpoint) {
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
    await this.options.onConnection?.(connection);
  }

  async #authorizedPeers(roles: readonly DeviceRole[]): Promise<TrustedMeshPeer[]> {
    const active = this.#trust.members
      .filter((member) =>
        member.state === "active" &&
        member.device.deviceId !== this.options.localIdentity.deviceId &&
        roles.some((role) => member.roles.includes(role)))
      .map((member) => member.device.deviceId);
    // 成员入口与常驻注册只为当前 active 成员；已不是成员的设备只走终态入口。
    return [...new Set(active)].sort().map((deviceId) => {
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

  #serverSecurity(trustedPeers: readonly TrustedMeshPeer[]) {
    const routes = this.options.terminalRoutes;
    return {
      identity: this.options.localIdentity,
      protocolRange: PROTOCOL_RANGE,
      trustedPeers,
      replayWindow: this.#replayWindow,
      ...(routes
        ? { routes: { resolve: routes.resolve, maxConcurrent: MAX_CONCURRENT_TERMINAL_ROUTES } }
        : {}),
      // 终态定位连接的身份与资格已由解析端口在握手前后两次精确核过；成员入口只认当前 active 成员。
      authorizePeer: (identity: { deviceId: string }, _signal: AbortSignal, route?: MeshConnectionRoute) =>
        route
          ? route.kind === "terminal" && routes !== undefined
          : this.#isAuthorized(identity.deviceId, this.#compatiblePeerRoles()),
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

/** 连上盲中继并发出会合 hello；之后的字节通道交给端到端握手。 */
export async function openRelaySocket(
  endpoint: { readonly host: string; readonly port: number },
  key: `rzv:${string}`,
  role: "accept" | "connect",
  signal: AbortSignal,
): Promise<Socket> {
  if (signal.aborted) throw asError(signal.reason);
  // signal 绑住套接字的整个生命周期：各调用方的 abort 都意味着拆掉这条连接（等握手中的入口、已建立的会话）
  const socket = connectNet({
    host: endpoint.host,
    port: endpoint.port,
    signal,
  });
  try {
    await once(socket, "connect");
    await writeSocket(
      socket,
      encodeBlindRendezvousHello({ v: 1, key, role, ttlMs: RELAY_HELLO_TTL_MS }),
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
