/**
 * CoreHostConnection —— cli 到核心宿主的 RPC 连接生命周期管理。
 *
 * cli 进程级唯一连接:连接即接入面身份单位(observer 登记 / 确认定向推送 /
 * 换代判定全挂 connection),调度 / 会话 / 确认域经各自 facade 共用这一条
 * 已认证连接——双连接会把一个 cli 数成两个接入面。
 *
 * 只负责「确保有一个可用的已认证 RpcClient」，不懂任何方法域语义：
 * - 懒连接：首次需要时才发现 / 拉起宿主并连上。
 * - 并发去重：多个调用同时要连接时共享同一次建立过程。
 * - 断线重建：宿主 idle 退出后 client 关闭，下次 getClient 重新建立。
 * - 持久订阅：client 上每个 method 只挂一个查表转发器,用户 handler 只存在
 *   于订阅表一层——退订即删表、对活连接立即生效;重连只重挂转发器,
 *   无 handler 级的双层状态同步(生效面与声明面是同一张表)。
 *
 * 发现不到宿主时按需拉起核心宿主（复用 spawnDaemon，传静默 console
 * 让它不向终端倾倒原始日志——失败由本层封装成友好错误）。
 */

import {
  discoverServer,
  createRpcClient,
  isProtocolVersionCompatible,
  PROTOCOL_VERSION,
  ServerNotRunningError,
  SUPPORTED_PROTOCOL_RANGE,
  type AuthResult,
  type RpcClient,
  type ServerEndpoint,
} from "@zhixing/server";
import { spawnDaemon } from "../serve/daemon.js";
import { runStopCommand } from "../serve/stop.js";
import { ZHIXING_CLI_VERSION } from "../version.js";

const DEFAULT_VERSION_RECHECK_INTERVAL_MS = 15_000;

/** ensure 拉起 / 连接核心宿主失败——cli 捕获后给友好提示，不向用户倒原始日志。 */
export class CoreHostUnavailableError extends Error {
  constructor(reason: string) {
    super(`核心宿主当前不可用：${reason}`);
    this.name = "CoreHostUnavailableError";
  }
}

type NotificationHandler = (params: unknown) => void;
type LifecycleHandler = (notice: CoreHostLifecycleNotice) => void | Promise<void>;

export type CoreHostLifecycleNotice =
  | { kind: "reconnected"; reason: "connection-closed" | "manual-reconnect" }
  | {
      kind: "host-replaced";
      reason: "unresponsive" | "version-mismatch";
      oldVersion?: string;
      newVersion?: string;
    }
  | {
      kind: "version-pending";
      clientVersion: string;
      serverVersion: string;
      connectionCount?: number;
    };

export type CoreHostConnectionStatus =
  | { kind: "disconnected" }
  | {
      kind: "connected";
      protocol: number;
      serverVersion: string;
      clientVersion: string;
      capabilities: readonly string[];
      versionState: "current" | "pending-update";
      connectionCount?: number;
    };

interface ServerInfoWire {
  connectionCount?: unknown;
}

interface EstablishedClient {
  client: RpcClient;
  endpoint: ServerEndpoint;
  auth: AuthResult;
  versionState: "current" | "pending-update";
  connectionCount?: number;
  lifecycleNotices?: readonly CoreHostLifecycleNotice[];
}

/**
 * 连接的窄面 —— 各域设施(RpcSchedulerFacade / RpcConversationFacade /
 * RpcEventBus 等)依赖此接口而非具体类:设施只需要「请求 + 持久订阅」,
 * 连接的建立 / 重连 / 释放归进程级持有者,测试也无需绕完整连接装配。
 */
export interface CoreHostLink {
  /** 返回可用的已认证 client;无则发现 / 拉起并连上。 */
  getClient(): Promise<RpcClient>;
  /** 持久订阅一个 notification(跨重连有效、被动——不为订阅拉起宿主)。 */
  onNotification(method: string, handler: NotificationHandler): () => void;
}

export interface CoreHostConnectionDeps {
  /** 发现已在跑的宿主。 */
  discover: () => Promise<ServerEndpoint>;
  /** 拉起核心宿主，返回是否成功。 */
  spawn: () => Promise<{ ok: boolean; reason?: string }>;
  /** 停止 PID 存活但连接不可用的宿主。默认复用 serve stop 的优雅/强制清理链。 */
  stopUnresponsiveHost?: (
    endpoint: ServerEndpoint,
    cause: unknown,
  ) => Promise<{ ok: boolean; reason?: string }>;
  /** 建立 RpcClient。 */
  createClient: (url: string) => RpcClient;
  /** 当前接入面 build 版本，供 auth 握手与宿主换代判定。 */
  clientVersion?: string;
  /** build 版本待更新时的后台再评估间隔。 */
  versionRecheckIntervalMs?: number;
  /** 测试 / UI 注入：连接生命周期提示。 */
  onLifecycleNotice?: LifecycleHandler;
  /** 测试注入：时间源。 */
  clock?: () => number;
  /** 测试注入：等待。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 默认依赖：发现走 discoverServer、拉起走静默 spawnDaemon、client 走 createRpcClient。 */
export function defaultCoreHostConnectionDeps(): CoreHostConnectionDeps {
  return {
    discover: () => discoverServer(),
    spawn: async () => {
      // 静默 console：spawnDaemon 默认会打印成功横幅 / 失败日志尾部，但 ensure 是后台
      // 按需拉起、不是用户显式 serve，结果应由本层统一封装成友好错误。
      const silent = { log: () => {}, error: () => {} };
      const result = await spawnDaemon({
        // 不传 --port：child 走按 home 派生的端口（同 home 同端口 → listen 原子仲裁单例、
        // 并发拉起只活一个；不同 home 不同端口、不撞）。实际端口写 PID 文件供 discover。
        // 自动拉起与显式 serve 是同一个宿主——装什么由配置说了算（渠道 / MCP
        // 按配置自适应装配），不由拉起方式决定。
        forwardedArgs: ["serve"],
        deps: { console: silent },
      });
      return { ok: result.ok, reason: result.reason };
    },
    stopUnresponsiveHost: async (endpoint) => {
      const silent = { log: () => {}, warn: () => {}, error: () => {} };
      const result = await runStopCommand({
        verbose: false,
        timeoutMs: 10_000,
        expectedLock: endpoint.pid,
        deps: { console: silent },
      });
      if (result.status === "error") {
        return { ok: false, reason: result.reason };
      }
      return { ok: true };
    },
    createClient: (url) => createRpcClient({ url }),
    clientVersion: ZHIXING_CLI_VERSION,
  };
}

export class CoreHostConnection implements CoreHostLink {
  private client: RpcClient | null = null;
  private endpoint: ServerEndpoint | null = null;
  private connecting: Promise<RpcClient> | null = null;
  private reconnecting: Promise<void> | null = null;
  private lifecycleEpoch = 0;
  private disposed = false;
  private status: CoreHostConnectionStatus = { kind: "disconnected" };
  /**
   * 跨重连持久的 notification 订阅：method → handlers。
   * 这张表就是分发的生效面——client 上的转发器实时查它,退订删表即停止触达。
   */
  private readonly subscriptions = new Map<string, Set<NotificationHandler>>();
  private readonly lifecycleHandlers = new Set<LifecycleHandler>();
  /** 当前活 client 上已挂转发器的 method 集合（随连接重建重置）。 */
  private forwardedMethods = new Set<string>();
  private versionRecheckTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: CoreHostConnectionDeps) {
    if (deps.onLifecycleNotice) {
      this.lifecycleHandlers.add(deps.onLifecycleNotice);
    }
  }

  /** 主动确保核心宿主在场并已连上(不在则拉起)——启动轻检查防饿死等场景用。 */
  async ensure(): Promise<void> {
    await this.getClient();
  }

  getStatus(): CoreHostConnectionStatus {
    return this.status;
  }

  onLifecycleNotice(handler: LifecycleHandler): () => void {
    this.lifecycleHandlers.add(handler);
    return () => {
      this.lifecycleHandlers.delete(handler);
    };
  }

  /**
   * 主动换代当前宿主连接,保留持久订阅。
   *
   * 用于配置热重载 / 协议换代这类"旧宿主已被要求退出,必须连到新 owner"
   * 的场景。它不是 dispose:订阅表仍是接入面的声明面,新连接建立后自动重挂。
   */
  async reconnect(opts: { timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<void> {
    if (this.disposed) throw new Error("CoreHostConnection 已释放");
    if (this.reconnecting) {
      await this.reconnecting;
      return;
    }
    const task = this.performReconnect(opts);
    this.reconnecting = task;
    try {
      await task;
    } finally {
      if (this.reconnecting === task) this.reconnecting = null;
    }
  }

  /** 返回可用的已认证 client；无则发现 / 拉起并连上。并发调用共享同一次建立。 */
  async getClient(): Promise<RpcClient> {
    if (this.reconnecting) await this.reconnecting;
    return this.getClientNow();
  }

  private async getClientNow(): Promise<RpcClient> {
    if (this.disposed) throw new Error("CoreHostConnection 已释放");
    if (this.client && !this.client.closed) return this.client;
    const reconnectReason =
      this.client?.closed === true ? "connection-closed" : undefined;
    if (reconnectReason) {
      this.client = null;
      this.endpoint = null;
      this.forwardedMethods = new Set();
      this.status = { kind: "disconnected" };
      this.clearPendingVersionRecheck();
    }
    if (this.connecting) return this.connecting;
    const epoch = this.lifecycleEpoch;
    const task = this.establishCurrent(epoch, reconnectReason);
    this.connecting = task;
    try {
      return await task;
    } finally {
      if (this.connecting === task) this.connecting = null;
    }
  }

  private async establishCurrent(
    epoch: number,
    reconnectReason?: "connection-closed",
  ): Promise<RpcClient> {
    const established = await this.establish();
    return this.activateEstablished(established, epoch, reconnectReason);
  }

  private async activateEstablished(
    established: EstablishedClient,
    epoch: number,
    reconnectReason?: "connection-closed",
  ): Promise<RpcClient> {
    const client = established.client;
    // dispose 可能在 establish 在途期间发生：此刻关掉刚建立的连接、不赋给 this.client，
    // 由 dispose 的在途收尾兜底（幂等 close 安全），避免连接泄漏 + 守活宿主。
    if (this.disposed) {
      await client.close().catch(() => {});
      throw new Error("CoreHostConnection 在连接建立期间被释放");
    }
    if (epoch !== this.lifecycleEpoch) {
      await client.close().catch(() => {});
      throw new Error("CoreHostConnection 在连接建立期间被换代");
    }
    this.client = client;
    this.endpoint = established.endpoint;
    this.forwardedMethods = new Set();
    this.status = {
      kind: "connected",
      protocol: established.auth.protocol,
      serverVersion: established.auth.server.version,
      clientVersion: this.clientVersion(),
      capabilities: established.auth.capabilities,
      versionState: established.versionState,
      ...(established.connectionCount !== undefined
        ? { connectionCount: established.connectionCount }
        : {}),
    };
    // 对账:establish 的挂载循环之后、本赋值之前的 microtask 窗口里新增的
    // 订阅(onNotification 彼时见不到活连接)在此补挂——attachForwarder 幂等,
    // 全量循环即对账,「订阅表 = 生效面」在所有时序下成立。
    for (const method of this.subscriptions.keys()) {
      this.attachForwarder(client, method);
    }
    for (const notice of established.lifecycleNotices ?? []) {
      await this.emitNotice(notice);
    }
    if (reconnectReason) {
      await this.emitNotice({ kind: "reconnected", reason: reconnectReason });
    }
    if (this.status.kind === "connected" && this.status.versionState === "pending-update") {
      this.schedulePendingVersionRecheck();
    } else {
      this.clearPendingVersionRecheck();
    }
    return client;
  }

  private async establish(): Promise<EstablishedClient> {
    const endpoint = await this.discoverOrSpawn();
    const established = await this.connectEndpoint(endpoint, {
      replaceUnresponsive: true,
      replaceVersionMismatch: true,
    });
    this.forwardedMethods = new Set();
    return established;
  }

  private async connectEndpoint(
    endpoint: ServerEndpoint,
    opts: {
      replaceUnresponsive: boolean;
      replaceVersionMismatch: boolean;
    },
  ): Promise<EstablishedClient> {
    const client = this.deps.createClient(endpoint.url);
    try {
      await client.connect();
    } catch (err) {
      await client.close().catch(() => {});
      if (opts.replaceUnresponsive && this.deps.stopUnresponsiveHost) {
        return this.replaceUnresponsiveHost(endpoint, err);
      }
      throw err;
    }

    try {
      const auth = await client.authenticate(endpoint.token, {
        id: "zhixing-cli",
        version: this.clientVersion(),
      });
      this.assertProtocolCompatible(auth);
      return await this.handleVersionMismatch(client, endpoint, auth, opts);
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
  }

  private async replaceUnresponsiveHost(
    staleEndpoint: ServerEndpoint,
    cause: unknown,
  ): Promise<EstablishedClient> {
    const stopped = await this.deps.stopUnresponsiveHost!(staleEndpoint, cause);
    if (!stopped.ok) {
      throw new CoreHostUnavailableError(
        `旧核心宿主连接失败，且清理失败：${stopped.reason ?? "未知原因"}`,
      );
    }

    const replacement = await this.discoverReplacementEndpoint(staleEndpoint);
    if (replacement) {
      const established = await this.connectEndpoint(replacement, {
        replaceUnresponsive: false,
        replaceVersionMismatch: true,
      });
      return withLifecycleNotice(established, {
        kind: "host-replaced",
        reason: "unresponsive",
      });
    }

    const spawned = await this.deps.spawn();
    if (!spawned.ok) {
      const concurrentReplacement =
        await this.discoverReplacementEndpoint(staleEndpoint);
      if (concurrentReplacement) {
        const established = await this.connectEndpoint(concurrentReplacement, {
          replaceUnresponsive: false,
          replaceVersionMismatch: true,
        });
        return withLifecycleNotice(established, {
          kind: "host-replaced",
          reason: "unresponsive",
        });
      }
      throw new CoreHostUnavailableError(
        `旧核心宿主已清理，但新宿主拉起失败：${spawned.reason ?? "未知原因"}`,
      );
    }

    try {
      const endpoint = await this.deps.discover();
      const established = await this.connectEndpoint(endpoint, {
        replaceUnresponsive: false,
        replaceVersionMismatch: true,
      });
      return withLifecycleNotice(established, {
        kind: "host-replaced",
        reason: "unresponsive",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CoreHostUnavailableError(
        `核心宿主已重拉但仍不可连接：${reason}`,
      );
    }
  }

  private async handleVersionMismatch(
    client: RpcClient,
    endpoint: ServerEndpoint,
    auth: AuthResult,
    opts: { replaceVersionMismatch: boolean },
  ): Promise<EstablishedClient> {
    const clientVersion = this.clientVersion();
    const serverVersion = auth.server.version;
    if (serverVersion === clientVersion) {
      return { client, endpoint, auth, versionState: "current" };
    }

    const info = await this.readServerInfo(client).catch(() => ({ connectionCount: null }));
    const connectionCount = info.connectionCount;
    if (
      !opts.replaceVersionMismatch ||
      connectionCount === null ||
      connectionCount > 1
    ) {
      return withLifecycleNotice(
        {
          client,
          endpoint,
          auth,
          versionState: "pending-update",
          ...(connectionCount !== null ? { connectionCount } : {}),
        },
        {
          kind: "version-pending",
          clientVersion,
          serverVersion,
          ...(connectionCount !== null ? { connectionCount } : {}),
        },
      );
    }

    return this.replaceVersionMismatchedHost(client, endpoint, serverVersion);
  }

  private async replaceVersionMismatchedHost(
    client: RpcClient,
    endpoint: ServerEndpoint,
    oldVersion: string,
  ): Promise<EstablishedClient> {
    await client.request("server.shutdown", {
      reason: "client-version-change",
    });
    await client.close().catch(() => {});
    await this.waitForEndpointTurnover(endpoint, {});

    const spawned = await this.deps.spawn();
    if (!spawned.ok) {
      throw new CoreHostUnavailableError(
        `旧版本宿主已退出，但新宿主拉起失败：${spawned.reason ?? "未知原因"}`,
      );
    }

    const nextEndpoint = await this.deps.discover();
    const established = await this.connectEndpoint(nextEndpoint, {
      replaceUnresponsive: false,
      replaceVersionMismatch: false,
    });
    return withLifecycleNotice(established, {
      kind: "host-replaced",
      reason: "version-mismatch",
      oldVersion,
      newVersion: established.auth.server.version,
    });
  }

  private assertProtocolCompatible(auth: AuthResult): void {
    const serverRange = auth.protocolRange ?? {
      min: auth.protocol,
      max: auth.protocol,
    };
    const serverProtocolFitsClient =
      isProtocolVersionCompatible(auth.protocol);
    const clientProtocolFitsServer = isProtocolVersionCompatible(
      PROTOCOL_VERSION,
      serverRange,
    );
    if (serverProtocolFitsClient && clientProtocolFitsServer) return;
    throw new CoreHostUnavailableError(
      `RPC 协议不兼容：cli 支持 ${SUPPORTED_PROTOCOL_RANGE.min}-${SUPPORTED_PROTOCOL_RANGE.max}，宿主协议 ${auth.protocol}（支持 ${serverRange.min}-${serverRange.max}）`,
    );
  }

  private async readServerInfo(client: RpcClient): Promise<{
    connectionCount: number | null;
  }> {
    const raw = await client.request<ServerInfoWire>("server.info");
    return {
      connectionCount:
        typeof raw.connectionCount === "number" && raw.connectionCount > 0
          ? raw.connectionCount
          : null,
    };
  }

  private async discoverReplacementEndpoint(
    staleEndpoint: ServerEndpoint,
  ): Promise<ServerEndpoint | null> {
    try {
      const endpoint = await this.deps.discover();
      return isSameEndpoint(endpoint, staleEndpoint) ? null : endpoint;
    } catch (err) {
      if (err instanceof ServerNotRunningError) return null;
      throw err;
    }
  }

  private clientVersion(): string {
    return this.deps.clientVersion ?? ZHIXING_CLI_VERSION;
  }

  private async emitNotice(notice: CoreHostLifecycleNotice): Promise<void> {
    for (const handler of [...this.lifecycleHandlers]) {
      try {
        await handler(notice);
      } catch {
        // 生命周期通知是观察/接入面同步信号，订阅者失败不反向污染连接状态。
      }
    }
  }

  private schedulePendingVersionRecheck(): void {
    if (this.disposed || this.versionRecheckTimer) return;
    const intervalMs =
      this.deps.versionRecheckIntervalMs ?? DEFAULT_VERSION_RECHECK_INTERVAL_MS;
    const timer = setTimeout(() => {
      this.versionRecheckTimer = null;
      void this.replacePendingVersionWhenIdle().catch(() => {
        if (
          !this.disposed &&
          this.status.kind === "connected" &&
          this.status.versionState === "pending-update"
        ) {
          this.schedulePendingVersionRecheck();
        }
      });
    }, intervalMs);
    timer.unref?.();
    this.versionRecheckTimer = timer;
  }

  private clearPendingVersionRecheck(): void {
    if (!this.versionRecheckTimer) return;
    clearTimeout(this.versionRecheckTimer);
    this.versionRecheckTimer = null;
  }

  private async replacePendingVersionWhenIdle(): Promise<void> {
    if (this.disposed) return;
    if (this.reconnecting) {
      await this.reconnecting;
      return;
    }
    const task = this.performPendingVersionReplacement();
    this.reconnecting = task;
    try {
      await task;
    } finally {
      if (this.reconnecting === task) this.reconnecting = null;
    }
  }

  private async performPendingVersionReplacement(): Promise<void> {
    const status = this.status;
    const client = this.client;
    const endpoint = this.endpoint;
    if (
      this.disposed ||
      status.kind !== "connected" ||
      status.versionState !== "pending-update" ||
      !client ||
      client.closed ||
      !endpoint
    ) {
      return;
    }

    const info = await this.readServerInfo(client).catch(() => ({ connectionCount: null }));
    const connectionCount = info.connectionCount;
    if (connectionCount === null || connectionCount > 1) {
      if (
        connectionCount !== null &&
        this.status.kind === "connected" &&
        this.status.versionState === "pending-update"
      ) {
        this.status = { ...this.status, connectionCount };
      }
      this.schedulePendingVersionRecheck();
      return;
    }

    this.lifecycleEpoch += 1;
    const epoch = this.lifecycleEpoch;
    const established = await this.replaceVersionMismatchedHost(
      client,
      endpoint,
      status.serverVersion,
    );
    await this.activateEstablished(established, epoch);
  }

  /**
   * 在 client 上为 method 挂唯一的查表转发器——分发时实时读 subscriptions,
   * 用户 handler 永不直挂 client,退订删表即对活连接立即生效。
   * 转发器不随退订摘除：查空表 no-op,每 method 至多一个、无泄漏面,
   * 随连接关闭自然失效。
   */
  private attachForwarder(client: RpcClient, method: string): void {
    if (this.forwardedMethods.has(method)) return;
    this.forwardedMethods.add(method);
    client.onNotification(method, (params) => {
      const handlers = this.subscriptions.get(method);
      if (!handlers) return;
      // 快照分发——分发中退订不影响本帧可达性（与 EventBus 语义一致）
      for (const handler of [...handlers]) {
        // 订阅者级错误隔离——对齐底层 RpcClient 的 per-handler 语义(转发器
        // 合并多 handler 后,client 的 try/catch 只包到转发器整体,隔离粒度
        // 必须在此恢复为订阅者):单个订阅者抛错不阻断同 method 的其他订阅者,
        // 异步 handler 的拒绝同样兜接。传输层静默隔离,可观测性归订阅者
        // 自身(如 RpcEventBus 的 onListenerError)。
        try {
          const result = handler(params) as unknown;
          if (result instanceof Promise) result.catch(() => {});
        } catch {
          // 静默——与 RpcClient 的 listener 错误隔离语义一致
        }
      }
    });
  }

  private async discoverOrSpawn(): Promise<ServerEndpoint> {
    try {
      return await this.deps.discover();
    } catch (err) {
      if (!(err instanceof ServerNotRunningError)) throw err;
      const spawned = await this.deps.spawn();
      if (!spawned.ok) {
        // spawn 失败可能是并发拉起的败者（赢家宿主已起）——再发现一次再判失败
        try {
          return await this.deps.discover();
        } catch {
          throw new CoreHostUnavailableError(spawned.reason ?? "无法拉起核心宿主");
        }
      }
      try {
        return await this.deps.discover();
      } catch {
        throw new CoreHostUnavailableError("核心宿主已拉起但发现失败");
      }
    }
  }

  private async performReconnect(
    opts: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<void> {
    this.lifecycleEpoch += 1;
    const staleEndpoint = await this.closeCurrentClient();
    await this.waitForEndpointTurnover(staleEndpoint, opts);
    await this.getClientNow();
    await this.emitNotice({ kind: "reconnected", reason: "manual-reconnect" });
  }

  private async closeCurrentClient(): Promise<ServerEndpoint | null> {
    const inflight = this.connecting;
    const current = this.client;
    let staleEndpoint = this.endpoint;
    this.client = null;
    this.endpoint = null;
    this.forwardedMethods = new Set();
    this.status = { kind: "disconnected" };
    this.clearPendingVersionRecheck();
    if (current) {
      await current.close().catch(() => {});
    }
    if (inflight) {
      const client = await inflight.catch(() => null);
      staleEndpoint = staleEndpoint ?? this.endpoint;
      if (client) {
        if (this.client === client) {
          this.client = null;
          this.forwardedMethods = new Set();
        }
        await client.close().catch(() => {});
      }
      this.endpoint = null;
    }
    return staleEndpoint;
  }

  private async waitForEndpointTurnover(
    staleEndpoint: ServerEndpoint | null,
    opts: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<void> {
    if (!staleEndpoint) return;
    const timeoutMs = opts.timeoutMs ?? 35_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 100;
    const clock = this.deps.clock ?? Date.now;
    const sleep =
      this.deps.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = clock() + timeoutMs;

    while (clock() < deadline) {
      try {
        const endpoint = await this.deps.discover();
        if (!isSameEndpoint(endpoint, staleEndpoint)) return;
      } catch (err) {
        if (err instanceof ServerNotRunningError) return;
        throw err;
      }
      await sleep(pollIntervalMs);
    }
    throw new CoreHostUnavailableError("旧核心宿主停机超时，未完成连接换代");
  }

  /**
   * 持久订阅一个 notification（跨重连有效）。**被动**：不主动拉起宿主——只有当连接
   * 因其他操作建立 / 重建时才真正收到事件（无宿主则无事件，符合「无 daemon 无事件」）。
   */
  onNotification(method: string, handler: NotificationHandler): () => void {
    let handlers = this.subscriptions.get(method);
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(method, handlers);
    }
    handlers.add(handler);
    // 已有活连接则确保该 method 的转发器在场（幂等）
    if (this.client && !this.client.closed) {
      this.attachForwarder(this.client, method);
    }
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.subscriptions.delete(method);
      // 退订到此为止即已生效——转发器查表分发,表里没了就不再触达,
      // 活连接上无需(也不存在)handler 级的摘除动作。
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.subscriptions.clear();
    this.lifecycleHandlers.clear();
    this.clearPendingVersionRecheck();
    // 抓住在途 establish —— dispose 跑在 establish 在途时，this.client 仍为 null，
    // 只清现有 client 关不掉正在建立的连接；须等它 settle 再关（getClient 的
    // disposed 检查已拒绝把它赋给 this.client，此处负责关闭，避免 ws 泄漏 + 守活宿主）。
    const inflight = this.connecting;
    if (this.client) {
      const client = this.client;
      this.client = null;
      this.endpoint = null;
      this.status = { kind: "disconnected" };
      await client.close();
    }
    if (inflight) {
      await inflight.then((c) => c.close()).catch(() => {});
    }
  }
}

function isSameEndpoint(a: ServerEndpoint, b: ServerEndpoint): boolean {
  return (
    a.url === b.url &&
    a.pid.pid === b.pid.pid &&
    a.pid.port === b.pid.port &&
    a.pid.startTime === b.pid.startTime &&
    a.pid.startedAt === b.pid.startedAt
  );
}

function withLifecycleNotice(
  established: EstablishedClient,
  notice: CoreHostLifecycleNotice,
): EstablishedClient {
  return {
    ...established,
    lifecycleNotices: [...(established.lifecycleNotices ?? []), notice],
  };
}
