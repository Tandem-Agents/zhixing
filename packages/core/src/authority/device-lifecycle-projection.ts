import type { CommitEnvelope, JsonValue } from "../contracts/index.js";
import {
  DEVICE_LIFECYCLE_STREAM, deviceLifecycleSubjectKeys, protocolDigest,
  reduceDeviceLifecycleProjection, validateDeviceLifecycleOperation, validateDeviceLifecycleRecord,
  type DeviceLifecycleOperation, type DeviceLifecycleProjection, type DeviceLifecycleRecord,
} from "../protocol/index.js";
import type { ProtocolSignatureVerifier } from "../protocol/signature.js";
import {
  DurableProjectionRecordBindingError,
  type DurableProjectionMutation, type DurableProjectionReadContext,
} from "./durable-projection-index.js";

export const LIFECYCLE_PROJECTION_ID = "device-lifecycle-state-v1";
export const LIFECYCLE_ACTIVE_PREFIX = "active/";
export const LIFECYCLE_OPERATION_PREFIX = "operation/";
interface StoredOperation { readonly acceptedLsn: number; readonly acceptedEntry: number; readonly operation: DeviceLifecycleOperation }
interface Pointer { readonly operationId: string; readonly acceptedLsn: number; readonly acceptedEntry: number }
export function compareLifecycleAcceptance(a: Pick<Pointer, "acceptedLsn" | "acceptedEntry">, b: Pick<Pointer, "acceptedLsn" | "acceptedEntry">): number {
  return a.acceptedLsn - b.acceptedLsn || a.acceptedEntry - b.acceptedEntry;
}
function identityKey(prefix: string, identity: string): string { return `${prefix}${protocolDigest("LifecycleIndexIdentity", 1, { identity })}`; }
export function lifecycleOperationKey(id: string): string { return identityKey(LIFECYCLE_OPERATION_PREFIX, id); }
function subjectKey(subject: string): string { return identityKey("subject/", subject); }
export function lifecycleActivePrefix(deviceId?: string, kind?: DeviceLifecycleOperation["identity"]["kind"]): string {
  return deviceId !== undefined ? identityKey("active-device/", deviceId) + "/" : kind !== undefined ? `active-kind/${kind}/` : LIFECYCLE_ACTIVE_PREFIX;
}
export function lifecycleTargetDeviceId(operation: DeviceLifecycleOperation): string {
  return operation.identity.kind === "stop" ? operation.identity.localDeviceId : operation.subjectDeviceId;
}
function activeKey(value: Pointer, prefix = LIFECYCLE_ACTIVE_PREFIX): string { return `${prefix}${value.acceptedLsn.toString().padStart(16, "0")}/${value.acceptedEntry.toString().padStart(16, "0")}/${protocolDigest("LifecycleIndexIdentity", 1, { identity: value.operationId })}`; }
export function lifecycleLatestKey(kind: DeviceLifecycleOperation["identity"]["kind"], deviceId: string): string { return identityKey(`latest/${kind}/`, deviceId); }
export function lifecycleRetirementKey(deviceId?: string): string { return deviceId === undefined ? "retirement/latest" : identityKey("retirement/device/", deviceId); }

function invalid(error?: unknown): DurableProjectionRecordBindingError {
  return new DurableProjectionRecordBindingError(`Lifecycle projection identity is invalid${error instanceof Error ? `: ${error.message}` : ""}`);
}
function object(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value;
}
function pointer(value: JsonValue): Pointer {
  const row = object(value);
  if (Object.keys(row).length !== 3 || typeof row.operationId !== "string" ||
      typeof row.acceptedLsn !== "number" || !Number.isSafeInteger(row.acceptedLsn) || row.acceptedLsn < 1 ||
      typeof row.acceptedEntry !== "number" || !Number.isSafeInteger(row.acceptedEntry) || row.acceptedEntry < 0) throw invalid();
  return row as unknown as Pointer;
}
export function readLifecycleStored(value: JsonValue | undefined, id: string): StoredOperation | undefined {
  if (value === undefined) return;
  try {
    const row = object(value);
    if (Object.keys(row).length !== 3 || typeof row.acceptedLsn !== "number" || !Number.isSafeInteger(row.acceptedLsn) || row.acceptedLsn < 1 ||
        typeof row.acceptedEntry !== "number" || !Number.isSafeInteger(row.acceptedEntry) || row.acceptedEntry < 0) throw invalid();
    const operation = validateDeviceLifecycleOperation(row.operation);
    if (operation.identity.operationId !== id) throw invalid();
    return { operation, acceptedLsn: row.acceptedLsn, acceptedEntry: row.acceptedEntry };
  } catch (error) { throw invalid(error); }
}
export function lifecycleIndexedOperation(value: JsonValue): StoredOperation {
  const row = object(value), operation = object(row.operation!);
  const identity = object(operation.identity!);
  if (typeof identity.operationId !== "string") throw invalid();
  return readLifecycleStored(value, identity.operationId)!;
}

/** A decision needs one operation and its at most two subject ownership keys. */
export async function lifecycleDecisionState(current: DurableProjectionReadContext, record: DeviceLifecycleRecord): Promise<DeviceLifecycleProjection> {
  const id = record.t === "accepted" ? record.identity.operationId : record.operationId;
  const prior = readLifecycleStored(await current.get(lifecycleOperationKey(id)), id);
  const identity = record.t === "accepted" ? record.identity : prior?.operation.identity;
  const activeSubjects = new Map<string, string>();
  for (const subject of identity ? deviceLifecycleSubjectKeys(identity) : []) {
    const value = await current.get(subjectKey(subject));
    if (value === undefined) continue;
    const row = object(value);
    if (Object.keys(row).length !== 2 || row.subject !== subject || typeof row.operationId !== "string") throw invalid();
    const owner = row.operationId === id ? prior : readLifecycleStored(await current.get(lifecycleOperationKey(row.operationId)), row.operationId);
    if (!owner || owner.operation.phase === "terminal" || owner.operation.phase === "aborted" ||
        !deviceLifecycleSubjectKeys(owner.operation.identity).includes(subject)) throw invalid();
    activeSubjects.set(subject, row.operationId);
  }
  return { operations: new Map(prior ? [[id, prior.operation]] : []), activeSubjects };
}

export async function resolveLifecyclePointer(current: DurableProjectionReadContext, value: JsonValue | undefined): Promise<StoredOperation | undefined> {
  if (value === undefined) return;
  const ref = pointer(value);
  const stored = readLifecycleStored(await current.get(lifecycleOperationKey(ref.operationId)), ref.operationId);
  if (!stored || compareLifecycleAcceptance(stored, ref) !== 0) throw invalid();
  return stored;
}

export async function reduceLifecycleIndex(envelope: CommitEnvelope<JsonValue>, current: DurableProjectionReadContext,
  verifier: ProtocolSignatureVerifier | undefined): Promise<readonly DurableProjectionMutation[]> {
  const changes: DurableProjectionMutation[] = [];
  const overlay = new Map<string, JsonValue | undefined>();
  const read: DurableProjectionReadContext = { get: async key => overlay.has(key) ? overlay.get(key) : current.get(key), scan: (...args) => current.scan(...args) };
  const put = (key: string, value: JsonValue): void => { overlay.set(key, value); changes.push({ kind: "put", key, value }); };
  const remove = (key: string): void => { overlay.set(key, undefined); changes.push({ kind: "tombstone", key }); };
  for (const [entryIndex, entry] of envelope.entries.entries()) {
    if (entry.stream !== DEVICE_LIFECYCLE_STREAM) continue;
    const record = validateDeviceLifecycleRecord(entry.body);
    const id = record.t === "accepted" ? record.identity.operationId : record.operationId;
    const before = await lifecycleDecisionState(read, record);
    const next = reduceDeviceLifecycleProjection(before, record, verifier);
    if (next === before) continue;
    const operation = next.operations.get(id)!;
    const prior = readLifecycleStored(await read.get(lifecycleOperationKey(id)), id);
    const acceptedLsn = prior?.acceptedLsn ?? envelope.lsn;
    const acceptedEntry = prior?.acceptedEntry ?? entryIndex;
    const ref = { operationId: id, acceptedLsn, acceptedEntry };
    put(lifecycleOperationKey(id), { acceptedLsn, acceptedEntry, operation: operation as unknown as JsonValue });
    const terminal = operation.phase === "terminal" || operation.phase === "aborted";
    for (const subject of deviceLifecycleSubjectKeys(operation.identity)) {
      if (terminal) remove(subjectKey(subject));
      else put(subjectKey(subject), { subject, operationId: id });
    }
    const deviceId = lifecycleTargetDeviceId(operation);
    for (const prefix of [LIFECYCLE_ACTIVE_PREFIX, lifecycleActivePrefix(deviceId), lifecycleActivePrefix(undefined, operation.identity.kind)]) {
      if (terminal) remove(activeKey(ref, prefix)); else put(activeKey(ref, prefix), ref);
    }
    const latestKey = lifecycleLatestKey(operation.identity.kind, deviceId);
    const last = await resolveLifecyclePointer(read, await read.get(latestKey));
    if (last && (last.operation.identity.kind !== operation.identity.kind || lifecycleTargetDeviceId(last.operation) !== deviceId)) throw invalid();
    if (!last || compareLifecycleAcceptance(last, ref) <= 0) put(latestKey, ref);
    if (operation.phase === "terminal" && operation.identity.kind !== "stop") {
      for (const key of [lifecycleRetirementKey(), lifecycleRetirementKey(operation.subjectDeviceId)]) {
        const previous = await resolveLifecyclePointer(read, await read.get(key));
        if (previous && (previous.operation.phase !== "terminal" || previous.operation.identity.kind === "stop" ||
            (key !== lifecycleRetirementKey() && previous.operation.subjectDeviceId !== operation.subjectDeviceId))) throw invalid();
        if (!previous || compareLifecycleAcceptance(previous, ref) <= 0) put(key, ref);
      }
    }
  }
  return changes;
}

export function validateLifecycleActivePointer(key: string, value: JsonValue, prefix = LIFECYCLE_ACTIVE_PREFIX): void {
  if (key !== activeKey(pointer(value), prefix)) throw invalid();
}
