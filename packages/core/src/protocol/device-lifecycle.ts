import { Buffer } from "node:buffer";
import type { ArtifactRef, Signature } from "../contracts/index.js";
import { canonicalize, protocolDigest } from "./canonical.js";
import type { ProtocolSignatureVerifier, ProtocolSigner } from "./signature.js";
import { assertProtocolIdentifier } from "./validation.js";

export const DEVICE_LIFECYCLE_STREAM = "device-lifecycle";

export type DeviceLifecycleKind = "stop" | "executor-removal" | "anchor-uninstall";
export type StopStrategy = "immediate" | "drain" | "cancel";

export type DeviceLifecyclePeerEffectKind =
  | "preflight"
  | "issuer-abort"
  | "target-aborted"
  | "target-ready"
  | "issuer-revoked"
  | "target-cleanup-ready"
  | "issuer-terminal"
  /** 终态路由：issuer 侧绑定定位摘要，target 侧反绑恢复制品。 */
  | "terminal-route";

export interface DeviceLifecyclePeerEffect {
  readonly kind: DeviceLifecyclePeerEffectKind;
  readonly digest: string;
  readonly evidence: readonly DeviceLifecycleEvidenceRef[];
}

export interface DeviceLifecycleEvidenceRef {
  readonly kind:
    | "accepted-work"
    | "authority-transfer"
    | "authority-deletion"
    | "trust-event"
    | "credential-exposure"
     | "checkpoint"
    | "supervisor"
     | "cleanup";
  readonly digest: string;
  /** Optional durable payload root. Its digest must equal `digest`. */
  readonly artifact?: ArtifactRef;
}

export interface ExecutorRemovalDecision {
  readonly v: 1;
  readonly t: "executor-removal-decision";
  readonly operationId: string;
  readonly homeId: string;
  readonly targetDeviceId: string;
  readonly mode: "transfer" | "destroy";
  readonly currentAnchorDeviceId: string;
  readonly conversations: readonly {
    readonly conversationId: string;
    readonly displayName: string;
    readonly state: "current" | "frozen" | "importing";
  }[];
  readonly snapshotDigest?: string;
  readonly ownerItems?: readonly {
    readonly owner:
      | "conversation"
      | "intent"
      | "final"
      | "assignment"
      | "remote"
      | "channel"
      | "scheduler"
      | "delivery"
      | "lease"
      | "permit";
    readonly id: string;
    readonly revision: string;
  }[];
  readonly acceptedWork: {
    readonly active: number;
    readonly pendingFinals: number;
    readonly pendingAssignments: number;
    readonly deferredIntents: number;
    readonly outbox: number;
    readonly leases: number;
    readonly permits: number;
  };
  readonly decidedAt: string;
}

export type StopHostGeneration =
  | {
      readonly kind: "managed";
      readonly serviceId: string;
      readonly definitionDigest: string;
      readonly instanceId: string;
      readonly endpointLock?: StopEndpointLock;
    }
  | {
      readonly kind: "foreground";
      readonly processId: number;
      readonly startedAt: string;
      readonly endpointLock?: StopEndpointLock;
    };

export interface StopEndpointLock {
  readonly pid: number;
  readonly port: number;
  readonly startTime: number | null;
  readonly startedAt: string;
}

export interface StopLifecycleIdentity {
  readonly v: 1;
  readonly kind: "stop";
  readonly requestId: string;
  readonly operationId: string;
  readonly homeId: string;
  readonly localDeviceId: string;
  readonly strategy: StopStrategy;
  readonly host: StopHostGeneration;
}

export interface ExecutorRemovalLifecycleIdentity {
  readonly v: 1;
  readonly kind: "executor-removal";
  readonly requestId: string;
  readonly operationId: string;
  readonly homeId: string;
  readonly targetDeviceId: string;
  readonly targetMemberPublicKey: string;
  readonly targetDeviceKeyGeneration: string;
  readonly acceptedIssuerDeviceId: string;
  /** 接受时链上授权的 issuer key：回执与中止由它签名。迁居与灾备后它与设备钥不同。 */
  readonly acceptedIssuerKeyId: string;
  readonly acceptedTrustHeadDigest: string;
}

export type AnchorUninstallPath =
  | {
      readonly kind: "migration";
      readonly targetDeviceId: string;
      readonly transferId: string;
    }
  | {
      readonly kind: "recovery-backup";
      readonly checkpointTargetId: string;
      readonly checkpointGeneration: string;
    };

export interface AnchorUninstallLifecycleIdentity {
  readonly v: 1;
  readonly kind: "anchor-uninstall";
  readonly requestId: string;
  readonly operationId: string;
  readonly homeId: string;
  readonly currentDeviceId: string;
  readonly anchorEpoch: number;
  readonly trustHeadDigest: string;
  readonly path: AnchorUninstallPath;
}

export type DeviceLifecycleIdentity =
  | StopLifecycleIdentity
  | ExecutorRemovalLifecycleIdentity
  | AnchorUninstallLifecycleIdentity;

export type DeviceLifecyclePhase =
  | "accepted"
  | "gate-closed"
  | "work-settled"
  | "flushed"
  | "ready-to-stop"
  | "gate-frozen"
  | "authority-decided"
  | "authority-settled"
  | "revocation-ready"
  | "revoked"
  | "checkpoint-verified"
  | "transfer-committed"
  | "retirement-decided"
  | "final-checkpoint-verified"
  | "cleanup-complete"
  | "terminal"
  | "aborted";

export interface UnsignedDeviceLifecycleAbort {
  readonly v: 1;
  readonly operationId: string;
  readonly homeId: string;
  readonly subjectDeviceId: string;
  readonly authorizedByDeviceId: string;
  readonly reason: "user-cancelled" | "preflight-changed";
  readonly at: string;
}

export type DeviceLifecycleAbort = UnsignedDeviceLifecycleAbort & {
  readonly signature: Signature;
};

export interface UnsignedExecutorRemovalReceipt {
  readonly v: 1;
  readonly operationId: string;
  readonly homeId: string;
  readonly targetDeviceId: string;
  readonly targetDeviceKeyGeneration: string;
  readonly acceptedIssuerDeviceId: string;
  /** 接受时链上授权的 issuer key：回执与中止由它签名。迁居与灾备后它与设备钥不同。 */
  readonly acceptedIssuerKeyId: string;
  readonly acceptedTrustHeadDigest: string;
  readonly phase:
    | "accepted"
    | "aborted"
    | "revocation-ready"
    | "revoked"
    | "cleanup-ready"
    | "removed"
    | "lost";
  readonly evidenceDigest: string;
  readonly at: string;
  /**
   * 继任回执：接受这次移除的 issuer 已不在任，由现任 issuer key 续签。target 只在用同一份继任证明
   * 验明签名者与任期之后才接受；原 issuer 签的回执没有这一字段。
   */
  readonly successor?: ExecutorRemovalSuccessor;
}

export interface ExecutorRemovalSuccessor {
  readonly issuerDeviceId: string;
  readonly issuerKeyId: string;
  /** 现任 issuer key 的公钥：target 落盘前已按继任证明核过它是链上现任，重启后据此本地重验签名完整性。 */
  readonly issuerPublicKey: string;
  readonly anchorEpoch: number;
}

export type ExecutorRemovalReceipt = UnsignedExecutorRemovalReceipt & {
  readonly signature: Signature;
};

export type DeviceLifecycleRecord =
  | {
      readonly v: 1;
      readonly t: "accepted";
      readonly identity: DeviceLifecycleIdentity;
    }
  | {
      readonly v: 1;
      readonly t: "advanced";
      readonly operationId: string;
      readonly phase: Exclude<DeviceLifecyclePhase, "accepted" | "terminal" | "aborted">;
      readonly evidence: readonly DeviceLifecycleEvidenceRef[];
    }
  | {
      readonly v: 1;
      readonly t: "terminal";
      readonly operationId: string;
      readonly outcome: DeviceLifecycleTerminalOutcome;
      readonly evidence: readonly DeviceLifecycleEvidenceRef[];
    }
  | {
      readonly v: 1;
      readonly t: "aborted";
      readonly operationId: string;
      readonly abort: DeviceLifecycleAbort;
    }
  | {
      readonly v: 1;
      readonly t: "peer-effect";
      readonly operationId: string;
      readonly effect: DeviceLifecyclePeerEffect;
    };

export interface DeviceLifecycleOperation {
  readonly identity: DeviceLifecycleIdentity;
  readonly subjectDeviceId: string;
  readonly phase: DeviceLifecyclePhase;
  readonly evidence: readonly DeviceLifecycleEvidenceRef[];
  readonly recordDigests: Readonly<Record<string, string>>;
  readonly peerEffects: readonly DeviceLifecyclePeerEffect[];
  readonly abort?: DeviceLifecycleAbort;
  readonly terminalOutcome?: DeviceLifecycleTerminalOutcome;
}

/**
 * 终态结果。superseded 只属于 executor-removal：这次移除不再约束已证明的显式新配对（依据是一条
 * trust-event 证据），不表示已清理，也不撤销已发生的撤销与凭据暴露；它不是 removed 或 aborted 的别名。
 */
export type DeviceLifecycleTerminalOutcome = "stopped" | "removed" | "retired" | "superseded";

export interface DeviceLifecycleProjection {
  readonly operations: ReadonlyMap<string, DeviceLifecycleOperation>;
  readonly activeSubjects: ReadonlyMap<string, string>;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const STOP_PHASES = [
  "accepted",
  "gate-closed",
  "work-settled",
  "flushed",
  "ready-to-stop",
  "terminal",
] as const;
const REMOVAL_PHASES = [
  "accepted",
  "gate-frozen",
  "authority-decided",
  "authority-settled",
  "revocation-ready",
  "revoked",
  "cleanup-complete",
  "terminal",
] as const;

export function emptyDeviceLifecycleProjection(): DeviceLifecycleProjection {
  return { operations: new Map(), activeSubjects: new Map() };
}

export function deviceLifecycleSubject(identity: DeviceLifecycleIdentity): string {
  return identity.kind === "stop"
    ? `host:${identity.host.kind === "managed" ? identity.host.serviceId : identity.host.processId}`
    : identity.kind === "executor-removal"
      ? `device:${identity.targetDeviceId}`
      : `device:${identity.currentDeviceId}`;
}

export function deviceLifecycleSubjectKey(identity: DeviceLifecycleIdentity): string {
  return `${identity.homeId}\u0000${deviceLifecycleSubject(identity)}`;
}

export function deviceLifecycleSubjectKeys(identity: DeviceLifecycleIdentity): readonly string[] {
  const primary = deviceLifecycleSubjectKey(identity);
  if (identity.kind !== "stop") return [primary];
  return [primary, `${identity.homeId}\u0000device:${identity.localDeviceId}`];
}

export function createSignedDeviceLifecycleAbort(
  input: UnsignedDeviceLifecycleAbort,
  signer: ProtocolSigner,
): DeviceLifecycleAbort {
  const payload = validateUnsignedAbort(input);
  return { ...payload, signature: signer.sign("DeviceLifecycleAbort", 1, payload) };
}

export function validateDeviceLifecycleAbort(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): DeviceLifecycleAbort {
  const value = cloneObject(input, "Device lifecycle abort");
  exact(value, [
    "at",
    "authorizedByDeviceId",
    "homeId",
    "operationId",
    "reason",
    "signature",
    "subjectDeviceId",
    "v",
  ], "Device lifecycle abort");
  assertSignature(value.signature, "Device lifecycle abort signature");
  const { signature, ...unsigned } = value;
  const payload = validateUnsignedAbort(unsigned as unknown as UnsignedDeviceLifecycleAbort);
  verifier.verify("DeviceLifecycleAbort", 1, payload, signature);
  return value as unknown as DeviceLifecycleAbort;
}

export function createSignedExecutorRemovalReceipt(
  input: UnsignedExecutorRemovalReceipt,
  signer: ProtocolSigner,
): ExecutorRemovalReceipt {
  const payload = validateUnsignedRemovalReceipt(input);
  return { ...payload, signature: signer.sign("ExecutorRemovalReceipt", 1, payload) };
}

export function validateExecutorRemovalReceipt(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): ExecutorRemovalReceipt {
  const value = cloneObject(input, "Executor removal receipt");
  exact(value, [
    "acceptedIssuerDeviceId",
    "acceptedIssuerKeyId",
    "acceptedTrustHeadDigest",
    "at",
    "evidenceDigest",
    "homeId",
    "operationId",
    "phase",
    "signature",
    ...(value.successor === undefined ? [] : ["successor"]),
    "targetDeviceId",
    "targetDeviceKeyGeneration",
    "v",
  ], "Executor removal receipt");
  assertSignature(value.signature, "Executor removal receipt signature");
  const { signature, ...unsigned } = value;
  const payload = validateUnsignedRemovalReceipt(unsigned as unknown as UnsignedExecutorRemovalReceipt);
  verifier.verify("ExecutorRemovalReceipt", 1, payload, signature);
  return value as unknown as ExecutorRemovalReceipt;
}

export function encodeDeviceLifecycleRecord(input: DeviceLifecycleRecord): Uint8Array {
  return Buffer.from(canonicalize(validateDeviceLifecycleRecord(input)), "utf8");
}

export function decodeDeviceLifecycleRecord(input: Uint8Array): DeviceLifecycleRecord {
  let parsed: unknown;
  try {
    const text = Buffer.from(input).toString("utf8");
    parsed = JSON.parse(text);
    if (canonicalize(parsed) !== text) {
      throw new TypeError("Device lifecycle record bytes are not canonical JSON");
    }
  } catch (error) {
    throw new TypeError("Device lifecycle record bytes are invalid", { cause: error });
  }
  return validateDeviceLifecycleRecord(parsed);
}

export function encodeExecutorRemovalDecision(input: ExecutorRemovalDecision): Uint8Array {
  return Buffer.from(canonicalize(validateExecutorRemovalDecision(input)), "utf8");
}

export function decodeExecutorRemovalDecision(input: Uint8Array): ExecutorRemovalDecision {
  let parsed: unknown;
  try {
    const text = Buffer.from(input).toString("utf8");
    parsed = JSON.parse(text);
    if (canonicalize(parsed) !== text) {
      throw new TypeError("Executor removal decision bytes are not canonical JSON");
    }
  } catch (error) {
    throw new TypeError("Executor removal decision bytes are invalid", { cause: error });
  }
  return validateExecutorRemovalDecision(parsed);
}

export function validateExecutorRemovalDecision(input: unknown): ExecutorRemovalDecision {
  const value = cloneObject(input, "Executor removal decision");
  exact(value, [
    "acceptedWork",
    "conversations",
    "currentAnchorDeviceId",
    "decidedAt",
    "homeId",
    "mode",
    "operationId",
    ...(value.ownerItems === undefined ? [] : ["ownerItems"]),
    ...(value.snapshotDigest === undefined ? [] : ["snapshotDigest"]),
    "t",
    "targetDeviceId",
    "v",
  ], "Executor removal decision");
  if (value.v !== 1 || value.t !== "executor-removal-decision") {
    throw new TypeError("Executor removal decision schema is invalid");
  }
  for (const field of ["operationId", "homeId", "targetDeviceId", "currentAnchorDeviceId"] as const) {
    identifier(value[field], `Executor removal decision ${field}`);
  }
  if (!new Set(["transfer", "destroy"]).has(value.mode as string)) {
    throw new TypeError("Executor removal decision mode is invalid");
  }
  if (!Array.isArray(value.conversations)) {
    throw new TypeError("Executor removal decision conversations must be an array");
  }
  const seen = new Set<string>();
  const conversations = value.conversations.map((inputConversation, index) => {
    const conversation = cloneObject(inputConversation, `Executor removal conversation ${index}`);
    exact(conversation, ["conversationId", "displayName", "state"], `Executor removal conversation ${index}`);
    identifier(conversation.conversationId, `Executor removal conversation ${index} id`);
    if (seen.has(conversation.conversationId)) {
      throw new TypeError("Executor removal decision contains a duplicate conversation");
    }
    seen.add(conversation.conversationId);
    if (typeof conversation.displayName !== "string" || conversation.displayName.trim().length === 0 || conversation.displayName.length > 512) {
      throw new TypeError(`Executor removal conversation ${index} name is invalid`);
    }
    if (!new Set(["current", "frozen", "importing"]).has(conversation.state as string)) {
      throw new TypeError(`Executor removal conversation ${index} state is invalid`);
    }
    return conversation as unknown as ExecutorRemovalDecision["conversations"][number];
  });
  const acceptedWork = cloneObject(value.acceptedWork, "Executor removal accepted work");
  exact(acceptedWork, [
    "active",
    "deferredIntents",
    "leases",
    "outbox",
    "pendingAssignments",
    "pendingFinals",
    "permits",
  ], "Executor removal accepted work");
  for (const [field, count] of Object.entries(acceptedWork)) {
    nonNegativeInteger(count, `Executor removal accepted work ${field}`);
  }
  let ownerItems: readonly NonNullable<ExecutorRemovalDecision["ownerItems"]>[number][] | undefined;
  if (value.ownerItems !== undefined) {
    if (!Array.isArray(value.ownerItems) || value.ownerItems.length > 50_000) {
      throw new TypeError("Executor removal owner items must be a bounded array");
    }
    const itemIds = new Set<string>();
    ownerItems = Object.freeze(value.ownerItems.map((inputItem, index) => {
      const item = cloneObject(inputItem, `Executor removal owner item ${index}`);
      exact(item, ["id", "owner", "revision"], `Executor removal owner item ${index}`);
      if (!new Set([
        "conversation",
        "intent",
        "final",
        "assignment",
        "remote",
        "channel",
        "scheduler",
        "delivery",
        "lease",
        "permit",
      ]).has(item.owner as string)) {
        throw new TypeError(`Executor removal owner item ${index} owner is invalid`);
      }
      identifier(item.id, `Executor removal owner item ${index} id`);
      identifier(item.revision, `Executor removal owner item ${index} revision`);
      const key = `${item.owner}:${item.id}`;
      if (itemIds.has(key)) throw new TypeError("Executor removal owner items contain a duplicate");
      itemIds.add(key);
      return item as unknown as NonNullable<ExecutorRemovalDecision["ownerItems"]>[number];
    }));
  }
  if (value.snapshotDigest !== undefined) digest(value.snapshotDigest, "Executor removal snapshot digest");
  time(value.decidedAt, "Executor removal decision decidedAt");
  return Object.freeze({
    ...value,
    conversations: Object.freeze(conversations),
    acceptedWork: Object.freeze(acceptedWork),
    ...(ownerItems === undefined ? {} : { ownerItems }),
  }) as unknown as ExecutorRemovalDecision;
}

export function validateDeviceLifecycleRecord(input: unknown): DeviceLifecycleRecord {
  const value = cloneObject(input, "Device lifecycle record");
  if (value.v !== 1) throw new TypeError("Device lifecycle record version must be 1");
  if (value.t === "accepted") {
    exact(value, ["identity", "t", "v"], "Accepted lifecycle record");
    return { v: 1, t: "accepted", identity: validateIdentity(value.identity) };
  }
  if (value.t === "advanced") {
    exact(value, ["evidence", "operationId", "phase", "t", "v"], "Advanced lifecycle record");
    identifier(value.operationId, "Advanced lifecycle operationId");
    if (!isAdvancedPhase(value.phase)) throw new TypeError("Advanced lifecycle phase is invalid");
    return {
      v: 1,
      t: "advanced",
      operationId: value.operationId,
      phase: value.phase,
      evidence: validateEvidence(value.evidence),
    };
  }
  if (value.t === "terminal") {
    exact(value, ["evidence", "operationId", "outcome", "t", "v"], "Terminal lifecycle record");
    identifier(value.operationId, "Terminal lifecycle operationId");
    if (!new Set(["stopped", "removed", "retired", "superseded"]).has(value.outcome as string)) {
      throw new TypeError("Terminal lifecycle outcome is invalid");
    }
    return {
      v: 1,
      t: "terminal",
      operationId: value.operationId,
      outcome: value.outcome as DeviceLifecycleTerminalOutcome,
      evidence: validateEvidence(value.evidence),
    };
  }
  if (value.t === "aborted") {
    exact(value, ["abort", "operationId", "t", "v"], "Aborted lifecycle record");
    identifier(value.operationId, "Aborted lifecycle operationId");
    return {
      v: 1,
      t: "aborted",
      operationId: value.operationId,
      abort: cloneObject(value.abort, "Device lifecycle abort") as unknown as DeviceLifecycleAbort,
    };
  }
  if (value.t === "peer-effect") {
    exact(value, ["effect", "operationId", "t", "v"], "Peer-effect lifecycle record");
    identifier(value.operationId, "Peer-effect lifecycle operationId");
    const effect = cloneObject(value.effect, "Lifecycle peer effect");
    exact(effect, ["digest", "evidence", "kind"], "Lifecycle peer effect");
    if (!new Set([
      "preflight",
      "issuer-abort",
      "target-aborted",
      "target-ready",
      "issuer-revoked",
      "target-cleanup-ready",
      "issuer-terminal",
      "terminal-route",
    ]).has(effect.kind as string)) throw new TypeError("Lifecycle peer effect kind is invalid");
    digest(effect.digest, "Lifecycle peer effect digest");
    return {
      v: 1,
      t: "peer-effect",
      operationId: value.operationId,
      effect: {
        kind: effect.kind as DeviceLifecyclePeerEffectKind,
        digest: effect.digest,
        evidence: validateEvidence(effect.evidence),
      },
    };
  }
  throw new TypeError("Device lifecycle record type is invalid");
}

export function reduceDeviceLifecycle(
  current: DeviceLifecycleOperation | undefined,
  input: unknown,
  abortVerifier?: ProtocolSignatureVerifier,
): DeviceLifecycleOperation {
  const record = validateDeviceLifecycleRecord(input);
  const digest = protocolDigest("DeviceLifecycleRecord", 1, record);
  if (record.t === "accepted") {
    const identity = record.identity;
    const key = "accepted";
    if (current) {
      if (current.recordDigests[key] !== digest) {
        throw new TypeError("Lifecycle acceptance conflicts with replay");
      }
      return current;
    }
    return Object.freeze({
      identity,
      subjectDeviceId: subjectDeviceId(identity),
      phase: "accepted",
      evidence: [],
      recordDigests: Object.freeze({ [key]: digest }),
      peerEffects: Object.freeze([]),
    });
  }
  if (!current) throw new TypeError("Lifecycle operation must be accepted first");
  if (record.operationId !== current.identity.operationId) {
    throw new TypeError("Lifecycle record changes operation identity");
  }
  if (record.t === "peer-effect") {
    const previous = [...current.peerEffects].reverse().find((item) => item.kind === record.effect.kind);
    if (previous?.digest === record.effect.digest) return current;
    if (
      previous &&
      !(record.effect.kind === "preflight" && current.phase === "accepted")
    ) {
      throw new TypeError(`Lifecycle peer-effect:${record.effect.kind} conflicts with replay`);
    }
    return Object.freeze({
      ...current,
      evidence: Object.freeze([...current.evidence, ...record.effect.evidence]),
      peerEffects: Object.freeze([...current.peerEffects, record.effect]),
      recordDigests: Object.freeze({
        ...current.recordDigests,
        [`peer-effect:${record.effect.kind}:${record.effect.digest}`]: digest,
      }),
    });
  }
  const key = record.t === "advanced" ? `phase:${record.phase}` : record.t;
  const existing = current.recordDigests[key];
  if (existing) {
    if (existing !== digest) throw new TypeError(`Lifecycle ${key} conflicts with replay`);
    return current;
  }
  if (current.phase === "terminal" || current.phase === "aborted") {
    throw new TypeError("Terminal lifecycle operation cannot advance");
  }
  if (record.t === "aborted") {
    if (current.identity.kind === "stop") throw new TypeError("Accepted stop cannot be aborted");
    if (!abortVerifier) throw new TypeError("Authenticated lifecycle abort requires a verifier");
    const abort = validateDeviceLifecycleAbort(record.abort, abortVerifier);
    if (
      abort.operationId !== current.identity.operationId ||
      abort.homeId !== current.identity.homeId ||
      abort.subjectDeviceId !== current.subjectDeviceId ||
      abort.authorizedByDeviceId !== abortAuthority(current.identity)
    ) {
      throw new TypeError("Lifecycle abort does not bind the accepted identity");
    }
    if (isIrreversible(current)) throw new TypeError("Irreversible lifecycle operation cannot be aborted");
    return advance(current, "aborted", [], key, digest, abort);
  }
  if (record.t === "terminal") {
    assertTerminalOutcome(current.identity.kind, record.outcome);
    if (record.outcome === "superseded") assertCanBeSuperseded(current, record.evidence);
    else assertCanReachTerminal(current);
    return advance(current, "terminal", record.evidence, key, digest, undefined, record.outcome);
  }
  assertNextPhase(current, record.phase);
  return advance(current, record.phase, record.evidence, key, digest);
}

export function reduceDeviceLifecycleProjection(
  current: DeviceLifecycleProjection,
  input: unknown,
  abortVerifier?: ProtocolSignatureVerifier,
): DeviceLifecycleProjection {
  const record = validateDeviceLifecycleRecord(input);
  if (record.t === "accepted") {
    const identity = record.identity;
    const existing = current.operations.get(identity.operationId);
    if (!existing) {
      for (const subjectKey of deviceLifecycleSubjectKeys(identity)) {
        const active = current.activeSubjects.get(subjectKey);
        if (active && active !== identity.operationId) {
          throw new TypeError("Another lifecycle operation already owns this home subject");
        }
      }
    }
  }
  const operationId = record.t === "accepted" ? record.identity.operationId : record.operationId;
  const previous = current.operations.get(operationId);
  const next = reduceDeviceLifecycle(previous, record, abortVerifier);
  if (previous === next) return current;
  const operations = new Map(current.operations);
  operations.set(operationId, next);
  const activeSubjects = new Map(current.activeSubjects);
  for (const subjectKey of deviceLifecycleSubjectKeys(next.identity)) {
    if (next.phase === "terminal" || next.phase === "aborted") activeSubjects.delete(subjectKey);
    else activeSubjects.set(subjectKey, operationId);
  }
  return { operations, activeSubjects };
}

/** Codec for the authenticated current/exact lifecycle projection. Signature
 * verification of a new abort remains a reducer obligation; readers can also
 * verify its retained evidence with their own verifier. */
export function validateDeviceLifecycleOperation(input: unknown): DeviceLifecycleOperation {
  const value = cloneObject(input, "Device lifecycle operation");
  exact(value, ["identity", "subjectDeviceId", "phase", "evidence", "recordDigests", "peerEffects",
    ...(value.abort === undefined ? [] : ["abort"]),
    ...(value.terminalOutcome === undefined ? [] : ["terminalOutcome"])], "Device lifecycle operation");
  const identity = validateIdentity(value.identity);
  if (value.subjectDeviceId !== subjectDeviceId(identity)) throw new TypeError("Lifecycle operation subject is inconsistent");
  const phases = new Set<string>([...deviceLifecyclePhases(identity), ...(identity.kind === "stop" ? [] : ["aborted"])]);
  if (typeof value.phase !== "string" || !phases.has(value.phase)) throw new TypeError("Lifecycle operation phase is invalid");
  const recordDigests = cloneObject(value.recordDigests, "Lifecycle record digests");
  for (const item of Object.values(recordDigests)) digest(item, "Lifecycle record digest");
  if (recordDigests.accepted !== protocolDigest("DeviceLifecycleRecord", 1, { v: 1, t: "accepted", identity })) {
    throw new TypeError("Lifecycle operation does not bind its acceptance");
  }
  const phaseKey = value.phase === "accepted" ? "accepted" : value.phase === "terminal" || value.phase === "aborted" ? value.phase : `phase:${value.phase}`;
  if (!recordDigests[phaseKey]) throw new TypeError("Lifecycle phase has no durable record");
  if (!Array.isArray(value.peerEffects)) throw new TypeError("Lifecycle peer effects are invalid");
  const peerEffects = value.peerEffects.map(effect => {
    const record = validateDeviceLifecycleRecord({ v: 1, t: "peer-effect", operationId: identity.operationId, effect });
    if (record.t !== "peer-effect") throw new TypeError("Lifecycle peer effect is invalid");
    return record.effect;
  });
  let abort: DeviceLifecycleAbort | undefined;
  if (value.abort !== undefined) {
    const record = validateDeviceLifecycleRecord({ v: 1, t: "aborted", operationId: identity.operationId, abort: value.abort });
    if (record.t !== "aborted" || value.phase !== "aborted" || identity.kind === "stop" || record.abort.operationId !== identity.operationId || record.abort.homeId !== identity.homeId ||
        record.abort.subjectDeviceId !== value.subjectDeviceId || record.abort.authorizedByDeviceId !== abortAuthority(identity)) {
      throw new TypeError("Lifecycle abort does not bind its operation");
    }
    abort = record.abort;
  } else if (value.phase === "aborted") throw new TypeError("Lifecycle abort evidence is missing");
  if (value.phase === "terminal") {
    if (typeof value.terminalOutcome !== "string") throw new TypeError("Lifecycle terminal outcome is missing");
    assertTerminalOutcome(identity.kind, value.terminalOutcome);
  } else if (value.terminalOutcome !== undefined) throw new TypeError("Unfinished lifecycle has a terminal outcome");
  // The operation accumulates evidence from several individually bounded
  // records, including intentional repeated references. The record-level
  // 256-item/unique restriction must not be imposed on this aggregate.
  if (!Array.isArray(value.evidence)) throw new TypeError("Lifecycle accumulated evidence is invalid");
  const evidence = value.evidence.map(item => validateEvidence([item])[0]!);
  return { identity, subjectDeviceId: value.subjectDeviceId as string, phase: value.phase as DeviceLifecyclePhase,
    evidence, recordDigests: recordDigests as Record<string, string>, peerEffects,
    ...(abort ? { abort } : {}), ...(value.terminalOutcome === undefined ? {} : { terminalOutcome: value.terminalOutcome as DeviceLifecycleOperation["terminalOutcome"] }) };
}

function validateIdentity(input: unknown): DeviceLifecycleIdentity {
  const value = cloneObject(input, "Device lifecycle identity");
  if (value.v !== 1) throw new TypeError("Device lifecycle identity version must be 1");
  for (const field of ["requestId", "operationId", "homeId"] as const) identifier(value[field], `Lifecycle ${field}`);
  if (value.kind === "stop") {
    exact(value, ["homeId", "host", "kind", "localDeviceId", "operationId", "requestId", "strategy", "v"], "Stop lifecycle identity");
    identifier(value.localDeviceId, "Stop local device id");
    if (!new Set(["immediate", "drain", "cancel"]).has(value.strategy as string)) {
      throw new TypeError("Stop lifecycle strategy is invalid");
    }
    return { ...value, host: validateHost(value.host) } as unknown as StopLifecycleIdentity;
  }
  if (value.kind === "executor-removal") {
    exact(value, [
      "acceptedIssuerDeviceId",
      "acceptedIssuerKeyId",
      "acceptedTrustHeadDigest",
      "homeId",
      "kind",
      "operationId",
      "requestId",
      "targetDeviceId",
      "targetDeviceKeyGeneration",
      "targetMemberPublicKey",
      "v",
    ], "Executor removal lifecycle identity");
    for (const field of ["targetDeviceId", "targetDeviceKeyGeneration", "acceptedIssuerDeviceId", "acceptedIssuerKeyId"] as const) {
      identifier(value[field], `Executor removal ${field}`);
    }
    publicKey(value.targetMemberPublicKey, "Executor removal target member public key");
    digest(value.acceptedTrustHeadDigest, "Executor removal accepted trust head digest");
    if (value.targetDeviceId === value.acceptedIssuerDeviceId) {
      throw new TypeError("Current issuer cannot remove itself as an executor");
    }
    return value as unknown as ExecutorRemovalLifecycleIdentity;
  }
  if (value.kind === "anchor-uninstall") {
    exact(value, [
      "anchorEpoch",
      "currentDeviceId",
      "homeId",
      "kind",
      "operationId",
      "path",
      "requestId",
      "trustHeadDigest",
      "v",
    ], "Anchor uninstall lifecycle identity");
    identifier(value.currentDeviceId, "Anchor uninstall currentDeviceId");
    positiveInteger(value.anchorEpoch, "Anchor uninstall anchorEpoch");
    digest(value.trustHeadDigest, "Anchor uninstall trust head digest");
    return { ...value, path: validateUninstallPath(value.path) } as unknown as AnchorUninstallLifecycleIdentity;
  }
  throw new TypeError("Device lifecycle identity kind is invalid");
}

function validateHost(input: unknown): StopHostGeneration {
  const value = cloneObject(input, "Stop host generation");
  if (value.kind === "managed") {
    exact(value, value.endpointLock === undefined
      ? ["definitionDigest", "instanceId", "kind", "serviceId"]
      : ["definitionDigest", "endpointLock", "instanceId", "kind", "serviceId"], "Managed stop host generation");
    identifier(value.serviceId, "Stop serviceId");
    identifier(value.instanceId, "Stop instanceId");
    digest(value.definitionDigest, "Stop definition digest");
    return {
      ...value,
      ...(value.endpointLock === undefined ? {} : { endpointLock: validateStopEndpointLock(value.endpointLock) }),
    } as unknown as StopHostGeneration;
  }
  if (value.kind === "foreground") {
    exact(value, value.endpointLock === undefined
      ? ["kind", "processId", "startedAt"]
      : ["endpointLock", "kind", "processId", "startedAt"], "Foreground stop host generation");
    positiveInteger(value.processId, "Stop processId");
    time(value.startedAt, "Stop startedAt");
    return {
      ...value,
      ...(value.endpointLock === undefined ? {} : { endpointLock: validateStopEndpointLock(value.endpointLock) }),
    } as unknown as StopHostGeneration;
  }
  throw new TypeError("Stop host generation kind is invalid");
}

function validateStopEndpointLock(input: unknown): StopEndpointLock {
  const value = cloneObject(input, "Stop endpoint lock");
  exact(value, ["pid", "port", "startedAt", "startTime"], "Stop endpoint lock");
  positiveInteger(value.pid, "Stop endpoint lock pid");
  positiveInteger(value.port, "Stop endpoint lock port");
  if (value.port > 65_535) throw new TypeError("Stop endpoint lock port is invalid");
  if (value.startTime !== null) nonNegativeInteger(value.startTime, "Stop endpoint lock startTime");
  time(value.startedAt, "Stop endpoint lock startedAt");
  return value as unknown as StopEndpointLock;
}

function validateUninstallPath(input: unknown): AnchorUninstallPath {
  const value = cloneObject(input, "Anchor uninstall path");
  if (value.kind === "migration") {
    exact(value, ["kind", "targetDeviceId", "transferId"], "Anchor migration path");
    identifier(value.targetDeviceId, "Anchor migration targetDeviceId");
    identifier(value.transferId, "Anchor migration transferId");
    return value as unknown as AnchorUninstallPath;
  }
  if (value.kind === "recovery-backup") {
    exact(value, ["checkpointGeneration", "checkpointTargetId", "kind"], "Anchor recovery backup path");
    identifier(value.checkpointTargetId, "Anchor checkpointTargetId");
    identifier(value.checkpointGeneration, "Anchor checkpointGeneration");
    return value as unknown as AnchorUninstallPath;
  }
  throw new TypeError("Anchor uninstall path is invalid");
}

function validateUnsignedAbort(input: UnsignedDeviceLifecycleAbort): UnsignedDeviceLifecycleAbort {
  const value = cloneObject(input, "Unsigned device lifecycle abort");
  exact(value, [
    "at",
    "authorizedByDeviceId",
    "homeId",
    "operationId",
    "reason",
    "subjectDeviceId",
    "v",
  ], "Unsigned device lifecycle abort");
  if (value.v !== 1) throw new TypeError("Device lifecycle abort version must be 1");
  for (const field of ["authorizedByDeviceId", "homeId", "operationId", "subjectDeviceId"] as const) {
    identifier(value[field], `Device lifecycle abort ${field}`);
  }
  if (!new Set(["user-cancelled", "preflight-changed"]).has(value.reason as string)) {
    throw new TypeError("Device lifecycle abort reason is invalid");
  }
  time(value.at, "Device lifecycle abort at");
  return value as unknown as UnsignedDeviceLifecycleAbort;
}

function validateUnsignedRemovalReceipt(input: UnsignedExecutorRemovalReceipt): UnsignedExecutorRemovalReceipt {
  const value = cloneObject(input, "Unsigned executor removal receipt");
  exact(value, [
    "acceptedIssuerDeviceId",
    "acceptedIssuerKeyId",
    "acceptedTrustHeadDigest",
    "at",
    "evidenceDigest",
    "homeId",
    "operationId",
    "phase",
    ...(value.successor === undefined ? [] : ["successor"]),
    "targetDeviceId",
    "targetDeviceKeyGeneration",
    "v",
  ], "Unsigned executor removal receipt");
  if (value.successor !== undefined) {
    const successor = cloneObject(value.successor, "Executor removal receipt successor");
    exact(successor, ["anchorEpoch", "issuerDeviceId", "issuerKeyId", "issuerPublicKey"], "Executor removal receipt successor");
    identifier(successor.issuerDeviceId, "Executor removal receipt successor issuerDeviceId");
    identifier(successor.issuerKeyId, "Executor removal receipt successor issuerKeyId");
    if (typeof successor.issuerPublicKey !== "string" || !successor.issuerPublicKey.startsWith("ed25519:")) {
      throw new TypeError("Executor removal receipt successor issuerPublicKey is invalid");
    }
    if (!Number.isSafeInteger(successor.anchorEpoch) || (successor.anchorEpoch as number) < 1) {
      throw new TypeError("Executor removal receipt successor anchorEpoch is invalid");
    }
    if (successor.issuerKeyId === value.acceptedIssuerKeyId) {
      throw new TypeError("A successor receipt must be signed by a different issuer key than the accepting one");
    }
  }
  if (value.v !== 1) throw new TypeError("Executor removal receipt version must be 1");
  for (const field of [
    "acceptedIssuerDeviceId",
    "acceptedIssuerKeyId",
    "homeId",
    "operationId",
    "targetDeviceId",
    "targetDeviceKeyGeneration",
  ] as const) identifier(value[field], `Executor removal receipt ${field}`);
  digest(value.acceptedTrustHeadDigest, "Executor removal receipt accepted trust head digest");
  digest(value.evidenceDigest, "Executor removal receipt evidence digest");
  if (!new Set([
    "accepted",
    "aborted",
    "revocation-ready",
    "revoked",
    "cleanup-ready",
    "removed",
    "lost",
  ]).has(value.phase as string)) {
    throw new TypeError("Executor removal receipt phase is invalid");
  }
  time(value.at, "Executor removal receipt at");
  return value as unknown as UnsignedExecutorRemovalReceipt;
}

function validateEvidence(input: unknown): readonly DeviceLifecycleEvidenceRef[] {
  if (!Array.isArray(input) || input.length > 256) {
    throw new TypeError("Lifecycle evidence must be a bounded array");
  }
  const seen = new Set<string>();
  const result = input.map((item, index) => {
    const value = cloneObject(item, `Lifecycle evidence ${index}`);
    if (value.artifact === undefined) {
      exact(value, ["digest", "kind"], `Lifecycle evidence ${index}`);
    } else {
      exact(value, ["artifact", "digest", "kind"], `Lifecycle evidence ${index}`);
    }
    if (!new Set([
      "accepted-work",
      "authority-transfer",
      "authority-deletion",
      "trust-event",
      "credential-exposure",
      "checkpoint",
      "supervisor",
      "cleanup",
    ]).has(value.kind as string)) throw new TypeError(`Lifecycle evidence ${index} kind is invalid`);
    digest(value.digest, `Lifecycle evidence ${index} digest`);
    if (value.artifact !== undefined) {
      const artifact = cloneObject(value.artifact, `Lifecycle evidence ${index} artifact`);
      exact(artifact, ["bytes", "digest"], `Lifecycle evidence ${index} artifact`);
      digest(artifact.digest, `Lifecycle evidence ${index} artifact digest`);
      nonNegativeInteger(artifact.bytes, `Lifecycle evidence ${index} artifact bytes`);
      if (artifact.digest !== value.digest) {
        throw new TypeError(`Lifecycle evidence ${index} artifact digest does not match evidence`);
      }
    }
    const key = `${value.kind}:${value.digest}`;
    if (seen.has(key)) throw new TypeError("Lifecycle evidence contains a duplicate");
    seen.add(key);
    return value as unknown as DeviceLifecycleEvidenceRef;
  });
  return Object.freeze(result);
}

function nonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertNextPhase(current: DeviceLifecycleOperation, next: DeviceLifecyclePhase): void {
  assertSequential(deviceLifecyclePhases(current.identity), current.phase, next,
    current.identity.kind === "executor-removal" ? "executor removal" : current.identity.kind === "anchor-uninstall" ? "anchor uninstall" : "stop");
}

function deviceLifecyclePhases(identity: DeviceLifecycleIdentity): readonly DeviceLifecyclePhase[] {
  if (identity.kind === "stop") return STOP_PHASES;
  if (identity.kind === "executor-removal") return REMOVAL_PHASES;
  return identity.path.kind === "migration"
    ? ["accepted", "gate-frozen", "transfer-committed", "cleanup-complete", "terminal"] as const
    : [
        "accepted",
        "gate-frozen",
        "checkpoint-verified",
        "retirement-decided",
        "gate-closed",
        "work-settled",
        "flushed",
        "final-checkpoint-verified",
        "cleanup-complete",
        "terminal",
      ] as const;
}

function assertSequential(
  phases: readonly DeviceLifecyclePhase[],
  current: DeviceLifecyclePhase,
  next: DeviceLifecyclePhase,
  label: string,
): void {
  const index = phases.indexOf(current);
  if (index < 0 || phases[index + 1] !== next) {
    throw new TypeError(`${label} lifecycle cannot advance from ${current} to ${next}`);
  }
}

function assertTerminalOutcome(kind: DeviceLifecycleKind, outcome: string): void {
  if (kind === "executor-removal" && outcome === "superseded") return;
  const expected = kind === "stop" ? "stopped" : kind === "executor-removal" ? "removed" : "retired";
  if (outcome !== expected) throw new TypeError("Lifecycle terminal outcome does not match operation kind");
}

/**
 * 取代适用于任何还没终结的移除（含本机已 cleanup-complete、尚未删钥写 removed 的 lost），且必须带取代它的
 * 配对事件证据；已 removed/aborted 的终态不可改写（终态不再推进），removed 的阶段守卫不放宽。
 */
function assertCanBeSuperseded(current: DeviceLifecycleOperation, evidence: readonly DeviceLifecycleEvidenceRef[]): void {
  if (current.identity.kind !== "executor-removal") {
    throw new TypeError("Lifecycle operation cannot be superseded");
  }
  if (!evidence.some((item) => item.kind === "trust-event")) {
    throw new TypeError("Superseded lifecycle terminal requires the superseding trust event");
  }
}

function assertCanReachTerminal(current: DeviceLifecycleOperation): void {
  const expected = current.identity.kind === "stop"
    ? "ready-to-stop"
    : current.identity.kind === "executor-removal"
      ? "cleanup-complete"
      : "cleanup-complete";
  if (current.phase !== expected) throw new TypeError("Lifecycle terminal is missing required durable phases");
}

function isIrreversible(current: DeviceLifecycleOperation): boolean {
  if (current.identity.kind === "executor-removal") {
    return REMOVAL_PHASES.indexOf(current.phase as typeof REMOVAL_PHASES[number]) >=
      REMOVAL_PHASES.indexOf("authority-settled");
  }
  if (current.identity.kind === "anchor-uninstall") {
    return current.phase === "transfer-committed" ||
      current.phase === "retirement-decided" ||
      current.phase === "gate-closed" ||
      current.phase === "work-settled" ||
      current.phase === "flushed" ||
      current.phase === "final-checkpoint-verified" ||
      current.phase === "cleanup-complete";
  }
  return true;
}

function advance(
  current: DeviceLifecycleOperation,
  phase: DeviceLifecyclePhase,
  evidence: readonly DeviceLifecycleEvidenceRef[],
  key: string,
  digestValue: string,
  abort?: DeviceLifecycleAbort,
  terminalOutcome?: DeviceLifecycleOperation["terminalOutcome"],
): DeviceLifecycleOperation {
  return Object.freeze({
    ...current,
    phase,
    evidence: Object.freeze([...current.evidence, ...evidence]),
    recordDigests: Object.freeze({ ...current.recordDigests, [key]: digestValue }),
    ...(abort ? { abort } : {}),
    ...(terminalOutcome ? { terminalOutcome } : {}),
  });
}

function subjectDeviceId(identity: DeviceLifecycleIdentity): string {
  if (identity.kind === "executor-removal") return identity.targetDeviceId;
  if (identity.kind === "anchor-uninstall") return identity.currentDeviceId;
  return deviceLifecycleSubject(identity);
}

function abortAuthority(identity: Exclude<DeviceLifecycleIdentity, StopLifecycleIdentity>): string {
  // 设备移除的中止由接受时的 issuer key 签（不是 issuer 设备钥）
  return identity.kind === "executor-removal"
    ? identity.acceptedIssuerKeyId
    : identity.currentDeviceId;
}

function isAdvancedPhase(value: unknown): value is Exclude<DeviceLifecyclePhase, "accepted" | "terminal" | "aborted"> {
  return new Set([
    "gate-closed",
    "work-settled",
    "flushed",
    "ready-to-stop",
    "gate-frozen",
    "authority-decided",
    "authority-settled",
    "revocation-ready",
    "revoked",
    "checkpoint-verified",
    "transfer-committed",
    "retirement-decided",
    "final-checkpoint-verified",
    "cleanup-complete",
  ]).has(value as string);
}

function cloneObject(input: unknown, label: string): Record<string, unknown> {
  try {
    const cloned = JSON.parse(canonicalize(input)) as unknown;
    if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
      throw new TypeError(`${label} must be a plain object`);
    }
    return cloned as Record<string, unknown>;
  } catch (error) {
    throw new TypeError(`${label} must be canonical JSON data`, { cause: error });
  }
}

function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (canonicalize(Object.keys(value).sort()) !== canonicalize([...keys].sort())) {
    throw new TypeError(`${label} fields are incomplete or unknown`);
  }
}

function identifier(value: unknown, label: string): asserts value is string {
  assertProtocolIdentifier(value, label);
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
}

function publicKey(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.startsWith("ed25519:") || value.length > 512) {
    throw new TypeError(`${label} must be an Ed25519 public key`);
  }
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function time(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ISO_TIME_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
}

function assertSignature(value: unknown, label: string): asserts value is Signature {
  const signature = cloneObject(value, label);
  exact(signature, ["alg", "keyId", "sig"], label);
  identifier(signature.alg, `${label} alg`);
  identifier(signature.keyId, `${label} keyId`);
  identifier(signature.sig, `${label} sig`);
}
