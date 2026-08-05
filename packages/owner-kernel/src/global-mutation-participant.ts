import type { DurableProjectionReadContext } from "@zhixing/core/authority";
import type {
  AuthorityError,
  GlobalStagedMutation,
  LogicalRecord,
  WorksceneAppliedResult,
} from "@zhixing/core/contracts";

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
}
