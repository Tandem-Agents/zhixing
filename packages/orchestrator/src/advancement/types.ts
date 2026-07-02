import type {
  AdvancementRunReview,
  AdvancementRunReviewOutput,
  AdvancementWindowState,
  ConfirmedRubricSnapshot,
  EvidenceCapabilitySet,
  ReviewEvidence,
} from "@zhixing/core/advancement";
import type {
  LLMProvider,
  RunRecordInput,
  RunRecordRef,
  SegmentSummarizeLLMFn,
  SegmentThresholds,
  ITokenEstimator,
  ThinkingConfig,
  UserTurnInput,
} from "@zhixing/core";

export interface AdvancementRuntime {
  reviewRun(input: AdvancementReviewRunInput): Promise<AdvancementRunReviewOutput>;
}

export interface AdvancementRuntimeOptions {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly thinking?: ThinkingConfig;
  readonly evidenceProvider?: AdvancementEvidenceProvider;
  /**
   * 取证能力集事实——喂入裁判 system prompt，让裁判能区分「执行侧还没产出
   * 证据（failed 催证）」与「系统没有核验能力（capability-gap 退出）」。
   * 与取证 provider 的探测结果同源。
   */
  readonly evidenceCapabilities?: EvidenceCapabilitySet;
  readonly contextWindow?: AdvancementContextWindowOptions;
  readonly maxJudgeTurns?: number;
  readonly workingDirectory?: string;
  readonly now?: () => Date;
  readonly idGenerator?: () => string;
}

export interface AdvancementContextWindowOptions {
  readonly capability: SegmentThresholds;
  readonly summarize: SegmentSummarizeLLMFn;
  readonly estimator?: ITokenEstimator;
  readonly bufferTurns?: number;
}

export interface AdvancementReviewRunInput {
  readonly sessionId: string;
  readonly originalUserTask: UserTurnInput;
  readonly rubric: ConfirmedRubricSnapshot;
  readonly runIndex: number;
  readonly runRecord: RunRecordInput;
  readonly runRecordRef?: RunRecordRef;
  readonly priorReviews?: readonly AdvancementRunReview[];
  readonly advancementWindow?: AdvancementWindowState;
  readonly abortSignal?: AbortSignal;
}

export interface AdvancementEvidenceCollectionInput
  extends AdvancementReviewRunInput {
  readonly requirements: ConfirmedRubricSnapshot["content"]["evidenceRequirements"];
}

export interface AdvancementEvidenceProvider {
  collect(
    input: AdvancementEvidenceCollectionInput,
  ): Promise<readonly ReviewEvidence[]>;
}
