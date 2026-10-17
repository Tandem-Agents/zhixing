import {
  DEVICE_LIFECYCLE_STREAM, reduceDeviceLifecycleProjection, validateDeviceLifecycleAbort,
  validateDeviceLifecycleRecord,
  type DeviceLifecycleAbort, type DeviceLifecycleEvidenceRef, type DeviceLifecycleIdentity,
  type DeviceLifecycleOperation, type DeviceLifecyclePeerEffect, type DeviceLifecyclePhase,
  type DeviceLifecycleRecord,
} from "../protocol/index.js";
import type { ProtocolSignatureVerifier } from "../protocol/signature.js";
import type { AuthorityCommitLog } from "./interfaces.js";
import {
  DurableProjectionRecordBindingError,
  type DurableProjectionReadContext, type RebuildableDurableProjectionIndex,
} from "./durable-projection-index.js";
import {
  LIFECYCLE_PROJECTION_ID, LIFECYCLE_OPERATION_PREFIX, lifecycleActivePrefix,
  lifecycleDecisionState, lifecycleIndexedOperation, lifecycleLatestKey,
  lifecycleOperationKey, lifecycleRetirementKey, readLifecycleStored,
  reduceLifecycleIndex, resolveLifecyclePointer, validateLifecycleActivePointer,
  compareLifecycleAcceptance,
  lifecycleTargetDeviceId,
} from "./device-lifecycle-projection.js";

type AdvancedPhase = Exclude<DeviceLifecyclePhase, "accepted" | "terminal" | "aborted">;
interface SharedLifecycleIndex {
  readonly index: RebuildableDurableProjectionIndex;
  readonly verifier: ProtocolSignatureVerifier;
}
const shared = new WeakMap<AuthorityCommitLog, SharedLifecycleIndex>();

/** The home composition registers one immutable live verification port before
 * any journal opens. Stop-only readers use that same domain definition. */
export function registerDeviceLifecycleProjection(log: AuthorityCommitLog, verifier: ProtocolSignatureVerifier): RebuildableDurableProjectionIndex {
  const existing = shared.get(log);
  if (existing) {
    if (existing.verifier !== verifier) throw new TypeError("Device lifecycle verifier is already bound by its owner");
    return existing.index;
  }
  const index = log.durableProjection({
    projectionId: LIFECYCLE_PROJECTION_ID, reducerVersion: 1, authenticated: true,
    inputs: { streams: [DEVICE_LIFECYCLE_STREAM] },
    reduce: (envelope, current) => reduceLifecycleIndex(envelope, current, verifier),
  });
  shared.set(log, { index, verifier });
  return index;
}

/** Current subject ownership and exact operation history share the original
 * reducer and WAL transaction. Completed operations never enter startup memory. */
export class DeviceLifecycleJournal {
  readonly #projection: SharedLifecycleIndex;
  constructor(private readonly log: AuthorityCommitLog, verifier?: ProtocolSignatureVerifier) {
    if (verifier) registerDeviceLifecycleProjection(log, verifier);
    const existing = shared.get(log);
    if (!existing) throw new TypeError("Device lifecycle projection must be registered by its owner before opening a journal");
    this.#projection = existing;
  }

  #read<T>(read: (current: DurableProjectionReadContext) => Promise<T>): Promise<T> {
    return this.log.transactDurableProjection<never, T>(LIFECYCLE_PROJECTION_ID, async current =>
      ({ kind: "return", value: await read(current) })).then(result => result.value);
  }

  #checked(operation: DeviceLifecycleOperation): DeviceLifecycleOperation {
    if (operation.abort) {
      validateDeviceLifecycleAbort(operation.abort, this.#projection.verifier);
    }
    return structuredClone(operation);
  }

  state(operationId: string): Promise<DeviceLifecycleOperation | undefined> {
    return this.#read(async current => {
      const stored = readLifecycleStored(await current.get(lifecycleOperationKey(operationId)), operationId);
      return stored && this.#checked(stored.operation);
    });
  }

  async #active(current: DurableProjectionReadContext, deviceId?: string,
    kind?: DeviceLifecycleOperation["identity"]["kind"], firstOnly = false): Promise<DeviceLifecycleOperation[]> {
    const prefix = lifecycleActivePrefix(deviceId, kind);
    const result: DeviceLifecycleOperation[] = [];
    let continuation: string | undefined;
    do {
      const page = await current.scan({ gte: prefix, lt: prefix + "\uffff" }, firstOnly ? 1 : 64, continuation);
      for (const entry of page.entries) {
        validateLifecycleActivePointer(entry.key, entry.value, prefix);
        const stored = await resolveLifecyclePointer(current, entry.value);
        if (!stored || stored.operation.phase === "terminal" || stored.operation.phase === "aborted" ||
            (deviceId !== undefined && lifecycleTargetDeviceId(stored.operation) !== deviceId) ||
            (kind !== undefined && stored.operation.identity.kind !== kind)) {
          throw new DurableProjectionRecordBindingError("Lifecycle active directory does not bind an active subject");
        }
        result.push(this.#checked(stored.operation));
      }
      if (firstOnly) break;
      continuation = page.continuation;
    } while (continuation);
    return result;
  }

  active(): Promise<readonly DeviceLifecycleOperation[]> {
    return this.#read(current => this.#active(current));
  }

  activeFor(deviceId: string): Promise<readonly DeviceLifecycleOperation[]> {
    return this.#read(current => this.#active(current, deviceId));
  }

  latest(kind: DeviceLifecycleOperation["identity"]["kind"], deviceId: string): Promise<DeviceLifecycleOperation | undefined> {
    return this.#read(async current => {
      const stored = await resolveLifecyclePointer(current, await current.get(lifecycleLatestKey(kind, deviceId)));
      if (stored && (stored.operation.identity.kind !== kind || lifecycleTargetDeviceId(stored.operation) !== deviceId)) {
        throw new DurableProjectionRecordBindingError("Lifecycle latest directory changes subject");
      }
      return stored && this.#checked(stored.operation);
    });
  }

  /** Bootstrap needs only a local safety gate and the last terminal retirement.
   * With no local identity, one non-stop active operation proves recovery is needed. */
  startupState(deviceId?: string): Promise<{ readonly active: boolean; readonly retirement?: DeviceLifecycleOperation }> {
    return this.#read(async current => {
      const stored = await resolveLifecyclePointer(current, await current.get(lifecycleRetirementKey(deviceId)));
      if (stored && (stored.operation.phase !== "terminal" || stored.operation.identity.kind === "stop" ||
          (deviceId !== undefined && stored.operation.subjectDeviceId !== deviceId))) {
        throw new DurableProjectionRecordBindingError("Lifecycle retirement directory changes subject");
      }
      const active = deviceId === undefined
        ? (await this.#active(current, undefined, "executor-removal", true)).length > 0 ||
          (await this.#active(current, undefined, "anchor-uninstall", true)).length > 0
        : (await this.#active(current, deviceId, undefined, true)).length > 0 ||
          (await this.#active(current, undefined, "stop", true)).length > 0;
      return { active, ...(stored ? { retirement: this.#checked(stored.operation) } : {}) };
    });
  }

  /** Explicit history query only; normal startup uses startupState/activeFor. */
  operations(): Promise<readonly DeviceLifecycleOperation[]> {
    return this.#read(async current => {
      const values: ReturnType<typeof lifecycleIndexedOperation>[] = [];
      let continuation: string | undefined;
      do {
        const page = await current.scan({ gte: LIFECYCLE_OPERATION_PREFIX, lt: LIFECYCLE_OPERATION_PREFIX + "\uffff" }, 64, continuation);
        for (const entry of page.entries) {
          const stored = lifecycleIndexedOperation(entry.value);
          if (entry.key !== lifecycleOperationKey(stored.operation.identity.operationId)) {
            throw new DurableProjectionRecordBindingError("Lifecycle operation directory changes identity");
          }
          values.push(stored);
        }
        continuation = page.continuation;
      } while (continuation);
      return values.sort(compareLifecycleAcceptance).map(value => this.#checked(value.operation));
    });
  }

  accept(identity: DeviceLifecycleIdentity): Promise<DeviceLifecycleOperation> {
    return this.#append(validateDeviceLifecycleRecord({ v: 1, t: "accepted", identity }));
  }
  advance(operationId: string, phase: AdvancedPhase, evidence: readonly DeviceLifecycleEvidenceRef[] = []): Promise<DeviceLifecycleOperation> {
    return this.#append(validateDeviceLifecycleRecord({ v: 1, t: "advanced", operationId, phase, evidence }));
  }
  abort(operationId: string, abort: DeviceLifecycleAbort): Promise<DeviceLifecycleOperation> {
    return this.#append(validateDeviceLifecycleRecord({ v: 1, t: "aborted", operationId, abort }));
  }
  peerEffect(operationId: string, effect: DeviceLifecyclePeerEffect): Promise<DeviceLifecycleOperation> {
    return this.#append(validateDeviceLifecycleRecord({ v: 1, t: "peer-effect", operationId, effect }));
  }
  terminal(operationId: string, outcome: "stopped" | "removed" | "retired", evidence: readonly DeviceLifecycleEvidenceRef[] = []): Promise<DeviceLifecycleOperation> {
    return this.#append(validateDeviceLifecycleRecord({ v: 1, t: "terminal", operationId, outcome, evidence }));
  }

  async #append(record: DeviceLifecycleRecord): Promise<DeviceLifecycleOperation> {
    const operationId = record.t === "accepted" ? record.identity.operationId : record.operationId;
    const result = await this.log.transactDurableProjection<DeviceLifecycleRecord, DeviceLifecycleOperation>(
      LIFECYCLE_PROJECTION_ID,
      async current => {
        const before = await lifecycleDecisionState(current, record);
        const next = reduceDeviceLifecycleProjection(before, record, this.#projection.verifier);
        const operation = next.operations.get(operationId);
        if (!operation) throw new Error("Lifecycle transaction did not produce an operation");
        if (next === before) return { kind: "return", value: this.#checked(operation) };
        return { kind: "append", entries: [{ stream: DEVICE_LIFECYCLE_STREAM, body: record }], value: this.#checked(operation) };
      },
      { candidateReferences: record.t === "advanced" || record.t === "terminal"
        ? record.evidence.flatMap(item => item.artifact ? [item.artifact] : [])
        : record.t === "peer-effect" ? record.effect.evidence.flatMap(item => item.artifact ? [item.artifact] : []) : [] },
    );
    return result.value;
  }
}
