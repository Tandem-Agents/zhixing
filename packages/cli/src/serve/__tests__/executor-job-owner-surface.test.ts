import { describe, expect, it, vi } from "vitest";
import { createAccessSurfaces } from "../access-surfaces.js";
import type { AssemblyContext } from "../access-surface.js";
import { PROFILES } from "../profile.js";
import { StartupRollback } from "../startup-rollback.js";

const surface = createAccessSurfaces({}).find(
  (candidate) => candidate.name === "executor-job-owner",
)!;

describe("executor job owner production surface", () => {
  it("is a mandatory pre-server composition unit between the ledger and adapters", () => {
    const names = createAccessSurfaces({}).map((candidate) => candidate.name);
    expect(PROFILES.full.surfaces).not.toContain("executor-job-owner");
    expect(surface.phase).toBe("pre-server");
    expect(surface.mandatory).toBe(true);
    expect(names.indexOf("executor-job-owner")).toBeGreaterThan(
      names.indexOf("conversation"),
    );
    expect(names.indexOf("executor-job-owner")).toBeLessThan(
      names.indexOf("mesh-control"),
    );
    expect(names.indexOf("executor-job-owner")).toBeLessThan(
      names.indexOf("lossless-data-plane"),
    );
  });

  it("creates exactly one recoverable owner for anchor plus executor", async () => {
    const ledger = recoveryLedger();
    const rollback = new StartupRollback();
    const ctx = ownerContext(["anchor", "executor"], ledger, rollback);

    await surface.setup(ctx);

    expect(ctx.executorJobOwner).toBeDefined();
    expect(ctx.jobRelayObligations).toBeDefined();
    expect(ctx.startupCleanups.jobOwner).toBeDefined();
    await ctx.executorJobOwner!.start();
    expect(ctx.executorJobOwner!.ready).toBe(true);
    expect(ledger.recoverableJobAssignments).toHaveBeenCalledTimes(1);
    expect(ledger.recoverableJobCancellations).toHaveBeenCalledTimes(1);
    expect(ledger.recoverableJobInteractionAssignments).toHaveBeenCalledTimes(1);
    await expect(surface.setup(ctx)).rejects.toThrow(/already assembled/u);

    await ctx.startupCleanups.jobOwner!.run();
    expect(ctx.executorJobOwner!.ready).toBe(false);
  });

  it("creates the same owner contract for executor-only and stays inert without executor", async () => {
    const executorOnly = ownerContext(
      ["executor"],
      recoveryLedger(),
      new StartupRollback(),
    );
    await surface.setup(executorOnly);
    expect(executorOnly.executorJobOwner).toBeDefined();
    expect(executorOnly.jobRelayObligations).toBeUndefined();
    await executorOnly.startupCleanups.jobOwner!.run();

    const anchorOnly = ownerContext(
      ["anchor"],
      recoveryLedger(),
      new StartupRollback(),
    );
    await surface.setup(anchorOnly);
    expect(anchorOnly.executorJobOwner).toBeUndefined();
  });
});

function recoveryLedger() {
  return {
    recoverableJobAssignments: vi.fn(async () => []),
    recoverableJobCancellations: vi.fn(async () => []),
    recoverableJobInteractionAssignments: vi.fn(async () => []),
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
    startupCleanups: {},
  } as unknown as AssemblyContext;
}
