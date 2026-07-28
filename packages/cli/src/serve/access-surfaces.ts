/**
 * 接入面单元定义 —— 把 runServerProcess 里各接入面的内联装配等价搬成自包含 setup 单元。
 *
 * createAccessSurfaces 返回数组的顺序 = pre-server 依赖拓扑序（conversation→mesh
 * →lossless data plane→channel 门面→delivery），setupAccessSurfaces 按此序遍历。每个 setup 内聚自己的
 * 运行时条件（如 channel 判 messaging 配置）与失败处理；profile 是否启用由
 * PROFILES.surfaces 决定、不在 setup 内判 profile。teardown 策略见 access-surface.ts
 * 文件头（pre-server 走 shutdown-chain、post-server 在 setup 内自注册）。
 */

import chalk from "chalk";
import {
  ShardedTranscriptStore,
  SnapshotStore,
  buildStartupBootstrap,
  conversationsDir,
  countRuns,
  createTokenEstimator,
  parseConversationId,
} from "@zhixing/core";
import { ConversationManager } from "@zhixing/owner-kernel";
import {
  createConfirmationBridge,
  SESSION_NOTIFICATIONS,
  type SessionChangedPayload,
} from "@zhixing/rpc";
import {
  resolveModelCapability,
  type ChannelCredentialProjection,
} from "@zhixing/providers";
import { setupChannels } from "./channels.js";
import {
  setupAuthorityRuntime,
  setupDelivery,
} from "../setup-delivery.js";
import { MeshRuntimeAssembly, executorIdForDevice } from "./mesh-runtime-assembly.js";
import { SurfaceAssetMaintenance } from "./surface-asset-maintenance.js";
import { createAdvancementReviewMaintenance } from "./advancement-review-maintenance.js";
import { createTurnMaintenance } from "./turn-maintenance.js";
import { governControlTextCall } from "./governed-control-llm.js";
import { ConversationProtocolRuntime } from "./conversation-protocol-runtime.js";
import type { AccessSurface } from "./access-surface.js";
import { ZHIXING_CLI_VERSION } from "../version.js";
import { JobStatusDirectory } from "./job-status-directory.js";
import { ExecutorDataPlaneRuntime } from "./executor-data-plane-runtime.js";
import { LosslessDataPlaneRuntime } from "./lossless-data-plane-runtime.js";

/** MCP —— eager 连接外部 server，使工具目录进入 system prompt。 */
const mcpSurface: AccessSurface = {
  name: "mcp",
  phase: "pre-server",
  async setup(ctx) {
    ctx.startupCleanups.mcp ??= ctx.startupRollback.register(
      "mcpHub.dispose",
      () => ctx.mcpHub.dispose(),
    );
    await ctx.mcpHub.connectAll();
  },
};

/** Durable authority substrate shared by conversation and delivery composition. */
const authorityRuntimeSurface: AccessSurface = {
  name: "authority-runtime",
  phase: "pre-server",
  async setup(ctx) {
    const bootstrap = ctx.meshBootstrap;
    const authorityRuntime = await setupAuthorityRuntime({
      zhixingHome: ctx.zhixingHome,
      secretStore: ctx.secretStore,
      deviceKey: bootstrap.deviceKey,
      trustedIdentities: bootstrap.trustedIdentities,
      authorizedDeviceIds: bootstrap.authorizedDeviceIds,
      executorId: executorIdForDevice(bootstrap.deviceKey.deviceId),
      configurationSnapshot: {
        config: ctx.config,
        executableVersion: ZHIXING_CLI_VERSION,
      },
      executorReadiness: ctx.executorReadiness,
      enableLocalExecutor: ctx.enabledRoles.includes("executor"),
      storageMaintenance: ctx.storageMaintenance,
      // 清理所有权在 setupAuthorityRuntime 内部于任何资源取得前注册进同一回滚
      // 事务;这里只采用返回的 handle,不再事后另建——事后注册会留下"恢复后、
      // 返回前失败"的无人清理窗口。
      startupRollback: ctx.startupRollback,
    });
    ctx.startupCleanups.authorityRuntime = authorityRuntime.startupCleanup;
    ctx.authorityRuntime = authorityRuntime;
    const jobStatus = new JobStatusDirectory();
    jobStatus.onStatus((notice) => {
      ctx.runner?.server.context.broadcastAll?.("job.status", notice);
    });
    ctx.startupCleanups.jobStatus = ctx.startupRollback.register(
      "jobStatus.dispose",
      () => jobStatus.dispose(),
    );
    ctx.jobStatus = jobStatus;
  },
};

/** Executor-owned durable stream and ticket substrate, shared by local and mesh adapters. */
const executorDataPlaneSurface: AccessSurface = {
  name: "executor-data-plane",
  phase: "pre-server",
  async setup(ctx) {
    if (!ctx.enabledRoles.includes("executor")) return;
    if (!ctx.authorityRuntime || !ctx.executorRoleModule) {
      throw new Error("Executor data plane requires authority and executor modules");
    }
    const dataPlane = new ExecutorDataPlaneRuntime({
      zhixingHome: ctx.zhixingHome,
      authority: ctx.authorityRuntime,
      module: ctx.executorRoleModule,
      onError: (error) =>
        console.warn(chalk.yellow(`[data-plane] ${error.message}`)),
    });
    ctx.startupCleanups.executorDataPlane = ctx.startupRollback.register(
      "executorDataPlane.close",
      () => dataPlane.close(),
    );
    ctx.executorDataPlane = dataPlane;
  },
};

/**
 * 会话内容资产的周期回收。
 *
 * 持有者必须在全部拓扑下都存在:回收是锚点权威的生命周期治理义务,不能挂在只于
 * 多机拓扑创建的 mesh 控制面上,否则默认单机锚点永不回收临时件与已释放叶。
 */
const assetMaintenanceSurface: AccessSurface = {
  name: "asset-maintenance",
  phase: "pre-server",
  async setup(ctx) {
    if (!ctx.enabledRoles.includes("anchor")) return;
    const authority = ctx.authorityRuntime;
    if (!authority) {
      throw new Error("Asset maintenance requires the authority runtime");
    }
    // 治理端口注入协调器而非调度器:容量在协调器内部的叶级物理步骤取得,
    // 调度器只声明这轮回收的阻塞关系。
    const maintenance = new SurfaceAssetMaintenance({
      surfaceAssets: authority.surfaceAssets,
      onError: (error) =>
        console.warn(chalk.yellow(`[assets] ${error.message}`)),
    });
    ctx.startupCleanups.assetMaintenance = ctx.startupRollback.register(
      "assetMaintenance.stop",
      () => maintenance.stop(),
    );
    await maintenance.start();
    ctx.assetMaintenance = maintenance;
  },
};

/** Authenticated mesh control plane; absent in the no-genesis single-machine topology. */
const meshSurface: AccessSurface = {
  name: "mesh-control",
  phase: "pre-server",
  async setup(ctx) {
    const bootstrap = ctx.meshBootstrap;
    if (!bootstrap || bootstrap.mode === "single-machine") return;
    if (!ctx.authorityRuntime || !ctx.conversationProtocol) {
      throw new Error("Mesh control requires authority and conversation protocol runtimes");
    }
    const mesh = new MeshRuntimeAssembly({
      zhixingHome: ctx.zhixingHome,
      trust: bootstrap.trust,
      configuration: bootstrap.configuration,
      endpoints: bootstrap.endpoints,
      transportPeers: bootstrap.transportPeers,
      bootstrapStore: bootstrap.bootstrapStore,
      authority: ctx.authorityRuntime,
      protocol: ctx.conversationProtocol,
      ...(ctx.enabledRoles.includes("executor")
        ? {
            executor: {
              ledger: ctx.conversationProtocol.executorLedger(),
              runtimeFactory: ctx.runtimeFactory,
              interactions: ctx.durableInteractions,
              dataPlane: ctx.executorDataPlane!,
              InProcessAssignmentSubmission:
                ctx.executorRoleModule!.InProcessAssignmentSubmission,
            },
          }
        : {}),
      secretStore: ctx.secretStore,
      ...(bootstrap.localEndpoint ? { localEndpoint: bootstrap.localEndpoint } : {}),
      onError: (error) => console.warn(chalk.yellow(`[mesh] ${error.message}`)),
    });
    const cleanup = ctx.startupRollback.register(
      "meshRuntime.stop",
      () => mesh.stop(),
    );
    await mesh.start();
    ctx.meshRuntime = mesh;
    ctx.startupCleanups.meshRuntime = cleanup;
  },
};

/**
 * S6 无损数据面唯一产品组合根。
 *
 * 该接入面先于渠道装配完成：conversation 协议、executor 端点、mesh adapter 和
 * challenge 回调必须在渠道开始接收消息前形成闭环，避免新旧确认路径半启用。
 */
const losslessDataPlaneSurface: AccessSurface = {
  name: "lossless-data-plane",
  phase: "pre-server",
  async setup(ctx) {
    if (!ctx.enabledRoles.includes("anchor")) return;
    if (!ctx.authorityRuntime || !ctx.conversationProtocol) {
      throw new Error(
        "Lossless data plane requires authority and conversation protocol runtimes",
      );
    }
    const runtime = new LosslessDataPlaneRuntime({
      authority: ctx.authorityRuntime,
      ...(ctx.executorDataPlane ? { local: ctx.executorDataPlane } : {}),
      mesh: () => ctx.meshRuntime,
      interactions: ctx.durableInteractions,
      onError: (error) =>
        console.warn(chalk.yellow(`[data-plane] ${error.message}`)),
    });
    ctx.startupCleanups.losslessDataPlane = ctx.startupRollback.register(
      "losslessDataPlane.close",
      () => runtime.close(),
    );
    ctx.losslessDataPlane = runtime;
    ctx.conversationProtocol.bindLosslessDataPlane(runtime);
  },
};

/** 会话执行面 —— 持久用户 / channel / 工作场景会话（ConversationManager）。 */
const conversationSurface: AccessSurface = {
  name: "conversation",
  phase: "pre-server",
  async setup(ctx) {
    const { transcript, snapshots, config } = ctx;
    if (!ctx.authorityRuntime) {
      throw new Error("Conversation surface requires the durable authority runtime");
    }
    // 装填预算按主模型能力取值（serve 会话统一用 main 模型；未知模型有保守兜底）
    const capability = resolveModelCapability(config.llm?.main?.model ?? "");

    // 持久化路由——对话归属编码在全域键里(ws: 前缀 = 场景对话),持久层
    // 操作按 scope 选 store、用库内 id。场景库 store 惰性建、按 sceneId 缓存。
    const sceneStores = new Map<
      string,
      { transcript: ShardedTranscriptStore; snapshots: SnapshotStore }
    >();
    const storesFor = (conversationId: string) => {
      const { scope, localId } = parseConversationId(conversationId);
      if (scope.kind === "workscene") {
        let entry = sceneStores.get(scope.sceneId);
        if (!entry) {
          const dir = conversationsDir(scope);
          entry = {
            transcript: new ShardedTranscriptStore(dir),
            snapshots: new SnapshotStore(dir),
          };
          sceneStores.set(scope.sceneId, entry);
        }
        return { ...entry, localId };
      }
      return { transcript, snapshots, localId: conversationId };
    };

    const turnMaintenance = createTurnMaintenance({
      convRepo: ctx.convRepo,
      journal: ctx.journalStore,
      // turn 后台维护(自动命名/journal 凝练)是宿主维护类工作——scheduler 准入,
      // 每次外调经 control 治理边界预占计量
      governCallText: (call) =>
        governControlTextCall(
          {
            governor: ctx.authorityRuntime!.resourceGovernor,
            origin: { admissionClass: "scheduler", entry: "schedule-trigger" },
            workPrefix: "turn-maintenance",
          },
          call,
        ),
      onRenamed: (conversationId, name) => {
        ctx.sessionBroadcastRef.current?.(
          conversationId,
          SESSION_NOTIFICATIONS.changed,
          {
            conversationId,
            change: "renamed",
            name,
          } satisfies SessionChangedPayload,
        );
      },
    });
    const advancementReviewMaintenance = createAdvancementReviewMaintenance({
      advancement: ctx.advancement,
      sessionBroadcast: () => ctx.sessionBroadcastRef.current,
      conversations: () => ctx.conversations ?? null,
      conversationExists: (conversationId) =>
        ctx.conversationDirectory.exists(conversationId),
      recoverConversation: (conversationId, options) =>
        ctx.advancementRecoveryRef?.current?.recoverConversation(
          conversationId,
          options,
        ) ?? Promise.resolve(),
    });

    let manager: ConversationManager;
    if (ctx.enabledRoles.includes("executor") && !ctx.executorDataPlane) {
      throw new Error("Conversation executor requires its durable data plane");
    }
    const protocol = new ConversationProtocolRuntime({
      authority: ctx.authorityRuntime,
      ...(ctx.executorRoleModule
        ? {
            localExecutor: {
              ConversationAssignmentLedger:
                ctx.executorRoleModule.ConversationAssignmentLedger,
              InProcessAssignmentSubmission:
                ctx.executorRoleModule.InProcessAssignmentSubmission,
              dataPlaneTickets: ctx.executorDataPlane!.tickets,
              createStream: (input) =>
                ctx.executorDataPlane!.createStream(input),
            },
          }
        : {}),
      manager: () => manager,
      interactions: ctx.durableInteractions,
      executeRecoveredPerspective: async (input) => {
        const execution = await ctx.perspectives.executePerspectiveWork(input);
        return execution.runResult;
      },
      onStatus: (notice) => {
        ctx.sessionBroadcastRef.current?.(
          notice.ref.conversationId,
          SESSION_NOTIFICATIONS.status,
          notice,
        );
      },
      onFinal: (frame) => {
        ctx.sessionBroadcastRef.current?.(
          frame.conversationId,
          SESSION_NOTIFICATIONS.final,
          frame,
        );
      },
      projectLifecycle: async (input) => {
        if (input.mutation === "clear") {
          const outcome = await manager.clear(input.conversationId, async () => {
            await ctx.conversationDirectory.ensure(input.conversationId);
            await ctx.conversationDirectory.clear(input.conversationId);
            return true;
          });
          if (outcome === "busy") {
            throw new Error("Conversation lifecycle projection is busy");
          }
          if (outcome === "not-found") {
            throw new Error("Conversation lifecycle projection lost its identity");
          }
          ctx.sessionBroadcastRef.current?.(
            input.conversationId,
            SESSION_NOTIFICATIONS.changed,
            { conversationId: input.conversationId, change: "cleared" },
          );
          return;
        }
        const outcome = await manager.delete(input.conversationId, {
          removeDisk: async () => {
            await ctx.conversationDirectory.remove(input.conversationId);
            return true;
          },
          onDeleted: () => {
            ctx.sessionBroadcastRef.current?.(
              input.conversationId,
              SESSION_NOTIFICATIONS.changed,
              { conversationId: input.conversationId, change: "deleted" },
            );
          },
        });
        if (outcome === "busy") {
          throw new Error("Conversation lifecycle projection is busy");
        }
        // 权威删除的全部级联消费者在同一投影 claim 内幂等完成:推进会话
        // 取消与控制日志删除失败即抛错保持投影待办,由在线/启动恢复重驱;
        // advancement 子系统整体缺席时无级联数据,是显式判定而非能力兜底。
        if (ctx.advancement) {
          await ctx.advancement.cancelOpenConversationSession({
            conversationId: input.conversationId,
            reason: "user-cancelled",
            message: "原始对话已删除，推进会话已取消。",
          });
          await ctx.advancement.removeConversationData(input.conversationId);
        }
      },
      recoverAuxiliary: async (conversationId) => {
        const recovery = ctx.advancementRecoveryRef.current;
        if (!recovery) return;
        const result = await recovery.recoverConversation(conversationId);
        if (
          result.status === "failed" ||
          result.status === "full" ||
          result.status === "busy" ||
          result.status === "not-found" ||
          result.status === "missing-proxy"
        ) {
          throw new Error(
            result.message ??
              `Advancement recovery did not converge: ${result.status}`,
          );
        }
      },
    });
    manager = new ConversationManager(ctx.runtimeFactory, undefined, {
      onRelease: (conversationId) => protocol.releaseConversation(conversationId),
      loadHistory: async (conversationId) => {
        // 倒读自带索引自愈（分片文件在，会话就在）——计数与装填都不做
        // 裸文件存在性短路。undefined 只表示经成功读取确认的零历史
        // （真·新对话 / 刚清空）；任何 I/O、损坏或装填异常必须向调用面
        // 传播并保持会话未激活——把读取失败编码成空历史会让 agent 在
        // 缺失既有上下文时继续提交新权威结果,污染对话。
        const s = storesFor(conversationId);
        const turnCount = await countRuns(s.transcript, s.localId);
        if (turnCount === 0) return undefined;
        const bootstrap = await buildStartupBootstrap({
          conversationId: s.localId,
          store: s.transcript,
          snapshots: s.snapshots,
          capability: { optimalMaxTokens: capability.optimalMaxTokens },
          estimator: createTokenEstimator(),
        });
        return { bootstrap, turnCount };
      },
      initTranscript: async (conversationId) => {
        const s = storesFor(conversationId);
        await s.transcript.init(s.localId);
      },
      ensureConversation: async (conversationId) => {
        await ctx.conversationDirectory.ensure(conversationId);
      },
      appendRun: async (conversationId, input) => {
        const s = storesFor(conversationId);
        return await s.transcript.appendRunRecord(s.localId, input);
      },
      appendCommittedRun: async (conversationId, input) => {
        const s = storesFor(conversationId);
        return await s.transcript.appendCommittedRunRecord(s.localId, input);
      },
      writeSnapshot: async (conversationId, input) => {
        const s = storesFor(conversationId);
        await s.snapshots.write(s.localId, input);
      },
      confirmationHub: ctx.confirmationHub,
      // 所有入口的 accepted turn 经 recordTurn 汇聚；各维护任务各自
      // fire-and-forget，不能反向影响已落定的对话事实。
      onTurnCommitted: (info) => {
        turnMaintenance(info);
        advancementReviewMaintenance(info);
      },
      durableTurnExecutor: protocol,
    });
    if (ctx.executorDataPlane) {
      ctx.executorDataPlane.bindLedger(protocol.executorLedger());
      await ctx.executorDataPlane.start();
    }
    await protocol.recoverReadinessProjections();
    ctx.conversations = manager;
    ctx.conversationProtocol = protocol;
  },
};

/** 社交通道 —— 先装稳定门面，外部连接异步进入状态机；setup 失败非致命。 */
function createChannelSurface(credentials: ChannelCredentialProjection): AccessSurface {
  return {
    name: "channel",
    phase: "pre-server",
    async setup(ctx) {
      const { conversations, config, losslessDataPlane } = ctx;
      if (
        !conversations ||
        !config.messaging ||
        Object.keys(config.messaging).length === 0
      ) {
        return;
      }
      if (!losslessDataPlane) {
        throw new Error(
          "Channel setup requires the complete S6 lossless data plane",
        );
      }
      const channelLogger = {
        debug: (msg: string, ...args: unknown[]) =>
          console.log(chalk.dim(`[channel] ${msg}`), ...args),
        info: (msg: string, ...args: unknown[]) =>
          console.log(chalk.dim(`[channel] ${msg}`), ...args),
        warn: (msg: string, ...args: unknown[]) =>
          console.warn(chalk.yellow(`[channel] ${msg}`), ...args),
        error: (msg: string, ...args: unknown[]) =>
          console.error(chalk.red(`[channel] ${msg}`), ...args),
      };
      try {
        const result = await setupChannels({
          entries: config.messaging,
          credentials,
          conversations,
          logger: channelLogger,
          cancelKeywords: config.intent?.cancelKeywords,
          sessionBroadcast: () => ctx.sessionBroadcastRef.current,
          sessionActivityBroadcast: () =>
            ctx.sessionActivityBroadcastRef.current,
          onChallengeAction: (action) => {
            void losslessDataPlane.handleChallengeAction(action).catch((error) => {
              channelLogger.warn(
                "Signed challenge callback rejected: %s",
                error instanceof Error ? error.message : String(error),
              );
            });
          },
          registerHttpRoute: (path, handler) => {
            if (ctx.channelHttpRoutes.has(path)) {
              throw new Error(`Channel HTTP route already registered: ${path}`);
            }
            ctx.channelHttpRoutes.set(path, handler);
          },
        });
        losslessDataPlane.bindChannels(result.registry);
        ctx.channels = result.registry;
        ctx.inboundRouter = result.router;
        ctx.startupCleanups.channels = ctx.startupRollback.register(
          "channels.dispose",
          () => result.registry.dispose(),
        );
      } catch (err) {
        console.warn(
          chalk.yellow(
            `[channel] Setup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    },
  };
}

/** 投递栈 —— 依赖通道；late-bind Outbox 到 inboundRouter。 */
const deliverySurface: AccessSurface = {
  name: "delivery",
  phase: "pre-server",
  async setup(ctx) {
    const { channels, config, zhixingHome } = ctx;
    if (!channels || !config.messaging) return;
    if (!ctx.authorityRuntime) {
      throw new Error("Delivery requires the durable authority runtime");
    }
    const deliveryStack = await setupDelivery({
      channels,
      zhixingHome,
      authorityRuntime: ctx.authorityRuntime,
      startupRollback: ctx.startupRollback,
      logger: {
        info: (msg) => console.log(chalk.dim(msg)),
        warn: (msg) => console.warn(chalk.yellow(msg)),
        error: (msg) => console.error(chalk.red(msg)),
      },
    });
    ctx.deliveryStack = deliveryStack;
    ctx.startupCleanups.deliveryStack = deliveryStack.startupCleanup;
    ctx.conversationProtocol?.bindDeliveryDrain(() =>
      deliveryStack.authorityDelivery.flush(),
    );
    if (ctx.inboundRouter) {
      ctx.inboundRouter.setOutboxRegistry(deliveryStack.outboxRegistry);
    }
  },
};

/**
 * 远程确认桥 —— hub 事件 → RPC notification；依赖 runServer 之后的 server.connections
 * 与会话执行面。post-server 阶段，teardown 在此 setup 内自注册（时序正确）。
 */
const confirmationBridgeSurface: AccessSurface = {
  name: "confirmation-bridge",
  phase: "post-server",
  async setup(ctx) {
    const { conversations, confirmationHub, runner, cleanup } = ctx;
    if (!conversations || !runner) return;
    const confirmationBridge = createConfirmationBridge({
      connections: runner.server.connections,
      hub: confirmationHub,
      conversations,
    });
    cleanup.register("confirmationBridge.dispose", () => {
      confirmationBridge.dispose();
    });
  },
};

/** Work resumption starts only after RPC, channel, delivery and confirmation consumers exist. */
const conversationRecoverySurface: AccessSurface = {
  name: "conversation-recovery",
  phase: "post-server",
  async setup(ctx) {
    const protocol = ctx.conversationProtocol;
    if (!protocol) return;
    protocol.startRecoveryLoop();
  },
};

/**
 * 全部接入面单元，按 pre-server 依赖拓扑序排列（post-server 项排最后）。
 * 新增接入面 = 在此加一个单元 + 在 access-surface.ts 的 PROFILES 对应 surfaces 集合加名字。
 */
export function createAccessSurfaces(
  channelCredentials: ChannelCredentialProjection,
): readonly AccessSurface[] {
  return [
    mcpSurface,
    authorityRuntimeSurface,
    executorDataPlaneSurface,
    conversationSurface,
    assetMaintenanceSurface,
    meshSurface,
    losslessDataPlaneSurface,
    createChannelSurface(channelCredentials),
    deliverySurface,
    confirmationBridgeSurface,
    conversationRecoverySurface,
  ];
}
