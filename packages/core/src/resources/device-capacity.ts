import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { statfsSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { performance } from "node:perf_hooks";

export const DEVICE_CAPACITY_CLASSES = [
  "workload-interactive",
  "workload-advancement",
  "workload-scheduler",
  "workload-orchestration",
  "storage-foreground",
  "storage-recovery",
  "storage-background",
] as const;

export type DeviceCapacityClass = (typeof DEVICE_CAPACITY_CLASSES)[number];

export type DeviceCapacityDimension =
  | "memoryReservationBytes"
  | "temporaryBytes"
  | "slots"
  | "readBytes"
  | "writeBytes"
  | "ioOperations";

export interface DeviceCapacityBudget {
  readonly occupancy: {
    readonly memoryReservationBytes: number;
    readonly temporaryBytes: number;
    readonly slots: number;
  };
  readonly quantum: {
    readonly readBytes: number;
    readonly writeBytes: number;
    readonly ioOperations: number;
  };
}

export interface DeviceCapacityRequest {
  readonly admissionId: string;
  readonly serviceClass: DeviceCapacityClass;
  readonly atomic: DeviceCapacityBudget;
  readonly preferred: DeviceCapacityBudget;
  readonly maxWaitMs: number;
}

export interface DeviceCapacityStepPermit {
  claim(dimension: DeviceCapacityDimension, amount: number): void;
  complete(): void;
}

export interface DeviceCapacityPermit {
  readonly granted: DeviceCapacityBudget;
  tryBegin(stepBound: DeviceCapacityBudget): DeviceCapacityStepPermit | undefined;
  release(): void;
}

export type DeviceCapacityAdmission =
  | { readonly kind: "granted"; readonly permit: DeviceCapacityPermit }
  | {
      readonly kind: "backpressured";
      readonly blockedBy: DeviceCapacityDimension;
      readonly retryAfterMs: number;
    }
  | {
      readonly kind: "capacity-gap";
      readonly blockedBy: DeviceCapacityDimension;
      readonly required: number;
      readonly available: number;
    }
  | { readonly kind: "cancelled" };

export interface DeviceCapacityPressure {
  readonly cpuBusyRatio: number;
  readonly availableMemoryBytes: number;
  readonly processRssBytes: number;
  readonly temporaryBytesAvailable: number;
}

export interface DeviceCapacityDiagnostics {
  readonly occupancyCapacity: DeviceCapacityBudget["occupancy"];
  readonly occupancyInUse: DeviceCapacityBudget["occupancy"];
  readonly quantumAvailable: DeviceCapacityBudget["quantum"];
  readonly devicePressure: Omit<DeviceCapacityPressure, "temporaryBytesAvailable">;
  readonly queued: Partial<Record<DeviceCapacityClass, number>>;
  readonly blockedBy?: DeviceCapacityDimension;
  readonly lastViolation?: {
    readonly admissionId: string;
    readonly dimension: DeviceCapacityDimension;
    readonly limit: number;
    readonly requested: number;
  };
}

export interface DeviceCapacityArbiterPort {
  acquire(
    request: DeviceCapacityRequest,
    abort: AbortSignal,
  ): Promise<DeviceCapacityAdmission>;
  snapshot(): DeviceCapacityDiagnostics;
}

export interface DeviceCapacityPolicy {
  readonly version: 1;
  readonly occupancy: {
    readonly memoryReservationBytes: number;
    readonly temporaryBytes: number;
    readonly slots: number;
    readonly memorySafetyReserveBytes: number;
    readonly temporarySafetyReserveBytes: number;
  };
  readonly quantum: DeviceCapacityBudget["quantum"];
  readonly quantumRefillPerSecond: DeviceCapacityBudget["quantum"];
  readonly pressure: {
    readonly maxCpuBusyRatio: number;
    readonly minimumAvailableMemoryBytes: number;
  };
  readonly retryAfterMs: number;
  readonly classWeights: Readonly<Record<DeviceCapacityClass, number>>;
}

export interface DefaultDeviceCapacityArbiterOptions {
  readonly policy: DeviceCapacityPolicy;
  readonly probe: () => DeviceCapacityPressure;
  readonly now?: () => number;
}

interface MutableDeviceCapacityBudget {
  occupancy: {
    memoryReservationBytes: number;
    temporaryBytes: number;
    slots: number;
  };
  quantum: { readBytes: number; writeBytes: number; ioOperations: number };
}

interface PendingAdmission {
  readonly request: DeviceCapacityRequest;
  readonly abort: AbortSignal;
  readonly resolve: (admission: DeviceCapacityAdmission) => void;
  readonly abortListener: () => void;
  timeout: NodeJS.Timeout | undefined;
  settled: boolean;
}

const OCCUPANCY_DIMENSIONS = [
  "memoryReservationBytes",
  "temporaryBytes",
  "slots",
] as const;
const QUANTUM_DIMENSIONS = [
  "readBytes",
  "writeBytes",
  "ioOperations",
] as const;
const capacityStepContext = new AsyncLocalStorage<DeviceCapacityStepPermit>();

export class DefaultDeviceCapacityArbiter
  implements DeviceCapacityArbiterPort
{
  readonly #policy: DeviceCapacityPolicy;
  readonly #probe: () => DeviceCapacityPressure;
  readonly #now: () => number;
  readonly #queues = new Map<DeviceCapacityClass, PendingAdmission[]>();
  readonly #schedule: DeviceCapacityClass[];
  readonly #occupancyInUse = {
    memoryReservationBytes: 0,
    temporaryBytes: 0,
    slots: 0,
  };
  readonly #quantumAvailable: MutableDeviceCapacityBudget["quantum"];
  #lastRefillAt: number;
  #cursor = 0;
  #drainTimer: NodeJS.Timeout | undefined;
  #blockedBy: DeviceCapacityDimension | undefined;
  #lastViolation: DeviceCapacityDiagnostics["lastViolation"];

  constructor(options: DefaultDeviceCapacityArbiterOptions) {
    validatePolicy(options.policy);
    this.#policy = options.policy;
    this.#probe = options.probe;
    this.#now = options.now ?? Date.now;
    this.#lastRefillAt = this.#now();
    this.#quantumAvailable = { ...options.policy.quantum };
    for (const serviceClass of DEVICE_CAPACITY_CLASSES) {
      this.#queues.set(serviceClass, []);
    }
    this.#schedule = DEVICE_CAPACITY_CLASSES.flatMap((serviceClass) =>
      Array.from(
        { length: options.policy.classWeights[serviceClass] },
        () => serviceClass,
      ),
    );
  }

  acquire(
    request: DeviceCapacityRequest,
    abort: AbortSignal,
  ): Promise<DeviceCapacityAdmission> {
    validateRequest(request);
    if (abort.aborted) return Promise.resolve({ kind: "cancelled" });
    this.#refill();
    const pressure = this.#safePressure();
    const gap = this.#capacityGap(request.atomic);
    if (gap) return Promise.resolve(gap);

    return new Promise<DeviceCapacityAdmission>((resolve) => {
      const pending: PendingAdmission = {
        request: cloneRequest(request),
        abort,
        resolve,
        abortListener: () => this.#settle(pending, { kind: "cancelled" }),
        timeout: undefined,
        settled: false,
      };
      abort.addEventListener("abort", pending.abortListener, { once: true });
      this.#queues.get(request.serviceClass)!.push(pending);
      this.#drain();
      if (pending.settled) return;
      if (request.maxWaitMs === 0) {
        const blockedBy = this.#blockedDimension(request.atomic, pressure);
        this.#settle(pending, {
          kind: "backpressured",
          blockedBy,
          retryAfterMs: this.#policy.retryAfterMs,
        });
        return;
      }
      pending.timeout = setTimeout(() => {
        const currentPressure = this.#safePressure();
        this.#settle(pending, {
          kind: "backpressured",
          blockedBy: this.#blockedDimension(request.atomic, currentPressure),
          retryAfterMs: this.#policy.retryAfterMs,
        });
      }, request.maxWaitMs);
      pending.timeout.unref();
      this.#scheduleDrain();
    });
  }

  snapshot(): DeviceCapacityDiagnostics {
    this.#refill();
    const pressure = this.#safePressure();
    const occupancyCapacity = this.#occupancyCapacity(pressure);
    const queued: Partial<Record<DeviceCapacityClass, number>> = {};
    for (const serviceClass of DEVICE_CAPACITY_CLASSES) {
      const count = this.#queues.get(serviceClass)!.filter(
        ({ settled }) => !settled,
      ).length;
      if (count > 0) queued[serviceClass] = count;
    }
    return {
      occupancyCapacity,
      occupancyInUse: { ...this.#occupancyInUse },
      quantumAvailable: { ...this.#quantumAvailable },
      devicePressure: {
        cpuBusyRatio: pressure.cpuBusyRatio,
        availableMemoryBytes: pressure.availableMemoryBytes,
        processRssBytes: pressure.processRssBytes,
      },
      queued,
      ...(this.#blockedBy ? { blockedBy: this.#blockedBy } : {}),
      ...(this.#lastViolation ? { lastViolation: this.#lastViolation } : {}),
    };
  }

  #drain(): void {
    this.#refill();
    let granted = false;
    do {
      granted = false;
      const pressure = this.#safePressure();
      for (let attempts = 0; attempts < this.#schedule.length; attempts += 1) {
        const index = (this.#cursor + attempts) % this.#schedule.length;
        const serviceClass = this.#schedule[index]!;
        const queue = this.#queues.get(serviceClass)!;
        while (queue[0]?.settled) queue.shift();
        const pending = queue[0];
        if (!pending) continue;
        const admission = this.#tryGrant(pending.request, pressure);
        if (!admission) continue;
        queue.shift();
        this.#cursor = (index + 1) % this.#schedule.length;
        this.#settle(pending, admission);
        granted = true;
        break;
      }
    } while (granted);
    if (this.#hasPending()) this.#scheduleDrain();
  }

  #tryGrant(
    request: DeviceCapacityRequest,
    pressure: DeviceCapacityPressure,
  ): Extract<DeviceCapacityAdmission, { kind: "granted" }> | undefined {
    const blockedBy = this.#blockedDimension(request.atomic, pressure);
    if (!this.#fits(request.atomic, pressure)) {
      this.#blockedBy = blockedBy;
      return undefined;
    }
    const occupancyCapacity = this.#occupancyCapacity(pressure);
    const granted = emptyDeviceCapacityBudget();
    for (const dimension of OCCUPANCY_DIMENSIONS) {
      const available =
        occupancyCapacity[dimension] - this.#occupancyInUse[dimension];
      granted.occupancy[dimension] = Math.min(
        request.preferred.occupancy[dimension],
        available,
      );
      this.#occupancyInUse[dimension] += granted.occupancy[dimension];
    }
    for (const dimension of QUANTUM_DIMENSIONS) {
      granted.quantum[dimension] = Math.min(
        request.preferred.quantum[dimension],
        this.#quantumAvailable[dimension],
      );
      this.#quantumAvailable[dimension] -= granted.quantum[dimension];
    }
    this.#blockedBy = undefined;
    return {
      kind: "granted",
      permit: new CapacityPermit(
        request.admissionId,
        request.atomic,
        granted,
        (unused, violation) => {
          for (const dimension of OCCUPANCY_DIMENSIONS) {
            this.#occupancyInUse[dimension] -= granted.occupancy[dimension];
          }
          for (const dimension of QUANTUM_DIMENSIONS) {
            this.#quantumAvailable[dimension] = Math.min(
              this.#policy.quantum[dimension],
              this.#quantumAvailable[dimension] + unused[dimension],
            );
          }
          if (violation) this.#lastViolation = violation;
          this.#drain();
        },
      ),
    };
  }

  #fits(
    atomic: DeviceCapacityBudget,
    pressure: DeviceCapacityPressure,
  ): boolean {
    if (
      pressure.availableMemoryBytes <
        this.#policy.pressure.minimumAvailableMemoryBytes
    ) {
      return false;
    }
    const capacity = this.#occupancyCapacity(pressure);
    for (const dimension of OCCUPANCY_DIMENSIONS) {
      if (
        capacity[dimension] - this.#occupancyInUse[dimension] <
        atomic.occupancy[dimension]
      ) {
        return false;
      }
    }
    for (const dimension of QUANTUM_DIMENSIONS) {
      if (this.#quantumAvailable[dimension] < atomic.quantum[dimension]) {
        return false;
      }
    }
    return true;
  }

  #capacityGap(atomic: DeviceCapacityBudget):
    | Extract<DeviceCapacityAdmission, { kind: "capacity-gap" }>
    | undefined {
    // capacity-gap 只表示当前策略永远装不下 atomic；实时 CPU、内存与临时空间
    // 压力都是可恢复的 backpressure，不能把一次采样固化成“永远不可能”。
    const capacity = this.#policy.occupancy;
    for (const dimension of OCCUPANCY_DIMENSIONS) {
      const required = atomic.occupancy[dimension];
      const available = capacity[dimension];
      if (required > available) {
        return { kind: "capacity-gap", blockedBy: dimension, required, available };
      }
    }
    for (const dimension of QUANTUM_DIMENSIONS) {
      const required = atomic.quantum[dimension];
      const available = this.#policy.quantum[dimension];
      if (required > available) {
        return { kind: "capacity-gap", blockedBy: dimension, required, available };
      }
    }
    return undefined;
  }

  #blockedDimension(
    atomic: DeviceCapacityBudget,
    pressure: DeviceCapacityPressure,
  ): DeviceCapacityDimension {
    if (
      pressure.availableMemoryBytes <
      this.#policy.pressure.minimumAvailableMemoryBytes
    ) {
      return "memoryReservationBytes";
    }
    const capacity = this.#occupancyCapacity(pressure);
    for (const dimension of OCCUPANCY_DIMENSIONS) {
      if (
        capacity[dimension] - this.#occupancyInUse[dimension] <
        atomic.occupancy[dimension]
      ) {
        return dimension;
      }
    }
    for (const dimension of QUANTUM_DIMENSIONS) {
      if (this.#quantumAvailable[dimension] < atomic.quantum[dimension]) {
        return dimension;
      }
    }
    return "slots";
  }

  #occupancyCapacity(
    pressure: DeviceCapacityPressure,
  ): DeviceCapacityBudget["occupancy"] {
    return {
      memoryReservationBytes: Math.max(
        0,
        Math.min(
          this.#policy.occupancy.memoryReservationBytes,
          pressure.availableMemoryBytes -
            this.#policy.occupancy.memorySafetyReserveBytes,
        ),
      ),
      temporaryBytes: Math.max(
        0,
        Math.min(
          this.#policy.occupancy.temporaryBytes,
          pressure.temporaryBytesAvailable -
            this.#policy.occupancy.temporarySafetyReserveBytes,
        ),
      ),
      // CPU 是设备级压力诊断，不是可归因到某个任务的容量扣账。并发上界已经
      // 由版本化 slots 策略、七类公平队列与有界步骤共同治理；用一次进程级
      // CPU 采样把 slots 突然压低，会让已获 permit 占用超过新上界，继而把全部
      // committed 维护错误地拒成 backpressured，正是规范禁止的采样冒充用量。
      slots: this.#policy.occupancy.slots,
    };
  }

  #safePressure(): DeviceCapacityPressure {
    try {
      const pressure = this.#probe();
      validatePressure(pressure);
      return pressure;
    } catch {
      return {
        cpuBusyRatio: 1,
        availableMemoryBytes: 0,
        processRssBytes: 0,
        temporaryBytesAvailable: 0,
      };
    }
  }

  #refill(): void {
    const now = this.#now();
    const elapsedMs = Math.max(0, now - this.#lastRefillAt);
    if (elapsedMs === 0) return;
    this.#lastRefillAt = now;
    for (const dimension of QUANTUM_DIMENSIONS) {
      const refill = Math.floor(
        (this.#policy.quantumRefillPerSecond[dimension] * elapsedMs) / 1_000,
      );
      this.#quantumAvailable[dimension] = Math.min(
        this.#policy.quantum[dimension],
        this.#quantumAvailable[dimension] + refill,
      );
    }
  }

  #settle(pending: PendingAdmission, admission: DeviceCapacityAdmission): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.abort.removeEventListener("abort", pending.abortListener);
    pending.resolve(admission);
  }

  #hasPending(): boolean {
    return [...this.#queues.values()].some((queue) =>
      queue.some(({ settled }) => !settled),
    );
  }

  #scheduleDrain(): void {
    if (this.#drainTimer) return;
    this.#drainTimer = setTimeout(() => {
      this.#drainTimer = undefined;
      this.#drain();
    }, this.#policy.retryAfterMs);
    this.#drainTimer.unref();
  }
}

class CapacityPermit implements DeviceCapacityPermit {
  readonly granted: DeviceCapacityBudget;
  readonly #atomic: DeviceCapacityBudget;
  readonly #remainingQuantum: MutableDeviceCapacityBudget["quantum"];
  #activeStep = false;
  #released = false;
  #violation: DeviceCapacityDiagnostics["lastViolation"];

  constructor(
    private readonly admissionId: string,
    atomic: DeviceCapacityBudget,
    granted: DeviceCapacityBudget,
    private readonly onRelease: (
      unused: DeviceCapacityBudget["quantum"],
      violation?: DeviceCapacityDiagnostics["lastViolation"],
    ) => void,
  ) {
    this.#atomic = cloneBudget(atomic);
    this.granted = cloneBudget(granted);
    this.#remainingQuantum = { ...granted.quantum };
  }

  tryBegin(stepBound: DeviceCapacityBudget): DeviceCapacityStepPermit | undefined {
    validateBudget(stepBound, "Device capacity step");
    if (this.#released || this.#violation) return undefined;
    if (this.#activeStep) {
      this.#recordViolation("slots", 1, 2);
      return undefined;
    }
    for (const dimension of OCCUPANCY_DIMENSIONS) {
      const requested = stepBound.occupancy[dimension];
      const limit = this.#atomic.occupancy[dimension];
      if (requested > limit) {
        this.#recordViolation(dimension, limit, requested);
        return undefined;
      }
    }
    for (const dimension of QUANTUM_DIMENSIONS) {
      const requested = stepBound.quantum[dimension];
      const atomicLimit = this.#atomic.quantum[dimension];
      if (requested > atomicLimit) {
        this.#recordViolation(dimension, atomicLimit, requested);
        return undefined;
      }
      const remaining = this.#remainingQuantum[dimension];
      if (requested > remaining) {
        this.#recordViolation(dimension, remaining, requested);
        return undefined;
      }
    }
    for (const dimension of QUANTUM_DIMENSIONS) {
      this.#remainingQuantum[dimension] -= stepBound.quantum[dimension];
    }
    this.#activeStep = true;
    let completed = false;
    const used = emptyDeviceCapacityBudget();
    return {
      claim: (dimension, amount) => {
        assertNonNegativeSafeInteger(amount, `Device capacity ${dimension} claim`);
        if (completed || this.#released || this.#violation) {
          throw new DeviceCapacityStepError(
            "Device capacity step is no longer usable",
          );
        }
        const requested = isOccupancyDimension(dimension)
          ? used.occupancy[dimension] + amount
          : used.quantum[dimension] + amount;
        const limit = isOccupancyDimension(dimension)
          ? stepBound.occupancy[dimension]
          : stepBound.quantum[dimension];
        if (requested > limit) {
          this.#recordViolation(dimension, limit, requested);
          throw new DeviceCapacityStepError(
            `Device capacity step exceeded ${dimension}`,
          );
        }
        if (isOccupancyDimension(dimension)) {
          used.occupancy[dimension] = requested;
        } else {
          used.quantum[dimension] = requested;
        }
      },
      complete: () => {
        if (completed) return;
        completed = true;
        if (!this.#violation) {
          for (const dimension of QUANTUM_DIMENSIONS) {
            this.#remainingQuantum[dimension] +=
              stepBound.quantum[dimension] - used.quantum[dimension];
          }
        }
        this.#activeStep = false;
      },
    };
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    if (this.#activeStep && !this.#violation) {
      this.#recordViolation("slots", 1, 2);
    }
    this.#activeStep = false;
    this.onRelease({ ...this.#remainingQuantum }, this.#violation);
  }

  #recordViolation(
    dimension: DeviceCapacityDimension,
    limit: number,
    requested: number,
  ): void {
    this.#violation ??= {
      admissionId: this.admissionId,
      dimension,
      limit,
      requested,
    };
  }
}

export function emptyDeviceCapacityBudget(): MutableDeviceCapacityBudget {
  return {
    occupancy: { memoryReservationBytes: 0, temporaryBytes: 0, slots: 0 },
    quantum: { readBytes: 0, writeBytes: 0, ioOperations: 0 },
  };
}

export function deviceCapacityAdmissionId(prefix: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(prefix)) {
    throw new TypeError("Device capacity admission prefix is invalid");
  }
  return `${prefix}:${randomUUID()}`;
}

export async function withDeviceCapacityStep<T>(
  permit: DeviceCapacityPermit,
  stepBound: DeviceCapacityBudget,
  operation: () => Promise<T>,
): Promise<T> {
  const step = permit.tryBegin(stepBound);
  if (!step) {
    throw new DeviceCapacityStepError(
      "Device capacity permit cannot cover the next atomic step",
    );
  }
  try {
    return await capacityStepContext.run(step, operation);
  } finally {
    step.complete();
  }
}

export function claimDeviceCapacity(
  dimension: DeviceCapacityDimension,
  amount: number,
): void {
  capacityStepContext.getStore()?.claim(dimension, amount);
}

export class DeviceCapacityStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceCapacityStepError";
  }
}

export interface DeviceWorkloadCapacityRequest {
  readonly serviceClass: Extract<DeviceCapacityClass, `workload-${string}`>;
  readonly atomic: DeviceCapacityBudget;
  readonly preferred: DeviceCapacityBudget;
  readonly maxWaitMs: number;
}

export async function runWithDeviceCapacity<T>(
  arbiter: DeviceCapacityArbiterPort,
  request: DeviceWorkloadCapacityRequest,
  abort: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  const admission = await arbiter.acquire(
    {
      admissionId: deviceCapacityAdmissionId(request.serviceClass),
      serviceClass: request.serviceClass,
      atomic: request.atomic,
      preferred: request.preferred,
      maxWaitMs: request.maxWaitMs,
    },
    abort,
  );
  if (admission.kind !== "granted") {
    throw new DeviceCapacityAdmissionError(admission);
  }
  try {
    return await withDeviceCapacityStep(
      admission.permit,
      request.atomic,
      operation,
    );
  } finally {
    admission.permit.release();
  }
}

export class DeviceCapacityAdmissionError extends Error {
  constructor(
    readonly admission: Exclude<DeviceCapacityAdmission, { kind: "granted" }>,
  ) {
    super(`Device workload was not admitted: ${admission.kind}`);
    this.name = "DeviceCapacityAdmissionError";
  }
}

export function createDefaultDeviceCapacityPolicy(): DeviceCapacityPolicy {
  const cpuCount = Math.max(1, cpus().length);
  const memoryCapacity = Math.max(
    64 * 1024 * 1024,
    Math.min(512 * 1024 * 1024, Math.floor(totalmem() / 4)),
  );
  return {
    version: 1,
    occupancy: {
      memoryReservationBytes: memoryCapacity,
      temporaryBytes: 4 * 1024 * 1024 * 1024,
      slots: Math.max(2, cpuCount),
      memorySafetyReserveBytes: Math.min(
        256 * 1024 * 1024,
        Math.floor(totalmem() / 8),
      ),
      temporarySafetyReserveBytes: 512 * 1024 * 1024,
    },
    quantum: {
      readBytes: 256 * 1024 * 1024,
      writeBytes: 256 * 1024 * 1024,
      ioOperations: 16_384,
    },
    quantumRefillPerSecond: {
      readBytes: 64 * 1024 * 1024,
      writeBytes: 64 * 1024 * 1024,
      ioOperations: 4_096,
    },
    pressure: {
      maxCpuBusyRatio: 0.95,
      minimumAvailableMemoryBytes: Math.min(
        128 * 1024 * 1024,
        Math.floor(totalmem() / 16),
      ),
    },
    retryAfterMs: 25,
    classWeights: {
      "workload-interactive": 8,
      "workload-advancement": 4,
      "workload-scheduler": 2,
      "workload-orchestration": 3,
      "storage-foreground": 6,
      "storage-recovery": 3,
      "storage-background": 1,
    },
  };
}

export function createNodeDeviceCapacityProbe(
  temporaryRoot: string,
  options: {
    readonly now?: () => number;
    readonly readCpuTimes?: () => { readonly total: number; readonly idle: number };
  } = {},
): () => DeviceCapacityPressure {
  const now = options.now ?? performance.now.bind(performance);
  const readCpuTimes = options.readCpuTimes ?? cpuTimes;
  let previousCpu = readCpuTimes();
  let sampleStartedAt = now();
  let cpuBusyRatio = 0;
  return () => {
    const sampledAt = now();
    if (sampledAt - sampleStartedAt >= 250) {
      const currentCpu = readCpuTimes();
      const totalDelta = currentCpu.total - previousCpu.total;
      if (totalDelta > 0) {
        const idleDelta = Math.max(0, currentCpu.idle - previousCpu.idle);
        cpuBusyRatio = Math.min(1, Math.max(0, 1 - idleDelta / totalDelta));
      }
      previousCpu = currentCpu;
      sampleStartedAt = sampledAt;
    }
    const filesystem = statfsSync(temporaryRoot);
    const temporaryBytesAvailable = toSafeInteger(
      Number(filesystem.bavail) * Number(filesystem.bsize),
    );
    return {
      cpuBusyRatio,
      availableMemoryBytes: toSafeInteger(freemem()),
      processRssBytes: toSafeInteger(process.memoryUsage().rss),
      temporaryBytesAvailable,
    };
  };
}

function validatePolicy(policy: DeviceCapacityPolicy): void {
  if (policy.version !== 1) {
    throw new TypeError("Device capacity policy version is unsupported");
  }
  validateBudget(
    {
      occupancy: {
        memoryReservationBytes: policy.occupancy.memoryReservationBytes,
        temporaryBytes: policy.occupancy.temporaryBytes,
        slots: policy.occupancy.slots,
      },
      quantum: policy.quantum,
    },
    "Device capacity policy",
  );
  validateBudget(
    {
      occupancy: {
        memoryReservationBytes: policy.occupancy.memorySafetyReserveBytes,
        temporaryBytes: policy.occupancy.temporarySafetyReserveBytes,
        slots: 0,
      },
      quantum: policy.quantumRefillPerSecond,
    },
    "Device capacity refill policy",
  );
  if (
    !Number.isFinite(policy.pressure.maxCpuBusyRatio) ||
    policy.pressure.maxCpuBusyRatio < 0 ||
    policy.pressure.maxCpuBusyRatio > 1
  ) {
    throw new TypeError("Device CPU pressure threshold is invalid");
  }
  assertNonNegativeSafeInteger(
    policy.pressure.minimumAvailableMemoryBytes,
    "Device memory pressure threshold",
  );
  assertNonNegativeSafeInteger(policy.retryAfterMs, "Device capacity retry delay");
  for (const serviceClass of DEVICE_CAPACITY_CLASSES) {
    const weight = policy.classWeights[serviceClass];
    if (!Number.isSafeInteger(weight) || weight <= 0 || weight > 1_024) {
      throw new TypeError(`Device capacity class weight is invalid: ${serviceClass}`);
    }
  }
}

function validateRequest(request: DeviceCapacityRequest): void {
  if (!request.admissionId || request.admissionId.length > 256) {
    throw new TypeError("Device capacity admission id is invalid");
  }
  if (!DEVICE_CAPACITY_CLASSES.includes(request.serviceClass)) {
    throw new TypeError("Device capacity service class is invalid");
  }
  validateBudget(request.atomic, "Device capacity atomic budget");
  validateBudget(request.preferred, "Device capacity preferred budget");
  assertNonNegativeSafeInteger(request.maxWaitMs, "Device capacity wait limit");
  for (const dimension of OCCUPANCY_DIMENSIONS) {
    if (request.atomic.occupancy[dimension] > request.preferred.occupancy[dimension]) {
      throw new TypeError(`Device capacity atomic ${dimension} exceeds preferred`);
    }
  }
  for (const dimension of QUANTUM_DIMENSIONS) {
    if (request.atomic.quantum[dimension] > request.preferred.quantum[dimension]) {
      throw new TypeError(`Device capacity atomic ${dimension} exceeds preferred`);
    }
  }
  if (request.atomic.occupancy.slots < 1) {
    throw new TypeError("Device capacity atomic budget must reserve a slot");
  }
}

function validateBudget(budget: DeviceCapacityBudget, label: string): void {
  for (const dimension of OCCUPANCY_DIMENSIONS) {
    assertNonNegativeSafeInteger(
      budget.occupancy[dimension],
      `${label} ${dimension}`,
    );
  }
  for (const dimension of QUANTUM_DIMENSIONS) {
    assertNonNegativeSafeInteger(budget.quantum[dimension], `${label} ${dimension}`);
  }
}

function validatePressure(pressure: DeviceCapacityPressure): void {
  if (
    !Number.isFinite(pressure.cpuBusyRatio) ||
    pressure.cpuBusyRatio < 0 ||
    pressure.cpuBusyRatio > 1
  ) {
    throw new TypeError("Device CPU pressure sample is invalid");
  }
  assertNonNegativeSafeInteger(
    pressure.availableMemoryBytes,
    "Device available memory sample",
  );
  assertNonNegativeSafeInteger(pressure.processRssBytes, "Device RSS sample");
  assertNonNegativeSafeInteger(
    pressure.temporaryBytesAvailable,
    "Device temporary-space sample",
  );
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function isOccupancyDimension(
  dimension: DeviceCapacityDimension,
): dimension is (typeof OCCUPANCY_DIMENSIONS)[number] {
  return (OCCUPANCY_DIMENSIONS as readonly string[]).includes(dimension);
}

function cpuTimes(): { total: number; idle: number } {
  let total = 0;
  let idle = 0;
  for (const cpu of cpus()) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }
  return { total, idle };
}

function toSafeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function cloneRequest(request: DeviceCapacityRequest): DeviceCapacityRequest {
  return {
    ...request,
    atomic: cloneBudget(request.atomic),
    preferred: cloneBudget(request.preferred),
  };
}

function cloneBudget(budget: DeviceCapacityBudget): DeviceCapacityBudget {
  return {
    occupancy: { ...budget.occupancy },
    quantum: { ...budget.quantum },
  };
}
