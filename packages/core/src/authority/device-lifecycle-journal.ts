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
  LIFECYCLE_PROJECTION_ID, LIFECYCLE_OPERATION_PREFIX, lifecycleActivePrefix, lifecycleRemovalRouteKey, lifecycleRemovalTargetPrefix,
  validateLifecycleRemovalTargetPointer,
  lifecycleDecisionState, lifecycleIndexedOperation, lifecycleLatestKey,
  lifecycleOperationKey, lifecycleRetirementKey, readLifecycleStored,
  reduceLifecycleIndex, resolveLifecyclePointer, validateLifecycleActivePointer,
  compareLifecycleAcceptance,
  lifecycleTargetDeviceId,
} from "./device-lifecycle-projection.js";

type AdvancedPhase = Exclude<DeviceLifecyclePhase, "accepted" | "terminal" | "aborted">;

/** 生命周期持久投影的 id：别的事务以 readProjectionIds 选它，在同一锁定前缀上精确读操作。 */
export const DEVICE_LIFECYCLE_PROJECTION_ID = LIFECYCLE_PROJECTION_ID;

/** 在给定投影视图上按 operationId 精确读一个生命周期操作，不重放生命周期流。 */
export async function readDeviceLifecycleOperation(
  view: DurableProjectionReadContext,
  operationId: string,
): Promise<DeviceLifecycleOperation | undefined> {
  return readLifecycleStored(await view.get(lifecycleOperationKey(operationId)), operationId)?.operation;
}
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
    projectionId: LIFECYCLE_PROJECTION_ID, reducerVersion: 4, authenticated: true,
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

  /** 某一种类的未终结操作：启动只恢复确有重提义务的这些，与已终结的历史无关。 */
  activeOfKind(kind: DeviceLifecycleOperation["identity"]["kind"]): Promise<readonly DeviceLifecycleOperation[]> {
    return this.#read(current => this.#active(current, undefined, kind));
  }

  /**
   * 目标设备最后一个未中止的移除（终结的也在内）：分区里读一条，再按指针精确读。
   * 终端专用服务的放行在访问时据此核验，不在启动时预装已移除的设备。
   */
  lastRemovalFor(deviceId: string): Promise<DeviceLifecycleOperation | undefined> {
    return this.#read(async current => {
      const prefix = lifecycleRemovalTargetPrefix(deviceId);
      const entry = (await current.scan({ gte: prefix, lt: prefix + "\uffff" }, 1)).entries[0];
      if (!entry) return undefined;
      validateLifecycleRemovalTargetPointer(entry.key, entry.value, deviceId);
      const stored = await resolveLifecyclePointer(current, entry.value);
      if (!stored || stored.operation.identity.kind !== "executor-removal" || stored.operation.phase === "aborted" ||
          lifecycleTargetDeviceId(stored.operation) !== deviceId) {
        throw new DurableProjectionRecordBindingError("Lifecycle removal target directory does not bind a removal");
      }
      return this.#checked(stored.operation);
    });
  }

  /** 终态路由定位摘要指向的未中止设备移除：终态入口按请求精确读一条，中止即查不到。 */
  removalForRoute(routeDigest: string): Promise<DeviceLifecycleOperation | undefined> {
    return this.#read(async current => {
      const value = await current.get(lifecycleRemovalRouteKey(routeDigest));
      if (value === undefined) return undefined;
      const stored = await resolveLifecyclePointer(current, value);
      if (!stored || stored.operation.identity.kind !== "executor-removal" || stored.operation.phase === "aborted" ||
          stored.operation.peerEffects.find((effect) => effect.kind === "terminal-route")?.digest !== routeDigest) {
        throw new DurableProjectionRecordBindingError("Lifecycle removal route directory does not bind its removal");
      }
      return this.#checked(stored.operation);
    });
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
