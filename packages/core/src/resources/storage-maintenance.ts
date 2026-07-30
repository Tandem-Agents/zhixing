import type { Digest, IsoTime } from "../contracts/index.js";
import { protocolDigest } from "../protocol/canonical.js";
import {
  deviceCapacityAdmissionId,
  emptyDeviceCapacityBudget,
  type DeviceCapacityAdmission,
  type DeviceCapacityArbiterPort,
  type DeviceCapacityBudget,
  withDeviceCapacityStep,
} from "./device-capacity.js";
import {
  currentMaintenanceAbortSignal,
  currentMaintenanceUrgency,
  isHoldingMaintenanceExclusion,
  runWithMaintenanceUrgency,
} from "./maintenance-context.js";

export const STORAGE_MAINTENANCE_KINDS = [
  "log-migration",
  "workspace-migration",
  "workscene-cleanup",
  "projection-flush",
  "projection-rebuild",
  "projection-scrub",
  "projection-compaction",
  "lifecycle-reconcile",
  "asset-gc",
  "ticket-retirement",
  "stream-spool-reclaim",
] as const;

export type StorageMaintenanceKind =
  (typeof STORAGE_MAINTENANCE_KINDS)[number];
export const STORAGE_MAINTENANCE_TASK_OWNERS = {
  "log-migration": "authority-commit-log",
  "workspace-migration": "workspace-binding-migrator",
  "workscene-cleanup": "anchor-workscene-owner",
  "projection-flush": "durable-projection-index",
  "projection-rebuild": "durable-projection-index",
  "projection-scrub": "durable-projection-index",
  "projection-compaction": "durable-projection-index",
  "lifecycle-reconcile": "artifact-lifecycle-index",
  "asset-gc": "anchor-asset-maintainer",
  "ticket-retirement": "executor-data-plane",
  "stream-spool-reclaim": "executor-data-plane",
} as const satisfies Readonly<
  Record<StorageMaintenanceKind, string>
>;
export type StorageMaintenanceTaskOwner =
  (typeof STORAGE_MAINTENANCE_TASK_OWNERS)[StorageMaintenanceKind];
export type StorageMaintenanceUrgency =
  | "foreground"
  | "recovery"
  | "background";
export type StorageMaintenanceObligation = "pre-commit" | "committed";

export interface StorageMaintenanceRequest {
  readonly workKey: Digest;
  readonly kind: StorageMaintenanceKind;
  readonly urgency: StorageMaintenanceUrgency;
  readonly obligation: StorageMaintenanceObligation;
  readonly atomic: DeviceCapacityBudget;
  readonly preferred: DeviceCapacityBudget;
  readonly maxWaitMs: number;
}

/**
 * 义务级协调请求。义务层只做 single-flight 协调,不申请容量,因此不携带
 * 预算与等待上限——容量语义全部属于叶级物理步骤请求。workKey 是义务的
 * 规范身份:类别 + 资源 + 义务输入的摘要,同键即同一份工作。
 */
export interface StorageMaintenanceObligationRequest {
  readonly workKey: Digest;
  readonly kind: StorageMaintenanceKind;
  readonly owner: StorageMaintenanceTaskOwner;
  readonly urgency: StorageMaintenanceUrgency;
  readonly obligation: StorageMaintenanceObligation;
}

export interface StorageMaintenanceDiagnostics {
  readonly queued: Partial<Record<StorageMaintenanceKind, number>>;
  readonly inFlight: Partial<Record<StorageMaintenanceKind, number>>;
  readonly estimatedDebt: DeviceCapacityBudget;
  readonly capacity: ReturnType<DeviceCapacityArbiterPort["snapshot"]>;
  readonly oldestWaitMs?: number;
  readonly blockedBy?: ReturnType<DeviceCapacityArbiterPort["snapshot"]>["blockedBy"];
  readonly lastError?: {
    readonly kind: StorageMaintenanceKind;
    readonly at: IsoTime;
    readonly code: string;
  };
}

export interface StorageMaintenanceGovernorPort {
  acquire(
    request: StorageMaintenanceRequest,
    abort: AbortSignal,
  ): Promise<DeviceCapacityAdmission>;
  snapshot(): StorageMaintenanceDiagnostics;
}

export interface DefaultStorageMaintenanceGovernorOptions {
  readonly capacity: DeviceCapacityArbiterPort;
  readonly clock?: () => IsoTime;
}

interface PendingMaintenance {
  readonly request: StorageMaintenanceRequest;
  readonly queuedAt: number;
}

export class DefaultStorageMaintenanceGovernor
  implements StorageMaintenanceGovernorPort
{
  readonly #capacity: DeviceCapacityArbiterPort;
  readonly #clock: () => IsoTime;
  readonly #pending = new Set<PendingMaintenance>();
  readonly #inFlight = new Map<StorageMaintenanceKind, number>();
  #lastError: StorageMaintenanceDiagnostics["lastError"];

  constructor(options: DefaultStorageMaintenanceGovernorOptions) {
    this.#capacity = options.capacity;
    this.#clock = options.clock ?? (() => new Date().toISOString());
  }

  async acquire(
    request: StorageMaintenanceRequest,
    abort: AbortSignal,
  ): Promise<DeviceCapacityAdmission> {
    validateStorageRequest(request);
    const pending: PendingMaintenance = { request, queuedAt: Date.now() };
    this.#pending.add(pending);
    let admission: DeviceCapacityAdmission;
    try {
      admission = await this.#capacity.acquire(
        {
          admissionId: deviceCapacityAdmissionId(`storage-${request.kind}`),
          serviceClass: `storage-${request.urgency}`,
          atomic: request.atomic,
          preferred: request.preferred,
          maxWaitMs: request.maxWaitMs,
        },
        abort,
      );
    } finally {
      this.#pending.delete(pending);
    }
    if (admission.kind !== "granted") return admission;
    this.#inFlight.set(
      request.kind,
      (this.#inFlight.get(request.kind) ?? 0) + 1,
    );
    let released = false;
    const permit = admission.permit;
    return {
      kind: "granted",
      permit: {
        granted: permit.granted,
        tryBegin: (stepBound) => permit.tryBegin(stepBound),
        release: () => {
          if (released) return;
          released = true;
          permit.release();
          const count = (this.#inFlight.get(request.kind) ?? 1) - 1;
          if (count === 0) this.#inFlight.delete(request.kind);
          else this.#inFlight.set(request.kind, count);
        },
      },
    };
  }

  snapshot(): StorageMaintenanceDiagnostics {
    const queued: Partial<Record<StorageMaintenanceKind, number>> = {};
    const estimatedDebt = emptyDeviceCapacityBudget();
    let oldestWaitMs: number | undefined;
    const now = Date.now();
    for (const pending of this.#pending) {
      queued[pending.request.kind] = (queued[pending.request.kind] ?? 0) + 1;
      addBudget(estimatedDebt, pending.request.preferred);
      const wait = now - pending.queuedAt;
      oldestWaitMs = oldestWaitMs === undefined ? wait : Math.max(oldestWaitMs, wait);
    }
    const inFlight: Partial<Record<StorageMaintenanceKind, number>> = {};
    for (const [kind, count] of this.#inFlight) inFlight[kind] = count;
    const capacity = this.#capacity.snapshot();
    return {
      queued,
      inFlight,
      estimatedDebt,
      capacity,
      ...(oldestWaitMs === undefined ? {} : { oldestWaitMs }),
      ...(capacity.blockedBy ? { blockedBy: capacity.blockedBy } : {}),
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  recordError(kind: StorageMaintenanceKind, error: unknown): void {
    this.#lastError = {
      kind,
      at: this.#clock(),
      code: maintenanceErrorCode(error),
    };
  }
}

interface SharedTask<T> {
  readonly workKey: Digest;
  readonly kind: StorageMaintenanceKind;
  readonly owner: StorageMaintenanceTaskOwner;
  /** committed 一经出现即不可降级；它表示工作已跨过候选提交点。 */
  obligation: StorageMaintenanceObligation;
  /** 当前仍在等待的调用者中最强的紧急度。 */
  urgency: StorageMaintenanceUrgency;
  readonly abort: AbortController;
  promise: Promise<T>;
  readonly waiters: Map<symbol, StorageMaintenanceUrgency>;
  settled: boolean;
}

/**
 * 义务级协调层:完整维护义务的 single-flight 所有权。
 *
 * 与物理步骤准入严格分层:这里只做规范 workKey 的同键合流、提级、逐等待者
 * 取消与诊断,不申请、不持有任何设备容量 permit——义务体内部的每个物理
 * 步骤在取得所属锁或串行权后,经 `runStorageMaintenanceStep` 独立准入。
 * 整段义务持有一个 permit 会横跨锁等待与全部步骤;把义务切成叶级 workKey
 * 则合流、提级、取消与诊断失去载体——两种形态都是本类要消灭的。
 */
export class StorageMaintenanceTaskRunner {
  readonly #tasks = new Map<string, SharedTask<unknown>>();
  #stopped = false;

  constructor(private readonly governor?: StorageMaintenanceGovernorPort) {}

  run<T>(
    request: StorageMaintenanceObligationRequest,
    waiterAbort: AbortSignal,
    operation: (abort: AbortSignal) => Promise<T>,
  ): Promise<T> {
    validateStorageObligationRequest(request);
    if (this.#stopped) {
      return Promise.reject(new StorageMaintenanceCancelledError());
    }
    if (waiterAbort.aborted) {
      return Promise.reject(new StorageMaintenanceCancelledError());
    }
    const existing = this.#tasks.get(request.workKey);
    if (existing) {
      if (
        existing.kind !== request.kind ||
        existing.owner !== request.owner
      ) {
        return Promise.reject(
          new StorageMaintenanceConflictError(
            `Storage maintenance key ${request.workKey} was reused with different inputs`,
          ),
        );
      }
      // 已被最后一个 pre-commit 等待者取消的旧执行仍可能在清理。新调用不得
      // 加入注定失败的 promise，也不得与它并行执行同键工作；等它结算后重驱。
      if (existing.abort.signal.aborted) {
        return this.#runAfterSettlement(
          existing,
          request,
          waiterAbort,
          operation,
        );
      }
      if (request.obligation === "committed") {
        existing.obligation = "committed";
      }
      return this.#join(
        existing as SharedTask<T>,
        waiterAbort,
        request.urgency,
      );
    }

    const task: SharedTask<T> = {
      workKey: request.workKey,
      kind: request.kind,
      owner: request.owner,
      obligation: request.obligation,
      urgency: request.urgency,
      abort: new AbortController(),
      promise: undefined as unknown as Promise<T>,
      waiters: new Map(),
      settled: false,
    };
    task.promise = this.#execute(task, operation).finally(() => {
      task.settled = true;
      if (this.#tasks.get(task.workKey) === task) {
        this.#tasks.delete(task.workKey);
      }
    });
    this.#tasks.set(task.workKey, task as SharedTask<unknown>);
    return this.#join(task, waiterAbort, request.urgency);
  }

  stop(): void {
    this.#stopped = true;
    for (const task of this.#tasks.values()) task.abort.abort();
  }

  async #execute<T>(
    task: SharedTask<T>,
    operation: (abort: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      return await runWithMaintenanceUrgency(
        () => task.urgency,
        task.abort.signal,
        () => operation(task.abort.signal),
      );
    } catch (error) {
      recordMaintenanceError(this.governor, task.kind, error);
      throw error;
    }
  }

  #join<T>(
    task: SharedTask<T>,
    waiterAbort: AbortSignal,
    urgency: StorageMaintenanceUrgency,
  ): Promise<T> {
    const waiter = Symbol("storage-maintenance-waiter");
    task.waiters.set(waiter, urgency);
    this.#refreshUrgency(task);
    if (waiterAbort.aborted) {
      this.#releaseWaiter(task, waiter);
      return Promise.reject(new StorageMaintenanceCancelledError());
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        waiterAbort.removeEventListener("abort", onAbort);
        this.#releaseWaiter(task, waiter);
        callback();
      };
      const onAbort = () =>
        finish(() => reject(new StorageMaintenanceCancelledError()));
      waiterAbort.addEventListener("abort", onAbort, { once: true });
      task.promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  #releaseWaiter(task: SharedTask<unknown>, waiter: symbol): void {
    task.waiters.delete(waiter);
    this.#refreshUrgency(task);
    if (
      task.waiters.size === 0 &&
      !task.settled &&
      task.obligation === "pre-commit"
    ) {
      task.abort.abort();
    }
  }

  #refreshUrgency(task: SharedTask<unknown>): void {
    let urgency: StorageMaintenanceUrgency = "background";
    for (const current of task.waiters.values()) {
      if (URGENCY_RANK[current] > URGENCY_RANK[urgency]) urgency = current;
    }
    task.urgency = urgency;
  }

  #runAfterSettlement<T>(
    current: SharedTask<unknown>,
    request: StorageMaintenanceObligationRequest,
    waiterAbort: AbortSignal,
    operation: (abort: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (callback: () => void) => {
        if (finished) return;
        finished = true;
        waiterAbort.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () =>
        finish(() => reject(new StorageMaintenanceCancelledError()));
      waiterAbort.addEventListener("abort", onAbort, { once: true });
      if (waiterAbort.aborted) {
        onAbort();
        return;
      }
      current.promise.then(
        () => {
          if (finished) return;
          waiterAbort.removeEventListener("abort", onAbort);
          finished = true;
          this.run(request, waiterAbort, operation).then(resolve, reject);
        },
        () => {
          if (finished) return;
          waiterAbort.removeEventListener("abort", onAbort);
          finished = true;
          this.run(request, waiterAbort, operation).then(resolve, reject);
        },
      );
    });
  }
}

const MIB = 1024 * 1024;

const STORAGE_STEP_BUDGETS: Readonly<
  Record<StorageMaintenanceKind, DeviceCapacityBudget>
> = {
  "log-migration": budget(32 * MIB, 256 * MIB, 256 * MIB, 256 * MIB, 4_096),
  "workspace-migration": budget(
    16 * MIB,
    16 * MIB,
    64 * MIB,
    64 * MIB,
    4_096,
  ),
  "workscene-cleanup": budget(16 * MIB, 0, 256 * MIB, 256 * MIB, 4_096),
  "projection-flush": budget(32 * MIB, 64 * MIB, 256 * MIB, 256 * MIB, 16_384),
  "projection-rebuild": budget(32 * MIB, 64 * MIB, 256 * MIB, 256 * MIB, 16_384),
  "projection-scrub": budget(
    16 * MIB,
    16 * MIB,
    256 * MIB,
    16 * MIB,
    16_384,
  ),
  "projection-compaction": budget(
    32 * MIB,
    256 * MIB,
    256 * MIB,
    256 * MIB,
    16_384,
  ),
  "lifecycle-reconcile": budget(
    32 * MIB,
    64 * MIB,
    256 * MIB,
    256 * MIB,
    16_384,
  ),
  "asset-gc": budget(16 * MIB, 0, 256 * MIB, 256 * MIB, 4_096),
  // 票据退休 = 有界 WAL 追加批与内存投影清理,量级由过期票据数决定。
  "ticket-retirement": budget(16 * MIB, 0, 64 * MIB, 16 * MIB, 4_096),
  // spool 回收 = 单 assignment 目录的墓碑写与物理删除。
  "stream-spool-reclaim": budget(16 * MIB, 0, 256 * MIB, 256 * MIB, 4_096),
};

export function storageMaintenanceRequest(
  kind: StorageMaintenanceKind,
  resourceId: string,
  inputIdentity: unknown,
  options: {
    readonly obligation: StorageMaintenanceObligation;
    readonly maxWaitMs?: number;
  },
): StorageMaintenanceRequest {
  const atomic = cloneBudget(STORAGE_STEP_BUDGETS[kind]);
  // 紧急度只能从执行语境取:它由"当前谁在等这件事"决定,叶级任务无从判断,
  // 也不允许自己声明——否则每个后台任务都会把自己写成前台。
  const urgency = currentMaintenanceUrgency();
  // 持锁或处于串行段时一律零等待:排队会把锁的持有时间拉到准入超时那么长,
  // 把一次背压放大成对全部持锁者的阻塞。背压后由锁外重试。
  const maxWaitMs = isHoldingMaintenanceExclusion()
    ? 0
    : (options.maxWaitMs ??
      (options.obligation === "pre-commit" ? 0 : 5_000));
  return {
    workKey: storageMaintenanceWorkKey(kind, resourceId, inputIdentity),
    kind,
    urgency,
    obligation: options.obligation,
    atomic,
    preferred: cloneBudget(atomic),
    maxWaitMs,
  };
}

/**
 * 构造义务级协调请求:规范身份 = 类别 + 资源 + 义务输入的摘要。紧急度取当前
 * 语境——"当前谁在等这份义务"只有触发点知道,义务自身不得自报。
 */
export function storageMaintenanceObligation(
  kind: StorageMaintenanceKind,
  resourceId: string,
  inputIdentity: unknown,
  options: {
    readonly owner: StorageMaintenanceTaskOwner;
    readonly obligation: StorageMaintenanceObligation;
  },
): StorageMaintenanceObligationRequest {
  if (STORAGE_MAINTENANCE_TASK_OWNERS[kind] !== options.owner) {
    throw new TypeError("Storage maintenance task owner is invalid");
  }
  return {
    workKey: storageMaintenanceWorkKey(kind, resourceId, inputIdentity),
    kind,
    owner: options.owner,
    urgency: currentMaintenanceUrgency(),
    obligation: options.obligation,
  };
}

/**
 * 物理步骤准入层:一个叶级物理副作用的一次容量准入。
 *
 * 必须在取得所属锁或串行权之后、真正产生副作用之前调用;零等待由互斥语境
 * 单点给出,背压由调用方在锁外重试。permit 完成即释放,绝不横跨锁等待、
 * 串行队列或外部等待。不做 single-flight:叶步骤已被所属串行区线性化,
 * 同键合流是义务层的职责。governor 缺省时直通,对应不装配治理的嵌入场景。
 */
export async function runStorageMaintenanceStep<T>(
  governor: StorageMaintenanceGovernorPort | undefined,
  request: StorageMaintenanceRequest,
  operation: () => Promise<T>,
): Promise<T> {
  const abort = currentMaintenanceAbortSignal();
  throwIfMaintenanceCancelled(abort);
  if (!governor) return operation();
  validateStorageRequest(request);
  const admission = await governor.acquire(request, abort);
  if (admission.kind === "cancelled") {
    throw new StorageMaintenanceCancelledError();
  }
  if (admission.kind !== "granted") {
    throw new StorageMaintenanceAdmissionError(admission);
  }
  try {
    throwIfMaintenanceCancelled(abort);
    return await withDeviceCapacityStep(
      admission.permit,
      request.atomic,
      async () => {
        throwIfMaintenanceCancelled(abort);
        return operation();
      },
    );
  } catch (error) {
    recordMaintenanceError(governor, request.kind, error);
    throw error;
  } finally {
    admission.permit.release();
  }
}

export function storageMaintenanceWorkKey(
  kind: StorageMaintenanceKind,
  resourceId: string,
  inputIdentity: unknown,
): Digest {
  if (!STORAGE_MAINTENANCE_KINDS.includes(kind)) {
    throw new TypeError("Storage maintenance kind is invalid");
  }
  if (!resourceId || resourceId.length > 512) {
    throw new TypeError("Storage maintenance resource id is invalid");
  }
  return protocolDigest("StorageMaintenanceWork", 1, {
    kind,
    resourceId,
    inputIdentity,
  });
}

export class StorageMaintenanceAdmissionError extends Error {
  constructor(readonly admission: Exclude<DeviceCapacityAdmission, { kind: "granted" }>) {
    super(
      `Storage maintenance was not admitted: ${admission.kind}` +
        ("blockedBy" in admission ? `:${admission.blockedBy}` : ""),
    );
    this.name = "StorageMaintenanceAdmissionError";
  }
}

/**
 * 可重试背压 → 建议的重试延时;其余准入结果(容量缺口、取消)一律返回
 * `undefined`,由调用方原样上抛。
 *
 * 判据只此一处:段内准入是零等待的,每个持锁/串行段的调用点都需要在段外重试,
 * 各自内联就会分叉——放宽一处、另一处不跟,两条恢复路径的容量语义会静默不一致。
 */
export function maintenanceRetryDelayMs(error: unknown): number | undefined {
  return error instanceof StorageMaintenanceAdmissionError &&
      error.admission.kind === "backpressured"
    ? error.admission.retryAfterMs
    : undefined;
}

/** 段外等待。必须在互斥区之外调用,否则等待又落回区内。 */
export function waitForMaintenanceRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class StorageMaintenanceCancelledError extends Error {
  constructor() {
    super("Storage maintenance waiter was cancelled");
    this.name = "StorageMaintenanceCancelledError";
  }
}

function throwIfMaintenanceCancelled(abort: AbortSignal): void {
  if (abort.aborted) throw new StorageMaintenanceCancelledError();
}

export class StorageMaintenanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageMaintenanceConflictError";
  }
}

function validateStorageRequest(request: StorageMaintenanceRequest): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(request.workKey)) {
    throw new TypeError("Storage maintenance work key is invalid");
  }
  if (!STORAGE_MAINTENANCE_KINDS.includes(request.kind)) {
    throw new TypeError("Storage maintenance kind is invalid");
  }
  if (!["foreground", "recovery", "background"].includes(request.urgency)) {
    throw new TypeError("Storage maintenance urgency is invalid");
  }
  if (!["pre-commit", "committed"].includes(request.obligation)) {
    throw new TypeError("Storage maintenance obligation is invalid");
  }
}

function validateStorageObligationRequest(
  request: StorageMaintenanceObligationRequest,
): void {
  if (!/^sha256:[a-f0-9]{64}$/u.test(request.workKey)) {
    throw new TypeError("Storage maintenance work key is invalid");
  }
  if (!STORAGE_MAINTENANCE_KINDS.includes(request.kind)) {
    throw new TypeError("Storage maintenance kind is invalid");
  }
  if (STORAGE_MAINTENANCE_TASK_OWNERS[request.kind] !== request.owner) {
    throw new TypeError("Storage maintenance task owner is invalid");
  }
  if (!["foreground", "recovery", "background"].includes(request.urgency)) {
    throw new TypeError("Storage maintenance urgency is invalid");
  }
  if (!["pre-commit", "committed"].includes(request.obligation)) {
    throw new TypeError("Storage maintenance obligation is invalid");
  }
}

/** 同一错误只记一次:步骤层先记,沿义务层上抛时去重保证不重复计数。 */
const recordedMaintenanceErrors = new WeakSet<object>();

function recordMaintenanceError(
  governor: StorageMaintenanceGovernorPort | undefined,
  kind: StorageMaintenanceKind,
  error: unknown,
): void {
  if (!(governor instanceof DefaultStorageMaintenanceGovernor)) return;
  if (typeof error === "object" && error !== null) {
    if (recordedMaintenanceErrors.has(error)) return;
    recordedMaintenanceErrors.add(error);
  }
  governor.recordError(kind, error);
}

/** 紧急度强弱序:前台 > 恢复 > 后台。 */
const URGENCY_RANK: Readonly<Record<StorageMaintenanceUrgency, number>> = {
  foreground: 2,
  recovery: 1,
  background: 0,
};

function addBudget(
  target: ReturnType<typeof emptyDeviceCapacityBudget>,
  input: DeviceCapacityBudget,
): void {
  target.occupancy.memoryReservationBytes += input.occupancy.memoryReservationBytes;
  target.occupancy.temporaryBytes += input.occupancy.temporaryBytes;
  target.occupancy.slots += input.occupancy.slots;
  target.quantum.readBytes += input.quantum.readBytes;
  target.quantum.writeBytes += input.quantum.writeBytes;
  target.quantum.ioOperations += input.quantum.ioOperations;
}

function cloneBudget(budget: DeviceCapacityBudget): DeviceCapacityBudget {
  return {
    occupancy: { ...budget.occupancy },
    quantum: { ...budget.quantum },
  };
}

function budget(
  memoryReservationBytes: number,
  temporaryBytes: number,
  readBytes: number,
  writeBytes: number,
  ioOperations: number,
): DeviceCapacityBudget {
  return {
    occupancy: { memoryReservationBytes, temporaryBytes, slots: 1 },
    quantum: { readBytes, writeBytes, ioOperations },
  };
}

function maintenanceErrorCode(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return "unknown";
}
