import type { RunRecordRef } from "../transcript/shard/types.js";
export type { RunRecordAdvancementMetadata } from "../transcript/types.js";
import type { EvidenceBundle, EvidenceRequest } from "../contracts/protocol.js";
import type { Digest } from "../types/distributed.js";
import type { TokenUsage } from "../types/llm.js";
import type { Message } from "../types/messages.js";
import type { UserTurnInput } from "../types/user-input.js";

export type AdvancementSessionStatus =
  | "awaiting-rubric-confirmation"
  | "active"
  | "completed"
  | "exited"
  | "cancelled";

export type ObjectiveSignalKind =
  | "file-diff"
  | "test-result"
  | "build-result"
  | "log"
  | "artifact"
  | "conversation-fact"
  | "none";

export type EvidenceKind = ObjectiveSignalKind;

/**
 * 证据定位——契约的一部分：草案生成时从任务上下文填写、随契约确认对用户
 * 可见可改，取证不做临场猜测。第一版仅支持路径定位（相对 workspace）；
 * 验证命令类定位属未来的验证性执行层，不在此扩展。
 */
export interface EvidenceLocator {
  readonly paths?: readonly string[];
}

export interface EvidenceRequirementSpec {
  readonly id: string;
  readonly kind: ObjectiveSignalKind;
  readonly description: string;
  readonly required?: boolean;
  readonly locator?: EvidenceLocator;
}

/**
 * 取证能力集——系统当前具备独立核验能力的客观证据种类，运行时探测的系统
 * 事实（如 git 可用性决定 file-diff 是否在集内）。它是 required 落点的约束
 * 来源：required 只能指向能力集内的 kind，能力集外的证据要求仍可写入契约
 * （裁判参考与代理消息素材），但不构成通过的硬门槛。
 */
export interface EvidenceCapabilitySet {
  readonly independentKinds: readonly ObjectiveSignalKind[];
}

/** 空能力集——未装配取证 provider 时的缺省：任何客观要求都不得标 required。 */
export const EMPTY_EVIDENCE_CAPABILITIES: EvidenceCapabilitySet = {
  independentKinds: [],
};

const OBJECTIVE_EVIDENCE_KIND_SET: ReadonlySet<ObjectiveSignalKind> = new Set([
  "file-diff",
  "test-result",
  "build-result",
  "log",
  "artifact",
]);

/** 客观证据种类——独立核验与 required 硬门槛只对这些 kind 有意义。 */
export function isObjectiveEvidenceKind(kind: ObjectiveSignalKind): boolean {
  return OBJECTIVE_EVIDENCE_KIND_SET.has(kind);
}

/**
 * 该证据要求是否允许标 required——required 只能落在系统当前具备独立核验
 * 能力的客观 kind 上；log / artifact 还必须有可执行的路径定位（没有定位
 * 就做不了确定性核验，不能成为通过的硬门槛）。
 */
export function canBeRequired(
  kind: ObjectiveSignalKind,
  locator: EvidenceLocator | undefined,
  capabilities: EvidenceCapabilitySet,
): boolean {
  if (!isObjectiveEvidenceKind(kind)) return false;
  if (!capabilities.independentKinds.includes(kind)) return false;
  if ((kind === "log" || kind === "artifact") && !locator?.paths?.length) {
    return false;
  }
  return true;
}

export interface FailureHandlingSpec {
  readonly id: string;
  readonly scenario: string;
  readonly reply: string;
}

export interface RubricContractContentSnapshot {
  readonly passCriteria: readonly string[];
  readonly evidenceRequirements?: readonly EvidenceRequirementSpec[];
  readonly failureHandling: readonly FailureHandlingSpec[];
}

/**
 * 确认固化后的通过标准条目。id 在确认这一步按序机械分配（"pc-1"…），
 * 快照不可变，因此 id 在整个推进会话内恒稳——它是归因引用、跨轮机械对比
 * 与收场标准矩阵的稳定锚；草案与 RUBRIC.md 资产层保持自然列表，不带 id。
 */
export interface PassCriterionSnapshot {
  readonly id: string;
  readonly text: string;
}

export interface ConfirmedRubricContentSnapshot {
  readonly passCriteria: readonly PassCriterionSnapshot[];
  readonly evidenceRequirements?: readonly EvidenceRequirementSpec[];
  readonly failureHandling: readonly FailureHandlingSpec[];
}

export type RubricContractSource = "matched" | "generated";

export interface RubricCandidateSnapshot {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly source: "own" | "linked";
  readonly matchScore?: number;
}

export type RubricDraftPersistenceChoice =
  | { readonly kind: "save-new" }
  | {
      readonly kind: "update-existing";
      readonly rubricId: string;
    };

export interface RubricContractDraftSnapshot {
  readonly draftId: string;
  readonly originalTurnId: string;
  readonly source: RubricContractSource;
  readonly candidateRubricIds: readonly string[];
  readonly candidateRubrics?: readonly RubricCandidateSnapshot[];
  readonly title: string;
  readonly description: string;
  readonly content: RubricContractContentSnapshot;
  readonly createdAt: string;
}

/**
 * 已确认 Rubric 契约的来源身份。library：库条目的不可变快照，由 rubricId 与
 * 资产级版本锚定；local-draft：尚未沉淀全局库的确认草案，以稳定 snapshotId
 * 与内容摘要锚定——契约不依赖全局身份即可在当前 owner 立即生效，离线确认
 * 在类型层可构造；后续沉淀成功只经修订关联库身份，不改写 active 快照内容。
 */
export type ConfirmedRubricSource =
  | {
      readonly kind: "library";
      readonly rubricId: string;
      readonly rubricVersion: string;
    }
  | {
      readonly kind: "local-draft";
      readonly snapshotId: string;
      readonly contentDigest: Digest;
    };

export interface ConfirmedRubricSnapshot {
  readonly source: ConfirmedRubricSource;
  readonly title: string;
  readonly description: string;
  readonly content: ConfirmedRubricContentSnapshot;
  readonly confirmedAt: string;
  readonly confirmedBy: "user";
}

export type AdvancementReviewDecision = "passed" | "failed" | "exit";

export type ReviewCriterionVerdict = "met" | "unmet" | "unknown";

/**
 * 裁判对单条通过标准的结论性判定：结论 + 一句话理由 + 独立证据摘录。
 * 只承载结论与证据事实，不承载裁判思考过程——它随代理消息下发执行侧，
 * 让判断分歧一轮解开而不是原地打转。
 */
export interface ReviewCriterionAttribution {
  readonly criterionId: string;
  readonly verdict: ReviewCriterionVerdict;
  readonly reason: string;
  readonly evidenceExcerpt?: string;
}

/**
 * 一次验收的逐条归因。每条通过标准恰好一条判定（全覆盖），
 * 随 review 持久化——恢复重建、收场标准矩阵与跨轮死胡同对比的权威数据源。
 * 系统兜底 review（无裁判工具产出）criteria 为空数组。
 */
export interface ReviewAttribution {
  readonly criteria: readonly ReviewCriterionAttribution[];
}

export interface ReviewEvidence {
  readonly id: string;
  readonly kind: ObjectiveSignalKind;
  readonly summary: string;
  readonly requirementId?: string;
  readonly source?: "independent" | "execution-report" | "user";
  readonly passed?: boolean;
  readonly refs?: readonly string[];
}

export interface AdvancementReviewContextWindowSnapshot {
  readonly source: "advancement-window";
  readonly priorReviewCount: number;
  readonly inputMessageCount: number;
  readonly outputMessageCount: number;
  readonly decision: {
    readonly kind: "pass" | "defer" | "trigger";
    readonly reason: string;
    readonly currentTokens?: number;
    readonly threshold?: number;
  };
  readonly compact?: {
    readonly pairsCompacted: number;
    readonly tokensBefore: number;
    readonly tokensAfter: number;
    readonly segmentId?: string;
  };
}

export type AdvancementWindowEntry =
  | {
      readonly kind: "summary";
      readonly messages: readonly [Message, Message];
    }
  | {
      readonly kind: "review";
      readonly reviewId: string;
      readonly runIndex: number;
      readonly messages: readonly [Message, Message];
    };

export interface AdvancementWindowState {
  readonly source: "advancement-window";
  readonly reviewCount: number;
  readonly entries: readonly AdvancementWindowEntry[];
  readonly updatedAt: string;
  readonly lastSnapshot?: AdvancementReviewContextWindowSnapshot;
}

export type AdvancementExitReason =
  | "passed"
  | "dead-end"
  | "user-cancelled"
  | "user-took-over"
  | "superseded"
  | "system-error"
  /** required 客观证据超出系统当前独立核验能力——请用户人工验收，不进入无效续推循环。 */
  | "capability-gap"
  /**
   * 单会话累计 token 触达失控保险丝阈值——系统边界退出并交付收场。
   * 由系统审前计量触发，不进裁判 schema。
   */
  | "budget-exceeded";

export interface AdvancementExit {
  readonly reason: AdvancementExitReason;
  readonly message: string;
  readonly occurredAt: string;
}

export interface AdvancementRunReview {
  readonly id: string;
  readonly runIndex: number;
  readonly runRecordRef?: RunRecordRef;
  readonly reviewedAt: string;
  readonly decision: AdvancementReviewDecision;
  readonly evidence: readonly ReviewEvidence[];
  /** 逐条判定的权威数据源；unmetCriteria 是它的文本投影。 */
  readonly attribution: ReviewAttribution;
  /** attribution 中 unmet 条目的标准文本投影，供轻量消费；系统兜底 review 存放错误消息。 */
  readonly unmetCriteria: readonly string[];
  /**
   * 裁判调用与被审 run 的 usage 两半快照——随 review 落盘，沿序列累加即得
   * 推进会话总消耗（单会话保险丝的计量输入），免于回读 transcript。
   */
  readonly usage?: {
    readonly judge?: TokenUsage;
    readonly run?: TokenUsage;
  };
  readonly selectedFailureHandlingId?: string;
  readonly proxyMessageId?: string;
  readonly exitReason?: AdvancementExitReason;
  readonly contextWindow?: AdvancementReviewContextWindowSnapshot;
}

export interface AdvancementRunReviewOutput {
  readonly review: AdvancementRunReview;
  readonly advancementWindow?: AdvancementWindowState;
}

export interface AdvancementProxyMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly reviewId: string;
  readonly content: UserTurnInput;
  readonly rubricFailureHandlingId: string;
  readonly variables: Readonly<Record<string, string>>;
  /** 产生本消息的验收归因——content 中归因事实块的确定性数据源，恢复重建时按此重渲染。 */
  readonly attribution: ReviewAttribution;
  readonly createdAt: string;
}

export interface AdvancementSession {
  readonly id: string;
  readonly conversationId: string;
  readonly status: AdvancementSessionStatus;
  readonly originalUserTask: UserTurnInput;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rubricDraftVersion: number;
  readonly pendingRubricDraft?: RubricContractDraftSnapshot;
  readonly confirmedRubric?: ConfirmedRubricSnapshot;
  readonly runs: readonly AdvancementRunReview[];
  readonly proxyMessages: readonly AdvancementProxyMessage[];
  readonly outstandingProxyMessageId?: string;
  readonly advancementWindow?: AdvancementWindowState;
  readonly evidence?: AdvancementEvidenceProjection;
  readonly exit?: AdvancementExit;
}

export interface CreateAdvancementSessionInput {
  readonly id: string;
  readonly conversationId: string;
  readonly originalUserTask: UserTurnInput;
  readonly pendingRubricDraft: RubricContractDraftSnapshot;
  readonly createdAt?: string;
}

export type AdvancementStoreEvent =
  | AdvancementSessionCreatedEvent
  | AdvancementRubricDraftRevisedEvent
  | AdvancementRubricConfirmedEvent
  | AdvancementRunReviewedEvent
  | AdvancementWindowUpdatedEvent
  | AdvancementProxyEnqueuedEvent
  | AdvancementProxySettledEvent
  | AdvancementEvidenceRequestedEvent
  | AdvancementEvidenceResultEvent
  | AdvancementEvidenceSettledEvent
  | AdvancementCompletedEvent
  | AdvancementExitedEvent
  | AdvancementCancelledEvent;

/** 分布式控制日志复用现有推进事件，不建立第二套事件模型。 */
export type AdvancementControlEvent = AdvancementStoreEvent;

/** 分布式读取复用现有推进会话快照。 */
export type AdvancementSnapshot = AdvancementSession;

export interface AdvancementSessionCreatedEvent {
  readonly type: "session_created";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly originalUserTask: UserTurnInput;
  readonly pendingRubricDraft: RubricContractDraftSnapshot;
}

export interface AdvancementRubricDraftRevisedEvent {
  readonly type: "rubric_draft_revised";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly pendingRubricDraft: RubricContractDraftSnapshot;
}

export interface AdvancementRubricConfirmedEvent {
  readonly type: "rubric_confirmed";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly confirmedRubric: ConfirmedRubricSnapshot;
}

export interface AdvancementRunReviewedEvent {
  readonly type: "run_reviewed";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly review: AdvancementRunReview;
}

export interface AdvancementWindowUpdatedEvent {
  readonly type: "window_updated";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly advancementWindow: AdvancementWindowState;
}

export interface AdvancementProxyEnqueuedEvent {
  readonly type: "proxy_enqueued";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly proxyMessage: AdvancementProxyMessage;
}

export interface AdvancementProxySettledEvent {
  readonly type: "proxy_settled";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly proxyMessageId: string;
}

export interface AdvancementCompletedEvent {
  readonly type: "completed";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly exit: AdvancementExit;
}

export interface AdvancementExitedEvent {
  readonly type: "exited";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly exit: AdvancementExit;
}

export interface AdvancementCancelledEvent {
  readonly type: "cancelled";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly exit?: AdvancementExit;
}

/**
 * 取证请求的验真结果：bundle 是 executor 签名、经 owner 全等绑定核验的独立
 * 证据包；typed-stale 是观测前后状态指纹不一致；capability-gap 是系统当前
 * 不具备该请求所需的独立核验能力（无快照文件系统上的历史精确证据等）。
 */
export type AdvancementEvidenceOutcome =
  | { readonly kind: "bundle"; readonly bundle: EvidenceBundle }
  | { readonly kind: "typed-stale" }
  | { readonly kind: "capability-gap" };

/** 单个证据 item 到一至多个契约证据要求的耐久映射（wire 不新增内部 id）。 */
export interface AdvancementEvidenceItemRequirement {
  readonly itemIndex: number;
  readonly requirementIds: readonly string[];
}

/** 一次取证 attempt 的完整耐久请求事实——未过期 attempt 的重发只回放它。 */
export interface AdvancementEvidenceAttempt {
  readonly requestId: string;
  readonly reviewId: string;
  readonly attempt: number;
  readonly request: EvidenceRequest;
  readonly itemRequirements: readonly AdvancementEvidenceItemRequirement[];
  readonly requestDigest: Digest;
}

export type AdvancementEvidenceSettlement = "consumed" | "deferred";

/** 未关闭的取证请求：发送、结果接收与 review 之间任意崩溃的重入凭据。 */
export interface AdvancementEvidencePending
  extends AdvancementEvidenceAttempt {
  readonly outcome?: AdvancementEvidenceOutcome;
}

export interface AdvancementEvidenceProjection {
  readonly pending: readonly AdvancementEvidencePending[];
}

/** pending 投影上界——正常每会话至多一个在飞请求，越界即异常信号。 */
export const MAX_ADVANCEMENT_PENDING_EVIDENCE = 16;

export interface AdvancementEvidenceRequestedEvent {
  readonly type: "evidence_requested";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly attempt: AdvancementEvidenceAttempt;
}

export interface AdvancementEvidenceResultEvent {
  readonly type: "evidence_result";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly outcome: AdvancementEvidenceOutcome;
}

export interface AdvancementEvidenceSettledEvent {
  readonly type: "evidence_settled";
  readonly timestamp: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly settlement: AdvancementEvidenceSettlement;
}
