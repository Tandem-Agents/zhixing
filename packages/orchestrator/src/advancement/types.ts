import type {
  AdvancementRunReview,
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

/**
 * 一次验收的结果——结论与挂起是两种语义，不用异常做控制流：
 * - reviewed：裁判产出了结论（含 fail-closed 的终局 exit）——落盘、驱动闭环。
 * - deferred：本轮验收未产生结论——基础设施 transient 失败（限流 / 网络 /
 *   取证 IO）或调用被中止。不落盘 review、不前进已审进度，被审 run 保持
 *   「已接受未审」态由补审触发点收敛；过夜任务不因一次抖动永久退出。
 */
export type AdvancementReviewRunOutcome =
  | {
      readonly kind: "reviewed";
      readonly review: AdvancementRunReview;
      readonly advancementWindow?: AdvancementWindowState;
    }
  | {
      readonly kind: "deferred";
      readonly cause: "infrastructure" | "aborted";
      readonly reason: string;
    };

export interface AdvancementRuntime {
  reviewRun(input: AdvancementReviewRunInput): Promise<AdvancementReviewRunOutcome>;
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
