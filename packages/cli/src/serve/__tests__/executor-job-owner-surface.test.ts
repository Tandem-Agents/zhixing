import { describe, expect, it, vi } from "vitest";
import { createAssemblyUnits } from "../access-surfaces.js";
import type { AssemblyContext } from "../access-surface.js";
import { PROFILES } from "../profile.js";
import { StartupRollback } from "../startup-rollback.js";
import { AssemblyLifecycleContributions } from "../assembly-lifecycle.js";

const unit = createAssemblyUnits({}).find(
  (candidate) => candidate.name === "executor-job-owner",
)!;
const startUnit = createAssemblyUnits({}).find(
  (candidate) => candidate.name === "executor-job-owner-start",
)!;

describe("executor job owner production surface", () => {
  it("is a mandatory pre-server composition unit between the ledger and adapters", () => {
    const names = createAssemblyUnits({}).map((candidate) => candidate.name);
    expect(PROFILES.full.surfaces).not.toContain("executor-job-owner");
    expect(unit.phase).toBe("pre-server");
    expect(unit.kind).toBe("core");
    expect(names.indexOf("executor-job-owner")).toBeGreaterThan(
      names.indexOf("conversation"),
    );
    expect(names.indexOf("executor-job-owner")).toBeLessThan(
      names.indexOf("mesh-control"),
    );
    expect(names.indexOf("executor-job-owner")).toBeLessThan(
      names.indexOf("lossless-data-plane"),
    );
    expect(startUnit.kind).toBe("core");
    expect(names.indexOf("executor-job-owner-start")).toBeGreaterThan(
      names.indexOf("lossless-data-plane"),
    );
  });

  it("creates exactly one recoverable owner for anchor plus executor", async () => {
    const ledger = recoveryLedger();
    const rollback = new StartupRollback();
    const ctx = ownerContext(["anchor", "executor"], ledger, rollback);

    await unit.setup(ctx);

    expect(ctx.executorJobOwner).toBeDefined();
    expect(ctx.jobRelayObligations).toBeDefined();
    expect(ctx.lifecycleContributions.has("executorJobOwner.close")).toBe(false);
    await startUnit.setup(ctx);
    expect(ctx.lifecycleContributions.has("executorJobOwner.close")).toBe(true);
    expect(ctx.executorJobOwner!.ready).toBe(true);
    expect(ledger.recoverableJobObligations).toHaveBeenCalledTimes(1);
    await expect(unit.setup(ctx)).rejects.toThrow(/already assembled/u);

    await rollback.rollback();
    expect(ctx.executorJobOwner!.ready).toBe(false);
  });

  it("keeps fresh job recovery closed until the durable lifecycle artifact exists", async () => {
    const ctx = ownerContext(
      ["executor"],
      recoveryLedger(),
      new StartupRollback(),
    );
    ctx.startupLifecycle = {
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
    await unit.setup(ctx);
    const start = vi.spyOn(ctx.executorJobOwnerAssembly!, "start");

    await startUnit.setup(ctx);

    expect(start).toHaveBeenCalledWith({
      admissionClosed: true,
      recoverAcceptedWork: false,
    });
    expect(ctx.executorJobOwner!.ready).toBe(false);
    await ctx.startupRollback.rollback();
  });

  it("creates the same owner contract for executor-only and stays inert without executor", async () => {
    const executorOnly = ownerContext(
      ["executor"],
      recoveryLedger(),
      new StartupRollback(),
    );
    await unit.setup(executorOnly);
    expect(executorOnly.executorJobOwner).toBeDefined();
    expect(executorOnly.jobRelayObligations).toBeUndefined();
    await startUnit.setup(executorOnly);
    await executorOnly.startupRollback.rollback();

    const anchorOnly = ownerContext(
      ["anchor"],
      recoveryLedger(),
      new StartupRollback(),
    );
    await unit.setup(anchorOnly);
    expect(anchorOnly.executorJobOwner).toBeUndefined();
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
      ["executor"],
      { recoverableJobObligations } as ReturnType<typeof recoveryLedger>,
      new StartupRollback(),
    );
    await unit.setup(ctx);

    const items = await ctx.executorJobOwner!.acceptedWorkItems();

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
    await unit.setup(ctx);
    rollback.register("transport.stop", () => {
      order.push("transport");
    });
    const assembly = ctx.executorJobOwnerAssembly!;
    const close = assembly.close.bind(assembly);
    vi.spyOn(assembly, "close").mockImplementation(async () => {
      order.push("owner");
      await close();
    });

    await startUnit.setup(ctx);
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
): AssemblyContext {
  return {
    enabledRoles,
    authorityRuntime: {},
    executorDataPlane: {
      createStream: vi.fn(),
    },
    executorRoleModule: {
      InProcessAssignmentSubmission: class {},
    },
    conversationProtocol: {
      executorLedger: () => ledger,
    },
    jobRuntime: {
      create: vi.fn(),
    },
    startupRollback,
    lifecycleContributions: new AssemblyLifecycleContributions(startupRollback),
  } as unknown as AssemblyContext;
}
