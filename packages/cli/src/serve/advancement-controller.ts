import { randomUUID } from "node:crypto";
import {
  buildClosureSynthesisPrompt,
  LLMAdvancementAdmissionStrategy,
  LLMRubricDraftGenerationStrategy,
  LLMRubricDraftRevisionStrategy,
  RubricContractBuilder,
  type RubricCatalogPort,
  userMessage,
  validateThinkingConfig,
  type LLMRole,
  type ThinkingConfig,
} from "@zhixing/core";
import type {
  EvidenceClientPort,
  GlobalStatePort,
  ResourceReservationPort,
  SessionStatePort,
} from "@zhixing/core/contracts";
import type { FileArtifactStore } from "@zhixing/core/authority";
import type {
  ProtocolSignatureVerifier,
  ProtocolSigner,
} from "@zhixing/core/protocol";
import {
  createProviderRoles,
  getModelCapabilityOverride,
  resolveModelCapability,
  resolveWorkspace,
  resolveWorkspaceSessionType,
  type ProviderCredentialProjection,
  type ZhixingConfig,
} from "@zhixing/providers";
import {
  createAdvancementRuntime,
} from "@zhixing/orchestrator/advancement";
import { createControlCompletionPort } from "@zhixing/orchestrator/runtime";
import { PROTOCOL_BUDGET_DEFAULTS } from "@zhixing/providers";
import {
  AdvancementController,
  AdvancementEvidenceCoordinator,
  SessionAdvancementStore,
  type AdvancementEvidenceTarget,
} from "@zhixing/owner-services";
import {
  GlobalRubricCatalog,
  GlobalRubricPublication,
} from "./advancement-rubric-library.js";

export interface ServeAdvancementControllerDeps {
  readonly config: ZhixingConfig;
  readonly credentials: ProviderCredentialProjection;
  /**
   * control 资源治理端口（惰性——authority runtime 在 pre-server surface 装配，
   * 晚于本控制器创建；advancement 外调发生在运行期，取值时必须已就绪，
   * 缺失即 fail-closed，不允许静默绕过治理）。
   */
  readonly governor: () => ResourceReservationPort | undefined;
  /**
   * 会话状态端口（惰性）——advancement 权威状态读写经对话 owner 日志，
   * 无权威运行时即 fail-closed，不回退本地文件形态。
   */
  readonly sessionState: () => SessionStatePort | undefined;
  /** 准入投影来源——活跃会话窗口尾部（经 lazy ref 取，未就绪返回 undefined）。 */
  readonly recentContextProvider?: (
    conversationId: string,
  ) => Promise<string | undefined>;
  /** 准入延迟基线观测（诊断日志）。 */
  readonly onAdmissionTiming?: (elapsedMs: number) => void;
  readonly evidenceRuntime?: () =>
    | {
        readonly signer: ProtocolSigner;
        readonly verifier: ProtocolSignatureVerifier;
        readonly resolveTarget: (
          conversationId: string,
          runId: string,
        ) => Promise<AdvancementEvidenceTarget | undefined>;
        readonly clientFor: (executorId: string) => EvidenceClientPort | undefined;
      }
    | undefined;
  readonly rubricRuntime?: () =>
    | {
        readonly globalState: GlobalStatePort;
        readonly artifacts: FileArtifactStore;
        readonly anchorEpoch: number;
      }
    | undefined;
  /** Local owners use local-draft contracts and never imply a global save. */
  readonly rubricScope?: "global" | "local";
  readonly rubricCatalog?: RubricCatalogPort;
}

/** 惰性解析的治理端口代理——每次调用时解析真实 governor，缺失即拒绝。 */
function lazyResourcePort(
  resolve: () => ResourceReservationPort | undefined,
): ResourceReservationPort {
  const required = (): ResourceReservationPort => {
    const port = resolve();
    if (!port) {
      throw new Error("Advancement LLM calls require the durable authority runtime");
    }
    return port;
  };
  return {
    enqueueRoot: (reservationId, workload, origin, ctx) =>
      required().enqueueRoot(reservationId, workload, origin, ctx),
    prepareAssignmentRoot: (request, origin, ctx) =>
      required().prepareAssignmentRoot(request, origin, ctx),
    prepareSystemJobRoot: (request, origin, ctx) =>
      required().prepareSystemJobRoot(request, origin, ctx),
    acquireRoot: (workload, budget, origin, ctx, audience, scopeBinding) =>
      required().acquireRoot(
        workload,
        budget,
        origin,
        ctx,
        audience,
        scopeBinding,
      ),
    inspectImmediateRoot: (workload) =>
      required().inspectImmediateRoot(workload),
    acquireChild: (parent, workload, budget, ctx) =>
      required().acquireChild(parent, workload, budget, ctx),
    reserveUsage: (lease, usage, ctx) => required().reserveUsage(lease, usage, ctx),
    consume: (lease, usage, ctx) => required().consume(lease, usage, ctx),
    settle: (lease, ctx) => required().settle(lease, ctx),
    release: (lease, ctx) => required().release(lease, ctx),
  };
}

const ADVANCEMENT_CONTROL_BUDGET = { maxCalls: 1, maxTokens: 300_000 } as const;

export async function createServeAdvancementController(
  deps: ServeAdvancementControllerDeps,
): Promise<AdvancementController> {
  const { roles: rawRoles, resolvedRoles, config } = createProviderRoles({
    config: deps.config,
    credentials: deps.credentials,
  });
  // 推进控制智能（准入 / 草案 / 修订 / 收场 / 裁判）的全部真实 LLM 外调只经
  // ControlCompletionPort 与 AdvancementReviewerPort 两条通道：调用方取得
  // control 根租约并在 finally 终结，端口沿租约以稳定 usageId 计量——
  // 通道消费的 provider 保持未治理（裸），杜绝双重租约。
  const governor = lazyResourcePort(deps.governor);
  const roles = {
    main: rawRoles.main,
    light: rawRoles.light,
  };
  const mainThinking = resolveConfiguredThinking(
    roles.main,
    config.llm?.main?.thinking,
  );
  const lightThinking = resolveConfiguredThinking(
    roles.light,
    config.llm?.light?.thinking,
  );
  const completionPort = createControlCompletionPort({
    roles,
    thinking: { main: mainThinking, light: lightThinking },
    meter: governor,
    defaultMaxOutputTokens:
      PROTOCOL_BUDGET_DEFAULTS[resolvedRoles.light.resolved.protocol]
        .maxOutputTokens,
  });
  const completeViaPort = async (
    role: "main" | "light",
    prompt: string,
  ): Promise<string> => {
    const workId = `advancement:${randomUUID()}`;
    const ctx = {
      principal: { kind: "host" as const, component: "advancement-control" },
      requestId: `advancement-control:${workId}`,
      deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    };
    const lease = await governor.acquireRoot(
      { kind: "control", id: workId, attempt: 1 },
      ADVANCEMENT_CONTROL_BUDGET,
      { admissionClass: "advancement", entry: "advancement-control" },
      ctx,
    );
    try {
      const result = await completionPort.complete({
        role,
        messages: [userMessage(prompt)],
        lease,
        abort: new AbortController().signal,
        deadlineAt: ctx.deadlineAt,
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.text;
    } finally {
      await governor.settle(lease, ctx).catch(() => {});
      await governor.release(lease, ctx).catch(() => {});
    }
  };
  const workspace = resolveWorkspace(config, {
    sessionType: resolveWorkspaceSessionType(),
  });
  const advancementWindowCapability = resolveModelCapability(
    roles.main.model,
    getModelCapabilityOverride(config.modelCapabilityOverrides, roles.main.model),
  );

  // 取证能力集是运行时探测的系统事实（git 可用性 / workspace 形态），
  // 传入草案生成——required 只能落在能力集内的 kind 上；无工作区时
  // 无从独立取证，能力集为空、不装取证 provider（安全缺省）。
  const workspacePath = workspace.path ?? undefined;
  const evidenceCapabilities = deps.evidenceRuntime
    ? { independentKinds: ["file-diff", "log", "artifact"] as const }
    : undefined;

  const rubricLibrary = {
    globalState: () => deps.rubricRuntime?.()?.globalState,
    artifacts: () => deps.rubricRuntime?.()?.artifacts,
    anchorEpoch: () => deps.rubricRuntime?.()?.anchorEpoch,
  };
  const contractBuilder = new RubricContractBuilder({
    ...(deps.rubricCatalog
      ? { rubricCatalog: deps.rubricCatalog }
      : deps.rubricScope === "local"
        ? {}
        : { rubricCatalog: new GlobalRubricCatalog(rubricLibrary) }),
    generationStrategy: new LLMRubricDraftGenerationStrategy({
      complete: (prompt) => completeViaPort("main", prompt),
    }),
    revisionStrategy: new LLMRubricDraftRevisionStrategy({
      complete: (prompt) => completeViaPort("main", prompt),
    }),
    ...(evidenceCapabilities ? { evidenceCapabilities } : {}),
  });

  const store = new SessionAdvancementStore({
      port: () => {
        const port = deps.sessionState();
        if (!port) {
          throw new Error(
            "Advancement requires the conversation authority runtime",
          );
        }
        return port;
      },
    });
  const evidence = deps.evidenceRuntime
    ? new AdvancementEvidenceCoordinator({
        store,
        resources: governor,
        resolveTarget: (conversationId, runId) => {
          const runtime = deps.evidenceRuntime?.();
          if (!runtime) return Promise.resolve(undefined);
          return runtime.resolveTarget(conversationId, runId);
        },
        clientFor: (executorId) =>
          deps.evidenceRuntime?.()?.clientFor(executorId),
        signer: {
          sign: (schemaId, version, payload) => {
            const runtime = deps.evidenceRuntime?.();
            if (!runtime) throw new Error("Advancement evidence runtime is unavailable");
            return runtime.signer.sign(schemaId, version, payload);
          },
        },
        verifier: {
          verify: (schemaId, version, payload, signature) => {
            const runtime = deps.evidenceRuntime?.();
            if (!runtime) throw new Error("Advancement evidence runtime is unavailable");
            runtime.verifier.verify(schemaId, version, payload, signature);
          },
        },
      })
    : undefined;

  return new AdvancementController({
    store,
    admissionStrategy: new LLMAdvancementAdmissionStrategy({
      complete: (prompt) => completeViaPort("light", prompt),
    }),
    resources: governor,
    ...(evidence ? { evidence } : {}),
    ...(deps.rubricScope === "local"
      ? {}
      : { rubricPublication: new GlobalRubricPublication(rubricLibrary) }),
    ...(deps.recentContextProvider
      ? { recentContextProvider: deps.recentContextProvider }
      : {}),
    ...(deps.onAdmissionTiming
      ? { onAdmissionTiming: deps.onAdmissionTiming }
      : {}),
    // 收场合成走轻推理通道；失败由 controller 降级结构化直出。
    closureSynthesizer: {
      synthesize: (facts) =>
        completeViaPort("light", buildClosureSynthesisPrompt(facts)),
    },
    ...(config.advancement?.sessionTokenBudget !== undefined
      ? { sessionTokenBudget: config.advancement.sessionTokenBudget }
      : {}),
    contractBuilder,
    reviewer: createAdvancementRuntime({
      provider: roles.main.provider,
      model: roles.main.model,
      thinking: mainThinking,
      lightProvider: roles.light.provider,
      lightModel: roles.light.model,
      lightThinking,
      resourceMeter: governor,
      defaultMaxOutputTokens:
        PROTOCOL_BUDGET_DEFAULTS[resolvedRoles.main.resolved.protocol]
          .maxOutputTokens,
      workingDirectory: workspacePath,
      ...(evidenceCapabilities ? { evidenceCapabilities } : {}),
      contextWindow: {
        capability: advancementWindowCapability,
      },
    }),
  });
}

function resolveConfiguredThinking(
  role: LLMRole,
  configured: ThinkingConfig | undefined,
): ThinkingConfig | undefined {
  if (configured === undefined) return undefined;
  const modelInfo = role.provider.models.find((m) => m.id === role.model);
  if (modelInfo === undefined) return configured;
  const control = modelInfo.thinkingControl ?? { type: "none" };
  if (validateThinkingConfig(configured, control)) return configured;
  return undefined;
}
