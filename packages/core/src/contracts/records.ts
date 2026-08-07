import type {
  ArtifactRef,
  AuthorityError,
  ConversationRunState,
  Digest,
  IsoTime,
  InteractionDisplay,
  JobRunState,
  Signature,
  TurnSource,
  WireContractV1,
} from "./foundation.js";
import type {
  WireSchemaIdentity,
  WireSchemaV1,
} from "../types/distributed.js";
import type {
  AssignmentActivationProof,
  AuthorityEpochRef,
  ControlLease,
  InteractionAnswerAuthority,
  ReservableResourceLease,
  RootResourceWorkload,
  SurfaceAssetGrant,
} from "./authorization.js";
import type {
  DeferredGlobalIntent,
  GlobalStagedMutation,
  JobGlobalStagedMutation,
  SessionStagedMutation,
  WorksceneAppliedResult,
} from "./state.js";
import type { ControlEnvelope, IngressContext } from "./protocol.js";

export type UncertainResolutionTargetState = "queued" | "cancelled" | "failed";

export type ControlResultBody =
  | { t: "input"; runId: string; queuedPosition: number }
  | { t: "cancel"; runState: ConversationRunState }
  | {
      // 冻结的有序批次:候选选择与逐 run 终态在同一权威决定内定格,
      // 重放消费该结果而不重新枚举候选。
      t: "cancel-batch";
      conversationId: string;
      runs: Array<{
        runId: string;
        runState: ConversationRunState;
        source: TurnSource;
        ingressId: string;
      }>;
    }
  | { t: "session-write"; revision: number }
  | { t: "session-create"; conversationId: string }
  | { t: "global-write"; revision: number }
  | { t: "job-run"; jobRunId: string }
  | { t: "job-cancel"; runState: JobRunState }
  | {
      t: "uncertain-resolve";
      state: UncertainResolutionTargetState;
      factDigest: Digest;
    }
  | { t: "delivery-resolve"; applied: boolean };

export type ControlResult = WireSchemaV1<"ControlResult"> &
  (
    | { status: "ok"; body: ControlResultBody }
    | { status: "rejected"; error: AuthorityError }
  );

export type ControlRecord =
  | {
      t: "received";
      requestId: string;
      envelope: ControlEnvelope | { ref: ArtifactRef };
      ingress?: IngressContext;
    }
  | {
      t: "applied";
      requestId: string;
      result: ControlResult | { ref: ArtifactRef };
      authorityRevision: number;
    }
  | {
      t: "asset-grant-issued";
      grant: SurfaceAssetGrant;
    }
  | {
      t: "asset-grant-revoked";
      grantId: string;
      reason: "session-deleted" | "surface-revoked" | "superseded";
    }
  | {
      t: "authority-time-frontier";
      frontier: IsoTime;
    };

/** Latest-wins snapshot in one conversation-owned deferred-intent stream. */
export type IntentStreamRecord = {
  t: "intent";
  intent: DeferredGlobalIntent;
};

export interface DispatchRejectionProof
  extends WireSchemaV1<"DispatchRejectionProof"> {
  assignmentId: string;
  executorId: string;
  dispatchDigest: Digest;
  error: AuthorityError;
  lastRecordSeq: number;
  ledgerDigest: Digest;
  signature: Signature;
}

export interface DispatchConflictProof
  extends WireSchemaV1<"DispatchConflictProof"> {
  assignmentId: string;
  executorId: string;
  acceptedDispatchRef: ArtifactRef;
  conflictingDispatchRef: ArtifactRef;
  acceptedActivationDigest: Digest;
  conflictingActivationDigest: Digest;
  receivedRecordSeq: number;
  receivedLedgerDigest: Digest;
  error: { code: "idempotency-conflict"; retryable: false };
  signature: Signature;
}

export type DispatchConflictPayload = Omit<
  DispatchConflictProof,
  "signature"
>;

export type SupersedeProof = WireSchemaV1<"SupersedeProof"> &
  (
    | {
        assignmentId: string;
        executorId: string;
        fence: { fenceSeq: number; requestId: string };
        decision: "not-started-fenced";
        lastRecordSeq: number;
        ledgerDigest: Digest;
        signature: Signature;
      }
    | {
        assignmentId: string;
        executorId: string;
        fence: { fenceSeq: number; requestId: string };
        decision: "already-started";
        lastRecordSeq: number;
        ledgerDigest: Digest;
        signature: Signature;
      }
  );

export type CancelProofCommon = WireContractV1 & {
  assignmentId: string;
  executorId: string;
  authority: AuthorityEpochRef;
  lastRecordSeq: number;
  usageFinal: { reportDigest: Digest; upToUsageSeq: number };
  ledgerDigest: Digest;
  issuedAt: IsoTime;
  signature: Signature;
};

export type CancelProofCause =
  | {
      cause: "owner-fence";
      fence: { fenceSeq: number; requestId: string };
      ticketDigest?: never;
      surfacePrincipal?: never;
    }
  | {
      cause: "abort-ticket";
      ticketDigest: Digest;
      surfacePrincipal: string;
      fence?: never;
    };

export type CancelProofDecision =
  | { decision: "not-started"; lastEffectSeq?: never }
  | { decision: "halted"; lastEffectSeq: number };

export type NotStartedCancelProof = CancelProofCommon &
  CancelProofCause &
  Extract<CancelProofDecision, { decision: "not-started" }>;

export type HaltedCancelProof = CancelProofCommon &
  CancelProofCause &
  Extract<CancelProofDecision, { decision: "halted" }>;

export type CancelProofBody = WireSchemaV1<"CancelProofBody"> &
  (NotStartedCancelProof | HaltedCancelProof);

export type AssignmentTerminationProof =
  | DispatchRejectionProof
  | Extract<SupersedeProof, { decision: "not-started-fenced" }>
  | NotStartedCancelProof;

export interface InteractionMirrorEntry {
  ordinal: number;
  seq: number;
  requestId: string;
  kind: "allow-once";
  outcome:
    | {
        t: "answered";
        authority: InteractionAnswerAuthority;
        decision: { allowed: boolean; reason?: string };
        decisionDigest: Digest;
        by: string;
      }
    | {
        t: "auto-resolved";
        decision: "denied";
        reason: "no-interactive-surface" | "policy-fail-closed";
      }
    | {
        t: "cancelled";
        via: "cancel-fence" | "abort-ticket" | "run-end" | "backpressure";
      }
    | { t: "expired" };
  at: IsoTime;
}

export interface InteractionMirrorBatchPayload
  extends WireSchemaV1<"InteractionMirrorBatch"> {
  assignmentId: string;
  executorId: string;
  previousDigest: Digest;
  entries: InteractionMirrorEntry[];
  mirrorDigest: Digest;
}

export type InteractionMirrorBatch = InteractionMirrorBatchPayload & {
  signature: Signature;
};

export interface InteractionSettlementStreamProof {
  readonly v: 2;
  readonly assignmentId: string;
  readonly executorId: string;
  readonly ticketDigest: Digest;
  readonly sourceLastSeq: number;
  readonly sourceChainDigest: Digest;
  readonly targetInteractionRecordSeq: number;
  readonly projectedRecordSeq: number;
  readonly upToRecordSeq: number;
  readonly lastStreamSeq: number;
  readonly streamDigest: Digest;
  readonly ledgerChainDigest: Digest;
  readonly signature: Signature;
}

type AssignmentRecordV1Body =
  (
    | {
        t: "received";
        envelope: { ref: ArtifactRef };
        activation: AssignmentActivationProof;
      }
    | {
        t: "dispatch-rejected";
        dispatchDigest: Digest;
        reason: AuthorityError;
      }
    | { t: "control-lease-renewed"; lease: ControlLease }
    | { t: "supersede-fenced"; fenceSeq: number; requestId: string }
    | { t: "started" }
    | {
        t: "interaction-requested";
        requestId: string;
        kind: "allow-once";
        toolName: string;
        display: InteractionDisplay;
        issuedAt: IsoTime;
        ttlMs: number;
        expiresAt: IsoTime;
      }
    | {
        t: "interaction-finished";
        requestId: string;
        kind: "allow-once";
        outcome:
          | {
              t: "answered";
              authority: InteractionAnswerAuthority;
              decision: { allowed: boolean; reason?: string };
              decisionDigest: Digest;
              by: string;
            }
          | {
              t: "auto-resolved";
              decision: "denied";
              reason: "no-interactive-surface" | "policy-fail-closed";
            }
          | {
              t: "cancelled";
              via:
                | "cancel-fence"
                | "abort-ticket"
                | "run-end"
                | "backpressure";
            }
          | { t: "expired" };
      }
    | {
        t: "staged-mutation";
        seq: number;
        domain: "session" | "global";
        mutation:
          | SessionStagedMutation
          | GlobalStagedMutation
          | JobGlobalStagedMutation;
        requestId: string;
        expected?: { anchorEpoch: number };
      }
    | {
        t: "side-effect-started";
        effectSeq: number;
        kind: "tool-mutation" | "external-call";
        toolName: string;
        summary: string;
        target: "workspace-file" | "external-service" | "device-system";
      }
    | {
        t: "side-effect-completed";
        effectSeq: number;
        status: "ok" | "failed" | "aborted";
        resultDigest?: Digest;
      }
    | {
        t: "abort-requested";
        via: "owner-fence";
        refId: string;
      }
    | {
        t: "abort-requested";
        via: "abort-ticket";
        refId: string;
        surfacePrincipal: string;
      }
    | { t: "halted"; proof: CancelProofBody }
    | {
        t: "execution-failed";
        reason: string;
        usageFinal: { reportDigest: Digest; upToUsageSeq: number };
      }
    | {
        t: "bundle_sealed";
        bundle: { ref: ArtifactRef };
        mutationBatch?: { ref: ArtifactRef };
      }
    | { t: "acked"; commitRevision: number }
    | { t: "mirrored"; upTo: number; ordinal: number; mirrorDigest: Digest }
  );

type AssignmentRecordV1 = AssignmentRecordV1Body extends infer RecordBody
  ? RecordBody extends object
    ? RecordBody & { readonly v: 1 }
    : never
  : never;

type AssignmentRecordV2 =
  | {
      readonly v: 2;
      readonly t: "interaction-stream-projection-enabled";
      readonly legacyUpToRecordSeq: number;
    }
  | {
      readonly v: 2;
      readonly t: "interaction-stream-projected";
      readonly assignmentId: string;
      readonly upToRecordSeq: number;
      readonly lastStreamSeq: number;
      readonly streamDigest: Digest;
    }
  | {
      readonly v: 2;
      readonly t: "cancel-proof-owner-accepted";
    }
  | {
      readonly v: 2;
      readonly t: "interaction-settlement-owner-accepted";
      readonly assignmentId: string;
      readonly ticketDigest: Digest;
      readonly settlementVersion: 1;
    }
  | {
      readonly v: 2;
      readonly t: "interaction-settlement-owner-accepted";
      readonly assignmentId: string;
      readonly ticketDigest: Digest;
      readonly settlementVersion: 2;
      readonly streamProof: InteractionSettlementStreamProof;
    };

export type AssignmentRecord = WireSchemaIdentity<"AssignmentRecord"> &
  (AssignmentRecordV1 | AssignmentRecordV2);

export interface AssignmentEntry {
  recordSeq: number;
  body: AssignmentRecord;
}

export interface MutationBatch extends WireSchemaV1<"MutationBatch"> {
  assignmentId: string;
  records: Array<Extract<AssignmentRecord, { t: "staged-mutation" }>>;
  count: number;
  digest: Digest;
}

export type PublishRecord =
  | {
      t: "publish-decision";
      assignmentId: string;
      batch: { ref: ArtifactRef };
      sessionCount: number;
      globalCount: number;
      outcomes: Array<{
        seq: number;
        outcome:
          | {
              t: "granted";
              targetRevision: number;
              appliedResult?: WorksceneAppliedResult;
            }
          | { t: "conflicted"; error: AuthorityError };
      }>;
    }
  | {
      t: "publish-progress";
      assignmentId: string;
      domain: "session" | "global";
      upToSeq: number;
      state: "pending" | "settled";
    };

export type GovernorRecord =
  | {
      t: "queued";
      reservationId: string;
      admissionClass: import("./authorization.js").AdmissionClass;
      workload: RootResourceWorkload;
    }
    | {
        t: "dequeue";
        workload: RootResourceWorkload;
        reason: "cancelled" | "failed" | "expired";
      }
  | { t: "reserve"; lease: ReservableResourceLease }
  | {
      t: "usage-reserved";
      rootReservationId: string;
      reservationId: string;
      usageId: string;
      tokens?: number;
      calls?: number;
      costMinor?: number;
    }
  | {
      t: "consume";
      usageSeq: number;
      rootReservationId: string;
      reservationId: string;
      usageId: string;
      tokens?: number;
      calls?: number;
      costMinor?: number;
    }
  | { t: "settle" | "release" | "reclaim"; reservationId: string };

export interface FinalOutboxRecord {
  t: "final";
  conversationId: string;
  runId: string;
  commitRevision: number;
  digest: Digest;
  state: "pending" | "published" | "expired";
}
