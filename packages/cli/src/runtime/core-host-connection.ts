/**
 * CoreHostConnection —— cli 到核心宿主的 RPC 连接生命周期管理。
 *
 * 只负责「确保有一个可用的已认证 RpcClient」，不懂 schedule 语义：
 * - 懒连接：首次需要时才发现 / 拉起宿主并连上。
 * - 并发去重：多个调用同时要连接时共享同一次建立过程。
 * - 断线重建：宿主 idle 退出后 client 关闭，下次 getClient 重新建立。
 * - 重订阅：重建连接后把持久订阅的 notification handler 重新挂上。
 *
 * 发现不到宿主时按需拉起一个「调度 profile」最小宿主（复用 spawnDaemon，传静默 console
 * 让它不向终端倾倒原始日志——失败由本层封装成友好错误）。
 */

import {
  discoverServer,
  createRpcClient,
  ServerNotRunningError,
  type RpcClient,
  type ServerEndpoint,
} from "@zhixing/server";
import { spawnDaemon } from "../serve/daemon.js";

/** ensure 拉起 / 连接核心宿主失败——cli 捕获后给友好提示，不向用户倒原始日志。 */
export class CoreHostUnavailableError extends Error {
  constructor(reason: string) {
    super(`定时功能当前不可用：${reason}`);
    this.name = "CoreHostUnavailableError";
  }
}

type NotificationHandler = (params: unknown) => void;

export interface CoreHostConnectionDeps {
  /** 发现已在跑的宿主。 */
  discover: () => Promise<ServerEndpoint>;
  /** 拉起一个调度 profile 宿主，返回是否成功。 */
  spawn: () => Promise<{ ok: boolean; reason?: string }>;
  /** 建立 RpcClient。 */
  createClient: (url: string) => RpcClient;
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
        forwardedArgs: ["serve", "--profile", "schedule"],
        deps: { console: silent },
      });
      return { ok: result.ok, reason: result.reason };
    },
    createClient: (url) => createRpcClient({ url }),
  };
}

export class CoreHostConnection {
  private client: RpcClient | null = null;
  private connecting: Promise<RpcClient> | null = null;
  private disposed = false;
  /** 跨重连持久的 notification 订阅：method → handlers。 */
  private readonly subscriptions = new Map<string, Set<NotificationHandler>>();

  constructor(private readonly deps: CoreHostConnectionDeps) {}

  /** 返回可用的已认证 client；无则发现 / 拉起并连上。并发调用共享同一次建立。 */
  async getClient(): Promise<RpcClient> {
    if (this.disposed) throw new Error("CoreHostConnection 已释放");
    if (this.client && !this.client.closed) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.establish();
    try {
      const client = await this.connecting;
      // dispose 可能在 establish 在途期间发生：此刻关掉刚建立的连接、不赋给 this.client，
      // 由 dispose 的在途收尾兜底（幂等 close 安全），避免连接泄漏 + 守活宿主。
      if (this.disposed) {
        await client.close().catch(() => {});
        throw new Error("CoreHostConnection 在连接建立期间被释放");
      }
      this.client = client;
      return client;
    } finally {
      this.connecting = null;
    }
  }

  private async establish(): Promise<RpcClient> {
    const endpoint = await this.discoverOrSpawn();
    const client = this.deps.createClient(endpoint.url);
    await client.connect();
    await client.authenticate(endpoint.token);
    // 重连后恢复所有持久订阅到新 client（旧 client 已关、其 listener 自然失效）
    for (const [method, handlers] of this.subscriptions) {
      for (const handler of handlers) client.onNotification(method, handler);
    }
    return client;
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
          throw new CoreHostUnavailableError(spawned.reason ?? "无法拉起调度宿主");
        }
      }
      try {
        return await this.deps.discover();
      } catch {
        throw new CoreHostUnavailableError("调度宿主已拉起但发现失败");
      }
    }
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
    // 已有活连接则立即挂上
    if (this.client && !this.client.closed) {
      this.client.onNotification(method, handler);
    }
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.subscriptions.delete(method);
      // 当前 client 上的该 listener 留到连接关闭自然失效——取消订阅多发生在退出，
      // 此时连接随即关闭，无需逐个摘除当前 listener。
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.subscriptions.clear();
    // 抓住在途 establish —— dispose 跑在 establish 在途时，this.client 仍为 null，
    // 只清现有 client 关不掉正在建立的连接；须等它 settle 再关（getClient 的
    // disposed 检查已拒绝把它赋给 this.client，此处负责关闭，避免 ws 泄漏 + 守活宿主）。
    const inflight = this.connecting;
    if (this.client) {
      const client = this.client;
      this.client = null;
      await client.close();
    }
    if (inflight) {
      await inflight.then((c) => c.close()).catch(() => {});
    }
  }
}
