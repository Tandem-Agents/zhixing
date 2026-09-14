import { describe, expect, it, vi } from "vitest";
import { createExecutorJobOwner, startExecutorJobOwner, type CreateExecutorJobOwnerInput } from "../access-surfaces.js";
import type { StartupLifecycleRestoration } from "../access-surface.js";
import { JobRelayObligationDirectory } from "../channel-interaction-coordinator.js";
import { StartupRollback } from "../startup-rollback.js";
import { AssemblyLifecycleContributions } from "../assembly-lifecycle.js";


describe("executor job owner production surface", () => {

  it("creates one recovered owner that remains closed until Mesh lifecycle recovery", async () => {
    const ledger = recoveryLedger();
    const rollback = new StartupRollback();
    const ctx = ownerContext(["anchor", "executor"], ledger, rollback);

    const assembly = await createExecutorJobOwner(Object.freeze(ctx));

    expect(assembly.owner).toBeDefined();
    expect(ctx.jobRelayObligations).toBeDefined();
    expect(ctx.lifecycleContributions.has("executorJobOwner.close")).toBe(false);
    await startExecutorJobOwner({ executorJobOwnerAssembly: assembly, lifecycleContributions: ctx.lifecycleContributions, startupLifecycle: ctx.startupLifecycle });
    expect(ctx.lifecycleContributions.has("executorJobOwner.close")).toBe(true);
    expect(assembly.owner.ready).toBe(false);
    expect(ledger.recoverableJobObligations).toHaveBeenCalledTimes(1);
    expect(ctx).not.toHaveProperty("executorJobOwner");

    await rollback.rollback();
    expect(assembly.owner.ready).toBe(false);
  });

  it("keeps fresh job recovery closed until the durable lifecycle artifact exists", async () => {
    const base = ownerContext(
      ["anchor", "executor"],
      recoveryLedger(),
      new StartupRollback(),
    );
    const startupLifecycle: StartupLifecycleRestoration = {
      kind: "stop",
      artifactReady: false,
      recoverAcceptedWork: false,
      alreadySettled: false,
      delivery: {
        operationId: "stop-startup",
        sources: [],
        deliveries: [],
        sealed: false,
      },
    };
    const ctx = { ...base, startupLifecycle };
    const assembly = await createExecutorJobOwner(Object.freeze(ctx));
    const start = vi.spyOn(assembly, "start");

    await startExecutorJobOwner({ executorJobOwnerAssembly: assembly, lifecycleContributions: ctx.lifecycleContributions, startupLifecycle: ctx.startupLifecycle });

    expect(start).toHaveBeenCalledWith({
      admissionClosed: true,
      recoverAcceptedWork: false,
    });
    expect(assembly.owner.ready).toBe(false);
    await ctx.startupRollback.rollback();
  });

  it("rejects missing execution dependencies", async () => {
    await expect(createExecutorJobOwner({} as never)).rejects.toThrow("requires authority");
  });

  it("projects the complete durable job obligation exact-set without starting recovery", async () => {
    const recoverableJobObligations = vi.fn()
      .mockResolvedValueOnce({
        entries: [{
          envelope: { assignmentId: "assignment-b" },
          execution: true,
          cancellation: false,
          interaction: false,
        }],
        continuation: "assignment-b",
      })
      .mockResolvedValueOnce({
        entries: [{
          envelope: { assignmentId: "assignment-a" },
          execution: false,
          cancellation: true,
          interaction: false,
        }],
      });
    const ctx = ownerContext(
      ["anchor", "executor"],
      { recoverableJobObligations } as ReturnType<typeof recoveryLedger>,
      new StartupRollback(),
    );
    const assembly = await createExecutorJobOwner(Object.freeze(ctx));

    const items = await assembly.owner.acceptedWorkItems();

    expect(items.map((item) => item.id)).toEqual([
      "assignment-a",
      "assignment-b",
    ]);
    expect(items.every((item) => /^sha256:[a-f0-9]{64}$/u.test(item.revision))).toBe(true);
    expect(recoverableJobObligations).toHaveBeenNthCalledWith(1, { limit: 32 });
    expect(recoverableJobObligations).toHaveBeenNthCalledWith(2, {
      limit: 32,
      continuation: "assignment-b",
    });
  });

  it("registers rollback after transports so the started owner closes first", async () => {
    const order: string[] = [];
    const rollback = new StartupRollback();
    const ctx = ownerContext(
      ["anchor", "executor"],
      recoveryLedger(),
      rollback,
    );
    const assembly = await createExecutorJobOwner(Object.freeze(ctx));
    rollback.register("transport.stop", () => {
      order.push("transport");
    });
    const close = assembly.close.bind(assembly);
    vi.spyOn(assembly, "close").mockImplementation(async () => {
      order.push("owner");
      await close();
    });

    await startExecutorJobOwner({ executorJobOwnerAssembly: assembly, lifecycleContributions: ctx.lifecycleContributions, startupLifecycle: ctx.startupLifecycle });
    await rollback.rollback();

    expect(order).toEqual(["owner", "transport"]);
  });
});

function recoveryLedger() {
  return {
    recoverableJobObligations: vi.fn(async () => ({ entries: [] })),
  };
}

function ownerContext(
  enabledRoles: readonly ("anchor" | "executor")[],
  ledger: ReturnType<typeof recoveryLedger>,
  startupRollback: StartupRollback,
): CreateExecutorJobOwnerInput & { startupRollback: StartupRollback; lifecycleContributions: AssemblyLifecycleContributions; startupLifecycle?: StartupLifecycleRestoration } {
  return {
    enabledRoles,
    authorityRuntime: {},
    jobRelayObligations: new JobRelayObligationDirectory(),
    executorDataPlane: {
      createStream: vi.fn(),
    },
    executorRoleModule: {
      InProcessAssignmentSubmission: class {},
    },
    conversationProtocol: {},
    conversationExecutorLedger: ledger,
    jobRuntime: {
      create: vi.fn(),
    },
    startupRollback,
    lifecycleContributions: new AssemblyLifecycleContributions(startupRollback),
  } as unknown as CreateExecutorJobOwnerInput & { startupRollback: StartupRollback; lifecycleContributions: AssemblyLifecycleContributions; startupLifecycle?: StartupLifecycleRestoration };
}
