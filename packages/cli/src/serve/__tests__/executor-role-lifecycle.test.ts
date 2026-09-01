import { describe, expect, it, vi } from "vitest";
import {
  EXECUTOR_ROLE_LIFECYCLE_DESCRIPTORS,
  ExecutorRoleLifecycle,
  throwExecutorRoleFailures,
  type ExecutorRoleLifecycleIdentity,
} from "../executor-role-lifecycle.js";

describe("ExecutorRoleLifecycle", () => {
  it("freezes the non-Server owner and cleanup order exact-set", () => {
    expect(EXECUTOR_ROLE_LIFECYCLE_DESCRIPTORS).toEqual([
      { owner: "executor-role", id: "localConversationOwner.close" },
      { owner: "executor-role", id: "evidenceHandler.stopAccepting" },
      { owner: "executor-role", id: "localWorkspaceHost.close" },
      { owner: "executor-role", id: "executorJobOwnerLifecycle.close" },
      { owner: "executor-role", id: "executorDataPlane.close" },
      { owner: "executor-role", id: "authorityRuntime.stopStorageMaintenance" },
      { owner: "executor-role", id: "mcpRuntime.close" },
    ]);
  });

  it("rejects duplicate, missing and late contributions", () => {
    const lifecycle = new ExecutorRoleLifecycle();
    lifecycle.acquire("mcpRuntime.close", () => undefined);
    expect(() => lifecycle.acquire("mcpRuntime.close", () => undefined))
      .toThrow("already exists");
    expect(() => lifecycle.seal()).toThrow("contributions are incomplete");
  });

  it("rejects a same-name Authority handle from another lifecycle", () => {
    const lifecycle = new ExecutorRoleLifecycle();
    const foreign = new ExecutorRoleLifecycle();
    const foreignHandle = foreign.authorityStartupRollback().register(
      "authorityRuntime.stopStorageMaintenance",
      () => undefined,
    );

    expect(() => lifecycle.adoptAuthority(foreignHandle))
      .toThrow("does not belong to this role lifecycle");
  });

  it("closes partial startup in the fixed order and continues after failures", async () => {
    const lifecycle = new ExecutorRoleLifecycle();
    const order: string[] = [];
    lifecycle.acquire("mcpRuntime.close", () => order.push("mcp"));
    lifecycle.acquire("localWorkspaceHost.close", () => {
      order.push("workspace");
      throw new Error("workspace failed");
    });
    lifecycle.acquire("evidenceHandler.stopAccepting", () => {
      order.push("evidence");
    });

    const failure = await lifecycle.close().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect(order).toEqual(["evidence", "workspace", "mcp"]);
  });

  it("uses each sealed contribution exactly once on repeated normal close", async () => {
    const lifecycle = new ExecutorRoleLifecycle();
    const cleanups = new Map<ExecutorRoleLifecycleIdentity, ReturnType<typeof vi.fn>>();
    for (const { id } of EXECUTOR_ROLE_LIFECYCLE_DESCRIPTORS) {
      const cleanup = vi.fn(async () => undefined);
      cleanups.set(id, cleanup);
      if (id === "authorityRuntime.stopStorageMaintenance") {
        const handle = lifecycle.authorityStartupRollback().register(id, cleanup);
        lifecycle.adoptAuthority(handle);
      } else {
        lifecycle.acquire(id, cleanup);
      }
    }
    lifecycle.seal();

    await lifecycle.close();
    await lifecycle.close();

    for (const cleanup of cleanups.values()) {
      expect(cleanup).toHaveBeenCalledTimes(1);
    }
    expect(() => lifecycle.acquire("mcpRuntime.close", () => undefined))
      .toThrow("already closing");
  });

  it("re-observes Authority rollback failure when setup never contributes", async () => {
    const lifecycle = new ExecutorRoleLifecycle();
    const cleanup = vi.fn(async () => {
      throw new Error("authority cleanup failed");
    });
    const handle = lifecycle.authorityStartupRollback().register(
      "authorityRuntime.stopStorageMaintenance",
      cleanup,
    );
    await handle.run().catch(() => undefined);

    const failure = await lifecycle.close().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("preserves the original role failure ahead of cleanup failures", () => {
    const roleFailure = new Error("role failed");
    const cleanupFailure = new Error("cleanup failed");
    let result: unknown;
    try {
      throwExecutorRoleFailures(roleFailure, [cleanupFailure]);
    } catch (error) {
      result = error;
    }
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([
      roleFailure,
      cleanupFailure,
    ]);
    expect(() => throwExecutorRoleFailures(roleFailure, []))
      .toThrow(roleFailure);
    expect(() => throwExecutorRoleFailures(undefined, [cleanupFailure]))
      .toThrow("Executor role cleanup failed");
    expect(() => throwExecutorRoleFailures(undefined, []))
      .not.toThrow();
  });
});
