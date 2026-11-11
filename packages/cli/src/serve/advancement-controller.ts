import { randomUUID } from "node:crypto";
import {
  AdvancementProposalApplicationService,
  buildClosureSynthesisPrompt,
  LLMAdvancementAdmissionStrategy,
  LLMRubricDraftGenerationStrategy,
  LLMRubricDraftRevisionStrategy,
  RubricContractBuilder,
  type AdvancementProposalFactPort,
  type RubricCatalogPort,
  type RubricContractCompleteOptions,
} from "@zhixing-ai/core/advancement";
import { userMessage } from "@zhixing-ai/core";
import type {
  GlobalStatePort,
  ResourceReservationPort,
  SessionStatePort,
} from "@zhixing-ai/core/contracts";

/** 推进控制调用的治理端口：在通用资源端口之外，收尾使用同一所有者的“结算并释放”（同一帧、需两项授权）。 */
type AdvancementResourcePort = ResourceReservationPort & {
  settleAndRelease: ResourceReservationPort["settle"];
};
import {
  assertAdvancementModelProviderBinding,
  type AdvancementModelProviderFactory,
} from "@zhixing-ai/orchestrator/advancement";
import {
  AdvancementController,
  AdvancementEvidenceCoordinator,
  SessionAdvancementStore,
} from "@zhixing-ai/owner-services/advancement";
import { createAdvancementReviewAttemptApplication } from "@zhixing-ai/owner-services/advancement/review-attempt-correctness";
import { createAdvancementReviewExternalMechanism } from "@zhixing-ai/owner-services/advancement/review-external-mechanism";
import type {
  AdvancementReviewAttemptApplication,
  AdvancementRubricArtifactPort,
  RubricPublicationPort,
} from "@zhixing-ai/core/advancement/application";
import {
  GlobalRubricCatalog,
  GlobalRubricPublication,
} from "./advancement-rubric-library.js";
import type { AdvancementEvidenceRuntimePort } from "./advancement-evidence-topology.js";

export interface AdvancementRecentContextPort {
  read(conversationId: string): Promise<string | undefined>;
}

export interface ServeAdvancementControllerDeps {
  readonly modelProvider: AdvancementModelProviderFactory;
  /**
   * control 资源治理端口（惰性——authority runtime 在 pre-server surface 装配，
   * 晚于本控制器创建；advancement 外调发生在运行期，取值时必须已就绪，
   * 缺失即 fail-closed，不允许静默绕过治理）。
   */
  readonly governor: () => AdvancementResourcePort | undefined;
  /** Conversation-owner state port captured directly before publication. */
  readonly sessionState: SessionStatePort;
  /** Required recent-context reader captured from the bound conversation owner. */
  readonly recentContext: AdvancementRecentContextPort;
  /** 准入延迟基线观测（诊断日志）。 */
  readonly onAdmissionTiming?: (elapsedMs: number) => void;
  readonly evidenceRuntime?: AdvancementEvidenceRuntimePort;
  readonly rubricRuntime?: () =>
    | {
        readonly globalState: GlobalStatePort;
        readonly artifacts: AdvancementRubricArtifactPort;
        readonly anchorEpoch: number;
      }
    | undefined;
  /** Local owners use local-draft contracts and never imply a global save. */
  readonly rubricScope?: "global" | "local";
  readonly rubricCatalog?: RubricCatalogPort;
  readonly rubricPublication?: RubricPublicationPort;
  /** 提议阶段的可见结果（草案就绪、生成失败或结果不明）交给接入面呈现。 */
  readonly onProposalFact?: AdvancementProposalFactPort["publish"];
}

/** 惰性解析的治理端口代理——每次调用时解析真实 governor，缺失即拒绝。 */
function lazyResourcePort(
  resolve: () => AdvancementResourcePort | undefined,
): AdvancementResourcePort {
  const required = (): AdvancementResourcePort => {
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
    acquireRoot: (workload, budget, origin, ctx, audience, scopeBinding, delegation) =>
      required().acquireRoot(
        workload,
        budget,
        origin,
        ctx,
        audience,
        scopeBinding,
        delegation,
      ),
    inspectImmediateRoot: (workload) =>
      required().inspectImmediateRoot(workload),
    acquireChild: (parent, workload, budget, ctx) =>
      required().acquireChild(parent, workload, budget, ctx),
    reserveUsage: (lease, usage, ctx) => required().reserveUsage(lease, usage, ctx),
    consume: (lease, usage, ctx) => required().consume(lease, usage, ctx),
    settle: (lease, ctx) => required().settle(lease, ctx),
    release: (lease, ctx) => required().release(lease, ctx),
    settleAndRelease: (lease, ctx) => required().settleAndRelease(lease, ctx),
  };
}

const ADVANCEMENT_CONTROL_BUDGET = { maxCalls: 1, maxTokens: 300_000 } as const;

export interface ServeAdvancementApplications {
  readonly controller: AdvancementController;
  readonly reviews: AdvancementReviewAttemptApplication;
  /** 主 Agent 提议的接受与草案。 */
  readonly proposals: AdvancementProposalApplicationService;
}

export async function createServeAdvancementApplications(
  deps: ServeAdvancementControllerDeps,
): Promise<ServeAdvancementApplications> {
  if (
    !deps.sessionState ||
    typeof deps.sessionState.readAdvancementState !== "function" ||
    typeof deps.sessionState.mutate !== "function"
  ) {
    throw new TypeError(
      "Advancement requires a direct conversation session-state port",
    );
  }
  if (!deps.recentContext || typeof deps.recentContext.read !== "function") {
    throw new TypeError(
      "Advancement requires a direct recent-context port",
    );
  }
  // 推进控制智能（准入 / 草案 / 修订 / 收场 / 裁判）的全部真实 LLM 外调只经
  // ControlCompletionPort 与 AdvancementReviewerPort 两条通道：调用方取得
  // control 根租约并在 finally 终结，端口沿租约以稳定 usageId 计量——
  // 通道消费的 provider 保持未治理（裸），杜绝双重租约。
  const governor = lazyResourcePort(deps.governor);
  const evidenceCapabilities = deps.evidenceRuntime
    ? { independentKinds: ["file-diff", "log", "artifact"] as const }
    : undefined;
  const modelProvider = deps.modelProvider.create(Object.freeze({
    resourceMeter: governor,
    ...(evidenceCapabilities ? { evidenceCapabilities } : {}),
  }));
  assertAdvancementModelProviderBinding(modelProvider);
  const completeViaPort = async (
    role: "main" | "light",
    prompt: string,
    options: RubricContractCompleteOptions = {},
  ): Promise<string> => {
    options.abortSignal?.throwIfAborted();
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
      // 图片与提示同属一条用户消息；调用随调用方的中止信号停下（停服、排空、删除）
      const images = options.images ?? [];
      const result = await modelProvider.completion.complete({
        role,
        messages: [images.length === 0 ? userMessage(prompt) : {
          role: "user",
          content: [{ type: "text", text: prompt }, ...images.map((source) => ({ type: "image" as const, source }))],
        }],
        lease,
        abort: options.abortSignal ?? new AbortController().signal,
        deadlineAt: ctx.deadlineAt,
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.text;
    } finally {
      // 结算与释放在同一帧；与原先各自尽力的两步逐状态等价（已结算只补释放，已释放不写，已回收照旧拒绝）
      await governor.settleAndRelease(lease, ctx).catch(() => {});
    }
  };
  // 取证能力集是运行时探测的系统事实（git 可用性 / workspace 形态），
  // 传入草案生成——required 只能落在能力集内的 kind 上；无工作区时
  // 无从独立取证，能力集为空、不装取证 provider（安全缺省）。
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
      complete: (prompt, options) => completeViaPort("main", prompt, options),
    }),
    revisionStrategy: new LLMRubricDraftRevisionStrategy({
      complete: (prompt, options) => completeViaPort("main", prompt, options),
    }),
    ...(evidenceCapabilities ? { evidenceCapabilities } : {}),
  });

  const store = new SessionAdvancementStore({ port: deps.sessionState });
  const evidenceRuntime = deps.evidenceRuntime;
  const evidence = evidenceRuntime
    ? new AdvancementEvidenceCoordinator({
        store,
        resources: governor,
        resolveTarget: (conversationId, runId) =>
          evidenceRuntime.resolveTarget(conversationId, runId),
        clientFor: (executorId) =>
          evidenceRuntime.targets.clientForExecutor(executorId),
        signer: {
          sign: (schemaId, version, payload) =>
            evidenceRuntime.signer.sign(schemaId, version, payload),
        },
        verifier: {
          verify: (schemaId, version, payload, signature) =>
            evidenceRuntime.verifier.verify(
              schemaId,
              version,
              payload,
              signature,
            ),
        },
      })
    : undefined;
  const closureSynthesizer = {
    synthesize: (facts: Parameters<typeof buildClosureSynthesisPrompt>[0]) =>
      completeViaPort("light", buildClosureSynthesisPrompt(facts)),
  };
  const reviews = createAdvancementReviewAttemptApplication({
    store,
    resources: governor,
    mechanism: createAdvancementReviewExternalMechanism({
      evidence,
      reviewer: modelProvider.reviewer,
    }),
    reviewerAvailable: true,
    closureSynthesizer,
    ...(modelProvider.sessionTokenBudget !== undefined
      ? { sessionTokenBudget: modelProvider.sessionTokenBudget }
      : {}),
  });
  const controller = new AdvancementController({
    store,
    admissionStrategy: new LLMAdvancementAdmissionStrategy({
      complete: (prompt) => completeViaPort("light", prompt),
    }),
    ...(deps.rubricPublication
      ? { rubricPublication: deps.rubricPublication }
      : deps.rubricScope === "local"
        ? {}
        : { rubricPublication: new GlobalRubricPublication(rubricLibrary) }),
    recentContextProvider: (conversationId) =>
      deps.recentContext.read(conversationId),
    ...(deps.onAdmissionTiming
      ? { onAdmissionTiming: deps.onAdmissionTiming }
      : {}),
    // 收场合成走轻推理通道；失败由领域投影降级结构化直出。
    closureSynthesizer,
    contractBuilder,
  });
  // 起草与修订沿用控制器现有的模型调用（经 completeViaPort 计量），持久化走同一 store
  const proposals = new AdvancementProposalApplicationService({
    mechanism: {
      listPendingProposals: (conversationId) => store.listPendingProposals(conversationId),
      acceptProposal: (input) => store.acceptProposal(input),
      loadLatestSession: (conversationId) => controller.loadLatestSession(conversationId),
      transitionDraftAttempt: (conversationId, sessionId, attempt) =>
        store.transitionDraftAttempt(conversationId, sessionId, attempt),
      persistProposalDraft: (conversationId, sessionId, attempt, revision, draft) =>
        store.persistProposalDraft(conversationId, sessionId, attempt, revision, draft),
      buildDraft: (input) => controller.buildRubricDraft(input),
      reviseDraft: (input) => controller.reviseRubricDraftContent(input),
    },
    ...(deps.onProposalFact ? { facts: { publish: deps.onProposalFact } } : {}),
  });
  return Object.freeze({ controller, reviews, proposals });
}
