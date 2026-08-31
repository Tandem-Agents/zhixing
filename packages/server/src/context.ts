/**
 * ServerContext — 服务运行时共享上下文
 *
 * 持有网关所需共享状态：配置、auth token、启动时间与有限产品 API 等。
 * 通过显式传递（而不是单例）保持可测试性。
 */

import type {
  ChannelRegistry,
  HttpHandler,
  AuthorityDeliveryStats,
  DeliveryStatusNotice,
} from "@zhixing/core";
import type { ProductApiDispatcher } from "@zhixing/core/product-api";
import type {
  ConversationStatusNotice,
  ExecutionStatusNotice,
  FinalFrame,
  JobStatusNotice,
  PublishResultNotice,
  SchedulerUserNotice,
} from "@zhixing/core/contracts";
import type { ConfirmationHub, ConversationManager } from "@zhixing/owner-kernel";
import type { AdvancementRecoveryMaintenance } from "@zhixing/owner-services";
import type {
  SessionActivityBroadcast,
  SessionBroadcast,
} from "@zhixing/rpc/session-broadcast";
import type { ServerConfig } from "./types.js";
import type { ManagedHostPublicStatus } from "./managed-host-status.js";
import type { RpcSurfaceRegistry } from "./rpc/surface-identity.js";
import type { PerspectivesController } from "./perspectives/index.js";

export type ServerShutdownStrategy = "immediate" | "drain" | "cancel";

export interface LifecycleShutdownAdapter {
  prepare(input: {
    readonly requestId: string;
    readonly reason: string;
    readonly strategy: ServerShutdownStrategy;
    readonly timeoutMs: number;
  }): Promise<{
    readonly requestId: string;
    readonly phase: "ready-to-stop";
    readonly strategy: ServerShutdownStrategy;
  }>;
}


/**
 * 第一方权威 RPC 的窄覆盖点。非当前锚点宿主只转发冻结的有限方法集；
 * 方法仍须存在于 canonical RPC registry，认证与 wire 分发仍由 server 拥有。
 */
export interface FirstPartyConversationRpcRouter {
  dispatch(input: {
    readonly method: string;
    readonly params: unknown;
    readonly connection: {
      readonly id: number;
      readonly closed: boolean;
      readonly authenticated: boolean;
      readonly loopback: boolean;
      readonly clientInfo?: { readonly id?: string; readonly version?: string };
      readonly surfacePrincipal?: string;
      readonly surfaceGeneration?: number;
      notify(method: string, params: unknown): void;
      onClose(handler: () => void): () => void;
    };
    /** Executes this same registered method locally without re-entering the ingress router. */
    readonly dispatchCanonical: () => Promise<unknown>;
  }): Promise<
    | { readonly handled: false }
    | { readonly handled: true; readonly result: unknown }
  >;
}

/** Canonical server method surface reused by the authenticated mesh relay. */
export interface CanonicalFirstPartyConversationSurface {
  dispatch(input: {
    readonly method: string;
    readonly params: unknown;
    readonly connection: import("./rpc/connection.js").RpcConnection;
  }): Promise<unknown>;
}

export interface RuntimeControlAdapter {
  openFirstPartyFinality?: (input: {
    readonly lastSeen: readonly {
      readonly subject:
        | {
            readonly execution: "conversation";
            readonly conversationId: string;
            readonly runId: string;
          }
        | {
            readonly execution: "job";
            readonly taskId: string;
            readonly jobRunId: string;
          }
        | { readonly execution: "delivery"; readonly itemId: string };
      readonly afterStatusRevision: number;
    }[];
    readonly onStatus: (
      notice: ExecutionStatusNotice,
    ) => void | Promise<void>;
    readonly onResyncRequired?: (error: Error) => void;
  }) => Promise<{
    readonly next: readonly {
      readonly subject:
        | {
            readonly execution: "conversation";
            readonly conversationId: string;
            readonly runId: string;
          }
        | {
            readonly execution: "job";
            readonly taskId: string;
            readonly jobRunId: string;
          }
        | { readonly execution: "delivery"; readonly itemId: string };
      readonly afterStatusRevision: number;
    }[];
    close(): void;
  }>;
  deliveryStats?: () => AuthorityDeliveryStats;
  deliveryStatus?: (
    afterByItem: Readonly<Record<string, number>>,
  ) => Promise<readonly DeliveryStatusNotice[]>;
  conversationStatus?: (
    after: readonly {
      readonly conversationId: string;
      readonly runId: string;
      readonly afterStatusRevision: number;
    }[],
  ) => Promise<{
    readonly notices: readonly ConversationStatusNotice[];
    readonly next: readonly {
      readonly conversationId: string;
      readonly runId: string;
      readonly afterStatusRevision: number;
    }[];
  }>;
  jobStatus?: (
    after: readonly {
      readonly taskId: string;
      readonly jobRunId: string;
      readonly afterStatusRevision: number;
    }[],
  ) => Promise<{
    readonly notices: readonly JobStatusNotice[];
    readonly next: readonly {
      readonly taskId: string;
      readonly jobRunId: string;
      readonly afterStatusRevision: number;
    }[];
  }>;
  schedulerNotices?: (afterRevision: number) => Promise<{
    readonly notices: readonly SchedulerUserNotice[];
    readonly nextRevision: number;
  }>;
  conversationFinalHistory?: (
    conversationId: string,
    afterCommitRevision: number,
  ) => Promise<readonly {
    readonly frame: FinalFrame;
    readonly publishResults: readonly PublishResultNotice[];
  }[]>;
  beginDrain?: () => Promise<void>;
  drainAcceptedWork?: () => Promise<void>;
  flushDelivery?: () => Promise<void>;
}

export interface ServerContext {
  /** 配置（不可变；config.port 是请求的端口，实际端口见 listenAddr） */
  readonly config: ServerConfig;
  /** Server 包版本号 */
  readonly version: string;
  /** 启动时间戳（ms） */
  readonly startedAt: number;
  /** 共享 token（auth 验证用）。由 ServerOrchestrator 注入 */
  readonly token: string;
  /** 对话运行时管理器（不传则 session.* 方法不可用） */
  conversations?: ConversationManager;
  /** 任务推进恢复维护面。不传则 session.resume/list 只暴露静态推进状态。 */
  advancementRecovery?: AdvancementRecoveryMaintenance;
  /** 多视角发散收敛门面。不传则多视角发起意图不可执行。 */
  perspectives?: PerspectivesController;
  /** Host 组合的传输无关 Product API。不传则相应产品 API 不可用。 */
  productApi?: ProductApiDispatcher;
  /** 宿主装配信息(server.info 的运维字段:工作区 / 日志路径)。 */
  hostInfo?: { workspace?: string; logPath?: string };
  /** 公开的本机运行状态；只允许稳定产品语言和有限动作。 */
  managedHostPublicStatus?: () => ManagedHostPublicStatus | Promise<ManagedHostPublicStatus>;
  /** 用户级恢复备份状态；不暴露 root、日志水位或摘要。 */
  recoveryBackupStatus?: () => Promise<{
    state: "not-configured" | "pending-verification" | "recoverable" | "unavailable";
    fullBackupReady: boolean;
    nextAction?: string;
  }>;
  /**
   * MCP 连接状态快照(server.info 扩展字段,/mcp 状态显示的数据面)。
   * 结构与 MCP hub 的 serverStatuses 兼容(server 不依赖 mcp 包,结构形声明)。
   */
  mcpStatuses?: () => Array<{
    serverId: string;
    transport: string;
    status: string;
    toolCount: number;
    error?: string;
  }>;
  /**
   * 轻推理通道(llm.complete 执行体,仅可信面)——/mcp 接入向导等管理流程
   * 的单发文本调用。装配方注入(如 ephemeral runtime 的 callText)。
   */
  llmComplete?: (prompt: string, role?: "main" | "light") => Promise<string>;
  /** 当前连接数(startServer 回填,server.info 用)。 */
  connectionCount?: () => number;
  /** Stable first-party RPC surface identity registry. */
  rpcSurfaces?: RpcSurfaceRegistry;
  /**
   * 向全部已认证连接广播(startServer 回填)——全局域变更通知用
   * (如 skill.changed);会话域推送走 sessionBroadcast(observer 名册)。
   */
  broadcastAll?: (method: string, params: unknown) => void;
  /** 通道注册表（不传则不启用通道功能） */
  channels?: ChannelRegistry;
  /** Pre-server channel callback routes, keyed by exact path. */
  channelHttpRoutes?: ReadonlyMap<string, HttpHandler>;
  /**
   * 确认聚合器（不传则远程确认不启用，serve 模式回退到永久 pending → 30min expire → 拒绝）。
   * 远程权限确认的 owner 聚合入口。
   */
  confirmationHub?: ConfirmationHub;
  /** 运行控制需要的可选事实源与动作钩子，由宿主装配层注入。 */
  runtimeControl?: RuntimeControlAdapter;
  /** 耐久停机收束点。所有外部停机入口必须先取得 ready-to-stop。 */
  lifecycleShutdown?: LifecycleShutdownAdapter;
  /** executor-only 宿主的有限第一方会话路由；锚点宿主不注入。 */
  conversationRpc?: FirstPartyConversationRpcRouter;
  /** 实际监听的地址（startServer 监听就绪后回填） */
  listenAddr?: { port: number; host: string };
  /**
   * 会话域组播(observer 名册定向推送)。startServer 在 connections 就绪后
   * 回填;未回填(最小测试 ctx)时 session 推送退化为发起连接单播。
   */
  sessionBroadcast?: SessionBroadcast;
  /**
   * 工作台类接入面的非当前会话活动提示。它不携内容,也不发给当前 observer。
   */
  sessionActivityBroadcast?: SessionActivityBroadcast;
  /**
   * 优雅停机触发器（runServer 在 startServer resolve 后同一微任务绑定）。
   * 仅在 lifecycleShutdown 已耐久到 ready-to-stop 后触发进程清理。
   * 未绑定（start 失败）时 handler 应抛 RpcErrors.internal。
   */
  requestShutdown?: (reason: string) => void;
}

export interface CreateContextOptions {
  config: ServerConfig;
  version: string;
  token: string;
  conversations?: ConversationManager;
  advancementRecovery?: AdvancementRecoveryMaintenance;
  perspectives?: PerspectivesController;
  productApi?: ProductApiDispatcher;
  hostInfo?: { workspace?: string; logPath?: string };
  managedHostPublicStatus?: ServerContext["managedHostPublicStatus"];
  recoveryBackupStatus?: ServerContext["recoveryBackupStatus"];
  mcpStatuses?: ServerContext["mcpStatuses"];
  llmComplete?: (prompt: string, role?: "main" | "light") => Promise<string>;
  channels?: ChannelRegistry;
  channelHttpRoutes?: ReadonlyMap<string, HttpHandler>;
  confirmationHub?: ConfirmationHub;
  runtimeControl?: RuntimeControlAdapter;
  lifecycleShutdown?: LifecycleShutdownAdapter;
  conversationRpc?: FirstPartyConversationRpcRouter;
}

export function createServerContext(opts: CreateContextOptions): ServerContext {
  return {
    config: opts.config,
    version: opts.version,
    token: opts.token,
    startedAt: Date.now(),
    conversations: opts.conversations,
    advancementRecovery: opts.advancementRecovery,
    perspectives: opts.perspectives,
    productApi: opts.productApi,
    hostInfo: opts.hostInfo,
    managedHostPublicStatus: opts.managedHostPublicStatus,
    recoveryBackupStatus: opts.recoveryBackupStatus,
    mcpStatuses: opts.mcpStatuses,
    llmComplete: opts.llmComplete,
    channels: opts.channels,
    channelHttpRoutes: opts.channelHttpRoutes,
    confirmationHub: opts.confirmationHub,
    runtimeControl: opts.runtimeControl,
    lifecycleShutdown: opts.lifecycleShutdown,
    conversationRpc: opts.conversationRpc,
  };
}
