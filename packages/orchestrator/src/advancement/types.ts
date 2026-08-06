import type {
  AdvancementReviewRunInput,
  ConfirmedRubricSnapshot,
  EvidenceCapabilitySet,
} from "@zhixing/core/advancement";
import type {
  LLMProvider,
  ReviewEvidence,
  SegmentThresholds,
  ITokenEstimator,
  ThinkingConfig,
} from "@zhixing/core";
import type {
  AdvancementReviewerPort,
  ResourceReservationPort,
} from "@zhixing/core/contracts";

export type {
  AdvancementReviewRunInput,
  AdvancementReviewRunOutcome,
} from "@zhixing/core/advancement";

/** 推进侧裁判运行体——AdvancementReviewerPort 的生产实现形状。 */
export type AdvancementRuntime = AdvancementReviewerPort;

export interface AdvancementRuntimeOptions {
  /** 未治理的主档 provider——裁判调用的计量由本运行体对传入租约单点执行。 */
  readonly provider: LLMProvider;
  readonly model: string;
  readonly thinking?: ThinkingConfig;
  /** 未治理的 light provider——推进窗口摘要的计量与裁判同一租约。 */
  readonly lightProvider?: LLMProvider;
  readonly lightModel?: string;
  readonly lightThinking?: ThinkingConfig;
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
  /**
   * 租约计量面——裁判与窗口调用沿稳定 usageId 对 review 传入租约预占/消费；
   * 缺省时调用不计量（测试 / 无治理装配）。
   */
  readonly resourceMeter?: Pick<
    ResourceReservationPort,
    "reserveUsage" | "consume"
  >;
  readonly hostComponent?: string;
  readonly defaultMaxOutputTokens?: number;
}

export interface AdvancementContextWindowOptions {
  readonly capability: SegmentThresholds;
  readonly estimator?: ITokenEstimator;
  readonly bufferTurns?: number;
}

export interface AdvancementEvidenceCollectionInput
  extends AdvancementReviewRunInput {
  readonly requirements: ConfirmedRubricSnapshot["content"]["evidenceRequirements"];
  readonly abortSignal?: AbortSignal;
}

export interface AdvancementEvidenceProvider {
  collect(
    input: AdvancementEvidenceCollectionInput,
  ): Promise<readonly ReviewEvidence[]>;
}
