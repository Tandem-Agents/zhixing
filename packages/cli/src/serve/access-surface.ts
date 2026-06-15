/**
 * 接入面（access surface）单元化 + 数据驱动装配。
 *
 * 核心宿主 = 恒定核心（runtime + 会话态 owner 位 + Scheduler + RPC server）+ 一组**可挂载的
 * 接入面**。profile 不"砍核心"，声明该档完整行为画像（接入面集合 + 校验模式 + 生命周期，
 * 见 PROFILES 描述符）；接入面装配 = 遍历启用集合各自 setup，而非在主干用 `if (profile === ...)`
 * 顺序枚举——新增接入面 = 写一个单元 + 在 PROFILES 的 surfaces 集合加一个名字，装配主干一行
 * 不改（杜绝"每加一面改主干"的声明面领先生效面复发）。
 *
 * 真实装配拓扑有交织（核心 Scheduler 构造期吃 delivery 接入面、confirmationBridge 依赖
 * runServer 之后的 connections），故接入面带 phase：
 * - pre-server：runServer 之前装（MCP / 会话执行面 / channel 门面 / delivery / 文本确认渲染器）。
 * - post-server：runServer 之后装（confirmationBridge，依赖 server.connections）。
 * 核心 Scheduler 排在 pre-server 接入面之后构造（读 ctx.deliveryStack）。
 *
 * teardown 不进本单元体系——它已由 shutdown-chain.ts 数据驱动管理（registerCoreCleanup
 * 接收资源包、LIFO 精心排序），且接入面 teardown 有时序硬约束：必须在 server.close 之前
 * 执行（= runServer 之后注册），而 pre-server 接入面 setup 在 runServer 之前，若在 setup
 * 内注册 teardown 会落到 LIFO 末尾、跑在 server.close 之后造成双重 dispose。故 pre-server
 * 接入面只 setup（产物写回 ctx，供 runServer 后的 shutdown-chain 用 ctx 产物注册清理）；
 * 仅 post-server 接入面（本就在 runServer 后）可在 setup 内自注册 teardown 到 ctx.cleanup。
 */

import { PROFILES, type ServerProfile } from "./profile.js";
import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";
import type {
  ChannelRegistry,
  ConversationRepository,
  JournalStore,
  ShardedTranscriptStore,
  SnapshotStore,
} from "@zhixing/core";
import type {
  ConfirmationHub,
  ConversationManager,
  ConversationDirectory,
  InboundRouter,
  RunningServer,
  CleanupRegistry,
  SessionBroadcast,
  TextConfirmationRenderer,
  RuntimeFactory,
} from "@zhixing/server";
import type { McpHub } from "@zhixing/mcp";
import type { DeliveryStack } from "../setup-delivery.js";

/** 接入面装配阶段 —— 适配真实交织（confirmationBridge 依赖 runServer 后的 connections）。 */
export type SurfacePhase = "pre-server" | "post-server";

/**
 * 装配期共享上下文 —— 接入面 setup 从这里读依赖、把产物写回，后续接入面 / 核心再读。
 * 单线程顺序装配，共享安全。分两区：
 * - 输入 / 恒定核心（readonly）：外层在装配接入面前已备好。
 * - 接入面产物（mutable）：各 surface.setup 写回，下游 surface 与核心读（依赖链
 *   conversations → channel → delivery → scheduler、connections → confirmationBridge）。
 */
export interface AssemblyContext {
  // ── 输入（外层准备） ──
  readonly profile: ServerProfile;
  readonly config: ZhixingConfig;
  readonly credentials: ZhixingCredentials;
  readonly zhixingHome: string;

  // ── 恒定核心（接入面 setup 前已建，供其读） ──
  readonly confirmationHub: ConfirmationHub;
  readonly mcpHub: McpHub;
  readonly transcript: ShardedTranscriptStore;
  readonly snapshots: SnapshotStore;
  readonly runtimeFactory: RuntimeFactory;
  /** user 域对话 meta 仓——turn 后维护(自动命名)与对话目录共用同一实例 */
  readonly convRepo: ConversationRepository;
  /** 对话目录——会话执行面经此归口创建 / 确保持久化身份 */
  readonly conversationDirectory: ConversationDirectory;
  /** journal 域仓——turn 后维护与系统维护任务共用同一实例 */
  readonly journalStore: JournalStore;
  /**
   * 会话组播 lazy ref(runServer 后回填)——turn 后维护的改名通知等运行期
   * 推送经此读最新值;装配期为 null,运行期必已就位。
   */
  readonly sessionBroadcastRef: { current: SessionBroadcast | null };
  /**
   * 唯一清理出口（LIFO）。pre-server 接入面的 teardown 走 runServer 后的 shutdown-chain
   * 注册（时序约束见文件头）；仅 post-server 接入面在自己 setup 内注册到这里。
   */
  readonly cleanup: CleanupRegistry;

  // ── 接入面产物（surface.setup 写回） ──
  conversations?: ConversationManager;
  channels?: ChannelRegistry;
  inboundRouter?: InboundRouter | null;
  deliveryStack?: DeliveryStack;
  textRenderer?: TextConfirmationRenderer;

  // ── post-server 输入（runServer resolve 后填，供 post-server 接入面读） ──
  runner?: RunningServer;
}

/**
 * 接入面单元 —— 把"某个接入面的装配"封成自包含单元：条件（如 channel 判 messaging 配置）、
 * 失败处理、对 ctx 的依赖读取与产物写回，全内聚在 setup 内；主干不再有它的 if。
 * teardown 见文件头说明（pre-server 走 shutdown-chain，post-server 在 setup 内自注册）。
 */
export interface AccessSurface {
  readonly name: string;
  readonly phase: SurfacePhase;
  setup(ctx: AssemblyContext): Promise<void>;
}

/**
 * 数据驱动装配：按 `surfaces` 数组序（= 依赖拓扑序）遍历，装配当前 phase 且被本 profile
 * 启用的接入面。这是装配主干唯一的"接入面装配"出口——新增接入面不改本函数。
 */
export async function setupAccessSurfaces(
  surfaces: readonly AccessSurface[],
  ctx: AssemblyContext,
  phase: SurfacePhase,
): Promise<void> {
  const enabled = new Set(PROFILES[ctx.profile].surfaces);
  for (const surface of surfaces) {
    if (surface.phase === phase && enabled.has(surface.name)) {
      await surface.setup(ctx);
    }
  }
}
