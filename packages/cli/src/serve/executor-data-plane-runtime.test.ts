import { describe, expect, it, vi } from "vitest";
import { currentMaintenanceAbortSignal, isHoldingMaintenanceExclusion, runHoldingMaintenanceExclusion, StorageMaintenanceAdmissionError, StorageMaintenanceCancelledError } from "@zhixing/core/resources";
import { MeshServiceRegistry } from "@zhixing/mesh";
import {
  createExecutorDataPlaneAssignmentPair,
  type ExecutorDataPlaneAssignmentAuthorityPort,
  type ExecutorDataPlaneRuntimeOptions,
} from "./executor-data-plane-runtime.js";
import type { ExecutorRoleModule } from "./role-topology.js";

function composeRuntime(
  options: ExecutorDataPlaneRuntimeOptions,
  authority: ExecutorDataPlaneAssignmentAuthorityPort = {
    dataPlaneBinding: vi.fn(),
    authorizeOwnerRelay: vi.fn(),
  },
) {
  return createExecutorDataPlaneAssignmentPair(options, () =>
    Object.freeze({ assignment: authority, authority })
  ).dataPlane;
}

describe("ExecutorDataPlaneRuntime", () => {
  it("recovers tickets, maintains every durable spool, and creates streams through one substrate", async () => {
    const opened = { append: vi.fn(), final: vi.fn() };
    const recover = vi.fn(async () => undefined);
    const maintainTickets = vi.fn(async () => 2);
    const reclaimDue = vi.fn(async (assignmentId: string) =>
      assignmentId === "assignment-2");
    class Spool {
      assignmentIdPage = vi.fn(async () => ["assignment-1", "assignment-2"]);
      reclaimDue = reclaimDue;
      closeAssignmentScan = vi.fn(async () => undefined);
      stopStorageMaintenance = vi.fn();
    }
    class Tickets {
      recover = recover;
      maintain = maintainTickets;
    }
    class Writer {
      static open = vi.fn(async () => opened);
    }
    const ledger = {
      dataPlaneBinding: vi.fn(),
      authorizeOwnerRelay: vi.fn(),
    };
    const runtime = composeRuntime({
      zhixingHome: "X:/zhixing-home",
      authority: {
        artifacts: {},
        executorLog: {},
        executorId: "executor-1",
        verifier: {},
      } as never,
      module: {
        AssignmentStreamSpool: Spool,
        AssignmentStreamWriter: Writer,
        DataPlaneTicketRegistry: Tickets,
      } as unknown as ExecutorRoleModule,
    }, ledger as never);

    await runtime.start();
    expect(recover).toHaveBeenCalledOnce();
    expect(maintainTickets).not.toHaveBeenCalled();
    expect(reclaimDue).not.toHaveBeenCalled();
    await runtime.maintain();
    expect(maintainTickets).toHaveBeenCalledOnce();
    expect(reclaimDue.mock.calls.map(([assignmentId]) => assignmentId)).toEqual([
      "assignment-1",
      "assignment-2",
    ]);
    await expect(
      runtime.createStream({
        assignmentId: "assignment-1",
        ref: {
          execution: "conversation",
          conversationId: "conversation-1",
          runId: "run-1",
          ownerEpoch: 1,
        },
      }),
    ).resolves.toBe(opened);
    await runtime.close();
  });

  it("admits every physical maintenance step through the storage governor with a bounded batch", async () => {
    const manyAssignments = Array.from(
      { length: 40 },
      (_, index) => `assignment-${String(index).padStart(2, "0")}`,
    );
    const reclaimed: string[] = [];
    let spoolOptions: { readonly storageMaintenance?: unknown } | undefined;
    let page = 0;
    class Spool {
      constructor(
        _rootDir: string,
        _artifacts: unknown,
        options: { readonly storageMaintenance?: unknown },
      ) {
        spoolOptions = options;
      }
      assignmentIdPage = vi.fn(
        async (
          limit: number,
          runPhysicalStep?: <T>(operation: () => Promise<T>) => Promise<T>,
        ) => {
          if (!runPhysicalStep) throw new Error("discovery bypassed");
          return runPhysicalStep(async () => {
            const offset = page * limit;
            page += 1;
            return manyAssignments.slice(offset, offset + limit);
          });
        },
      );
      reclaimDue = vi.fn(
        async (
          assignmentId: string,
          _now: unknown,
          runPhysicalStep?: <T>(operation: () => Promise<T>) => Promise<T>,
        ) => {
          // 物理删除必须发生在调用方提供的准入步骤内——零旁路。
          if (!runPhysicalStep) throw new Error("physical step bypassed");
          return runPhysicalStep(async () => {
            reclaimed.push(assignmentId);
            return true;
          });
        },
      );
      closeAssignmentScan = vi.fn(async () => undefined);
      stopStorageMaintenance = vi.fn();
    }
    class Tickets {
      recover = vi.fn(async () => undefined);
      maintain = vi.fn(
        async (
          runPhysicalStep?: <T>(operation: () => Promise<T>) => Promise<T>,
        ) => {
          if (!runPhysicalStep) throw new Error("physical step bypassed");
          return runPhysicalStep(async () => 0);
        },
      );
    }
    class Writer {}
    const acquire = vi.fn(async () => ({
      kind: "granted" as const,
      permit: {
        budget: {},
        tryBegin: vi.fn(() => ({
          claim: vi.fn(),
          complete: vi.fn(),
        })),
        extend: vi.fn(async () => true),
        release: vi.fn(),
      },
    }));
    const storageMaintenance = { acquire } as never;
    const runtime = composeRuntime({
      zhixingHome: "X:/zhixing-home",
      authority: {
        artifacts: {},
        executorLog: {},
        executorId: "executor-1",
        verifier: {},
      } as never,
      module: {
        AssignmentStreamSpool: Spool,
        AssignmentStreamWriter: Writer,
        DataPlaneTicketRegistry: Tickets,
      } as unknown as ExecutorRoleModule,
      storageMaintenance,
    });
    expect(spoolOptions?.storageMaintenance).toBe(storageMaintenance);

    await runtime.start();
    await runtime.maintain();
    // 单轮上界:40 个 assignment 只发现并回收前 32 个；目录页、
    // 每个 assignment 物理步骤与票据批都独立准入。
    expect(reclaimed).toEqual(manyAssignments.slice(0, 32));
    expect(acquire).toHaveBeenCalledTimes(34);

    reclaimed.length = 0;
    await runtime.maintain();
    // 打开的目录游标续扫:下一轮只触碰余下 8 个。
    expect(reclaimed).toEqual(manyAssignments.slice(32));
    await runtime.close();
  });

  it("does not publish a pair when assignment construction fails", () => {
    class Spool {
      closeAssignmentScan = vi.fn(async () => undefined);
      stopStorageMaintenance = vi.fn();
    }
    class Tickets {}
    class Writer {}
    const createAssignment = vi.fn(() => {
      throw new Error("assignment construction failed");
    });

    expect(() =>
      createExecutorDataPlaneAssignmentPair(
        {
          zhixingHome: "X:/zhixing-home",
          authority: {
            artifacts: {},
            executorLog: {},
            executorId: "executor-1",
            verifier: {},
          } as never,
          module: {
            AssignmentStreamSpool: Spool,
            AssignmentStreamWriter: Writer,
            DataPlaneTicketRegistry: Tickets,
          } as unknown as ExecutorRoleModule,
        },
        createAssignment,
      )
    ).toThrow("assignment construction failed");
    expect(createAssignment).toHaveBeenCalledOnce();
  });

  it.each([false, true])("constructs one frozen pair with optional binding batch support=%s", async batching => {
    let ticketAssignments:
      | {
        dataPlaneBindings(requests: readonly { assignmentId: string; use?: string }[]): Promise<readonly unknown[]>;
        dataPlaneBinding(
          assignmentId: string,
          use?: unknown,
        ): Promise<unknown>;
      }
      | undefined;
    class Spool {}
    class Tickets {
      constructor(options: { readonly assignments: typeof ticketAssignments }) {
        ticketAssignments = options.assignments;
      }
    }
    class Writer {}
    const binding = Object.freeze({ assignmentId: "assignment-1" });
    const batch = vi.fn(async (requests: readonly unknown[]) => requests.map(() => binding));
    const authority = {
      ...(batching ? { dataPlaneBindings: batch } : {}),
      dataPlaneBinding: vi.fn(async () => binding),
      authorizeOwnerRelay: vi.fn(async () => undefined),
    };
    let assemblyTickets: unknown;
    const pair = createExecutorDataPlaneAssignmentPair(
      {
        zhixingHome: "X:/zhixing-home",
        authority: {
          artifacts: {},
          executorLog: {},
          executorId: "executor-1",
          verifier: {},
        } as never,
        module: {
          AssignmentStreamSpool: Spool,
          AssignmentStreamWriter: Writer,
          DataPlaneTicketRegistry: Tickets,
        } as unknown as ExecutorRoleModule,
      },
      (dataPlane) => {
        assemblyTickets = dataPlane.assignmentTickets;
        return Object.freeze({ assignment: authority, authority });
      },
    );

    expect(Object.isFrozen(pair)).toBe(true);
    expect(pair.assignment).toBe(authority);
    expect(assemblyTickets).toBe(pair.dataPlane.assignmentTickets);
    expect("bindAssignmentAuthority" in pair.dataPlane).toBe(false);
    const requests = [{ assignmentId: "assignment-1", use: "observe" as const }];
    await expect(ticketAssignments!.dataPlaneBindings(requests)).resolves.toEqual([binding]);
    if (batching) { expect(batch).toHaveBeenCalledWith(requests); expect(authority.dataPlaneBinding).not.toHaveBeenCalled(); }
    else expect(authority.dataPlaneBinding).toHaveBeenCalledWith("assignment-1", "observe");
    await expect(
      ticketAssignments?.dataPlaneBinding("assignment-1"),
    ).resolves.toBe(binding);
    expect(authority.dataPlaneBinding).toHaveBeenCalledWith(
      "assignment-1",
      undefined,
    );
  });

  it("owns concrete spool and tickets while exposing one finite Mesh service lifecycle", () => {
    class Spool {}
    class Tickets {}
    class Writer {}
    const runtime = composeRuntime({
      zhixingHome: "X:/zhixing-home",
      authority: {
        artifacts: {},
        executorLog: {},
        executorId: "executor-1",
        verifier: {},
      } as never,
      module: {
        AssignmentStreamSpool: Spool,
        AssignmentStreamWriter: Writer,
        DataPlaneTicketRegistry: Tickets,
      } as unknown as ExecutorRoleModule,
    });
    const services = new MeshServiceRegistry();
    const dispose = runtime.registerMeshServices({
      services,
      operations: {} as never,
      authorizeOwner: () => true,
      surfacePrincipalFor: () => "surface:test",
      ownerMayPresentSurfaceTicket: () => true,
      authorizePeer: () => true,
    });

    expect(services.list()).toEqual([
      "assignment.data-plane-ticket",
      "assignment.stream",
    ]);
    expect("spool" in runtime).toBe(false);
    expect("tickets" in runtime).toBe(false);
    dispose();
    dispose();
    expect(services.list()).toEqual([]);
  });
});


describe("ticket startup recovery ownership", () => {
  const pressure = () => new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "probe-unavailable", retryAfterMs: 20 });
  function fixture(recover: () => Promise<void>) {
    const closeScan = vi.fn(async () => undefined);
    class Spool { closeAssignmentScan = closeScan; stopStorageMaintenance = vi.fn(); }
    class Tickets { recover = recover; }
    const runtime = composeRuntime({ zhixingHome: "X:/recovery", authority: { artifacts: {}, executorLog: {}, executorId: "executor-1", verifier: {} } as never,
      module: { AssignmentStreamSpool: Spool, AssignmentStreamWriter: class {}, DataPlaneTicketRegistry: Tickets } as unknown as ExecutorRoleModule });
    return { runtime, closeScan };
  }
  it("shares startup and retries only after the failed recovery has released exclusion", async () => {
    vi.useFakeTimers(); let calls = 0;
    const recover = vi.fn(async () => {
      expect(isHoldingMaintenanceExclusion()).toBe(false);
      expect(currentMaintenanceAbortSignal().aborted).toBe(false);
      await runHoldingMaintenanceExclusion(async () => { if (++calls === 1) throw pressure(); });
    });
    const { runtime } = fixture(recover);
    try {
      const first = runtime.start(); expect(runtime.start()).toBe(first);
      await vi.advanceTimersByTimeAsync(20); await first;
      expect(recover).toHaveBeenCalledTimes(2); expect(runtime.start()).toBe(first);
    } finally { await runtime.close(); vi.useRealTimers(); }
  });
  it("returns the original typed error after a finite retry window", async () => {
    vi.useFakeTimers(); const failure = pressure();
    const recover = vi.fn(async () => { throw failure; }), { runtime } = fixture(recover);
    try {
      const done = expect(runtime.start()).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(5_000); await done;
      const attempts = recover.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000); expect(recover).toHaveBeenCalledTimes(attempts);
    } finally { await runtime.close(); vi.useRealTimers(); }
  });
  it.each([new Error("corrupt ticket"), new StorageMaintenanceAdmissionError({ kind: "capacity-gap", blockedBy: "temporaryBytes", required: 2, available: 1 })])("does not retry permanent failures: %s", async failure => {
    const recover = vi.fn(async () => { throw failure; }), { runtime } = fixture(recover);
    try { await expect(runtime.start()).rejects.toBe(failure); expect(recover).toHaveBeenCalledOnce(); }
    finally { await runtime.close(); }
  });
  it("close cancels retry waiting without starting another pass", async () => {
    vi.useFakeTimers(); const recover = vi.fn(async () => { throw pressure(); }), { runtime } = fixture(recover);
    try {
      const done = expect(runtime.start()).rejects.toBeInstanceOf(StorageMaintenanceCancelledError);
      await vi.advanceTimersByTimeAsync(1); await runtime.close(); await done;
      await vi.advanceTimersByTimeAsync(60_000); expect(recover).toHaveBeenCalledOnce();
    } finally { await runtime.close(); vi.useRealTimers(); }
  });
  it("close drains an in-flight recovery before releasing spool resources", async () => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); let signal: AbortSignal | undefined;
    const { runtime, closeScan } = fixture(async () => { signal = currentMaintenanceAbortSignal(); entered.resolve(); await gate.promise; });
    const done = expect(runtime.start()).rejects.toBeInstanceOf(StorageMaintenanceCancelledError);
    await entered.promise; const closing = runtime.close();
    expect(signal?.aborted).toBe(true); expect(closeScan).not.toHaveBeenCalled();
    gate.resolve(); await done; await closing;
    expect(closeScan).toHaveBeenCalledOnce();
    await expect(runtime.start()).rejects.toThrow("closed");
  });
});
