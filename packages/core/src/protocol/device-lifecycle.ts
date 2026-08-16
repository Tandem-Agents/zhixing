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
  | "issuer-terminal";

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
      readonly outcome: "stopped" | "removed" | "retired";
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
  readonly terminalOutcome?: "stopped" | "removed" | "retired";
}

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

function deviceLifecycleSubjectKeys(identity: DeviceLifecycleIdentity): readonly string[] {
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
    "acceptedTrustHeadDigest",
    "at",
    "evidenceDigest",
    "homeId",
    "operationId",
    "phase",
    "signature",
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
    if (!new Set(["stopped", "removed", "retired"]).has(value.outcome as string)) {
      throw new TypeError("Terminal lifecycle outcome is invalid");
    }
    return {
      v: 1,
      t: "terminal",
      operationId: value.operationId,
      outcome: value.outcome as "stopped" | "removed" | "retired",
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
    assertCanReachTerminal(current);
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
    for (const field of ["targetDeviceId", "targetDeviceKeyGeneration", "acceptedIssuerDeviceId"] as const) {
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
    "acceptedTrustHeadDigest",
    "at",
    "evidenceDigest",
    "homeId",
    "operationId",
    "phase",
    "targetDeviceId",
    "targetDeviceKeyGeneration",
    "v",
  ], "Unsigned executor removal receipt");
  if (value.v !== 1) throw new TypeError("Executor removal receipt version must be 1");
  for (const field of [
    "acceptedIssuerDeviceId",
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
  if (current.identity.kind === "stop") {
    assertSequential(STOP_PHASES, current.phase, next, "stop");
    return;
  }
  if (current.identity.kind === "executor-removal") {
    assertSequential(REMOVAL_PHASES, current.phase, next, "executor removal");
    return;
  }
  const path = current.identity.path.kind;
  const phases = path === "migration"
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
  assertSequential(phases, current.phase, next, "anchor uninstall");
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
  const expected = kind === "stop" ? "stopped" : kind === "executor-removal" ? "removed" : "retired";
  if (outcome !== expected) throw new TypeError("Lifecycle terminal outcome does not match operation kind");
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
  return identity.kind === "executor-removal"
    ? identity.acceptedIssuerDeviceId
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
