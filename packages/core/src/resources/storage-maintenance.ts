import type { Digest, IsoTime } from "../contracts/index.js";
import { protocolDigest } from "../protocol/canonical.js";
import {
  deviceCapacityAdmissionId,
  emptyDeviceCapacityBudget,
  type DeviceCapacityAdmission,
  type DeviceCapacityArbiterPort,
  type DeviceCapacityBudget,
  type DeviceCapacityPermit,
  withDeviceCapacityStep,
} from "./device-capacity.js";
import {
  currentMaintenanceUrgency,
  isHoldingMaintenanceExclusion,
} from "./maintenance-context.js";

export const STORAGE_MAINTENANCE_KINDS = [
  "log-migration",
  "projection-flush",
  "projection-rebuild",
  "projection-scrub",
  "projection-compaction",
  "lifecycle-reconcile",
  "asset-gc",
] as const;

export type StorageMaintenanceKind =
  (typeof STORAGE_MAINTENANCE_KINDS)[number];
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
  readonly requestIdentity: string;
  /** 当前生效请求。等待准入期间可被更强的同键请求提级替换。 */
  request: StorageMaintenanceRequest;
  readonly abort: AbortController;
  promise: Promise<T>;
  /** 当前这次准入尝试的中断器;提级时中断它以便用更强请求重新排队。 */
  attempt: AbortController | undefined;
  waiters: number;
  settled: boolean;
  /** 已取得 permit 进入执行。此后提级无意义,新等待者直接共享结果。 */
  admitted: boolean;
  /** 等待准入期间被提级,当前这次 acquire 的取消应转为重试而非失败。 */
  escalated: boolean;
}

export class StorageMaintenanceTaskRunner {
  readonly #tasks = new Map<string, SharedTask<unknown>>();

  constructor(private readonly governor: StorageMaintenanceGovernorPort) {}

  run<T>(
    request: StorageMaintenanceRequest,
    waiterAbort: AbortSignal,
    operation: (permit: DeviceCapacityPermit, abort: AbortSignal) => Promise<T>,
  ): Promise<T> {
    validateStorageRequest(request);
    const identity = requestIdentity(request);
    const existing = this.#tasks.get(request.workKey);
    if (existing) {
      if (existing.requestIdentity !== identity) {
        return Promise.reject(
          new StorageMaintenanceConflictError(
            `Storage maintenance key ${request.workKey} was reused with different inputs`,
          ),
        );
      }
      // 更强的同键请求让仍在排队的任务带着新紧急度重新准入;已经拿到 permit
      // 的任务直接共享结果——它正在做的就是这件事,重排只会白白丢掉进度。
      if (!existing.admitted && isStrongerRequest(request, existing.request)) {
        existing.request = request;
        existing.escalated = true;
        existing.attempt?.abort();
      }
      return this.#join(existing as SharedTask<T>, waiterAbort);
    }

    const task: SharedTask<T> = {
      requestIdentity: identity,
      request,
      abort: new AbortController(),
      promise: undefined as unknown as Promise<T>,
      attempt: undefined,
      waiters: 0,
      settled: false,
      admitted: false,
      escalated: false,
    };
    task.promise = this.#execute(task, operation).finally(() => {
      task.settled = true;
      if (this.#tasks.get(request.workKey) === task) {
        this.#tasks.delete(request.workKey);
      }
    });
    this.#tasks.set(request.workKey, task as SharedTask<unknown>);
    return this.#join(task, waiterAbort);
  }

  stop(): void {
    for (const task of this.#tasks.values()) task.abort.abort();
  }

  async #execute<T>(
    task: SharedTask<T>,
    operation: (permit: DeviceCapacityPermit, abort: AbortSignal) => Promise<T>,
  ): Promise<T> {
    for (;;) {
      const admission = await this.#admit(task);
      // 提级中断的准入不是失败:换用更强的请求重新排队。
      if (admission.kind === "cancelled" && task.escalated) {
        task.escalated = false;
        continue;
      }
      if (admission.kind !== "granted") {
        throw new StorageMaintenanceAdmissionError(admission);
      }
      task.admitted = true;
      try {
        return await operation(admission.permit, task.abort.signal);
      } catch (error) {
        if (this.governor instanceof DefaultStorageMaintenanceGovernor) {
          this.governor.recordError(task.request.kind, error);
        }
        throw error;
      } finally {
        admission.permit.release();
      }
    }
  }

  /** 单次准入尝试:整体取消与提级中断都要能打断排队中的 acquire。 */
  async #admit(task: SharedTask<unknown>): Promise<DeviceCapacityAdmission> {
    if (task.abort.signal.aborted) return { kind: "cancelled" };
    const attempt = new AbortController();
    task.attempt = attempt;
    const forward = () => attempt.abort();
    task.abort.signal.addEventListener("abort", forward, { once: true });
    try {
      return await this.governor.acquire(task.request, attempt.signal);
    } finally {
      task.abort.signal.removeEventListener("abort", forward);
      task.attempt = undefined;
    }
  }

  #join<T>(task: SharedTask<T>, waiterAbort: AbortSignal): Promise<T> {
    task.waiters += 1;
    if (waiterAbort.aborted) {
      this.#releaseWaiter(task);
      return Promise.reject(new StorageMaintenanceCancelledError());
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        waiterAbort.removeEventListener("abort", onAbort);
        this.#releaseWaiter(task);
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

  #releaseWaiter(task: SharedTask<unknown>): void {
    task.waiters = Math.max(0, task.waiters - 1);
    if (
      task.waiters === 0 &&
      !task.settled &&
      task.request.obligation === "pre-commit"
    ) {
      task.abort.abort();
    }
  }
}

const MIB = 1024 * 1024;

const STORAGE_STEP_BUDGETS: Readonly<
  Record<StorageMaintenanceKind, DeviceCapacityBudget>
> = {
  "log-migration": budget(32 * MIB, 256 * MIB, 256 * MIB, 256 * MIB, 4_096),
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

export async function runStorageMaintenanceTask<T>(
  runner: StorageMaintenanceTaskRunner | undefined,
  request: StorageMaintenanceRequest,
  operation: () => Promise<T>,
  waiterAbort: AbortSignal = new AbortController().signal,
): Promise<T> {
  if (!runner) return operation();
  return runner.run(request, waiterAbort, (permit) =>
    withDeviceCapacityStep(permit, request.atomic, operation),
  );
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

/**
 * 同键任务的身份口径 —— 只含业务身份与资源形状。
 *
 * 紧急度、义务来源和等待上限都是调度属性:同一份工作被前台等待还是后台触发,
 * 做的是同一件事,不该因此被判成异载荷冲突而拒绝合流。资源形状留在身份里,
 * 因为形状不同意味着 permit 授予的额度不能互换。
 */
function requestIdentity(request: StorageMaintenanceRequest): string {
  return JSON.stringify({
    kind: request.kind,
    atomic: request.atomic,
    preferred: request.preferred,
  });
}

/** 紧急度强弱序:前台 > 恢复 > 后台。 */
const URGENCY_RANK: Readonly<Record<StorageMaintenanceUrgency, number>> = {
  foreground: 2,
  recovery: 1,
  background: 0,
};

/**
 * 新请求是否比在跑的任务更强。更强时等待中的任务重新准入,避免后台任务先占住
 * 键、前台等待者只能陪它排在低优先级队列里。
 */
function isStrongerRequest(
  next: StorageMaintenanceRequest,
  current: StorageMaintenanceRequest,
): boolean {
  if (URGENCY_RANK[next.urgency] > URGENCY_RANK[current.urgency]) return true;
  return (
    next.obligation === "committed" && current.obligation === "pre-commit"
  );
}

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
