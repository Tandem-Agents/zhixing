import type {
  AdvancementControlEvent,
  ArtifactRef,
  AuthorityError,
  JobRunState,
  DeliveryTargetDto,
  Digest,
  IsoTime,
  JournalEntry,
  JsonValue,
  MemoryAppendPayload,
  MemoryEntry,
  OutboundContentDto,
  PersonEntry,
  SegmentRecord,
  SkillModeDto,
  SkillUsageRecord,
  TaskListOp,
  TaskPriorityDto,
  TaskScheduleDto,
  TranscriptRunRecord,
  TrustRule,
  TrustRuleSnapshot,
} from "./foundation.js";
import type { WireSchemaV1 } from "../types/distributed.js";
import type {
  ChannelMessageRef,
  ChannelResponderRef,
  ExecutionRef,
} from "./authorization.js";
import type { SecretRef } from "./identity.js";

export interface SessionMeta {
  conversationId: string;
  ownerEpoch: number;
  baseRevision: number;
  name?: string;
  sceneId?: string;
  turnCount: number;
  lastActiveAt: IsoTime;
}

export interface TranscriptCursor {
  shardId: string;
  runIndex: number;
}

export interface TranscriptPage {
  records: TranscriptRunRecord[];
  next?: TranscriptCursor;
}

export type ContentAssetRef = ArtifactRef & {
  kind: "image" | "file" | "tool-output" | "window-snapshot";
};

export type SessionControlMutation =
  | { kind: "task-list-op"; op: TaskListOp }
  | { kind: "advancement-event"; event: AdvancementControlEvent }
  | {
      kind: "session-meta";
      patch: { name?: string; sceneId?: string | null; viewLayerState?: string };
    }
  | { kind: "window-op"; op: "clear" | "compact" }
  | { kind: "conversation-delete" };

export type SessionStagedMutation =
  | { kind: "task-list-op"; op: TaskListOp }
  | { kind: "segment-append"; segment: SegmentRecord };

export type SessionInternalRecord = {
  kind: "content-asset-index";
  entries: ContentAssetRef[];
};

export interface WorksceneDto {
  id: string;
  name: string;
  workspace?: { deviceId: string; bindingRef: string };
  createdAt: IsoTime;
  lastActiveAt: IsoTime;
}

export interface SkillWriteDto {
  name: string;
  description: string;
  content: ArtifactRef;
}

export interface RubricWriteDto {
  title: string;
  description: string;
  content: ArtifactRef;
}

export type SkillStatePatch =
  | { mode: SkillModeDto; pinned?: boolean; disabled?: boolean }
  | { pinned: boolean; mode?: SkillModeDto; disabled?: boolean }
  | { disabled: boolean; mode?: SkillModeDto; pinned?: boolean };

export interface ConfigAssetRecord extends WireSchemaV1<"ConfigAssetRecord"> {
  domain:
    | "guidance"
    | "channel-registry"
    | "model-profile"
    | "policy"
    | "prompt-assets";
  key: string;
  revision: number;
  schemaId: string;
  value: JsonValue;
  digest: Digest;
}

export type GlobalQuery =
  | {
      kind: "memory-search";
      domain: "memory" | "journal" | "people";
      query: string;
      limit: number;
    }
  | { kind: "memory-stats"; domain: "journal" | "people" }
  | { kind: "trust-rules"; scope?: string }
  | { kind: "schedule-list"; includeDisabled?: boolean }
  | { kind: "workscene-list" }
  | { kind: "config-asset"; domain: ConfigAssetRecord["domain"]; key?: string }
  | { kind: "asset-index"; asset: "skills" | "rubrics" | "prompt-assets" };

export interface AssetIndexEntry {
  id: string;
  kind: "skills" | "rubrics" | "prompt-assets";
  revision: number;
  digest: Digest;
}

export type GlobalReadResult =
  | {
      kind: "memory-search";
      hits: Array<{
        domain: "memory" | "journal" | "people";
        entry: MemoryEntry | JournalEntry | PersonEntry;
        score?: number;
      }>;
    }
  | {
      kind: "memory-stats";
      domain: "journal" | "people";
      count: number;
      lastWriteAt?: IsoTime;
    }
  | { kind: "trust-rules"; snapshot: TrustRuleSnapshot }
  | { kind: "schedule-list"; tasks: TaskDefinition[] }
  | { kind: "workscene-list"; scenes: WorksceneDto[] }
  | { kind: "config-asset"; records: ConfigAssetRecord[] }
  | { kind: "asset-index"; entries: AssetIndexEntry[] };

export type TaskDeliveryDto =
  | { kind: "none" }
  | { kind: "channel"; channel: string; to: string; threadId?: string }
  | { kind: "webhook"; endpoint: SecretRef };

export type ScheduleActionDto = {
  kind: "agent-turn";
  prompt: string;
  model?: string;
  tools?: string[];
};

export interface ScheduleTaskSpecDto {
  name: string;
  description?: string;
  enabled: boolean;
  priority: TaskPriorityDto;
  schedule: TaskScheduleDto;
  action: ScheduleActionDto;
  delivery?: TaskDeliveryDto;
}

export type SystemHandlerId =
  | "__transcript-gc"
  | "__journal-gc"
  | "__advancement-gc";

export interface DeliveryRequestDto {
  target:
    | { kind: "turn-origin" }
    | { kind: "explicit"; target: DeliveryTargetDto };
  content: string | { ref: ArtifactRef };
}

export type ScheduleWriteMutation =
  | { kind: "schedule-create"; spec: ScheduleTaskSpecDto }
  | {
      kind: "schedule-update";
      taskId: string;
      spec: ScheduleTaskSpecDto;
      taskRevision: number;
    }
  | {
      kind: "schedule-set-state";
      taskId: string;
      state: "enabled" | "disabled";
      taskRevision: number;
    }
  | { kind: "schedule-delete"; taskId: string; taskRevision: number };

export type SkillWriteMutation =
  | { kind: "skill-create"; record: SkillWriteDto }
  | {
      kind: "skill-update";
      skillId: string;
      record: SkillWriteDto;
      expectedRevision: number;
    }
  | { kind: "skill-admit"; record: SkillWriteDto }
  | {
      kind: "skill-set-state";
      skillId: string;
      patch: SkillStatePatch;
      expectedRevision: number;
    }
  | { kind: "skill-archive"; skillId: string; expectedRevision: number };

export type RubricWriteMutation =
  | { kind: "rubric-save-own"; rubric: RubricWriteDto }
  | {
      kind: "rubric-update-own";
      rubricId: string;
      rubric: RubricWriteDto;
      expectedRevision: number;
    }
  | { kind: "rubric-archive"; rubricId: string; expectedRevision: number };

export type WorksceneWriteMutation =
  | {
      kind: "workscene-create";
      name: string;
      workspace?: { deviceId: string; bindingRef: string };
    }
  | {
      kind: "workscene-rename";
      sceneId: string;
      name: string;
      expectedRevision: number;
    }
  | {
      kind: "workscene-set-workdir";
      sceneId: string;
      workspace: { deviceId: string; bindingRef: string } | null;
      expectedRevision: number;
    }
  | { kind: "workscene-delete"; sceneId: string; expectedRevision: number };

export type TrustWriteMutation =
  | { kind: "trust-persist"; rule: TrustRule }
  | { kind: "trust-revoke"; ruleId: string };

export type GlobalControlMutation =
  | { kind: "memory-append"; payload: MemoryAppendPayload }
  | ScheduleWriteMutation
  | SkillWriteMutation
  | RubricWriteMutation
  | WorksceneWriteMutation
  | TrustWriteMutation
  | { kind: "config-asset-write"; record: ConfigAssetRecord };

export type GlobalStagedBase =
  | { kind: "memory-append"; payload: MemoryAppendPayload }
  | ScheduleWriteMutation
  | { kind: "skill-usage"; record: SkillUsageRecord }
  | Extract<
      SkillWriteMutation,
      { kind: "skill-create" | "skill-update" | "skill-admit" }
    >
  | WorksceneWriteMutation;

export type GlobalStagedMutation =
  | GlobalStagedBase
  | { kind: "delivery-enqueue"; request: DeliveryRequestDto };

export type JobGlobalStagedMutation =
  | GlobalStagedBase
  | {
      kind: "delivery-enqueue";
      request: {
        target: Extract<
          DeliveryRequestDto["target"],
          { kind: "explicit" }
        >;
        content: DeliveryRequestDto["content"];
      };
    };

export type TaskDefinitionBody =
  | {
      kind: "user";
      spec: ScheduleTaskSpecDto;
      origin?: DeliveryTargetDto;
      interactionResponder?: ChannelResponderRef;
      createdInTurn?: string;
    }
  | { kind: "system"; handler: SystemHandlerId; params?: JsonValue };

export interface TaskDefinition {
  taskId: string;
  taskRevision: number;
  definition: TaskDefinitionBody;
  state: "enabled" | "disabled" | "deleted";
}

export interface JobOccurrence {
  taskId: string;
  jobRunId: string;
  scheduledFor: IsoTime;
  taskRevision: number;
  deliveryPlan: { planDigest: Digest; delivery: TaskDeliveryDto };
  state: JobRunState;
}

export interface SystemJobFence {
  taskId: string;
  jobRunId: string;
  scheduledFor: IsoTime;
  taskRevision: number;
  anchorEpoch: number;
  handler: SystemHandlerId;
  paramsDigest: Digest;
  reservationId: string;
  attempt: number;
}

export type DeliveryEndpointDto =
  | { kind: "channel"; target: DeliveryTargetDto }
  | { kind: "webhook"; endpoint: SecretRef };

export type DeliveryEnqueueKeyBody =
  | {
      kind: "job-result-delivery";
      taskId: string;
      jobRunId: string;
      planDigest: Digest;
    }
  | { kind: "staged-delivery"; assignmentId: string; mutationSeq: number }
  | {
      kind: "conversation-final-delivery";
      conversationId: string;
      runId: string;
      commitRevision: number;
    }
  | {
      kind: "conversation-status-delivery";
      conversationId: string;
      runId: string;
      statusRevision: number;
    }
  | {
      kind: "job-status-delivery";
      taskId: string;
      jobRunId: string;
      statusRevision: number;
    }
  | {
      // 控制回执:一个控制决定恰产生一个回执 item,以 canonical requestId 幂等。
      // 当前唯一生产者是 cancel-batch 的空批次渠道回执。
      kind: "conversation-control-response-delivery";
      conversationId: string;
      requestId: string;
    };

export interface DeliveryIntentDto {
  endpoint: DeliveryEndpointDto;
  content: OutboundContentDto | { ref: ArtifactRef };
  priority: "low" | "normal" | "high";
  source?:
    | {
        kind: "scheduler";
        taskId: string;
        taskName: string;
        createdInTurn?: string;
      }
    | { kind: "agent"; conversationId: string; turnSlotId?: string }
    | { kind: "system"; reason: string };
  createdAt: IsoTime;
  maxAttempts: number;
}

export interface DeliveryFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface DeliveryResolutionFact {
  itemId: string;
  attempt: number;
  openedAnchorEpoch: number;
  resolvedAnchorEpoch: number;
  openFactDigest: Digest;
  decision: "user-verified-sent" | "abandon" | "retry-risk-ack";
  by: string;
  at: IsoTime;
  factDigest: Digest;
}

export type DeliveryItemState =
  | "queued"
  | "attempting"
  | "retry-wait"
  | "uncertain"
  | "sent"
  | "failed"
  | "verified-sent"
  | "abandoned";

export type DeliveryStreamRecord =
  | {
      t: "enqueued";
      itemId: string;
      keyBody: DeliveryEnqueueKeyBody;
      idempotencyKey: string;
      intentDigest: Digest;
      intent: DeliveryIntentDto;
      statusRevision: number;
    }
  | {
      t: "attempt-started";
      itemId: string;
      attempt: number;
      authorization:
        | { kind: "automatic" }
        | { kind: "manual"; resolutionFactDigest: Digest };
      startedAt: IsoTime;
      unknownOutcome:
        | { kind: "idempotent-redrive"; redriveUntil: IsoTime }
        | { kind: "manual-resolution" };
      statusRevision: number;
    }
  | {
      t: "sent";
      itemId: string;
      attempt: number;
      receipt?: { digest: Digest; platformMessage?: ChannelMessageRef };
      statusRevision: number;
    }
  | {
      t: "retry-scheduled";
      itemId: string;
      attempt: number;
      retryAt: IsoTime;
      error: DeliveryFailure;
      statusRevision: number;
    }
  | {
      t: "failed";
      itemId: string;
      attempt: number;
      error: DeliveryFailure;
      statusRevision: number;
    }
  | {
      t: "delivery-uncertain";
      itemId: string;
      attempt: number;
      openedAnchorEpoch: number;
      openedAt: IsoTime;
      openFactDigest: Digest;
      statusRevision: number;
    }
  | { t: "delivery-resolved"; fact: DeliveryResolutionFact; statusRevision: number };

export type UncertainResolutionOutcome = {
  kind:
    | "late-bundle-committed"
    | "proven-not-started-redispatched"
    | "proven-not-started-cancelled"
    | "user-verified-side-effects"
    | "user-abandoned"
    | "user-retry-acknowledged";
  by: string;
  at: IsoTime;
  factDigest: Digest;
};

export type UncertainResolutionFact =
  | {
      subject: Extract<ExecutionRef, { execution: "conversation" }> & {
        assignmentId: string;
      };
      openedAt: IsoTime;
      cause: "ledger-unknown" | "cancel-unproven" | "dispatch-conflict";
      openFactDigest: Digest;
      resolution?: UncertainResolutionOutcome;
    }
  | {
      subject: Extract<ExecutionRef, { execution: "job" }> & {
        assignmentId: string;
      };
      openedAt: IsoTime;
      cause: "ledger-unknown" | "job-cancel-unknown" | "dispatch-conflict";
      openFactDigest: Digest;
      resolution?: UncertainResolutionOutcome;
    };

export interface DeferredGlobalIntent {
  intentId: string;
  localDomainId: string;
  conversationId: string;
  mutation:
    | ScheduleWriteMutation
    | Extract<
        RubricWriteMutation,
        { kind: "rubric-save-own" | "rubric-update-own" }
      >;
  recordedAt: IsoTime;
  timeSensitive: boolean;
  status: "pending" | "confirmed" | "discarded";
  reviewedAt?: IsoTime;
}

export interface PublishConflictNotice {
  conversationId: string;
  runId: string;
  commitRevision: number;
  conflicts: Array<{
    seq: number;
    mutation: GlobalStagedMutation;
    error: AuthorityError;
  }>;
}
