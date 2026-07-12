import type {
  AssignmentMethodId,
  AuthorityPortMethodId,
  HostMethodId,
  OwnerControlMethodId,
  SubmissionMethodId,
  SurfaceMethodId,
  UsageReporterMethodId,
} from "./authorization.js";
import type {
  AdvancementControlEvent,
  AdvancementSnapshot,
  DeliveryTargetDto,
  MemoryAppendPayload,
  MemoryCategoryDto,
  PersonMetaDto,
  ScheduleTaskSpec,
  SegmentRecord,
  SkillModeDto,
  SkillUsageRecord,
  TaskListOp,
  TaskPriorityDto,
  TaskScheduleDto,
  TranscriptRunRecord,
  TrustRule,
  WindowCompactInstruction,
} from "./foundation.js";
import type { DispatchEnvelope } from "./protocol.js";
import type { RunDispatchArguments } from "./ports.js";
import type { JobGlobalStagedMutation, SkillStatePatch } from "./state.js";
import type { AdvancementSession, AdvancementStoreEvent } from "../advancement/types.js";
import type { DeliveryTarget } from "../channels/types.js";
import type { SegmentMeta, TaskListState } from "../conversation/types.js";
import type { MemoryCategory } from "../memory/memory-store.js";
import type { PersonMeta } from "../memory/people-store.js";
import type { TaskSpec } from "../scheduler/facade.js";
import type { TaskPriority, TaskSchedule } from "../scheduler/types.js";
import type { PermissionRule } from "../security/types.js";
import type { SkillMode, SkillUsage } from "../skills/types.js";
import type { RunRecord } from "../transcript/shard/types.js";
import type { WindowCompact } from "../context/window/types.js";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Equivalent<A, B> = A extends B ? (B extends A ? true : false) : false;

type RegisteredPrincipalMethods =
  | AssignmentMethodId
  | SurfaceMethodId
  | HostMethodId
  | OwnerControlMethodId
  | SubmissionMethodId
  | UsageReporterMethodId;

export type PrincipalMethodCoverageInvariant = Assert<
  Equal<AuthorityPortMethodId, RegisteredPrincipalMethods>
>;

type ConversationDispatch = Extract<
  DispatchEnvelope,
  { execution: "conversation" }
>;
type JobDispatch = Extract<DispatchEnvelope, { execution: "job" }>;

export type ConversationDispatchDomainInvariant = Assert<
  Equal<ConversationDispatch["work"]["t"], "conversation">
>;
export type JobDispatchDomainInvariant = Assert<
  Equal<JobDispatch["work"]["t"], "job">
>;
export type ConversationCapabilityDomainInvariant = Assert<
  Equal<
    ConversationDispatch["capabilities"][number]["scope"]["execution"],
    "conversation"
  >
>;
export type JobCapabilityDomainInvariant = Assert<
  Equal<JobDispatch["capabilities"][number]["scope"]["execution"], "job">
>;

type ConversationDispatchArguments = Extract<
  RunDispatchArguments,
  [envelope: { execution: "conversation" }, activation: object, ctx: object]
>;
export type DispatchArgumentDomainInvariant = Assert<
  Equal<
    ConversationDispatchArguments[1]["ref"]["execution"],
    "conversation"
  >
>;

type JobDelivery = Extract<
  JobGlobalStagedMutation,
  { kind: "delivery-enqueue" }
>;
export type JobDeliveryTargetInvariant = Assert<
  Equal<JobDelivery["request"]["target"]["kind"], "explicit">
>;
export type NonEmptySkillPatchInvariant = Assert<
  Record<string, never> extends SkillStatePatch ? false : true
>;

export type AdvancementEventAliasInvariant = Assert<
  Equal<AdvancementControlEvent, AdvancementStoreEvent>
>;
export type AdvancementSnapshotAliasInvariant = Assert<
  Equal<AdvancementSnapshot, AdvancementSession>
>;
export type TrustRuleAliasInvariant = Assert<Equal<TrustRule, PermissionRule>>;
export type ScheduleTaskSpecAliasInvariant = Assert<
  Equal<ScheduleTaskSpec, TaskSpec>
>;
export type TranscriptRunRecordAliasInvariant = Assert<
  Equal<TranscriptRunRecord, RunRecord>
>;
export type WindowCompactAliasInvariant = Assert<
  Equal<WindowCompactInstruction, WindowCompact>
>;
export type SegmentRecordAliasInvariant = Assert<Equal<SegmentRecord, SegmentMeta>>;
export type TaskListOpInvariant = Assert<
  Equal<TaskListOp, { op: "set"; state: TaskListState }>
>;
export type SkillUsageRecordInvariant = Assert<
  Equivalent<SkillUsageRecord, SkillUsage & { skillId: string }>
>;
export type MemoryCategorySnapshotInvariant = Assert<
  Equal<MemoryCategoryDto, MemoryCategory>
>;
export type PersonMetaSnapshotInvariant = Assert<
  Equivalent<PersonMetaDto, PersonMeta>
>;
export type TaskPrioritySnapshotInvariant = Assert<
  Equal<TaskPriorityDto, TaskPriority>
>;
export type TaskScheduleSnapshotInvariant = Assert<
  Equal<TaskScheduleDto, TaskSchedule>
>;
export type SkillModeSnapshotInvariant = Assert<Equal<SkillModeDto, SkillMode>>;
export type DeliveryTargetSnapshotInvariant = Assert<
  Equivalent<DeliveryTargetDto, DeliveryTarget>
>;
export type MemoryAppendDomainsInvariant = Assert<
  Equal<MemoryAppendPayload["domain"], "memory" | "journal" | "people">
>;
