/**
 * 接入面单元定义 —— 把 runServerProcess 里各接入面的内联装配等价搬成自包含 setup 单元。
 *
 * createAssemblyUnits 返回数组的顺序 = pre-server 依赖拓扑序（conversation→mesh
 * →lossless data plane→channel 门面→delivery），setupAssemblyUnits 按此序遍历。每个 setup 内聚自己的
 * 运行时条件（如 channel 判 messaging 配置）与失败处理；profile 是否启用由
 * PROFILES.surfaces 决定、不在 setup 内判 profile。teardown 策略见 access-surface.ts
 * 文件头（pre-server 与 post-server 都经 activation gate 的类型化 contribution 移交）。
 */

import chalk from "chalk";
import path from "node:path";
import {
  ShardedTranscriptStore,
  SnapshotStore,
  buildStartupBootstrap,
  conversationsDir,
  countRuns,
  createTokenEstimator,
  parseConversationId,
} from "@zhixing/core";
import type { AuthorityCallContext } from "@zhixing/core/contracts";
import {
  createConversationTaskListChangedFact,
  projectConversationClear,
  projectConversationDelete,
} from "@zhixing/core/conversation/application";
import {
  AdvancementAcceptedTurnApplicationService,
  AdvancementReviewResultProjectionApplicationService,
} from "@zhixing/core/advancement/application";
import { ConversationManager } from "@zhixing/owner-kernel";
import {
  createAdvancementRecoveryMaintenance,
} from "@zhixing/owner-services";
import { createAdvancementReviewProxySchedulePort } from "@zhixing/owner-services/advancement/proxy-scheduler";
import {
  createAdvancementEventSink,
  createAdvancementOriginalTaskAdmissionPort,
  createAdvancementProxyTurnPort,
} from "@zhixing/server";
import {
  createControlSessionEventEnvelope,
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
  ExecutionStatusHub,
  FirstPartyFinalitySession,
} from "./first-party-finality-session.js";
import {
  setupAuthorityRuntime,
  setupDelivery,
} from "../setup-delivery.js";
import { MeshRuntimeAssembly, executorIdForDevice } from "./mesh-runtime-assembly.js";
import { SurfaceAssetMaintenance } from "./surface-asset-maintenance.js";
import { createAnchorConversationDeleteProjectionPort } from "./conversation-delete-binding.js";
import { createTurnMaintenance } from "./turn-maintenance.js";
import { governControlTextCall } from "./governed-control-llm.js";
import { ConversationProtocolRuntime } from "./conversation-protocol-runtime.js";
import type {
  AccessSurface,
  AssemblyUnit,
  CoreAssemblyUnit,
} from "./access-surface.js";
import { ZHIXING_CLI_VERSION } from "../version.js";
import { JobStatusDirectory } from "./job-status-directory.js";
import { ExecutorDataPlaneRuntime } from "./executor-data-plane-runtime.js";
import { createLosslessDataPlaneComposition } from "./lossless-data-plane-composition.js";
import { ExecutorJobOwnerAssembly } from "./executor-job-owner.js";
import { JobInteractionRuntimeUnavailableError } from "./durable-job-interactions.js";
import { JobRelayObligationDirectory } from "./channel-interaction-coordinator.js";
import { AssignmentInteractionRouter } from "./assignment-operations-router.js";
import { createAssignmentGlobalQueryPort } from "./assignment-schedule-stager.js";
import { createExecutorLocalWorkspaceHost } from "../runtime/local-workspace-bootstrap.js";
import {
  EvidenceJournal,
  ExecutorEvidenceHandler,
} from "@zhixing/orchestrator/advancement";
import { LocalConversationOwnerAssembly } from "./local-conversation-owner.js";
import { createHostAdvancementModelProviderFactory } from "../runtime/advancement-model-provider.js";
import { localConversationOwnerRuntime } from "./conversation-owner-runtime.js";
import { createConversationEvidenceAuthorityVerifier } from "./conversation-evidence-authority.js";

/** MCP —— eager 连接外部 server，使工具目录进入 system prompt。 */
const mcpSurface: AccessSurface = {
  name: "mcp",
  phase: "pre-server",
  async setup(ctx) {
    ctx.lifecycleContributions.acquire("mcpHub.dispose", () =>
      ctx.mcpHub.dispose()
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
      ...(bootstrap.mode === "trusted-home" && bootstrap.installedAuthorityGeneration
        ? {
            anchorEpoch: bootstrap.installedAuthorityGeneration.anchorEpoch,
            installedAuthorityGeneration: bootstrap.installedAuthorityGeneration,
          }
        : {}),
      configurationSnapshot: {
        config: ctx.runtimeConfiguration,
        executableVersion: ZHIXING_CLI_VERSION,
      },
      executorReadiness: ctx.executorReadiness,
      enableLocalExecutor: ctx.enabledRoles.includes("executor"),
      storageMaintenance: ctx.storageMaintenance,
      deviceCapacity: ctx.deviceCapacity,
      // 清理所有权在 setupAuthorityRuntime 内部于任何资源取得前注册进同一回滚
      // 事务;这里只采用返回的 handle,不再事后另建——事后注册会留下"恢复后、
      // 返回前失败"的无人清理窗口。
      startupRollback: ctx.startupRollback,
    });
    ctx.lifecycleContributions.contribute(
      "authorityRuntime.stopStorageMaintenance",
      authorityRuntime.startupCleanup,
    );
    ctx.authorityRuntime = authorityRuntime;
    if (ctx.enabledRoles.includes("anchor")) {
      ctx.jobRelayObligations ??= new JobRelayObligationDirectory();
    }
    if (ctx.enabledRoles.includes("executor")) {
      const admin = authorityRuntime.workspaceBindingAdmin;
      const recovery = authorityRuntime.workspaceBindingRecovery;
      if (!admin || !recovery) throw new Error("Local workspace management ports are unavailable");
      const host = createExecutorLocalWorkspaceHost({
        identity: ctx.localWorkspaceIdentity,
        host: {
          zhixingHome: ctx.zhixingHome,
          management: {
            deviceId: authorityRuntime.deviceId,
            executorId: executorIdForDevice(authorityRuntime.deviceId),
            admin,
            recovery,
            resources: authorityRuntime.executorResourceGovernor,
          },
          storageMaintenance: ctx.storageMaintenance,
        },
      });
      if (!host) throw new Error("Local workspace management host is unavailable");
      ctx.lifecycleContributions.acquire("localWorkspaceHost.close", () =>
        host.close()
      );
      await host.start();
      if (!authorityRuntime.environment) {
        throw new Error("Executor evidence requires the local environment authority");
      }
      const evidenceHandler = new ExecutorEvidenceHandler({
        executorId: authorityRuntime.executorId,
        environment: authorityRuntime.environment,
        journal: new EvidenceJournal({
          file: path.join(
            ctx.zhixingHome,
            "distributed-runtime",
            "evidence",
            `${authorityRuntime.executorId}.jsonl`,
          ),
          verifier: authorityRuntime.verifier,
        }),
        signer: authorityRuntime.signer,
        verifier: authorityRuntime.verifier,
        verifyCurrentOwner: createConversationEvidenceAuthorityVerifier({
          authority: authorityRuntime,
          currentAnchorDeviceId: () =>
            ctx.meshBootstrap.mode === "trusted-home"
              ? ctx.meshRuntime?.currentAnchorDeviceId() ??
                ctx.meshBootstrap.trust.issuer.deviceId
              : authorityRuntime.deviceId,
        }),
        capacity: ctx.advancementCapacity,
      });
      ctx.lifecycleContributions.acquire(
        "evidenceHandler.stopAccepting",
        () => evidenceHandler.stopAccepting(),
      );
      ctx.evidenceHandler = evidenceHandler;
    }
    const jobStatus = new JobStatusDirectory();
    jobStatus.onStatus((notice) => {
      ctx.runner?.server.context.broadcastAll?.("job.status", notice);
    });
    jobStatus.onSchedulerNotice((notice) => {
      ctx.runner?.server.context.broadcastAll?.("scheduler.notice", notice);
    });
    // 三域权威 live/history 的聚合面:history 惰性路由到各域权威(装配序
    // 无关),live 由各域装配点 tee 入;第一方会话工厂按调用方 last-seen
    // 游标建立合并投影,渠道投递不经过它。
    const statusHub = new ExecutionStatusHub({
      conversationHistory: (requests) =>
        ctx.conversationProtocol
          ? ctx.conversationProtocol.statusHistory(requests)
          : Promise.resolve({ notices: [], next: requests }),
      jobHistory: async (cursors) => {
        const page = await jobStatus.statusHistory(cursors);
        return {
          notices: page.notices,
          next: page.next,
        };
      },
      deliveryHistory: async (afterByItem) =>
        (await ctx.deliveryStack?.statusHistory(afterByItem)) ?? [],
    });
    jobStatus.onStatus((notice) => statusHub.publish(notice));
    ctx.executionStatusHub = statusHub;
    ctx.firstPartyFinality = (input) =>
      new FirstPartyFinalitySession({ sources: statusHub, ...input });
    ctx.lifecycleContributions.acquire("jobStatus.dispose", () =>
      jobStatus.dispose()
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
      ...(ctx.storageMaintenance
        ? { storageMaintenance: ctx.storageMaintenance }
        : {}),
      onError: (error) =>
        console.warn(chalk.yellow(`[data-plane] ${error.message}`)),
    });
    ctx.lifecycleContributions.acquire("executorDataPlane.close", () =>
      dataPlane.close()
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
      surfaceAssets: () => authority.surfaceAssets,
      onError: (error) =>
        console.warn(chalk.yellow(`[assets] ${error.message}`)),
    });
    ctx.lifecycleContributions.acquire("assetMaintenance.stop", () =>
      maintenance.stop()
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
      ...(bootstrap.anchorIssuerKey
        ? { plannedAnchorIssuerKey: bootstrap.anchorIssuerKey }
        : {}),
      ...(bootstrap.plannedAnchorPostInstall
        ? { plannedAnchorPostInstall: bootstrap.plannedAnchorPostInstall }
        : {}),
      authority: ctx.authorityRuntime,
      protocol: ctx.conversationProtocol,
      ...(ctx.localConversationOwner
        ? { localConversationOwner: ctx.localConversationOwner }
        : {}),
      ...(ctx.jobRelayObligations
        ? { jobRelays: ctx.jobRelayObligations }
        : {}),
      ...(ctx.enabledRoles.includes("executor")
        ? {
            executor: {
              ledger: ctx.conversationProtocol.executorLedger(),
              runtimeFactory: ctx.assignmentRuntimeFactory,
              interactions: ctx.durableInteractions,
              dataPlane: ctx.executorDataPlane!,
              InProcessAssignmentSubmission:
                ctx.executorRoleModule!.InProcessAssignmentSubmission,
              ...(ctx.evidenceHandler
                ? { evidence: ctx.evidenceHandler }
                : {}),
              ...(ctx.executorJobOwner
                ? { job: { owner: ctx.executorJobOwner } }
                : {}),
            },
          }
        : {}),
      secretStore: ctx.secretStore,
      ...(ctx.meshConnectionProjection
        ? { connectionProjection: ctx.meshConnectionProjection }
        : {}),
      ...(bootstrap.localEndpoint ? { localEndpoint: bootstrap.localEndpoint } : {}),
      onError: (error) => console.warn(chalk.yellow(`[mesh] ${error.message}`)),
      ...(ctx.onTrustApplied ? { onTrustApplied: ctx.onTrustApplied } : {}),
    });
    ctx.lifecycleContributions.acquire("meshRuntime.stop", () => mesh.stop());
    await mesh.start(ctx.startupLifecycle
      ? {
          lifecycleAdmissionClosed: true,
          recoverAcceptedWork: ctx.startupLifecycle.recoverAcceptedWork,
        }
      : {});
    ctx.meshRuntime = mesh;
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
    if (!ctx.authorityRuntime || !ctx.conversationProtocol || !ctx.jobStatus) {
      throw new Error(
        "Lossless data plane requires authority, conversation, and job-status runtimes",
      );
    }
    const composition = createLosslessDataPlaneComposition({
      authority: ctx.authorityRuntime,
      ...(ctx.executorDataPlane ? { local: ctx.executorDataPlane } : {}),
      mesh: () => ctx.meshRuntime,
      interactions: new AssignmentInteractionRouter({
        ledger: ctx.conversationProtocol.executorLedger(),
        conversation: ctx.durableInteractions,
        ...(ctx.executorJobOwner ? { job: ctx.executorJobOwner } : {}),
      }),
      ...(ctx.jobRelayObligations
        ? { jobRelayObligations: ctx.jobRelayObligations }
        : {}),
      protocol: ctx.conversationProtocol,
      channels: () => ctx.channels,
      jobStatus: ctx.jobStatus,
      onDataPlaneError: (error) =>
        console.warn(chalk.yellow(`[data-plane] ${error.message}`)),
      onCoordinatorError: (error) =>
        console.warn(chalk.yellow(`[channel-coordinator] ${error.message}`)),
    });
    ctx.lifecycleContributions.acquire("losslessDataPlane.close", () =>
      composition.close()
    );
    ctx.losslessDataPlane = composition.runtime;
    ctx.channelCoordinator = composition.coordinator;
    ctx.jobRelayObligations = composition.jobRelayObligations;
  },
};

/** 会话执行面 —— 持久用户 / channel / 工作场景会话（ConversationManager）。 */
const conversationSurface: AccessSurface = {
  name: "conversation",
  phase: "pre-server",
  async setup(ctx) {
    const { transcript, snapshots, runtimeConfiguration: config } = ctx;
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
      // turn 后台维护（自动命名）是宿主维护类工作——scheduler 准入，
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
              runtimeFactory: ctx.assignmentRuntimeFactory,
              createStream: (input) =>
                ctx.executorDataPlane!.createStream(input),
            },
          }
        : {}),
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
        ctx.executionStatusHub?.publish(notice);
      },
      onFinal: (frame) => {
        ctx.sessionBroadcastRef.current?.(
          frame.conversationId,
          SESSION_NOTIFICATIONS.final,
          frame,
        );
      },
      onPublishResult: (notice) => {
        ctx.sessionBroadcastRef.current?.(
          notice.conversationId,
          SESSION_NOTIFICATIONS.event,
          createControlSessionEventEnvelope({
            conversationId: notice.conversationId,
            runId: notice.runId,
            seq: notice.seq,
            event: "publish:result",
            payload: notice,
          }),
        );
      },
      onFirstPartyFrame: (frame) => {
        if (frame.ref.execution !== "conversation") return;
        ctx.sessionBroadcastRef.current?.(
          frame.ref.conversationId,
          SESSION_NOTIFICATIONS.assignmentStream,
          frame,
        );
      },
      createFirstPartyFinality: (input) => {
        const factory = ctx.firstPartyFinality;
        if (!factory) {
          throw new Error("First-party finality projection is not assembled");
        }
        return factory(input);
      },
      projectLifecycle: async (input) => {
        if (input.mutation === "clear") {
          await projectConversationClear({
            conversationId: input.conversationId,
            operationId: input.requestId,
            projection: {
              clearStoredView: async (conversationId) => {
                await ctx.conversationIdentityLifecycle.ensureShell(
                  conversationId,
                );
                return ctx.conversationClearProjection.clearStoredView(
                  conversationId,
                );
              },
              clearRuntimeView: (conversationId, persist) =>
                manager.clear(conversationId, persist),
            },
            publishFact: (fact) => {
              ctx.sessionBroadcastRef.current?.(
                fact.conversationId,
                SESSION_NOTIFICATIONS.changed,
                { conversationId: fact.conversationId, change: "cleared" },
              );
            },
          });
          return;
        }
        await projectConversationDelete({
          conversationId: input.conversationId,
          operationId: input.requestId,
          deletionAlreadyCommitted: true,
          dependentFailure: "propagate",
          projection: createAnchorConversationDeleteProjectionPort({
            conversations: manager,
            storage: {
              exists: (conversationId) =>
                ctx.conversationIdentityLifecycle.identityExists(
                  conversationId,
                ),
              deleteStoredConversation: (conversationId) =>
                ctx.conversationDeleteProjection.deleteStoredConversation(
                  conversationId,
                ),
            },
            related: {
              cancelDependentLifecycle: (conversationId) =>
                ctx.advancementConversationLifecycle.cancelConversationLifecycle(
                  conversationId,
                ),
              removeDependentData: (conversationId) =>
                ctx.advancementConversationLifecycle.removeConversationData(
                  conversationId,
                ),
            },
          }),
          publishFact: (fact) => {
            ctx.sessionBroadcastRef.current?.(
              fact.conversationId,
              SESSION_NOTIFICATIONS.changed,
              { conversationId: fact.conversationId, change: "deleted" },
            );
          },
        });
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
        await protocol.ensureSession(conversationId);
        await ctx.conversationIdentityLifecycle.initializeRuntimeStorage(
          conversationId,
        );
      },
      appendRun: async (conversationId, input) => {
        const s = storesFor(conversationId);
        return await s.transcript.appendRunRecord(s.localId, input);
      },
      appendCommittedRun: async (conversationId, input) => {
        const s = storesFor(conversationId);
        return await s.transcript.appendCommittedRunRecord(s.localId, input);
      },
      applyCommittedSessionMutations: async (conversationId, mutations) => {
        const { repo, localId } = ctx.conversationRepoFor(conversationId);
        for (const record of [...mutations].sort((a, b) => a.seq - b.seq)) {
          if (record.mutation.kind === "task-list-op") {
            await repo.updateTaskListState(localId, record.mutation.op.state);
            ctx.taskListService.acceptCommitted(
              conversationId,
              record.mutation.op.state,
            );
            const fact = createConversationTaskListChangedFact(
              conversationId,
              record.mutation.op.state,
            );
            ctx.sessionBroadcastRef.current?.(
              conversationId,
              SESSION_NOTIFICATIONS.changed,
              {
                conversationId: fact.conversationId,
                change: "taskList",
                taskList: fact.taskList,
              } satisfies SessionChangedPayload,
            );
            continue;
          }
          await repo.appendSegmentMeta(localId, record.mutation.segment);
        }
      },
      writeSnapshot: async (conversationId, input) => {
        const s = storesFor(conversationId);
        await s.snapshots.write(s.localId, input);
      },
      confirmationHub: ctx.confirmationHub,
      durableTurnExecutor: protocol,
    });
    protocol.bindManager(manager);
    protocol.assertManagerBound();
    const conversationExists = (conversationId: string) =>
      ctx.conversationIdentityLifecycle.identityExists(conversationId);
    const proxyTurns = createAdvancementProxyTurnPort({
      manager,
      sessionBroadcast: () => ctx.sessionBroadcastRef.current,
      conversationExists,
    });
    const reviewResults = ctx.advancement
      ? new AdvancementReviewResultProjectionApplicationService({
          events: createAdvancementEventSink(
            () => ctx.sessionBroadcastRef.current,
          ),
          proxySchedule: createAdvancementReviewProxySchedulePort(proxyTurns),
        })
      : undefined;
    const advancementRecovery =
      ctx.advancement && reviewResults
          ? createAdvancementRecoveryMaintenance({
            advancement: ctx.advancement,
            reviews: ctx.advancementReviews,
            directory: ctx.advancementDirectory,
            proxyTurns,
            originalTasks: createAdvancementOriginalTaskAdmissionPort(
              manager,
              { conversationExists },
            ),
            events: createAdvancementEventSink(
              () => ctx.sessionBroadcastRef.current,
            ),
            reviewResults,
            logger: console,
          })
        : undefined;
    const advancementAcceptedTurns =
      ctx.advancement && advancementRecovery && reviewResults
        ? new AdvancementAcceptedTurnApplicationService({
            catchUp: {
              catchUpAcceptedTurn: (conversationId, beforeRunIndex) =>
                advancementRecovery.recoverConversation(conversationId, {
                  beforeRunIndex,
                }),
            },
            review: ctx.advancementReviews,
            results: reviewResults,
          })
        : undefined;
    if (advancementRecovery) {
      protocol.bindAuxiliaryRecovery(async (conversationId) => {
        const result = await advancementRecovery.recoverConversation(conversationId);
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
      });
    }
    // All accepted turns share one fire-and-forget listener. Bind and verify it
    // before the manager becomes reachable through any production ingress.
    manager.bindTurnCommittedListener((info) => {
      turnMaintenance(info);
      advancementAcceptedTurns?.acceptCommittedTurn(info);
    });
    manager.assertTurnCommittedListenerBound();
    ctx.advancementRecovery = advancementRecovery;
    ctx.lifecycleContributions.acquire(
      "execution.abortAllAndWait",
      () => manager.abortAllAndWait(
        { kind: "external", origin: "scheduler-shutdown" },
        30_000,
      ).then(() => undefined),
    );
    if (ctx.executorDataPlane) {
      ctx.executorDataPlane.bindLedger(protocol.executorLedger());
      await ctx.executorDataPlane.start();
    }
    await protocol.recoverReadinessProjections();
    ctx.conversations = manager;
    ctx.conversationProtocol = protocol;
    ctx.conversationAuthorityRef.current = protocol;
  },
};

/** Device-local owner: internal-only and present exactly when an executor is loaded. */
const localConversationOwnerUnit: CoreAssemblyUnit = {
  name: "local-conversation-owner",
  phase: "pre-server",
  kind: "core",
  async setup(ctx) {
    if (!ctx.enabledRoles.includes("executor")) return;
    if (
      !ctx.authorityRuntime ||
      !ctx.executorRoleModule ||
      !ctx.executorDataPlane ||
      !ctx.evidenceHandler
    ) {
      throw new Error(
        "Local conversation owner requires authority, executor, data-plane, and evidence runtime",
      );
    }
    if (ctx.localConversationOwner) {
      throw new Error("Local conversation owner is already assembled");
    }
    const assembly = await LocalConversationOwnerAssembly.create({
      owner: localConversationOwnerRuntime({
        artifacts: ctx.authorityRuntime.artifacts,
        deviceId: ctx.authorityRuntime.deviceId,
        executorCapabilities: ctx.authorityRuntime.executorCapabilities,
        executorId: ctx.authorityRuntime.executorId,
        executorLog: ctx.authorityRuntime.executorLog,
        executorResourceGovernor: ctx.authorityRuntime.executorResourceGovernor,
        executionAssetCatalog: ctx.authorityRuntime.executionAssetCatalog,
        localControlAdmission: ctx.authorityRuntime.localControlAdmission,
        localDomainId: ctx.authorityRuntime.localDomainId,
        localGovernorEpoch: ctx.authorityRuntime.localGovernorEpoch,
        localOwnerEpoch: ctx.authorityRuntime.localOwnerEpoch,
        permissionSnapshotFor: ctx.authorityRuntime.permissionSnapshotFor,
        preflightLocalConversationEnvironment:
          ctx.authorityRuntime.preflightLocalConversationEnvironment,
        prepareLocalConversationAssignment:
          ctx.authorityRuntime.prepareLocalConversationAssignment,
        releaseLocalConversationEnvironmentPreflight:
          ctx.authorityRuntime.releaseLocalConversationEnvironmentPreflight,
        signer: ctx.authorityRuntime.signer,
        storageMaintenance: ctx.authorityRuntime.storageMaintenance,
        validateConversationRuntimeBinding:
          ctx.authorityRuntime.validateConversationRuntimeBinding,
        validateLocalConversationManifest:
          ctx.authorityRuntime.validateLocalConversationManifest,
        verifier: ctx.authorityRuntime.verifier,
      }),
      ConversationAssignmentLedger:
        ctx.executorRoleModule.ConversationAssignmentLedger,
      InProcessAssignmentSubmission:
        ctx.executorRoleModule.InProcessAssignmentSubmission,
      runtimeFactory: ctx.assignmentRuntimeFactory,
      interactions: ctx.durableInteractions,
      advancementModelProvider: createHostAdvancementModelProviderFactory({
        config: ctx.runtimeConfiguration,
        credentials: ctx.providerCredentials ?? {},
      }),
      dataPlane: ctx.executorDataPlane,
      evidence: ctx.evidenceHandler,
      currentAnchorDeviceId: () =>
        ctx.meshBootstrap.mode === "trusted-home"
          ? ctx.meshRuntime?.currentAnchorDeviceId() ??
            ctx.meshBootstrap.trust.issuer.deviceId
          : ctx.authorityRuntime!.deviceId,
    });
    ctx.lifecycleContributions.acquire("localConversationOwner.close", () =>
      assembly.close()
    );
    await assembly.start(ctx.startupLifecycle
      ? {
          lifecycle: {
            operationId: ctx.startupLifecycle.delivery.operationId,
            kind: ctx.startupLifecycle.kind,
            recoverAcceptedWork: ctx.startupLifecycle.recoverAcceptedWork,
            alreadySettled: ctx.startupLifecycle.alreadySettled,
          },
        }
      : {});
    ctx.localConversationOwner = assembly;
  },
};

/**
 * Stable executor-owned job convergence owner.
 *
 * The worker is created before optional transports so every adapter receives
 * the same instance. Readiness is published only after recovery is scheduled.
 */
const executorJobOwnerUnit: CoreAssemblyUnit = {
  name: "executor-job-owner",
  phase: "pre-server",
  kind: "core",
  async setup(ctx) {
    if (!ctx.enabledRoles.includes("executor")) return;
    if (
      !ctx.authorityRuntime ||
      !ctx.executorDataPlane ||
      !ctx.executorRoleModule ||
      !ctx.conversationProtocol ||
      !ctx.jobRuntime
    ) {
      throw new Error(
        "Executor job owner requires authority, ledger, data-plane, module, and job runtime",
      );
    }
    if (ctx.executorJobOwner) {
      throw new Error("Executor job owner is already assembled");
    }
    if (ctx.enabledRoles.includes("anchor")) {
      ctx.jobRelayObligations ??= new JobRelayObligationDirectory();
    }
    const assembly = new ExecutorJobOwnerAssembly({
      ledger: ctx.conversationProtocol.executorLedger(),
      runtime: ctx.jobRuntime,
      submissionFor: (envelope, signal) => {
        const local =
          ctx.jobRelayObligations?.submissionFor(envelope.assignmentId);
        if (local) return local;
        if (ctx.enabledRoles.includes("anchor")) {
          return ctx.jobRelayObligations!.waitForSubmission(
            envelope.assignmentId,
            signal,
          );
        }
        const mesh = ctx.meshRuntime;
        if (mesh) return mesh.submissionForAnchor();
        throw new JobInteractionRuntimeUnavailableError(
          "Job assignment owner submission is not registered",
        );
      },
      finalizeUsage: ({ assignmentId }) => {
        const authority = ctx.authorityRuntime!;
        if (ctx.enabledRoles.includes("anchor")) {
          return authority.executorResourceGovernor.flushAssignment(
            assignmentId,
            authority.resourceGovernor,
            (report) =>
              usageReporterContext(report.reporterId, report.digest),
          );
        }
        const mesh = ctx.meshRuntime;
        if (!mesh) {
          throw new JobInteractionRuntimeUnavailableError(
            "Executor usage transport is not ready",
          );
        }
        return mesh.finalizeExecutorUsage(assignmentId);
      },
      globalQueryFor: (capability, anchorEpoch) => {
        const authority = ctx.authorityRuntime!;
        if (ctx.enabledRoles.includes("anchor")) {
          if (!authority.globalState) {
            throw new JobInteractionRuntimeUnavailableError(
              "Anchor global authority state is unavailable",
            );
          }
          return createAssignmentGlobalQueryPort({
            state: authority.globalState,
            capability,
            anchorEpoch,
          });
        }
        if (!ctx.meshRuntime) {
          throw new JobInteractionRuntimeUnavailableError(
            "Job assignment global query transport is not registered",
          );
        }
        return ctx.meshRuntime.globalQueryForAnchor(capability, anchorEpoch);
      },
      InProcessAssignmentSubmission:
        ctx.executorRoleModule.InProcessAssignmentSubmission,
      resourceGovernor: ctx.authorityRuntime.executorResourceGovernor,
      createStream: (input) => ctx.executorDataPlane!.createStream(input),
      onError: (_assignmentId, error) =>
        console.warn(chalk.yellow(`[job-worker] ${error.message}`)),
    });
    ctx.executorJobOwnerAssembly = assembly;
    ctx.executorJobOwner = assembly.owner;
  },
};

/**
 * Starts durable recovery only after every enabled adapter has received the
 * stable owner reference. Keeping this as a core unit prevents any optional
 * transport from owning the job capability lifecycle.
 */
const executorJobOwnerStartUnit: CoreAssemblyUnit = {
  name: "executor-job-owner-start",
  phase: "pre-server",
  kind: "core",
  async setup(ctx) {
    const assembly = ctx.executorJobOwnerAssembly;
    if (!assembly) return;
    ctx.lifecycleContributions.acquire("executorJobOwner.close", () =>
      assembly.close()
    );
    await assembly.start(ctx.startupLifecycle
      ? {
          admissionClosed: true,
          recoverAcceptedWork: ctx.startupLifecycle.recoverAcceptedWork,
        }
      : {});
  },
};

/** 社交通道 —— 先装稳定门面，外部连接异步进入状态机；setup 失败非致命。 */
function createChannelSurface(credentials: ChannelCredentialProjection): AccessSurface {
  return {
    name: "channel",
    phase: "pre-server",
    async setup(ctx) {
      const {
        conversations,
        runtimeConfiguration: config,
        losslessDataPlane,
      } = ctx;
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
      const isCurrentChannelOwner = () => {
        if (ctx.meshBootstrap.mode === "single-machine") return true;
        const currentDeviceId = ctx.meshRuntime?.currentAnchorDeviceId() ??
          ctx.meshBootstrap.trust.issuer.deviceId;
        const ready = ctx.meshRuntime?.plannedCurrentOwnerReady() ??
          ctx.meshBootstrap.plannedAnchorPostInstall === undefined;
        return currentDeviceId === ctx.meshBootstrap.deviceKey.deviceId && ready;
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
          // callback 可等待:耐久裁决完成才向平台确认;失败上抛让平台重投,
          // 耐久层同键幂等保证重投只回放原结果——绝不 fire-and-forget。
          onChallengeAction: (action) => {
            const coordinator = ctx.channelCoordinator;
            if (!coordinator) {
              return Promise.reject(
                new Error("Channel interaction coordinator is not assembled"),
              );
            }
            return coordinator.handleChallengeAction(action);
          },
          registerHttpRoute: (path, handler) => {
            if (ctx.channelHttpRoutes.has(path)) {
              throw new Error(`Channel HTTP route already registered: ${path}`);
            }
            ctx.channelHttpRoutes.set(path, handler);
          },
          isCurrentOwner: isCurrentChannelOwner,
          connectImmediately: isCurrentChannelOwner() && !ctx.startupLifecycle,
        });
        ctx.lifecycleContributions.acquire("channels.dispose", () =>
          result.registry.dispose()
        );
        losslessDataPlane.bindChannels(result.registry);
        ctx.channels = result.registry;
        const router = result.router;
        ctx.inboundRouter = router;
        if (router) {
          ctx.lifecycleContributions.acquire(
            "inboundRouter.refuseNew",
            () => router.refuseNewMessages(),
          );
        }
        if (ctx.startupLifecycle) router?.refuseNewMessages();
        ctx.channelConnections = {
          ready: result.connectionTask,
          connectConfigured: result.connectConfigured,
          disconnectConfigured: result.disconnectConfigured,
          suspendConfigured: result.suspendConfigured,
          resumeConfigured: result.resumeConfigured,
        };
        // 渠道在场后恢复耐久开放义务(job relay 会话按权威日志重建;
        // conversation 义务由协议恢复循环幂等重开)。
        if (!ctx.startupLifecycle || ctx.startupLifecycle.recoverAcceptedWork) {
          await ctx.channelCoordinator?.recover();
        }
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
    const { channels, runtimeConfiguration: config, zhixingHome } = ctx;
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
    ctx.lifecycleContributions.contribute(
      "deliveryStack.stop",
      deliveryStack.startupCleanup,
    );
    ctx.deliveryStack = deliveryStack;
    if (ctx.startupLifecycle) {
      await deliveryStack.lifecycle.restore(ctx.startupLifecycle.delivery);
      deliveryStack.lifecycle.close();
    }
    deliveryStack.onStatus((notice) => {
      ctx.executionStatusHub?.publish(notice);
    });
    ctx.conversationProtocol?.bindDeliveryDrain(() =>
      deliveryStack.flush(),
    );
    if (ctx.inboundRouter) {
      ctx.inboundRouter.setOutboxRegistry(deliveryStack.outboxRegistry);
    }
  },
};

/**
 * 远程确认桥 —— hub 事件 → RPC notification；依赖 runServer 之后的 server.connections
 * 与会话执行面。post-server 阶段取得同一 rollback provenance handle，随后由
 * activation gate 统一移交正常关闭链。
 */
const confirmationBridgeSurface: AccessSurface = {
  name: "confirmation-bridge",
  phase: "post-server",
  async setup(ctx) {
    const { conversations, confirmationHub, runner } = ctx;
    if (!conversations || !runner) return;
    const confirmationBridge = createConfirmationBridge({
      connections: runner.server.connections,
      hub: confirmationHub,
      conversations,
    });
    ctx.lifecycleContributions.acquire(
      "confirmationBridge.dispose",
      () => confirmationBridge.dispose(),
    );
  },
};

/** Work resumption starts only after RPC, channel, delivery and confirmation consumers exist. */
const conversationRecoverySurface: AccessSurface = {
  name: "conversation-recovery",
  phase: "post-server",
  async setup(ctx) {
    const protocol = ctx.conversationProtocol;
    if (!protocol || ctx.startupLifecycle) return;
    ctx.lifecycleContributions.acquire(
      "conversationProtocol.stopRecovery",
      () => protocol.stopRecoveryLoop(),
    );
    protocol.startRecoveryLoop();
  },
};

/**
 * 全部有序装配单元，按 pre-server 依赖拓扑序排列（post-server 项排最后）。
 * 可选接入面还须加入 PROFILES；稳定核心单元不得进入 profile。
 */
export function createAssemblyUnits(
  channelCredentials: ChannelCredentialProjection,
): readonly AssemblyUnit[] {
  return [
    mcpSurface,
    authorityRuntimeSurface,
    executorDataPlaneSurface,
    conversationSurface,
    localConversationOwnerUnit,
    executorJobOwnerUnit,
    assetMaintenanceSurface,
    meshSurface,
    losslessDataPlaneSurface,
    executorJobOwnerStartUnit,
    createChannelSurface(channelCredentials),
    deliverySurface,
    confirmationBridgeSurface,
    conversationRecoverySurface,
  ];
}

function usageReporterContext(
  executorId: string,
  reportDigest: string,
): AuthorityCallContext {
  return {
    principal: { kind: "usage-reporter", executorId },
    requestId: `usage-report:${reportDigest}`,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
}
