import type {
  ArtifactRef,
  AuthorityError,
  ConversationRunState,
  Digest,
  IsoTime,
  JobRunState,
  Signature,
  WireContractV1,
} from "./foundation.js";
import type { WireSchemaV1 } from "../types/distributed.js";
import type {
  AssignmentActivationProof,
  AuthorityEpochRef,
  InteractionAnswerAuthority,
} from "./authorization.js";
import type {
  GlobalStagedMutation,
  JobGlobalStagedMutation,
  SessionStagedMutation,
} from "./state.js";
import type { ControlEnvelope } from "./protocol.js";

export type ControlResultBody =
  | { t: "input"; runId: string; queuedPosition: number }
  | { t: "cancel"; runState: ConversationRunState }
  | { t: "session-write"; revision: number }
  | { t: "session-create"; conversationId: string }
  | { t: "global-write"; revision: number }
  | { t: "job-run"; jobRunId: string }
  | { t: "job-cancel"; runState: JobRunState }
  | { t: "uncertain-resolve"; state: ConversationRunState | JobRunState }
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
    }
  | {
      t: "applied";
      requestId: string;
      result: ControlResult | { ref: ArtifactRef };
      authorityRevision: number;
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
  seq: number;
  requestId: string;
  kind: "allow-once";
  outcome:
    | {
        t: "answered";
        authority: InteractionAnswerAuthority;
        decision: { allowed: boolean; reason?: string };
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

export type AssignmentRecord = WireSchemaV1<"AssignmentRecord"> &
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
    | { t: "supersede-fenced"; fenceSeq: number; requestId: string }
    | { t: "started" }
    | {
        t: "interaction-requested";
        requestId: string;
        kind: "allow-once";
        toolName: string;
        display: { title: string; lines: string[] };
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
        via: "owner-fence" | "abort-ticket";
        refId: string;
      }
    | { t: "halted"; proof: CancelProofBody }
    | {
        t: "bundle_sealed";
        bundle: { ref: ArtifactRef };
        mutationBatch?: { ref: ArtifactRef };
      }
    | { t: "acked"; commitRevision: number }
    | { t: "mirrored"; upTo: number }
  );

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
