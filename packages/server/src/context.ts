/**
 * ServerContext — 服务运行时共享上下文
 *
 * 持有所有跨模块共享的状态：配置、Scheduler、auth token、启动时间等。
 * 通过显式传递（而不是单例）保持可测试性。
 */

import type {
  SchedulerBackend,
  ChannelRegistry,
  HttpHandler,
  TaskListState,
  AuthorityDeliveryStats,
  DeliveryStatusNotice,
} from "@zhixing/core";
import type {
  ConversationStatusNotice,
  ExecutionStatusNotice,
  FinalFrame,
  JobStatusNotice,
  PublishResultNotice,
  SchedulerUserNotice,
} from "@zhixing/core/contracts";
import type { ConfirmationHub, ConversationManager } from "@zhixing/owner-kernel";
import type {
  AdvancementController,
  AdvancementRecoveryMaintenance,
} from "@zhixing/owner-services";
import type {
  SessionActivityBroadcast,
  SessionBroadcast,
} from "@zhixing/rpc/session-broadcast";
import type { SessionAdoptionReviewResult } from "@zhixing/rpc";
import type { ServerConfig } from "./types.js";
import type { ManagedHostPublicStatus } from "./managed-host-status.js";
import type { RpcSurfaceRegistry } from "./rpc/surface-identity.js";
import type { PerspectivesController } from "./perspectives/index.js";
import type { ConversationDirectory } from "./runtime/conversation-directory.js";
import type { WorksceneDirectory } from "./runtime/workscene-directory.js";
import type {
  MemoryDirectory,
  SkillDirectory,
  TrustDirectory,
} from "./runtime/management-directories.js";

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
  resolveDelivery?: (input: {
    readonly requestId: string;
    readonly itemId: string;
    readonly attempt: number;
    readonly anchorEpoch: number;
    readonly openFactDigest: string;
    readonly decision: "user-verified-sent" | "abandon" | "retry-risk-ack";
    readonly principal: {
      readonly surfacePrincipal: string;
      readonly deviceId: string;
      readonly connectionId: string;
    };
  }) => Promise<unknown>;
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
  /** 调度器实例（S2.E 注入） */
  scheduler?: SchedulerBackend;
  /** 对话运行时管理器（不传则 session.* 方法不可用） */
  conversations?: ConversationManager;
  /** 任务推进闭环控制面。不传则 session.send 保持纯执行语义。 */
  advancement?: AdvancementController;
  /** 任务推进恢复维护面。不传则 session.resume/list 只暴露静态推进状态。 */
  advancementRecovery?: AdvancementRecoveryMaintenance;
  /** 多视角发散收敛门面。不传则多视角发起意图不可执行。 */
  perspectives?: PerspectivesController;
  /**
   * 对话目录(盘上事实:清单 / 改名 / 删除 / 倒读)。装配方注入持久层实现;
   * 不传则 session.list / history / rename / delete 不可用。
   */
  conversationDirectory?: ConversationDirectory;
  /** 工作场景域(注册表管理 + 场景对话取建)。不传则 workscene.* 不可用。 */
  workscenes?: WorksceneDirectory;
  /** 信任规则管理面。不传则 trust.* 不可用。 */
  trust?: TrustDirectory;
  /** 技能库管理面。不传则 skill.* 不可用。 */
  skills?: SkillDirectory;
  /** 记忆域查看面。不传则 memory.* 不可用。 */
  memory?: MemoryDirectory;
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
  /** 用户主动迁移值班设备；仅暴露设备与用户可理解的阶段。 */
  dutyMigration?: {
    targets(): Promise<readonly {
      readonly deviceId: string;
      readonly displayName: string;
      readonly ready: boolean;
      readonly code?: "unavailable";
    }[]>;
    prepare(input: { readonly requestId: string; readonly transferId: string; readonly targetDeviceId: string }): Promise<{ readonly stage: "ready" }>;
    commit(input: { readonly requestId: string; readonly transferId: string }): Promise<{ readonly stage: "completed" }>;
    cancel(input: { readonly requestId: string; readonly transferId: string }): Promise<{ readonly stage: "cancelled" }>;
  };
  /** Current-duty-device management surface for a paired executor lifecycle. */
  deviceLifecycle?: {
    list(): Promise<readonly {
      readonly displayName: string;
      readonly reachable: boolean;
    }[]>;
    remove(input: {
      readonly requestId: string;
      readonly operationId: string;
      readonly targetName: string;
    }): Promise<{
      readonly conversations: readonly string[];
      readonly hasAcceptedWork: boolean;
    }>;
    continue(input: {
      readonly targetName: string;
      readonly mode: "transfer" | "destroy" | "lost" | "cancel";
    }): Promise<unknown>;
    status(input: {
      readonly targetName: string;
    }): Promise<unknown>;
  };
  /** Loopback-only permanent removal of the current duty device. */
  anchorUninstall?: {
    preflight(): Promise<{
      readonly migrationTargets: readonly { readonly displayName: string; readonly ready: boolean }[];
      readonly recoveryBackupReady: boolean;
    }>;
    begin(input:
      | {
          readonly path: "migration";
          readonly requestId: string;
          readonly operationId: string;
          readonly transferId: string;
          readonly targetName: string;
        }
      | {
          readonly path: "recovery-backup";
          readonly requestId: string;
          readonly operationId: string;
        }): Promise<unknown>;
    continue(input: {
      readonly operationId: string;
      readonly confirmBackup: true;
    }): Promise<unknown>;
    cancel(input: { readonly operationId: string }): Promise<unknown>;
    status(input: { readonly operationId: string }): Promise<unknown>;
  };
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
  /**
   * task_list 用户侧动作执行体(session.taskListUpdate)——写单点在宿主的
   * task_list 服务,动作语义由装配实现定义。返回写后权威快照,让发起
   * 接入面同步只读视图,不依赖 observer 广播回环。
   */
  taskListUpdate?: (
    conversationId: string,
    action: { kind: "add"; content: string } | { kind: "done"; token: string },
  ) => Promise<{ ok: boolean; message: string; taskList: TaskListState | null }>;
  /** task_list 权威快照(session.taskList 读模型)。 */
  taskListSnapshot?: (conversationId: string) => Promise<TaskListState | null>;
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
  /**
   * 收编后复核的窄接缝。session.resume 在 observer 身份成立后调用，需用户
   * 再确认的排程由现有 confirmation 链定向交给当前已认证接入面。
   */
  conversationAdoptionReview?: (input: {
    readonly conversationId: string;
    readonly surfacePrincipal: string;
    readonly connectionId: string;
  }) => Promise<SessionAdoptionReviewResult | undefined>;
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
  scheduler?: SchedulerBackend;
  conversations?: ConversationManager;
  advancement?: AdvancementController;
  advancementRecovery?: AdvancementRecoveryMaintenance;
  perspectives?: PerspectivesController;
  conversationDirectory?: ConversationDirectory;
  workscenes?: WorksceneDirectory;
  trust?: TrustDirectory;
  skills?: SkillDirectory;
  memory?: MemoryDirectory;
  hostInfo?: { workspace?: string; logPath?: string };
  managedHostPublicStatus?: ServerContext["managedHostPublicStatus"];
  recoveryBackupStatus?: ServerContext["recoveryBackupStatus"];
  dutyMigration?: ServerContext["dutyMigration"];
  deviceLifecycle?: ServerContext["deviceLifecycle"];
  mcpStatuses?: ServerContext["mcpStatuses"];
  llmComplete?: (prompt: string, role?: "main" | "light") => Promise<string>;
  taskListUpdate?: ServerContext["taskListUpdate"];
  taskListSnapshot?: ServerContext["taskListSnapshot"];
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
    scheduler: opts.scheduler,
    conversations: opts.conversations,
    advancement: opts.advancement,
    advancementRecovery: opts.advancementRecovery,
    perspectives: opts.perspectives,
    conversationDirectory: opts.conversationDirectory,
    workscenes: opts.workscenes,
    trust: opts.trust,
    skills: opts.skills,
    memory: opts.memory,
    hostInfo: opts.hostInfo,
    managedHostPublicStatus: opts.managedHostPublicStatus,
    recoveryBackupStatus: opts.recoveryBackupStatus,
    dutyMigration: opts.dutyMigration,
    deviceLifecycle: opts.deviceLifecycle,
    mcpStatuses: opts.mcpStatuses,
    llmComplete: opts.llmComplete,
    taskListUpdate: opts.taskListUpdate,
    taskListSnapshot: opts.taskListSnapshot,
    channels: opts.channels,
    channelHttpRoutes: opts.channelHttpRoutes,
    confirmationHub: opts.confirmationHub,
    runtimeControl: opts.runtimeControl,
    lifecycleShutdown: opts.lifecycleShutdown,
    conversationRpc: opts.conversationRpc,
  };
}
