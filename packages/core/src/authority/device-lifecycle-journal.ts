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
import type { AuthorityCommitLog, ProjectionCursor } from "./interfaces.js";
import { SerialTaskQueue } from "../persistence/serial-task-queue.js";

type AdvancedPhase = Exclude<DeviceLifecyclePhase, "accepted" | "terminal" | "aborted">;
type CachedLifecycleProjection = { readonly state: DeviceLifecycleProjection; readonly cursor: ProjectionCursor };

// 同一进程内，同一日志、同一校验器上的各个日志实例共享已回放的投影：宿主启动时
// 多处各自建实例，否则会把随每次启停增长的全部生命周期记录各回放一遍。只按完全
// 相同的校验器共享（无校验器时无法归约经签名的中止记录，不能借用校验过的结果）；
// 投影由归约产生新映射，对外结果均为副本，共享的基线不会被调用方修改。
const sharedProjections = new WeakMap<AuthorityCommitLog, Map<ProtocolSignatureVerifier | null, CachedLifecycleProjection>>();


export class DeviceLifecycleJournal {
  readonly #queue = new SerialTaskQueue();
  constructor(
    private readonly log: AuthorityCommitLog,
    private readonly abortVerifier?: ProtocolSignatureVerifier,
  ) {}

  get #cached(): CachedLifecycleProjection | undefined {
    return sharedProjections.get(this.log)?.get(this.abortVerifier ?? null);
  }

  set #cached(value: CachedLifecycleProjection) {
    let entries = sharedProjections.get(this.log);
    if (!entries) sharedProjections.set(this.log, entries = new Map());
    const key = this.abortVerifier ?? null;
    const prior = entries.get(key);
    // 并发实例可能以较旧的游标收尾；只前进，不回退到更早的基线。
    if (!prior || value.cursor.lsn >= prior.cursor.lsn) entries.set(key, value);
  }

  async state(operationId: string): Promise<DeviceLifecycleOperation | undefined> {
    const operation = (await this.#projection()).operations.get(operationId);
    return operation && structuredClone(operation);
  }

  async active(): Promise<readonly DeviceLifecycleOperation[]> {
    const projection = await this.#projection();
    return [...new Set(projection.activeSubjects.values())]
      .map((operationId) => projection.operations.get(operationId))
      .filter((operation): operation is DeviceLifecycleOperation => operation !== undefined)
      .map(operation => structuredClone(operation));
  }

  async operations(): Promise<readonly DeviceLifecycleOperation[]> {
    return [...(await this.#projection()).operations.values()].map(operation => structuredClone(operation));
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
    outcome: "stopped" | "removed" | "retired",
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

  #append(record: DeviceLifecycleRecord): Promise<DeviceLifecycleOperation> {
    return this.#queue.run(async () => { return this.#appendUnlocked(record); });
  }

  async #appendUnlocked(record: DeviceLifecycleRecord): Promise<DeviceLifecycleOperation> {
    const operationId = record.t === "accepted" ? record.identity.operationId : record.operationId;
    const result = await this.log.transactProjection<
      DeviceLifecycleProjection,
      unknown,
      DeviceLifecycleOperation
    >(
      this.#cached?.state ?? emptyDeviceLifecycleProjection(),
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
        ...(this.#cached ? { cursor: this.#cached.cursor } : {}),
        candidateReferences: record.t === "advanced" || record.t === "terminal"
          ? record.evidence.flatMap((item) => item.artifact ? [item.artifact] : [])
          : record.t === "peer-effect"
            ? record.effect.evidence.flatMap((item) => item.artifact ? [item.artifact] : [])
          : [],
      },
    );
    this.#cached = { state: result.state, cursor: result.cursor };
    return structuredClone(result.value);
  }

  #projection(): Promise<DeviceLifecycleProjection> {
    return this.#queue.run(async () => {
      // The log revalidates the physical prefix on every read. Reducers return
      // new maps, and public results are copied, so failed work or callers
      // cannot mutate the cached, verified basis.
      const result = await this.log.readProjection<DeviceLifecycleProjection, unknown>(
        this.#cached?.state ?? emptyDeviceLifecycleProjection(),
        (projection, entry) => this.#reduce(projection, entry),
        { stream: DEVICE_LIFECYCLE_STREAM, ...(this.#cached ? { cursor: this.#cached.cursor } : {}) },
      );
      this.#cached = { state: result.state, cursor: result.cursor };
      return result.state;
    });
  }

  #reduce(
    projection: DeviceLifecycleProjection,
    entry: LogicalRecord<unknown>,
  ): DeviceLifecycleProjection {
    if (entry.stream !== DEVICE_LIFECYCLE_STREAM) return projection;
    return reduceDeviceLifecycleProjection(projection, entry.body, this.abortVerifier);
  }
}
