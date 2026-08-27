import type { ArtifactRef } from "../types/distributed.js";

export type {
  ArtifactRef,
  Digest,
  IsoTime,
  JsonValue,
  KeyConfirmation,
  ProtocolVersion,
  Signature,
  Ulid,
  WireContractV1,
} from "../types/distributed.js";

export type { Message } from "../types/messages.js";
export type { UserTurnInput } from "../types/user-input.js";
export type { AgentYield } from "../loop/types.js";
export type { TurnOrigin } from "../types/tools.js";

/** Canonical durable representation shared by interaction journals and stream frames. */
export type InteractionDisplay =
  | { readonly title: string; readonly lines: readonly string[] }
  | { readonly ref: ArtifactRef };
export type {
  AgentEventMap,
  ProjectedPassthroughEvent,
  SessionEventProjection,
} from "../types/agent-events.js";
export type {
  AdvancementControlEvent,
  AdvancementSnapshot,
  EvidenceKind,
  EvidenceLocator,
} from "../advancement/types.js";
export type { TaskListOp, TaskListState, SegmentRecord } from "../conversation/types.js";
export type {
  PortableTrustRule,
  TrustRule,
  TrustRuleSnapshot,
} from "../security/types.js";
export type { SkillModeDto, SkillUsageRecord } from "../skills/types.js";
export type {
  ScheduleTaskSpec,
} from "../scheduler/facade.js";
export type {
  TaskPriorityDto,
  TaskScheduleDto,
} from "../scheduler/types.js";
export type { DeliveryTargetDto, OutboundContentDto } from "../channels/types.js";
export type { TranscriptRunRecord } from "../transcript/shard/types.js";
export type {
  RunRecordAdvancementMetadata,
  TurnSource,
} from "../transcript/types.js";
export type { WindowCompactInstruction } from "../context/window/types.js";

export interface AuthorityError {
  code:
    | "unauthorized"
    | "capability-expired"
    | "epoch-stale"
    | "revision-conflict"
    | "fence-rejected"
    | "busy"
    | "not-found"
    | "invalid"
    | "lease-exhausted"
    | "missing-base"
    | "typed-stale"
    | "capability-gap"
    | "unavailable-offline"
    | "idempotency-conflict";
  message: string;
  retryable: boolean;
}

export type DispatchConflictError = Omit<
  AuthorityError,
  "code" | "retryable"
> & {
  code: "idempotency-conflict";
  retryable: false;
};

export type ConversationRunState =
  | "queued"
  | "dispatched"
  | "running"
  | "cancel-requested"
  | "committed"
  | "cancelled"
  | "failed"
  | "expired"
  | "uncertain";

export type JobRunState =
  | "queued"
  | "dispatched"
  | "running"
  | "cancel-requested"
  | "committed"
  | "cancelled"
  | "failed"
  | "expired"
  | "missed"
  | "uncertain";
