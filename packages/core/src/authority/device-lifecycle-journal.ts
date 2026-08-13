import type { LogicalRecord } from "../contracts/index.js";
import {
  DEVICE_LIFECYCLE_STREAM,
  emptyDeviceLifecycleProjection,
  reduceDeviceLifecycleProjection,
  validateDeviceLifecycleRecord,
  type DeviceLifecycleAbort,
  type DeviceLifecycleEvidenceRef,
  type DeviceLifecycleIdentity,
  type DeviceLifecycleOperation,
  type DeviceLifecyclePeerEffect,
  type DeviceLifecyclePhase,
  type DeviceLifecycleProjection,
  type DeviceLifecycleRecord,
} from "../protocol/index.js";
import type { ProtocolSignatureVerifier } from "../protocol/signature.js";
import type { AuthorityCommitLog } from "./interfaces.js";

type AdvancedPhase = Exclude<DeviceLifecyclePhase, "accepted" | "terminal" | "aborted">;

export class DeviceLifecycleJournal {
  constructor(
    private readonly log: AuthorityCommitLog,
    private readonly abortVerifier?: ProtocolSignatureVerifier,
  ) {}

  async state(operationId: string): Promise<DeviceLifecycleOperation | undefined> {
    return (await this.#projection()).operations.get(operationId);
  }

  async active(): Promise<readonly DeviceLifecycleOperation[]> {
    const projection = await this.#projection();
    return [...new Set(projection.activeSubjects.values())]
      .map((operationId) => projection.operations.get(operationId))
      .filter((operation): operation is DeviceLifecycleOperation => operation !== undefined);
  }

  async operations(): Promise<readonly DeviceLifecycleOperation[]> {
    return [...(await this.#projection()).operations.values()];
  }

  async accept(identity: DeviceLifecycleIdentity): Promise<DeviceLifecycleOperation> {
    return this.#append(validateDeviceLifecycleRecord({ v: 1, t: "accepted", identity }));
  }

  async advance(
    operationId: string,
    phase: AdvancedPhase,
    evidence: readonly DeviceLifecycleEvidenceRef[] = [],
  ): Promise<DeviceLifecycleOperation> {
    return this.#append(validateDeviceLifecycleRecord({
      v: 1,
      t: "advanced",
      operationId,
      phase,
      evidence,
    }));
  }

  async abort(operationId: string, abort: DeviceLifecycleAbort): Promise<DeviceLifecycleOperation> {
    return this.#append(validateDeviceLifecycleRecord({ v: 1, t: "aborted", operationId, abort }));
  }

  async peerEffect(
    operationId: string,
    effect: DeviceLifecyclePeerEffect,
  ): Promise<DeviceLifecycleOperation> {
    return this.#append(validateDeviceLifecycleRecord({
      v: 1,
      t: "peer-effect",
      operationId,
      effect,
    }));
  }

  async terminal(
    operationId: string,
    outcome: "stopped" | "removed" | "retired" | "upgraded" | "rolled-back",
    evidence: readonly DeviceLifecycleEvidenceRef[] = [],
  ): Promise<DeviceLifecycleOperation> {
    return this.#append(validateDeviceLifecycleRecord({
      v: 1,
      t: "terminal",
      operationId,
      outcome,
      evidence,
    }));
  }

  async #append(record: DeviceLifecycleRecord): Promise<DeviceLifecycleOperation> {
    const operationId = record.t === "accepted" ? record.identity.operationId : record.operationId;
    const result = await this.log.transactProjection<
      DeviceLifecycleProjection,
      unknown,
      DeviceLifecycleOperation
    >(
      emptyDeviceLifecycleProjection(),
      (projection, entry) => this.#reduce(projection, entry),
      (projection) => {
        const next = reduceDeviceLifecycleProjection(projection, record, this.abortVerifier);
        const operation = next.operations.get(operationId);
        if (!operation) throw new Error("Lifecycle transaction did not produce an operation");
        if (next === projection) return { kind: "return", value: operation };
        return {
          kind: "append",
          entries: [{ stream: DEVICE_LIFECYCLE_STREAM, body: record }],
          value: operation,
        };
      },
      {
        stream: DEVICE_LIFECYCLE_STREAM,
        candidateReferences: record.t === "advanced" || record.t === "terminal"
          ? record.evidence.flatMap((item) => item.artifact ? [item.artifact] : [])
          : record.t === "peer-effect"
            ? record.effect.evidence.flatMap((item) => item.artifact ? [item.artifact] : [])
          : [],
      },
    );
    return result.value;
  }

  #projection(): Promise<DeviceLifecycleProjection> {
    return this.log.rebuildProjection<DeviceLifecycleProjection, unknown>(
      emptyDeviceLifecycleProjection(),
      (projection, entry) => this.#reduce(projection, entry),
      { stream: DEVICE_LIFECYCLE_STREAM },
    );
  }

  #reduce(
    projection: DeviceLifecycleProjection,
    entry: LogicalRecord<unknown>,
  ): DeviceLifecycleProjection {
    if (entry.stream !== DEVICE_LIFECYCLE_STREAM) return projection;
    return reduceDeviceLifecycleProjection(projection, entry.body, this.abortVerifier);
  }
}
