/**
 * ServerContext — 服务运行时共享上下文
 *
 * 持有网关所需共享状态：配置、auth token、启动时间与有限产品 API 等。
 * 通过显式传递（而不是单例）保持可测试性。
 */

import type {
  ChannelStatus,
  ConfirmationDecision,
  ConfirmationRequest,
  HttpHandler,
  AuthorityDeliveryStats,
  DeliveryStatusNotice,
} from "@zhixing/core";
import type { ProductApiDispatcher } from "@zhixing/core/product-api";
import type { BackupRecoveryPublicStatus } from "@zhixing/core/backup-recovery/application";
import type {
  ConversationStatusNotice,
  ExplicitEnvironmentSelection,
  ExecutionStatusNotice,
  FinalFrame,
  JobStatusNotice,
  PublishResultNotice,
  SchedulerUserNotice,
} from "@zhixing/core/contracts";
import type {
  AgentEventMap,
  PostTurnControlOutcome,
  TurnContext,
  UserTurnInput,
} from "@zhixing/core/types";
import type {
  SessionActivityBroadcast,
  SessionBroadcast,
} from "@zhixing/rpc/session-broadcast";
import type { ServerConfig } from "./types.js";
import type { ManagedHostPublicStatus } from "./managed-host-status.js";
import type { RpcSurfaceRegistry } from "./rpc/surface-identity.js";

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

/** Server's finite Conversation demand; it never exposes an owner object or session. */
export interface ServerConversationBinding {
  usesDurableTurnProtocol(): boolean;
  has(conversationId: string): boolean;
  addObserver(
    conversationId: string,
    connectionId: string,
    options?: Readonly<{ allowInactive?: boolean }>,
  ): boolean;
  removeObserver(conversationId: string, connectionId: string): void;
  getObserverConnectionIds(conversationId: string): ReadonlySet<string>;
  drainLifecycleDiagnostics(
    conversationId: string,
  ): readonly AgentEventMap["lifecycle:warning"][];
  setBusy(conversationId: string, busy: boolean): void;
  findDurableInteractionOutcome(
    conversationId: string,
    requestId: string,
  ): Promise<
    | Readonly<{ t: "answered"; decisionDigest: string }>
    | Readonly<{ t: "closed" }>
    | undefined
  >;
  executeTurn(input: Readonly<{
    conversationId: string;
    userInput: UserTurnInput;
    turnId: string;
    abortSignal: AbortSignal;
    turnContext: TurnContext;
    surfacePrincipal: string;
    environment?: ExplicitEnvironmentSelection;
    notify(method: string, params: unknown): void;
    onPostTurnControlIntent(control: PostTurnControlOutcome): void;
  }>): Promise<void>;
  list(): readonly Readonly<{
    conversationId: string;
    busy: boolean;
    pendingCount: number;
  }>[];
  durablePrincipal(input: Readonly<{
    surfacePrincipal: string;
    connectionId: string;
  }>): Readonly<{
    surfacePrincipal: string;
    deviceId: string;
    connectionId: string;
  }>;
  removeObserverFromAll(connectionId: string): void;
  disposeAll(): Promise<void>;
}

export interface ServerConfirmationPendingEntry {
  readonly request: ConfirmationRequest;
  readonly conversationId?: string;
}

/** Confirmation RPC's finite pending-query/resolve demand. */
export interface ServerConfirmationBinding {
  listPending(): readonly ServerConfirmationPendingEntry[];
  findPending(requestId: string): ServerConfirmationPendingEntry | undefined;
  resolve(requestId: string, decision: ConfirmationDecision): Promise<boolean>;
}

/** The exact runtime status/history demand of the server.info handler. */
export interface ServerInfoRuntimeBinding {
  readonly openFirstPartyFinality?: (input: {
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
  readonly deliveryStats?: () => AuthorityDeliveryStats;
  readonly deliveryStatus?: (
    afterByItem: Readonly<Record<string, number>>,
  ) => Promise<readonly DeliveryStatusNotice[]>;
  readonly conversationStatus?: (
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
  readonly jobStatus?: (
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
  readonly schedulerNotices?: (afterRevision: number) => Promise<{
    readonly notices: readonly SchedulerUserNotice[];
    readonly nextRevision: number;
  }>;
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
  /** Conversation handlers 的有限、构造期只读 binding。 */
  conversation?: ServerConversationBinding;
  /** Host 组合的传输无关 Product API。不传则相应产品 API 不可用。 */
  productApi?: ProductApiDispatcher;
  /** 宿主装配信息(server.info 的运维字段:工作区 / 日志路径)。 */
  hostInfo?: { workspace?: string; logPath?: string };
  /** 公开的本机运行状态；只允许稳定产品语言和有限动作。 */
  managedHostPublicStatus?: () => ManagedHostPublicStatus | Promise<ManagedHostPublicStatus>;
  /** 用户级恢复备份状态；不暴露 root、日志水位或摘要。 */
  recoveryBackupStatus?: () => Promise<BackupRecoveryPublicStatus>;
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
  /** 通道运行状态的有限只读快照（不传则不启用通道功能）。 */
  channelStatuses?: () => readonly Readonly<ChannelStatus>[];
  /** Pre-server channel callback routes, keyed by exact path. */
  channelHttpRoutes?: ReadonlyMap<string, HttpHandler>;
  /** 远程确认的有限 pending-query/resolve binding。 */
  confirmation?: ServerConfirmationBinding;
  /** server.info 唯一消费的运行状态与 finality 查询。 */
  readonly serverInfoRuntime?: ServerInfoRuntimeBinding;
  /** session.subscribe 在 observer 建立后回放的 Conversation final history。 */
  readonly conversationFinalHistory?: (
    conversationId: string,
    afterCommitRevision: number,
  ) => Promise<readonly {
    readonly frame: FinalFrame;
    readonly publishResults: readonly PublishResultNotice[];
  }[]>;
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
  conversation?: ServerConversationBinding;
  productApi?: ProductApiDispatcher;
  hostInfo?: { workspace?: string; logPath?: string };
  managedHostPublicStatus?: ServerContext["managedHostPublicStatus"];
  recoveryBackupStatus?: ServerContext["recoveryBackupStatus"];
  mcpStatuses?: ServerContext["mcpStatuses"];
  llmComplete?: (prompt: string, role?: "main" | "light") => Promise<string>;
  channelStatuses?: () => readonly Readonly<ChannelStatus>[];
  channelHttpRoutes?: ReadonlyMap<string, HttpHandler>;
  confirmation?: ServerConfirmationBinding;
  readonly serverInfoRuntime?: ServerInfoRuntimeBinding;
  readonly conversationFinalHistory?: ServerContext["conversationFinalHistory"];
  lifecycleShutdown?: LifecycleShutdownAdapter;
  conversationRpc?: FirstPartyConversationRpcRouter;
}

export function createServerContext(opts: CreateContextOptions): ServerContext {
  return {
    config: opts.config,
    version: opts.version,
    token: opts.token,
    startedAt: Date.now(),
    conversation: opts.conversation,
    productApi: opts.productApi,
    hostInfo: opts.hostInfo,
    managedHostPublicStatus: opts.managedHostPublicStatus,
    recoveryBackupStatus: opts.recoveryBackupStatus,
    mcpStatuses: opts.mcpStatuses,
    llmComplete: opts.llmComplete,
    channelStatuses: opts.channelStatuses,
    channelHttpRoutes: opts.channelHttpRoutes,
    confirmation: opts.confirmation,
    serverInfoRuntime: opts.serverInfoRuntime,
    conversationFinalHistory: opts.conversationFinalHistory,
    lifecycleShutdown: opts.lifecycleShutdown,
    conversationRpc: opts.conversationRpc,
  };
}
