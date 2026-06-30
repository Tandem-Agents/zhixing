import type {
  AdvancementRunReview,
  ConfirmedRubricSnapshot,
  ReviewEvidence,
} from "@zhixing/core/advancement";
import type {
  LLMProvider,
  RunRecordInput,
  RunRecordRef,
  ThinkingConfig,
  UserTurnInput,
} from "@zhixing/core";

export interface AdvancementRuntime {
  reviewRun(input: AdvancementReviewRunInput): Promise<AdvancementRunReview>;
}

export interface AdvancementRuntimeOptions {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly thinking?: ThinkingConfig;
  readonly evidenceProvider?: AdvancementEvidenceProvider;
  readonly maxJudgeTurns?: number;
  readonly workingDirectory?: string;
  readonly now?: () => Date;
  readonly idGenerator?: () => string;
}

export interface AdvancementReviewRunInput {
  readonly sessionId: string;
  readonly originalUserTask: UserTurnInput;
  readonly rubric: ConfirmedRubricSnapshot;
  readonly runIndex: number;
  readonly runRecord: RunRecordInput;
  readonly runRecordRef?: RunRecordRef;
  readonly priorReviews?: readonly AdvancementRunReview[];
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
