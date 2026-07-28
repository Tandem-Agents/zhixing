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
      assignmentIds = vi.fn(async () => ["assignment-1", "assignment-2"]);
      reclaimDue = reclaimDue;
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

  it("cannot start or create a stream before the durable ledger is bound", async () => {
    class Spool {}
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
