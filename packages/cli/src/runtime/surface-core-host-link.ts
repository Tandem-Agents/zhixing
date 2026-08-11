import { randomUUID } from "node:crypto";
import { getZhixingHome } from "@zhixing/core";
import type { HomeTrustRecord } from "@zhixing/core/contracts";
import { canonicalize } from "@zhixing/core/protocol";
import { validateMeshRoleBootConfig } from "@zhixing/mesh/bootstrap";
import { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import { loadConfig } from "@zhixing/providers";
import { createPlatformSecretStore } from "@zhixing/secrets";
import {
  PROTOCOL_VERSION,
  RpcAppError,
  type AuthResult,
  type RpcClient,
} from "@zhixing/server";
import { ZHIXING_CLI_VERSION } from "../version.js";
import {
  FirstPartyConversationMeshClient,
  isCurrentAnchorRelayMethod,
  type FirstPartyIngressConnection,
} from "../serve/first-party-conversation-mesh.js";
import { FileMeshBootstrapStore } from "../serve/mesh-bootstrap-store.js";
import { ProductionMeshControlPlane } from "../serve/mesh-control-plane.js";
import { loadExistingDeviceKey } from "../serve/mesh-device-key.js";
import { CoreHostUnavailableError } from "./core-host-connection.js";

type NotificationHandler = (params: unknown) => void;
type WildcardNotificationHandler = (method: string, params: unknown) => void;
let nextSurfaceConnectionId = 1;

export async function createCurrentAnchorSurfaceRpcClient(): Promise<CurrentAnchorSurfaceRpcClient> {
  const homeDir = getZhixingHome();
  const configuration = loadConfig({ homeDir }).mesh;
  if (!configuration) throw new CoreHostUnavailableError("这台设备尚未完成家庭配置");
  const secretStore = createPlatformSecretStore({ homeDir, context: "foreground" });
  if (await secretStore.unlockState() !== "unlocked") {
    throw new CoreHostUnavailableError("请先解锁本机凭据");
  }
  const deviceKey = await loadExistingDeviceKey(secretStore);
  if (!deviceKey) throw new CoreHostUnavailableError("这台设备尚未完成配对");
  const bootstrapStore = new FileMeshBootstrapStore(homeDir, deviceKey);
  const trust = await bootstrapStore.loadTrustRecord();
  if (!trust) {
    bootstrapStore.stopStorageMaintenance();
    throw new CoreHostUnavailableError("这台设备尚未完成配对");
  }
  const local = trust.members.find((member) => member.device.deviceId === deviceKey.deviceId);
  if (!local || local.state !== "active") {
    bootstrapStore.stopStorageMaintenance();
    throw new CoreHostUnavailableError("这台设备已不在当前家庭中");
  }
  try {
    const services = new MeshServiceRegistry();
    let client: CurrentAnchorSurfaceRpcClient | undefined;
    const control = new ProductionMeshControlPlane({
      localIdentity: deviceKey,
      trust,
      configuration: validateMeshRoleBootConfig(configuration),
      endpoints: await bootstrapStore.loadEndpoints(),
      transportPeers: await bootstrapStore.loadTransportPeers(),
      secretStore,
      bootstrapStore,
      services,
      onTrustReconciled: (record) => client?.reconcileOwner(record),
    });
    client = new CurrentAnchorSurfaceRpcClient(deviceKey.deviceId, control, bootstrapStore);
    return client;
  } catch (error) {
    bootstrapStore.stopStorageMaintenance();
    throw error;
  }
}

export class CurrentAnchorSurfaceRpcClient implements RpcClient {
  readonly #methodHandlers = new Map<string, Set<NotificationHandler>>();
  readonly #wildcardHandlers = new Set<WildcardNotificationHandler>();
  readonly #closeHandlers = new Set<() => void>();
  readonly #connection: FirstPartyIngressConnection;
  #remote: FirstPartyConversationMeshClient | undefined;
  #ownerDeviceId: string | undefined;
  #ownerIdentity: string | undefined;
  #started = false;
  #closed = false;

  constructor(
    private readonly sourceDeviceId: string,
    private readonly control: Pick<
      ProductionMeshControlPlane,
      "start" | "stop" | "currentTrust" | "connections"
    >,
    private readonly bootstrapStore: Pick<FileMeshBootstrapStore, "stopStorageMaintenance">,
  ) {
    const connectionId = nextSurfaceConnectionId++;
    const owner = this;
    this.#connection = {
      id: connectionId,
      get closed() { return owner.#closed; },
      authenticated: true,
      loopback: true,
      clientInfo: { id: "zhixing-cli-surface", version: ZHIXING_CLI_VERSION },
      surfacePrincipal: `rpc:${randomUUID()}`,
      surfaceGeneration: 1,
      notify: (method, params) => this.#notify(method, params),
      onClose: (handler) => {
        this.#closeHandlers.add(handler);
        return () => this.#closeHandlers.delete(handler);
      },
    };
  }

  get closed(): boolean { return this.#closed; }

  async connect(): Promise<void> {
    if (this.#closed) throw new CoreHostUnavailableError("远端接入面已经关闭");
    if (this.#started) return;
    await this.control.start();
    this.#started = true;
  }

  async authenticate(): Promise<AuthResult> {
    return {
      protocol: PROTOCOL_VERSION,
      protocolRange: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
      capabilities: ["first-party-current-anchor"],
      server: { version: ZHIXING_CLI_VERSION },
    };
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.#closed) throw new CoreHostUnavailableError("远端接入面已经关闭");
    if (!isCurrentAnchorRelayMethod(method)) {
      throw new TypeError("设备本地或未知方法不能通过 current anchor 接入面代理");
    }
    const trust = this.control.currentTrust();
    const owner = trust.issuer.deviceId;
    if (owner === this.sourceDeviceId) {
      throw new CoreHostUnavailableError("当前设备没有可用的本机核心宿主");
    }
    await this.#selectOwner(owner, canonicalize(trust));
    try {
      return await this.#remote!.dispatch(method, params, this.#connection) as T;
    } catch (error) {
      if (error instanceof RpcAppError) throw error;
      throw new CoreHostUnavailableError("值班设备暂时离线，请稍后重试");
    }
  }

  onNotification<T = unknown>(method: string, handler: (params: T) => void): () => void {
    let handlers = this.#methodHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.#methodHandlers.set(method, handlers);
    }
    handlers.add(handler as NotificationHandler);
    return () => {
      handlers!.delete(handler as NotificationHandler);
      if (handlers!.size === 0) this.#methodHandlers.delete(method);
    };
  }

  onAnyNotification(handler: WildcardNotificationHandler): () => void {
    this.#wildcardHandlers.add(handler);
    return () => this.#wildcardHandlers.delete(handler);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const handler of [...this.#closeHandlers]) handler();
    this.#closeHandlers.clear();
    if (this.#remote) await this.#remote.close(this.#connection);
    this.#remote = undefined;
    this.#ownerDeviceId = undefined;
    this.#ownerIdentity = undefined;
    try {
      await this.control.stop();
    } finally {
      this.bootstrapStore.stopStorageMaintenance();
    }
    this.#methodHandlers.clear();
    this.#wildcardHandlers.clear();
  }

  async reconcileOwner(record: HomeTrustRecord): Promise<void> {
    const identity = canonicalize(record);
    if (
      record.issuer.deviceId === this.#ownerDeviceId &&
      identity === this.#ownerIdentity
    ) return;
    if (this.#remote) await this.#remote.close(this.#connection);
    this.#remote = undefined;
    this.#ownerDeviceId = undefined;
    this.#ownerIdentity = undefined;
  }

  async #selectOwner(ownerDeviceId: string, ownerIdentity: string): Promise<void> {
    if (
      ownerDeviceId === this.#ownerDeviceId &&
      ownerIdentity === this.#ownerIdentity &&
      this.#remote
    ) return;
    if (this.#remote) await this.#remote.close(this.#connection);
    this.#ownerDeviceId = ownerDeviceId;
    this.#ownerIdentity = ownerIdentity;
    this.#remote = new FirstPartyConversationMeshClient(
      this.control.connections.client(ownerDeviceId),
      this.sourceDeviceId,
    );
  }

  #notify(method: string, params: unknown): void {
    for (const handler of this.#methodHandlers.get(method) ?? []) handler(params);
    for (const handler of this.#wildcardHandlers) handler(method, params);
  }
}
