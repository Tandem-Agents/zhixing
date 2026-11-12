import type { DurableProjectionReadContext } from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AuthorityError,
  GlobalStagedMutation,
  LogicalRecord,
  WorksceneAppliedResult,
} from "@zhixing-ai/core/contracts";

export type GlobalMutationPublishOutcome =
  | {
      readonly t: "granted";
      readonly targetRevision: number;
      readonly appliedResult?: WorksceneAppliedResult;
    }
  | { readonly t: "conflicted"; readonly error: AuthorityError };

export interface GlobalMutationCommitRecord {
  readonly seq: number;
  readonly requestId: string;
  readonly mutation: GlobalStagedMutation;
}

/**
 * One anchor-owned global domain that can reserve authoritative results in the
 * same commit as the run which granted them, then refresh its derived facade.
 */
export interface GlobalMutationCommitParticipant {
  /** Durable primary read model used for exact-prefix staged planning. */
  readonly stagedProjectionId: string;
  ownsStagedMutation(mutation: GlobalStagedMutation): boolean;
  collectStagedReferences?(
    records: readonly GlobalMutationCommitRecord[],
  ): Promise<readonly ArtifactRef[]>;
  prepareStagedMutations(input: {
    readonly assignmentId: string;
    readonly records: readonly GlobalMutationCommitRecord[];
    readonly authorityProjection: DurableProjectionReadContext;
    readonly at: string;
  }): Promise<{
    readonly records: readonly LogicalRecord[];
    readonly outcomes: ReadonlyMap<number, GlobalMutationPublishOutcome>;
  }>;
  applyStagedMutation(input: {
    readonly assignmentId: string;
    readonly seq: number;
    readonly mutation: GlobalStagedMutation;
    readonly requestId: string;
    readonly targetRevision: number;
    readonly appliedResult?: WorksceneAppliedResult;
  }): Promise<void>;
  refreshStagedMutations?(
    records: readonly GlobalMutationCommitRecord[],
    requestId?: string,
  ): Promise<void>;
  /**
   * 父运行提交成功之后、在提交事务之外调用，参数只含本次实际追加且已授予的本域记录。
   * 用于及时观察已提交的结果；物化确认仍由 applyStagedMutation 承担，恢复路径兜底。
   */
  observeCommittedMutations?(
    records: readonly GlobalMutationCommitRecord[],
  ): Promise<void>;
}
