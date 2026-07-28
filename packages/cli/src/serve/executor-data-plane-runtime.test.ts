import { describe, expect, it, vi } from "vitest";
import { ExecutorDataPlaneRuntime } from "./executor-data-plane-runtime.js";
import type { ExecutorRoleModule } from "./role-topology.js";

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
    }
    class Tickets {
      recover = recover;
      maintain = maintainTickets;
    }
    class Writer {
      static open = vi.fn(async () => opened);
    }
    const runtime = new ExecutorDataPlaneRuntime({
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
    const ledger = {
      dataPlaneBinding: vi.fn(),
    };
    runtime.bindLedger(ledger as never);

    await runtime.start();
    expect(recover).toHaveBeenCalledOnce();
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
    let page = 0;
    class Spool {
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
    const runtime = new ExecutorDataPlaneRuntime({
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
      storageMaintenance: { acquire } as never,
    });
    runtime.bindLedger({ dataPlaneBinding: vi.fn() } as never);

    await runtime.start();
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

  it("cannot start or create a stream before the durable ledger is bound", async () => {
    class Spool {
      closeAssignmentScan = vi.fn(async () => undefined);
    }
    class Tickets {}
    class Writer {}
    const runtime = new ExecutorDataPlaneRuntime({
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

    await expect(runtime.start()).rejects.toThrow(/no assignment authority/);
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
    ).rejects.toThrow(/no assignment authority/);
    await runtime.close();
  });
});
