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
  renderRecentContextFromMessages,
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
  type ChannelCredentialProjection,
} from "@zhixing/providers";
import {
  createInboundChannelRouter,
  setupChannels,
} from "./channels.js";
import { ChannelConversationProductBinding } from "./channel-conversation-product-binding.js";
import {
  ExecutionStatusHub,
  FirstPartyFinalitySession,
} from "./first-party-finality-session.js";
import {
  setupDelivery,
} from "../setup-delivery.js";
import {
  MeshConversationExecutorTopologyDirectory,
  MeshRuntimeAssembly,
  executorIdForDevice,
} from "./mesh-runtime-assembly.js";
import { createAssignmentArtifactReceiverInfrastructure } from "./assignment-artifact-receiver-infrastructure.js";
import { createConversationTransferStagingInfrastructure } from "./conversation-transfer-staging-infrastructure.js";
import { createFileMeshPairingContinuationRepository } from "./mesh-pairing-continuation.js";
import { createPersistentPairedCheckpointCommandReceiverInfrastructure } from "./paired-checkpoint-incoming-infrastructure.js";
import { projectConversationPerspectivesRuntime } from "./conversation-perspectives-correctness.js";
import { SurfaceAssetMaintenance } from "./surface-asset-maintenance.js";
import { createAnchorConversationDeleteProjectionPort } from "./conversation-delete-binding.js";
import { createTurnMaintenance } from "./turn-maintenance.js";
import { governControlTextCall } from "./governed-control-llm.js";
import {
  ConversationProtocolRuntime,
  createConversationAuxiliaryRecoveryAssemblyHandle,
  createConversationCommittedTurnListenerAssemblyHandle,
  createConversationManagerAssemblyHandle,
} from "./conversation-protocol-runtime.js";
import {
  createConversationAssignmentArtifactAuthorityIndex,
  createConversationExecutorHostBoundary,
  NO_REMOTE_CONVERSATION_EXECUTORS,
} from "./conversation-executor-dispatch.js";
import type {
  AccessSurface,
  AssemblyContext,
  AssemblyUnit,
  CoreAssemblyUnit,
} from "./access-surface.js";
import { JobStatusDirectory } from "./job-status-directory.js";
import {
  createExecutorDataPlaneAssignmentPair,
  type ExecutorDataPlaneRuntime,
} from "./executor-data-plane-runtime.js";
import { AssignmentDataPlaneTopologyAdapter } from "./assignment-data-plane-topology.js";
import { AdvancementEvidenceTopologyAdapter } from "./advancement-evidence-topology.js";
import {
  createConversationLosslessDataPlaneAssemblyHandle,
  createLosslessDataPlaneComposition,
  type ConversationLosslessDataPlaneAssemblyHandle,
} from "./lossless-data-plane-composition.js";
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
import {
  anchorConversationOwnerRuntime,
  createConversationResourceRecoveryPort,
  localConversationOwnerRuntime,
} from "./conversation-owner-runtime.js";
import { createConversationEvidenceAuthorityVerifier } from "./conversation-evidence-authority.js";
import {
  WorksceneApplicationService,
} from "@zhixing/core/workscene/application";
import { createWorksceneDirectory } from "./workscene-directory.js";
import {
  createAnchorWorksceneAdvancementApplicationPort,
  createAnchorWorksceneApplicationPorts,
} from "./workscene-application-adapter.js";

/** Durable authority substrate shared by conversation and delivery composition. */
const authorityRuntimeSurface: AccessSurface = {
  name: "authority-runtime",
  phase: "pre-server",
  async setup(ctx) {
    const authorityRuntime = ctx.authorityRuntime;
    if (!authorityRuntime) {
      throw new Error("Authority integration requires the prepared Authority runtime");
    }
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
const createMeshSurface = (): AccessSurface => ({
  name: "mesh-control",
  phase: "pre-server",
  async setup(ctx) {
    const bootstrap = ctx.meshBootstrap;
    if (!bootstrap || bootstrap.mode === "single-machine") return;
    if (
      !ctx.authorityRuntime ||
      !ctx.conversationProtocol ||
      !ctx.meshConnections ||
      !ctx.meshExecutorTopologyTrust ||
      !ctx.conversationExecutorTopologyDirectory ||
      !ctx.assignmentArtifactReceiver
    ) {
      throw new Error("Mesh control requires authority and conversation protocol runtimes");
    }
    const pairedCheckpointDeviceId = ctx.authorityRuntime.deviceId;
    const mesh = new MeshRuntimeAssembly({
      zhixingHome: ctx.zhixingHome,
      trust: bootstrap.trust,
      configuration: bootstrap.configuration,
      endpoints: bootstrap.endpoints,
      transportPeers: bootstrap.transportPeers,
      bootstrapStore: bootstrap.bootstrapStore,
      bootstrapProjection: bootstrap.bootstrapProjection,
      pairingContinuations: createFileMeshPairingContinuationRepository(
        ctx.zhixingHome,
      ),
      pairedCheckpointReceiver:
        createPersistentPairedCheckpointCommandReceiverInfrastructure({
          zhixingHome: ctx.zhixingHome,
          trust: bootstrap.trust,
          deviceId: pairedCheckpointDeviceId,
          bootstrapStore: bootstrap.bootstrapStore,
          storageMaintenance: ctx.authorityRuntime.storageMaintenance,
        }),
      ...(bootstrap.anchorIssuerKey
        ? { plannedAnchorIssuerKey: bootstrap.anchorIssuerKey }
        : {}),
      ...(bootstrap.plannedAnchorPostInstall
        ? { plannedAnchorPostInstall: bootstrap.plannedAnchorPostInstall }
        : {}),
      authority: ctx.authorityRuntime,
      assignmentArtifactReceiver: ctx.assignmentArtifactReceiver,
      conversationTransferStaging: createConversationTransferStagingInfrastructure({
        zhixingHome: ctx.zhixingHome,
      }),
      plannedAnchorTransferStaging: bootstrap.plannedAnchorTransferStaging,
      disasterRecoveryStaging: bootstrap.disasterRecoveryStaging,
      protocol: ctx.conversationProtocol,
      executorTopologyDirectory: ctx.conversationExecutorTopologyDirectory,
      executorTopologyTrust: ctx.meshExecutorTopologyTrust,
      connections: ctx.meshConnections,
      ...(ctx.localConversationOwner
        ? { localConversationOwner: ctx.localConversationOwner }
        : {}),
      ...(ctx.jobRelayObligations
        ? { jobRelays: ctx.jobRelayObligations }
        : {}),
      ...(ctx.enabledRoles.includes("executor")
        ? {
            executor: {
              ledger: ctx.conversationExecutorLedger!,
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
      ...(bootstrap.localEndpoint ? { localEndpoint: bootstrap.localEndpoint } : {}),
      onError: (error) => console.warn(chalk.yellow(`[mesh] ${error.message}`)),
      ...(ctx.onTrustApplied ? { onTrustApplied: ctx.onTrustApplied } : {}),
    });
    const preparation = Object.freeze({
      connections: mesh.connections,
      advancementEvidence: mesh,
      assignmentDataPlane: mesh,
      currentAnchorDeviceId: () => mesh.currentAnchorDeviceId(),
      plannedCurrentOwnerReady: () => mesh.plannedCurrentOwnerReady(),
      start: async (
        options: Parameters<MeshRuntimeAssembly["start"]>[0],
      ) => {
        await mesh.start(options);
        return mesh;
      },
      stop: () => mesh.stop(),
    });
    ctx.lifecycleContributions.acquire("meshRuntime.stop", preparation.stop);
    ctx.meshRuntimePreparation = preparation;
  },
});

/** Host-owned local/Mesh evidence selector installed after every mechanism exists. */
const advancementEvidenceTopologyUnit: CoreAssemblyUnit = {
  name: "advancement-evidence-topology",
  phase: "pre-server",
  kind: "core",
  async setup(ctx) {
    if (!ctx.enabledRoles.includes("anchor")) return;
    const authority = ctx.authorityRuntime;
    const protocol = ctx.conversationProtocol;
    if (!authority || !protocol) {
      throw new Error(
        "Advancement evidence topology requires authority and conversation runtimes",
      );
    }
    ctx.advancementEvidenceRuntime.bind({
      signer: authority.signer,
      verifier: authority.verifier,
      resolveTarget: (conversationId, runId) =>
        protocol.advancementEvidenceTarget(conversationId, runId),
      targets: new AdvancementEvidenceTopologyAdapter({
        ...(ctx.evidenceHandler
          ? {
              local: {
                executorId: authority.executorId,
                client: ctx.evidenceHandler,
              },
            }
          : {}),
        ...(ctx.meshRuntimePreparation
          ? { remote: ctx.meshRuntimePreparation.advancementEvidence }
          : {}),
      }),
    });
  },
};

/**
 * S6 无损数据面唯一产品组合根。
 *
 * Channel mechanism 先以显式 available/absent profile 完成；随后 conversation
 * 协议、executor 端点、mesh adapter 与 challenge effect 一次性形成闭环。
 */
const createLosslessDataPlaneSurface = (
  assembly: ConversationLosslessDataPlaneAssemblyHandle,
): AccessSurface => ({
  name: "lossless-data-plane",
  phase: "pre-server",
  async setup(ctx) {
    if (!ctx.enabledRoles.includes("anchor")) return;
    if (!ctx.authorityRuntime || !ctx.conversationProtocol || !ctx.jobStatus) {
      throw new Error(
        "Lossless data plane requires authority, conversation, and job-status runtimes",
      );
    }
    const channelMechanism = ctx.channelMechanism;
    if (!channelMechanism) {
      throw new Error("Lossless data plane requires a selected Channel mechanism");
    }
    const channelChallenges = channelMechanism.kind === "available"
      ? { kind: "available" as const, delivery: channelMechanism.channels.challenges }
      : { kind: "absent" as const, reason: channelMechanism.reason };
    const composition = createLosslessDataPlaneComposition({
      verifier: ctx.authorityRuntime.verifier,
      targets: new AssignmentDataPlaneTopologyAdapter({
        ...(ctx.executorDataPlane
          ? {
              local: {
                executorId: ctx.authorityRuntime.executorId,
                ownerDeviceId: ctx.authorityRuntime.deviceId,
                transport: ctx.executorDataPlane.localTransport,
                interactions: new AssignmentInteractionRouter({
                  ledger: ctx.conversationExecutorLedger!,
                  conversation: ctx.durableInteractions,
                  ...(ctx.executorJobOwner ? { job: ctx.executorJobOwner } : {}),
                }),
              },
            }
          : {}),
        ...(ctx.meshRuntimePreparation
          ? { remote: ctx.meshRuntimePreparation.assignmentDataPlane }
          : {}),
      }),
      ...(ctx.jobRelayObligations
        ? { jobRelayObligations: ctx.jobRelayObligations }
        : {}),
      channelChallenges,
      isCurrentOwner: () => isCurrentChannelOwner(ctx),
      jobStatus: ctx.jobStatus,
      onDataPlaneError: (error) =>
        console.warn(chalk.yellow(`[data-plane] ${error.message}`)),
      onCoordinatorError: (error) =>
        console.warn(chalk.yellow(`[channel-coordinator] ${error.message}`)),
    });
    ctx.lifecycleContributions.acquire("losslessDataPlane.close", () =>
      composition.close()
    );
    assembly.complete(composition.coordinator);
    ctx.losslessDataPlane = composition.runtime;
    ctx.channelCoordinator = composition.coordinator;
    ctx.channelChallengeAction = composition.onChallengeAction;
    ctx.jobRelayObligations = composition.jobRelayObligations;
  },
});

/** 会话执行面 —— 持久用户 / channel / 工作场景会话（ConversationManager）。 */
const createConversationSurface = (
  losslessDataPlane: ConversationLosslessDataPlaneAssemblyHandle,
): AccessSurface => ({
  name: "conversation",
  phase: "pre-server",
  async setup(ctx) {
    if (!ctx.authorityRuntime) {
      throw new Error("Conversation surface requires the durable authority runtime");
    }

    const turnMaintenance = createTurnMaintenance({
      convRepo: ctx.conversationNamingStorage,
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
        ctx.sessionBroadcast(
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
    const managerAssembly = createConversationManagerAssemblyHandle();
    const auxiliaryRecoveryAssembly =
      createConversationAuxiliaryRecoveryAssemblyHandle();
    const committedTurnListenerAssembly =
      createConversationCommittedTurnListenerAssemblyHandle();
    const assignmentArtifacts = createConversationAssignmentArtifactAuthorityIndex();
    let topologyDirectory = NO_REMOTE_CONVERSATION_EXECUTORS;
    if (ctx.meshBootstrap.mode !== "single-machine") {
      if (!ctx.meshConnections || !ctx.meshExecutorTopologyTrust) {
        throw new Error("Conversation executor requires the Host mesh topology ports");
      }
      const receiver = createAssignmentArtifactReceiverInfrastructure({
        zhixingHome: ctx.zhixingHome,
        artifacts: ctx.authorityRuntime.artifacts,
      });
      topologyDirectory = new MeshConversationExecutorTopologyDirectory({
        trust: ctx.meshExecutorTopologyTrust,
        connections: ctx.meshConnections,
        localDeviceId: ctx.authorityRuntime.deviceId,
        artifacts: ctx.authorityRuntime.artifacts,
        receiver,
        signer: ctx.authorityRuntime.signer,
        verifier: ctx.authorityRuntime.verifier,
        assignmentArtifacts,
      });
      ctx.assignmentArtifactReceiver = receiver;
    }
    const conversationAuthority = anchorConversationOwnerRuntime(ctx.authorityRuntime);
    let dataPlane: ExecutorDataPlaneRuntime | undefined;
    const executorBoundary = ctx.executorRoleModule
      ? (() => {
          const pair = createExecutorDataPlaneAssignmentPair(
            {
              zhixingHome: ctx.zhixingHome,
              authority: ctx.authorityRuntime!,
              module: ctx.executorRoleModule!,
              ...(ctx.storageMaintenance
                ? { storageMaintenance: ctx.storageMaintenance }
                : {}),
              onError: (error) =>
                console.warn(chalk.yellow(`[data-plane] ${error.message}`)),
            },
            (dataPlaneAssembly) => {
              const boundary = createConversationExecutorHostBoundary({
                authority: conversationAuthority,
                directory: topologyDirectory,
                clock: () => new Date().toISOString(),
                local: {
                  ConversationAssignmentLedger:
                    ctx.executorRoleModule!.ConversationAssignmentLedger,
                  InProcessAssignmentSubmission:
                    ctx.executorRoleModule!.InProcessAssignmentSubmission,
                  dataPlaneTickets: dataPlaneAssembly.assignmentTickets,
                  runtimeFactory: ctx.assignmentRuntimeFactory,
                  createStream: dataPlaneAssembly.createStream,
                },
              });
              if (!boundary.localLedger) {
                throw new Error(
                  "Conversation executor pair did not provide its local ledger",
                );
              }
              return Object.freeze({
                assignment: boundary,
                authority: boundary.localLedger,
              });
            },
          );
          dataPlane = pair.dataPlane;
          ctx.lifecycleContributions.acquire("executorDataPlane.close", () =>
            pair.dataPlane.close()
          );
          return pair.assignment;
        })()
      : createConversationExecutorHostBoundary({
          authority: conversationAuthority,
          directory: topologyDirectory,
          clock: () => new Date().toISOString(),
        });
    const protocol = new ConversationProtocolRuntime({
      authority: ctx.authorityRuntime,
      manager: managerAssembly.resolve,
      recoverAuxiliary: auxiliaryRecoveryAssembly.resolve,
      losslessDataPlane: Object.freeze({
        kind: "available",
        port: losslessDataPlane.port,
      }),
      executorDispatch: executorBoundary.application,
      assignmentArtifactAuthority: assignmentArtifacts,
      ...(executorBoundary.staging
        ? { assignmentStaging: executorBoundary.staging }
        : {}),
      interactions: ctx.durableInteractions,
      executeRecoveredPerspective: async (input) => {
        const execution = await ctx.conversationPerspectives.executePerspectiveWork({
          runtime: projectConversationPerspectivesRuntime(
            input.managed,
            input.managed.runtime,
          ),
          originalInput: input.originalInput,
          question: input.question,
          source: input.source,
          ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          turnContext: input.turnContext,
          ...(input.authorizeToolExecution
            ? { authorizeToolExecution: input.authorizeToolExecution }
            : {}),
          ...(input.modelCallMetering
            ? { modelCallMetering: input.modelCallMetering }
            : {}),
        });
        return execution.runResult;
      },
      onStatus: (notice) => {
        ctx.sessionBroadcast(
          notice.ref.conversationId,
          SESSION_NOTIFICATIONS.status,
          notice,
        );
        ctx.executionStatusHub?.publish(notice);
      },
      onFinal: (frame) => {
        ctx.sessionBroadcast(
          frame.conversationId,
          SESSION_NOTIFICATIONS.final,
          frame,
        );
      },
      onPublishResult: (notice) => {
        ctx.sessionBroadcast(
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
        ctx.sessionBroadcast(
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
              ctx.sessionBroadcast(
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
                advancementConversationLifecycle.cancelConversationLifecycle(
                  conversationId,
                ),
              removeDependentData: (conversationId) =>
                advancementConversationLifecycle.removeConversationData(
                  conversationId,
                ),
            },
          }),
          publishFact: (fact) => {
            ctx.sessionBroadcast(
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
      ...ctx.conversationRuntimeStorage,
      ensureConversation: async (conversationId) => {
        await protocol.ensureSession(conversationId);
        await ctx.conversationIdentityLifecycle.initializeRuntimeStorage(
          conversationId,
        );
      },
      applyCommittedSessionMutations: async (conversationId, mutations) => {
        for (const record of [...mutations].sort((a, b) => a.seq - b.seq)) {
          if (record.mutation.kind === "task-list-op") {
            await ctx.conversationCommittedViewStorage.persistTaskList(
              conversationId,
              record.mutation.op.state,
            );
            ctx.taskListService.acceptCommitted(
              conversationId,
              record.mutation.op.state,
            );
            const fact = createConversationTaskListChangedFact(
              conversationId,
              record.mutation.op.state,
            );
            ctx.sessionBroadcast(
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
          await ctx.conversationCommittedViewStorage.appendSegment(
            conversationId,
            record.mutation.segment,
          );
        }
      },
      confirmationHub: ctx.confirmationHub,
      durableTurnExecutor: protocol,
      onTurnCommitted: committedTurnListenerAssembly.notify,
    });
    managerAssembly.complete(manager);
    const advancementComposition =
      await ctx.advancementConversationComposition.create({
        sessionState: protocol.sessionState,
        recentContext: Object.freeze({
          read: async (conversationId: string) =>
            renderRecentContextFromMessages(
              manager.getHistory(conversationId, 6),
            ),
        }),
      });
    const advancementController = advancementComposition.controller;
    const advancementReviews = advancementComposition.reviews;
    const advancementConversationLifecycle = advancementComposition.lifecycle;
    const conversationExists = (conversationId: string) =>
      ctx.conversationIdentityLifecycle.identityExists(conversationId);
    const proxyTurns = createAdvancementProxyTurnPort({
      manager,
      sessionBroadcast: ctx.sessionBroadcast,
      conversationExists,
    });
    const reviewResults = new AdvancementReviewResultProjectionApplicationService({
      events: createAdvancementEventSink(ctx.sessionBroadcast),
      proxySchedule: createAdvancementReviewProxySchedulePort(proxyTurns),
    });
    const advancementRecovery = createAdvancementRecoveryMaintenance({
      advancement: advancementController,
      reviews: advancementReviews,
      directory: ctx.advancementDirectory,
      proxyTurns,
      originalTasks: createAdvancementOriginalTaskAdmissionPort(
        manager,
        { conversationExists },
      ),
      events: createAdvancementEventSink(ctx.sessionBroadcast),
      reviewResults,
      logger: console,
    });
    const advancementAcceptedTurns =
      new AdvancementAcceptedTurnApplicationService({
        catchUp: {
          catchUpAcceptedTurn: (conversationId, beforeRunIndex) =>
            advancementRecovery.recoverConversation(conversationId, {
              beforeRunIndex,
            }),
        },
        review: advancementReviews,
        results: reviewResults,
      });
    auxiliaryRecoveryAssembly.complete(async (conversationId) => {
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
    // Complete the constructor-owned fire-and-forget listener before the
    // manager becomes reachable through any production ingress.
    committedTurnListenerAssembly.complete((info) => {
      turnMaintenance(info);
      advancementAcceptedTurns.acceptCommittedTurn(info);
    });
    const worksceneDirectory = createWorksceneDirectory({
      authority: ctx.worksceneAuthority,
      conversations: manager,
      conversationAuthority: protocol,
      conversationStorageProjectionCleanup:
        ctx.worksceneConversationStorageProjectionCleanup,
      sceneStorageRemoval: ctx.worksceneSceneStorageRemoval,
    });
    const worksceneApplicationPorts =
      createAnchorWorksceneApplicationPorts(worksceneDirectory);
    const worksceneAdvancementApplicationPort =
      createAnchorWorksceneAdvancementApplicationPort({
        recovery: advancementRecovery,
        activeState: advancementReviews,
        logger: console,
      });
    const worksceneApplication = new WorksceneApplicationService(
      worksceneApplicationPorts.management,
      worksceneApplicationPorts.workspaces,
      worksceneApplicationPorts.entry,
      worksceneApplicationPorts.runtime,
      worksceneAdvancementApplicationPort,
    );
    ctx.advancementRecovery = advancementRecovery;
    ctx.advancement = advancementController;
    ctx.advancementReviews = advancementReviews;
    ctx.advancementConversationLifecycle = advancementConversationLifecycle;
    ctx.lifecycleContributions.acquire(
      "execution.abortAllAndWait",
      () => manager.abortAllAndWait(
        { kind: "external", origin: "scheduler-shutdown" },
        30_000,
      ).then(() => undefined),
    );
    if (dataPlane) await dataPlane.start();
    await protocol.recoverReadinessProjections();
    ctx.conversations = manager;
    ctx.conversationProtocol = protocol;
    ctx.worksceneDirectory = worksceneDirectory;
    ctx.worksceneApplication = worksceneApplication;
    ctx.conversationExecutorDispatch = executorBoundary.application;
    ctx.conversationExecutorTopologyDirectory = topologyDirectory;
    ctx.conversationAssignmentStaging = executorBoundary.staging;
    ctx.conversationExecutorLedger = executorBoundary.localLedger;
    ctx.executorDataPlane = dataPlane;
  },
});

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
    const executorResources = ctx.authorityRuntime.executorResourceGovernor;
    const localOwner = localConversationOwnerRuntime({
      artifacts: ctx.authorityRuntime.artifacts,
      deviceId: ctx.authorityRuntime.deviceId,
      executorCapabilities: ctx.authorityRuntime.executorCapabilities,
      executorId: ctx.authorityRuntime.executorId,
      executorLog: ctx.authorityRuntime.executorLog,
      resources: executorResources,
      executionResources: executorResources,
      assignmentResources: executorResources,
      resourceRecovery: createConversationResourceRecoveryPort({
        primary: executorResources,
        acceptedWork: executorResources,
      }),
      finalizeUsage: (assignmentId) =>
        executorResources.finalizeLocalAssignment(assignmentId),
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
    });
    const localExecutorBoundary = createConversationExecutorHostBoundary({
      authority: localOwner,
      directory: NO_REMOTE_CONVERSATION_EXECUTORS,
      clock: () => new Date().toISOString(),
      local: {
        ConversationAssignmentLedger:
          ctx.executorRoleModule.ConversationAssignmentLedger,
        InProcessAssignmentSubmission:
          ctx.executorRoleModule.InProcessAssignmentSubmission,
        runtimeFactory: ctx.assignmentRuntimeFactory,
        dataPlaneTickets: ctx.executorDataPlane.assignmentTickets,
        createStream: (input) => ctx.executorDataPlane!.createStream(input),
      },
    });
    if (!localExecutorBoundary.staging) {
      throw new Error("Local Conversation owner requires assignment staging");
    }
    const assembly = await LocalConversationOwnerAssembly.create({
      owner: localOwner,
      executorDispatch: localExecutorBoundary.application,
      assignmentStaging: localExecutorBoundary.staging,
      runtimeFactory: ctx.assignmentRuntimeFactory,
      interactions: ctx.durableInteractions,
      advancementModelProvider: createHostAdvancementModelProviderFactory({
        configuration: ctx.advancementConfiguration,
        credentials: ctx.providerCredentials ?? {},
      }),
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
      ledger: ctx.conversationExecutorLedger!,
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
      resources: ctx.authorityRuntime.executorResourceGovernor,
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
    await assembly.start({
      admissionClosed: true,
      recoverAcceptedWork: ctx.startupLifecycle?.recoverAcceptedWork ?? true,
    });
  },
};

const channelLogger = Object.freeze({
  debug: (msg: string, ...args: unknown[]) =>
    console.log(chalk.dim(`[channel] ${msg}`), ...args),
  info: (msg: string, ...args: unknown[]) =>
    console.log(chalk.dim(`[channel] ${msg}`), ...args),
  warn: (msg: string, ...args: unknown[]) =>
    console.warn(chalk.yellow(`[channel] ${msg}`), ...args),
  error: (msg: string, ...args: unknown[]) =>
    console.error(chalk.red(`[channel] ${msg}`), ...args),
});

function isCurrentChannelOwner(ctx: AssemblyContext): boolean {
  if (ctx.meshBootstrap.mode === "single-machine") return true;
  const currentDeviceId = ctx.meshRuntime?.currentAnchorDeviceId() ??
    ctx.meshBootstrap.trust.issuer.deviceId;
  const ready = ctx.meshRuntime?.plannedCurrentOwnerReady() ??
    ctx.meshBootstrap.plannedAnchorPostInstall === undefined;
  return currentDeviceId === ctx.meshBootstrap.deviceKey.deviceId && ready;
}

/** 社交通道 —— 只装稳定机制；inbound consumer 与物理连接等待 Delivery Outbox。 */
function createChannelSurface(credentials: ChannelCredentialProjection): AccessSurface {
  return {
    name: "channel",
    phase: "pre-server",
    async setup(ctx) {
      const {
        conversations,
        channelConfiguration,
      } = ctx;
      if (
        !channelConfiguration.messaging ||
        Object.keys(channelConfiguration.messaging).length === 0
      ) {
        ctx.channelMechanism = Object.freeze({
          kind: "absent",
          reason: "not-configured",
        });
        return;
      }
      if (!conversations) {
        throw new Error("Configured Channel requires Conversation application");
      }
      try {
        const conversationProduct = new ChannelConversationProductBinding(
          conversations,
        );
        const result = await setupChannels({
          entries: channelConfiguration.messaging,
          credentials,
          logger: channelLogger,
          registerHttpRoute: (path, handler) => {
            if (ctx.channelHttpRoutes.has(path)) {
              throw new Error(`Channel HTTP route already registered: ${path}`);
            }
            ctx.channelHttpRoutes.set(path, handler);
          },
        });
        ctx.lifecycleContributions.acquire("channels.dispose", async () => {
          conversationProduct.close();
          await result.dispose();
        });
        ctx.channelStatuses = result.statusSnapshot;
        ctx.channelDelivery = result.delivery;
        ctx.channelConversationProduct = conversationProduct;
        ctx.channelMechanism = Object.freeze({
          kind: "available",
          channels: result,
        });
      } catch (err) {
        ctx.channelMechanism = Object.freeze({
          kind: "absent",
          reason: "setup-failed",
        });
        console.warn(
          chalk.yellow(
            `[channel] Setup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    },
  };
}

/** Recover durable Channel obligations only after S6 and the job owner both exist. */
const createChannelInteractionRecoveryUnit = (
  assembly: ConversationLosslessDataPlaneAssemblyHandle,
): CoreAssemblyUnit => ({
  name: "channel-interaction-recovery",
  phase: "pre-server",
  kind: "core",
  async setup(ctx) {
    if (!ctx.enabledRoles.includes("anchor")) return;
    assembly.assertComplete();
    const mechanism = ctx.channelMechanism;
    const coordinator = ctx.channelCoordinator;
    if (!mechanism || !coordinator) {
      throw new Error("Channel interaction recovery requires the complete S6 graph");
    }
    if (
      mechanism.kind === "available" &&
      (!ctx.startupLifecycle || ctx.startupLifecycle.recoverAcceptedWork)
    ) {
      await coordinator.recover();
    }
  },
});

/** 投递栈 —— 取得唯一 Outbox 后才构造、发布并连接 inbound router。 */
const deliverySurface: AccessSurface = {
  name: "delivery",
  phase: "pre-server",
  async setup(ctx) {
    const {
      channelDelivery,
      channelConfiguration,
      channelConversationProduct,
      channelChallengeAction,
      conversations,
      channelMechanism,
      zhixingHome,
    } = ctx;
    if (!channelConfiguration.messaging) return;
    if (!channelMechanism) {
      throw new Error("Delivery requires a selected Channel mechanism");
    }
    if (channelMechanism.kind === "absent") return;
    const preparedChannels = channelMechanism.channels;
    if (
      !channelDelivery ||
      !channelConversationProduct ||
      !channelChallengeAction ||
      !conversations
    ) {
      throw new Error("Delivery requires the complete prepared Channel surface");
    }
    if (!ctx.authorityRuntime) {
      throw new Error("Delivery requires the durable authority runtime");
    }
    const deliveryStack = await setupDelivery({
      channels: channelDelivery,
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
    if (ctx.startupLifecycle) {
      await deliveryStack.lifecycle.restore(ctx.startupLifecycle.delivery);
    }
    deliveryStack.lifecycle.close();
    deliveryStack.onStatus((notice) => {
      ctx.executionStatusHub?.publish(notice);
    });
    ctx.conversationProtocol?.bindDeliveryDrain(() =>
      deliveryStack.flush(),
    );
    const router = createInboundChannelRouter({
      conversation: channelConversationProduct,
      channels: preparedChannels.inbound,
      deliveryOutbox: deliveryStack.outboxRegistry,
      logger: channelLogger,
      confirmationHub: ctx.confirmationHub,
      cancelKeywords: channelConfiguration.intent?.cancelKeywords,
      sessionBroadcast: ctx.sessionBroadcast,
      sessionActivityBroadcast: ctx.sessionActivityBroadcast,
      isCurrentOwner: () => isCurrentChannelOwner(ctx),
    });
    ctx.lifecycleContributions.acquire(
      "inboundRouter.refuseNew",
      () => router.refuseNewMessages(),
    );
    router.refuseNewMessages();
    const inbound = Object.freeze({
      kind: "router" as const,
      handleMessage: (message: import("@zhixing/core").InboundMessage) =>
        router.handleMessage(message),
    });
    const consumers = Object.freeze({
      inbound,
      // 完整 S6 composition 在发布 protocol consumer 前已冻结此 callback。
      onChallengeAction: channelChallengeAction,
    });
    ctx.deliveryStack = deliveryStack;
    ctx.inboundRouter = router;
    ctx.channelConnections = Object.freeze({
      ready: Promise.resolve(),
      connectConfigured: () => preparedChannels.connectConfigured(consumers),
      disconnectConfigured: () => preparedChannels.disconnectConfigured(),
      suspendConfigured: () => preparedChannels.suspendConfigured(),
      resumeConfigured: () => preparedChannels.resumeConfigured(consumers),
    });
    delete ctx.channelMechanism;
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
  const conversationLosslessDataPlane =
    createConversationLosslessDataPlaneAssemblyHandle();
  const conversationSurface = createConversationSurface(
    conversationLosslessDataPlane,
  );
  const losslessDataPlaneSurface = createLosslessDataPlaneSurface(
    conversationLosslessDataPlane,
  );
  const channelInteractionRecoveryUnit = createChannelInteractionRecoveryUnit(
    conversationLosslessDataPlane,
  );
  return [
    authorityRuntimeSurface,
    conversationSurface,
    localConversationOwnerUnit,
    executorJobOwnerUnit,
    assetMaintenanceSurface,
    createMeshSurface(),
    advancementEvidenceTopologyUnit,
    createChannelSurface(channelCredentials),
    losslessDataPlaneSurface,
    executorJobOwnerStartUnit,
    channelInteractionRecoveryUnit,
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
