import { describe, expect, it, vi } from "vitest";
import {
  DefaultDeviceCapacityArbiter,
  type DeviceCapacityBudget,
  type DeviceCapacityPolicy,
} from "../device-capacity.js";
import {
  DefaultStorageMaintenanceGovernor,
  StorageMaintenanceConflictError,
  StorageMaintenanceTaskRunner,
  storageMaintenanceWorkKey,
  type StorageMaintenanceRequest,
} from "../storage-maintenance.js";

function budget(): DeviceCapacityBudget {
  return {
    occupancy: {
      memoryReservationBytes: 1,
      temporaryBytes: 0,
      slots: 1,
    },
    quantum: { readBytes: 1, writeBytes: 1, ioOperations: 1 },
  };
}

function governor() {
  const classWeights = {
    "workload-interactive": 1,
    "workload-advancement": 1,
    "workload-scheduler": 1,
    "workload-orchestration": 1,
    "storage-foreground": 1,
    "storage-recovery": 1,
    "storage-background": 1,
  } satisfies DeviceCapacityPolicy["classWeights"];
  return new DefaultStorageMaintenanceGovernor({
    capacity: new DefaultDeviceCapacityArbiter({
      policy: {
        version: 1,
        occupancy: {
          memoryReservationBytes: 8,
          temporaryBytes: 8,
          slots: 2,
          memorySafetyReserveBytes: 0,
          temporarySafetyReserveBytes: 0,
        },
        quantum: { readBytes: 8, writeBytes: 8, ioOperations: 8 },
        quantumRefillPerSecond: {
          readBytes: 8,
          writeBytes: 8,
          ioOperations: 8,
        },
        pressure: {
          maxCpuBusyRatio: 1,
          minimumAvailableMemoryBytes: 0,
        },
        retryAfterMs: 1,
        classWeights,
      },
      probe: () => ({
        cpuBusyRatio: 0,
        availableMemoryBytes: 8,
        processRssBytes: 0,
        temporaryBytesAvailable: 8,
      }),
    }),
  });
}

function request(
  inputIdentity: string,
  obligation: StorageMaintenanceRequest["obligation"] = "pre-commit",
): StorageMaintenanceRequest {
  return {
    workKey: storageMaintenanceWorkKey(
      "projection-rebuild",
      "projection:test",
      inputIdentity,
    ),
    kind: "projection-rebuild",
    urgency: "recovery",
    obligation,
    atomic: budget(),
    preferred: budget(),
    maxWaitMs: 100,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("StorageMaintenanceTaskRunner", () => {
  it("joins identical work and executes the operation once", async () => {
    const runner = new StorageMaintenanceTaskRunner(governor());
    const gate = deferred<void>();
    const operation = vi.fn(async () => {
      await gate.promise;
      return "done";
    });
    const req = request("checkpoint-1");
    const first = runner.run(req, new AbortController().signal, operation);
    const second = runner.run(req, new AbortController().signal, operation);
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "done",
      "done",
    ]);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("rejects a reused key only when the resource shape is incompatible", async () => {
    const runner = new StorageMaintenanceTaskRunner(governor());
    const gate = deferred<void>();
    const req = request("checkpoint-1");
    const first = runner.run(
      req,
      new AbortController().signal,
      async () => gate.promise,
    );
    // 形状不同意味着已授予的额度不能互换,这才是真冲突。
    const conflicting: StorageMaintenanceRequest = {
      ...req,
      atomic: {
        occupancy: { ...req.atomic.occupancy, slots: 2 },
        quantum: { ...req.atomic.quantum },
      },
    };
    await expect(
      runner.run(conflicting, new AbortController().signal, async () => {}),
    ).rejects.toBeInstanceOf(StorageMaintenanceConflictError);
    gate.resolve();
    await first;
  });

  it("merges a same-key request that only differs in scheduling attributes", async () => {
    const runner = new StorageMaintenanceTaskRunner(governor());
    const gate = deferred<void>();
    const operation = vi.fn(async () => {
      await gate.promise;
      return "done";
    });
    const req = request("checkpoint-escalate");
    const background = runner.run(
      req,
      new AbortController().signal,
      operation,
    );
    // 同一份工作被前台等待时不该被判成异载荷冲突:做的是同一件事,
    // 只是现在有人在等它。
    const foreground = runner.run(
      { ...req, urgency: "foreground", maxWaitMs: 0 },
      new AbortController().signal,
      operation,
    );
    gate.resolve();
    await expect(Promise.all([background, foreground])).resolves.toEqual([
      "done",
      "done",
    ]);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not let an already-cancelled waiter cancel another waiter", async () => {
    const runner = new StorageMaintenanceTaskRunner(governor());
    const gate = deferred<void>();
    const operation = vi.fn(async (_permit, sharedAbort: AbortSignal) => {
      await gate.promise;
      expect(sharedAbort.aborted).toBe(false);
      return "done";
    });
    const req = request("checkpoint-2");
    const live = runner.run(req, new AbortController().signal, operation);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      runner.run(req, cancelled.signal, operation),
    ).rejects.toThrow("cancelled");
    gate.resolve();
    await expect(live).resolves.toBe("done");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("keeps a committed task alive after its last waiter leaves", async () => {
    const runner = new StorageMaintenanceTaskRunner(governor());
    const gate = deferred<void>();
    const waiter = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    const operation = vi.fn(async (_permit, signal: AbortSignal) => {
      sharedSignal = signal;
      await gate.promise;
      return "done";
    });
    const pending = runner.run(
      request("checkpoint-3", "committed"),
      waiter.signal,
      operation,
    );
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    waiter.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(sharedSignal?.aborted).toBe(false);
    gate.resolve();
  });

  it("stops a pre-commit task once its last waiter leaves", async () => {
    // committed 的对偶:pre-commit 只服务那个候选,候选取消后续做没有意义,
    // 还会白占容量。删掉这条分支不会让上一条失败,所以必须单独钉住。
    const runner = new StorageMaintenanceTaskRunner(governor());
    const gate = deferred<void>();
    const waiter = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    const operation = vi.fn(async (_permit, signal: AbortSignal) => {
      sharedSignal = signal;
      await gate.promise;
      return "done";
    });
    const pending = runner.run(
      request("checkpoint-4", "pre-commit"),
      waiter.signal,
      operation,
    );
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    waiter.abort();
    await expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(sharedSignal?.aborted).toBe(true));
    gate.resolve();
  });

  it("reports queued, in-flight and last-error diagnostics", async () => {
    // "诊断可核对"要有可执行证据:字段算错时没有消费者会替我们发现。
    const port = governor();
    const runner = new StorageMaintenanceTaskRunner(port);
    const gate = deferred<void>();
    const running = runner.run(
      request("diagnostics-1", "committed"),
      new AbortController().signal,
      async () => {
        await gate.promise;
        throw new Error("operation failed");
      },
    );
    await vi.waitFor(() =>
      expect(port.snapshot().inFlight["projection-rebuild"]).toBe(1)
    );
    const busy = port.snapshot();
    expect(busy.queued).toEqual({});
    expect(busy.oldestWaitMs ?? 0).toBeGreaterThanOrEqual(0);
    expect(busy.lastError).toBeUndefined();

    gate.resolve();
    await expect(running).rejects.toThrow("operation failed");
    await vi.waitFor(() =>
      expect(port.snapshot().inFlight["projection-rebuild"] ?? 0).toBe(0)
    );
    // 失败必须留痕:kind 与错误码都要落到 lastError 上。
    expect(port.snapshot().lastError?.kind).toBe("projection-rebuild");
    expect(port.snapshot().lastError?.code).toBeDefined();
  });
});
