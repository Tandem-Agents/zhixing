import { describe, expect, it, vi } from "vitest";
import {
  DefaultDeviceCapacityArbiter,
  type DeviceCapacityBudget,
  type DeviceCapacityPolicy,
} from "../device-capacity.js";
import { currentMaintenanceUrgency } from "../maintenance-context.js";
import {
  DefaultStorageMaintenanceGovernor,
  runStorageMaintenanceStep,
  StorageMaintenanceAdmissionError,
  StorageMaintenanceConflictError,
  STORAGE_MAINTENANCE_KINDS,
  STORAGE_MAINTENANCE_TASK_OWNERS,
  StorageMaintenanceTaskRunner,
  storageMaintenanceWorkKey,
  type StorageMaintenanceGovernorPort,
  type StorageMaintenanceObligationRequest,
  type StorageMaintenanceRequest,
  type StorageMaintenanceUrgency,
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

function obligation(
  inputIdentity: string,
  options: {
    urgency?: StorageMaintenanceUrgency;
    obligation?: StorageMaintenanceObligationRequest["obligation"];
  } = {},
): StorageMaintenanceObligationRequest {
  return {
    workKey: storageMaintenanceWorkKey(
      "projection-rebuild",
      "projection:test",
      inputIdentity,
    ),
    kind: "projection-rebuild",
    owner: "durable-projection-index",
    urgency: options.urgency ?? "background",
    obligation: options.obligation ?? "committed",
  };
}

function stepRequest(
  inputIdentity: string,
  obligation: StorageMaintenanceRequest["obligation"] = "committed",
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

describe("StorageMaintenanceTaskRunner obligations", () => {
  it("declares exactly one owner for every maintenance kind", () => {
    expect(Object.keys(STORAGE_MAINTENANCE_TASK_OWNERS).sort()).toEqual(
      [...STORAGE_MAINTENANCE_KINDS].sort(),
    );
    expect(
      new Set(Object.values(STORAGE_MAINTENANCE_TASK_OWNERS)),
    ).toEqual(
      new Set([
        "authority-commit-log",
        "durable-projection-index",
        "artifact-lifecycle-index",
        "anchor-asset-maintainer",
        "anchor-workscene-owner",
        "authority-checkpoint-owner",
        "conversation-transfer-owner",
        "device-lifecycle-owner",
        "executor-data-plane",
        "local-workspace-management-host",
        "managed-service-owner",
        "workspace-binding-migrator",
        "workspace-binding-recovery-owner",
        "workspace-probe-owner",
      ]),
    );
  });

  it("joins identical work and executes the operation once", async () => {
    const runner = new StorageMaintenanceTaskRunner(governor());
    const gate = deferred<void>();
    const operation = vi.fn(async () => {
      await gate.promise;
      return "done";
    });
    const req = obligation("checkpoint-1");
    const first = runner.run(req, new AbortController().signal, operation);
    const second = runner.run(req, new AbortController().signal, operation);
    gate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "done",
      "done",
    ]);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("holds no device capacity permit for the obligation itself", async () => {
    // 义务层只协调、不持容量:一旦义务层重新引入准入,整段义务又会横跨
    // 锁等待与全部步骤——这条用例就是那个回退的探针。
    const port = governor();
    const acquire = vi.spyOn(port, "acquire");
    const runner = new StorageMaintenanceTaskRunner(port);
    const gate = deferred<void>();
    const running = runner.run(
      obligation("no-permit"),
      new AbortController().signal,
      async () => {
        await gate.promise;
        return "done";
      },
    );
    await vi.waitFor(() => expect(acquire).not.toHaveBeenCalled());
    gate.resolve();
    await expect(running).resolves.toBe("done");
    expect(acquire).not.toHaveBeenCalled();
  });

  it("escalates the effective urgency of a coalesced obligation mid-flight", async () => {
    // 后台触发的义务被前台等待时,后续叶步骤必须按前台准入,而不是陪后台
    // 排完整个义务。提级生效的证据 = 义务体内实时读到的紧急度发生变化。
    const runner = new StorageMaintenanceTaskRunner(governor());
    const gate = deferred<void>();
    const seen: StorageMaintenanceUrgency[] = [];
    const background = runner.run(
      obligation("escalate-mid", { urgency: "background" }),
      new AbortController().signal,
      async () => {
        seen.push(currentMaintenanceUrgency());
        await gate.promise;
        seen.push(currentMaintenanceUrgency());
        return "done";
      },
    );
    await vi.waitFor(() => expect(seen).toEqual(["background"]));
    const foreground = runner.run(
      obligation("escalate-mid", { urgency: "foreground" }),
      new AbortController().signal,
      async () => "unused",
    );
    gate.resolve();
    await expect(Promise.all([background, foreground])).resolves.toEqual([
      "done",
      "done",
    ]);
    expect(seen).toEqual(["background", "foreground"]);
  });

  it("merges urgency and obligation independently without downgrading either", async () => {
    const runner = new StorageMaintenanceTaskRunner(governor());
    const promoted = deferred<void>();
    const demoted = deferred<void>();
    const finish = deferred<void>();
    const backgroundWaiter = new AbortController();
    const foregroundWaiter = new AbortController();
    const seen: StorageMaintenanceUrgency[] = [];
    let sharedAbort: AbortSignal | undefined;
    const operation = vi.fn(async (abort: AbortSignal) => {
      sharedAbort = abort;
      seen.push(currentMaintenanceUrgency());
      await promoted.promise;
      seen.push(currentMaintenanceUrgency());
      await demoted.promise;
      seen.push(currentMaintenanceUrgency());
      await finish.promise;
      return "done";
    });

    const committed = runner.run(
      obligation("merge-components", {
        urgency: "background",
        obligation: "committed",
      }),
      backgroundWaiter.signal,
      operation,
    );
    await vi.waitFor(() => expect(seen).toEqual(["background"]));
    const foreground = runner.run(
      obligation("merge-components", {
        urgency: "foreground",
        obligation: "pre-commit",
      }),
      foregroundWaiter.signal,
      operation,
    );
    promoted.resolve();
    await vi.waitFor(() =>
      expect(seen).toEqual(["background", "foreground"])
    );

    foregroundWaiter.abort();
    await expect(foreground).rejects.toThrow("cancelled");
    demoted.resolve();
    await vi.waitFor(() =>
      expect(seen).toEqual(["background", "foreground", "background"])
    );
    backgroundWaiter.abort();
    await expect(committed).rejects.toThrow("cancelled");
    expect(sharedAbort?.aborted).toBe(false);
    const observer = runner.run(
      obligation("merge-components", {
        urgency: "background",
        obligation: "committed",
      }),
      new AbortController().signal,
      operation,
    );
    finish.resolve();
    await expect(observer).resolves.toBe("done");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("keeps foreground urgency when a committed background waiter joins", async () => {
    const runner = new StorageMaintenanceTaskRunner(governor());
    const sample = deferred<void>();
    const finish = deferred<void>();
    const foregroundWaiter = new AbortController();
    const backgroundWaiter = new AbortController();
    const seen: StorageMaintenanceUrgency[] = [];
    let sharedAbort: AbortSignal | undefined;
    const operation = vi.fn(async (abort: AbortSignal) => {
      sharedAbort = abort;
      seen.push(currentMaintenanceUrgency());
      await sample.promise;
      seen.push(currentMaintenanceUrgency());
      await finish.promise;
      return "done";
    });

    const foreground = runner.run(
      obligation("merge-reverse", {
        urgency: "foreground",
        obligation: "pre-commit",
      }),
      foregroundWaiter.signal,
      operation,
    );
    await vi.waitFor(() => expect(seen).toEqual(["foreground"]));
    const committed = runner.run(
      obligation("merge-reverse", {
        urgency: "background",
        obligation: "committed",
      }),
      backgroundWaiter.signal,
      operation,
    );
    sample.resolve();
    await vi.waitFor(() =>
      expect(seen).toEqual(["foreground", "foreground"])
    );

    foregroundWaiter.abort();
    backgroundWaiter.abort();
    await expect(foreground).rejects.toThrow("cancelled");
    await expect(committed).rejects.toThrow("cancelled");
    expect(sharedAbort?.aborted).toBe(false);
    const observer = runner.run(
      obligation("merge-reverse", {
        urgency: "background",
        obligation: "committed",
      }),
      new AbortController().signal,
      operation,
    );
    finish.resolve();
    await expect(observer).resolves.toBe("done");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("waits for a cancelled pre-commit execution before redriving the same key", async () => {
    const runner = new StorageMaintenanceTaskRunner(governor());
    const cleanup = deferred<void>();
    const firstWaiter = new AbortController();
    const firstOperation = vi.fn(async (abort: AbortSignal) => {
      if (!abort.aborted) {
        await new Promise<void>((resolve) =>
          abort.addEventListener("abort", () => resolve(), { once: true })
        );
      }
      await cleanup.promise;
      throw new Error("cancelled execution settled");
    });
    const first = runner.run(
      obligation("cancelled-redrive", { obligation: "pre-commit" }),
      firstWaiter.signal,
      firstOperation,
    );
    await vi.waitFor(() => expect(firstOperation).toHaveBeenCalledTimes(1));
    firstWaiter.abort();
    await expect(first).rejects.toThrow("cancelled");

    const successorOperation = vi.fn(async () => "done");
    const successor = runner.run(
      obligation("cancelled-redrive", { obligation: "committed" }),
      new AbortController().signal,
      successorOperation,
    );
    expect(successorOperation).not.toHaveBeenCalled();
    cleanup.resolve();
    await expect(successor).resolves.toBe("done");
    expect(firstOperation).toHaveBeenCalledTimes(1);
    expect(successorOperation).toHaveBeenCalledTimes(1);
  });

  it("rejects a reused key when the kind differs", async () => {
    // 防御栏:规范 workKey 已摘要类别,同键异类在构造上不该发生;一旦发生,
    // 合流会把两份不同工作当成一份,必须拒绝而不是择一。
    const runner = new StorageMaintenanceTaskRunner(governor());
    const gate = deferred<void>();
    const req = obligation("conflict-1");
    const first = runner.run(req, new AbortController().signal, async () => {
      await gate.promise;
    });
    await expect(
      runner.run(
        { ...req, kind: "asset-gc", owner: "anchor-asset-maintainer" },
        new AbortController().signal,
        async () => {},
      ),
    ).rejects.toBeInstanceOf(StorageMaintenanceConflictError);
    gate.resolve();
    await first;
  });

  it("does not let an already-cancelled waiter cancel another waiter", async () => {
    const runner = new StorageMaintenanceTaskRunner(governor());
    const gate = deferred<void>();
    const operation = vi.fn(async (sharedAbort: AbortSignal) => {
      await gate.promise;
      expect(sharedAbort.aborted).toBe(false);
      return "done";
    });
    const req = obligation("checkpoint-2");
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

  it("does not start a new obligation for an already-cancelled waiter", async () => {
    const runner = new StorageMaintenanceTaskRunner(governor());
    const cancelled = new AbortController();
    const operation = vi.fn(async () => "unreachable");
    cancelled.abort();

    await expect(
      runner.run(
        obligation("cancelled-before-start"),
        cancelled.signal,
        operation,
      ),
    ).rejects.toThrow("cancelled");
    expect(operation).not.toHaveBeenCalled();
  });

  it("keeps a committed task alive after its last waiter leaves", async () => {
    const runner = new StorageMaintenanceTaskRunner(governor());
    const gate = deferred<void>();
    const waiter = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    const operation = vi.fn(async (signal: AbortSignal) => {
      sharedSignal = signal;
      await gate.promise;
      return "done";
    });
    const pending = runner.run(
      obligation("checkpoint-3", { obligation: "committed" }),
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
    // committed 的对偶:pre-commit 只服务那个候选,候选取消后续做没有意义。
    // 删掉这条分支不会让上一条失败,所以必须单独钉住。
    const runner = new StorageMaintenanceTaskRunner(governor());
    const gate = deferred<void>();
    const waiter = new AbortController();
    let sharedSignal: AbortSignal | undefined;
    const operation = vi.fn(async (signal: AbortSignal) => {
      sharedSignal = signal;
      await gate.promise;
      return "done";
    });
    const pending = runner.run(
      obligation("checkpoint-4", { obligation: "pre-commit" }),
      waiter.signal,
      operation,
    );
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    waiter.abort();
    await expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(sharedSignal?.aborted).toBe(true));
    gate.resolve();
  });

  it("propagates the shared pre-commit cancellation into capacity waiting", async () => {
    let capacityAbort: AbortSignal | undefined;
    const port: StorageMaintenanceGovernorPort = {
      acquire: async (_request, abort) => {
        capacityAbort = abort;
        if (!abort.aborted) {
          await new Promise<void>((resolve) =>
            abort.addEventListener("abort", () => resolve(), { once: true })
          );
        }
        return { kind: "cancelled" };
      },
      snapshot: () => governor().snapshot(),
    };
    const runner = new StorageMaintenanceTaskRunner(port);
    const waiter = new AbortController();
    const operation = vi.fn(async () => "unreachable");
    const pending = runner.run(
      obligation("capacity-cancel", { obligation: "pre-commit" }),
      waiter.signal,
      () =>
        runStorageMaintenanceStep(
          port,
          stepRequest("capacity-cancel", "pre-commit"),
          operation,
        ),
    );
    await vi.waitFor(() => expect(capacityAbort).toBeDefined());
    waiter.abort();
    await expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(capacityAbort?.aborted).toBe(true));
    expect(operation).not.toHaveBeenCalled();
  });

  it("lets process stop cancel a committed task waiting for capacity", async () => {
    let capacityAbort: AbortSignal | undefined;
    const port: StorageMaintenanceGovernorPort = {
      acquire: async (_request, abort) => {
        capacityAbort = abort;
        if (!abort.aborted) {
          await new Promise<void>((resolve) =>
            abort.addEventListener("abort", () => resolve(), { once: true })
          );
        }
        return { kind: "cancelled" };
      },
      snapshot: () => governor().snapshot(),
    };
    const runner = new StorageMaintenanceTaskRunner(port);
    const pending = runner.run(
      obligation("stop-capacity"),
      new AbortController().signal,
      () =>
        runStorageMaintenanceStep(
          port,
          stepRequest("stop-capacity"),
          async () => "unreachable",
        ),
    );
    await vi.waitFor(() => expect(capacityAbort).toBeDefined());
    const rejection = expect(pending).rejects.toThrow("cancelled");
    await runner.stop();
    await rejection;
    expect(capacityAbort?.aborted).toBe(true);
  });

  it("records a cross-layer failure only once in governor diagnostics", async () => {
    // 步骤层先记、义务层上抛时再记会把同一次故障算成两次;诊断的计数语义
    // 必须是一次故障一条记录。
    const port = governor();
    const recordError = vi.spyOn(port, "recordError");
    const runner = new StorageMaintenanceTaskRunner(port);
    const failure = new Error("step failed");
    await expect(
      runner.run(
        obligation("dedup-error"),
        new AbortController().signal,
        async () => {
          await runStorageMaintenanceStep(
            port,
            stepRequest("dedup-error-step"),
            async () => {
              throw failure;
            },
          );
        },
      ),
    ).rejects.toBe(failure);
    expect(recordError).toHaveBeenCalledTimes(1);
    expect(recordError).toHaveBeenCalledWith("projection-rebuild", failure);
    expect(port.snapshot().lastError?.kind).toBe("projection-rebuild");
  });

  it("records a pure obligation failure in governor diagnostics", async () => {
    const port = governor();
    const recordError = vi.spyOn(port, "recordError");
    const runner = new StorageMaintenanceTaskRunner(port);
    const failure = new Error("obligation failed");
    await expect(
      runner.run(obligation("obligation-error"), new AbortController().signal, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(recordError).toHaveBeenCalledTimes(1);
    expect(recordError).toHaveBeenCalledWith("projection-rebuild", failure);
    expect(port.snapshot().lastError?.code).toBeDefined();
  });
});

describe("runStorageMaintenanceStep", () => {
  it("acquires, accounts and releases the permit around the step", async () => {
    const port = governor();
    const gate = deferred<void>();
    const running = runStorageMaintenanceStep(
      port,
      stepRequest("step-1"),
      async () => {
        await gate.promise;
        return "done";
      },
    );
    await vi.waitFor(() =>
      expect(port.snapshot().inFlight["projection-rebuild"]).toBe(1)
    );
    gate.resolve();
    await expect(running).resolves.toBe("done");
    await vi.waitFor(() =>
      expect(port.snapshot().inFlight["projection-rebuild"] ?? 0).toBe(0)
    );
  });

  it("rejects with an admission error without running the operation", async () => {
    const port = governor();
    const gate = deferred<void>();
    // 两个槽全部占满后,第三个零等待准入必然背压;操作体不得执行。
    const first = runStorageMaintenanceStep(port, stepRequest("step-2a"), () =>
      gate.promise,
    );
    const second = runStorageMaintenanceStep(port, stepRequest("step-2b"), () =>
      gate.promise,
    );
    await vi.waitFor(() =>
      expect(port.snapshot().inFlight["projection-rebuild"]).toBe(2)
    );
    const operation = vi.fn(async () => "unreachable");
    await expect(
      runStorageMaintenanceStep(
        port,
        { ...stepRequest("step-2c"), maxWaitMs: 0 },
        operation,
      ),
    ).rejects.toBeInstanceOf(StorageMaintenanceAdmissionError);
    expect(operation).not.toHaveBeenCalled();
    gate.resolve();
    await Promise.all([first, second]);
  });

  it("runs the operation directly when no governor is assembled", async () => {
    const operation = vi.fn(async () => "done");
    await expect(
      runStorageMaintenanceStep(undefined, stepRequest("step-3"), operation),
    ).resolves.toBe("done");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("records step failures with kind and code in governor diagnostics", async () => {
    const port = governor();
    const failure = new Error("physical step failed");
    await expect(
      runStorageMaintenanceStep(port, stepRequest("step-4"), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(port.snapshot().lastError?.kind).toBe("projection-rebuild");
    expect(port.snapshot().lastError?.code).toBeDefined();
  });
});
