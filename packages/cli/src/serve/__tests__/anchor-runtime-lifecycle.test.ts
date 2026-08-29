import { CleanupRegistry } from "@zhixing/server";
import { describe, expect, it, vi } from "vitest";
import {
  ANCHOR_RUNTIME_LIFECYCLE_DESCRIPTORS,
  AssemblyLifecycleContributions,
} from "../assembly-lifecycle.js";
import { StartupRollback } from "../startup-rollback.js";

const RUNTIME_IDENTITIES = ANCHOR_RUNTIME_LIFECYCLE_DESCRIPTORS.map(
  ({ id }) => id,
);

describe("typed Anchor activation-gate lifecycle contributions", () => {
  it("freezes the runtime identity, owner, stage, and registration exact-set", () => {
    expect(ANCHOR_RUNTIME_LIFECYCLE_DESCRIPTORS).toEqual([
      { owner: "anchor-host", role: "surface", id: "confirmationBridge.dispose", stage: "post-server" },
      { owner: "anchor-host", role: "runtime", id: "execution.abortAllAndWait", stage: "activation" },
      { owner: "anchor-host", role: "runtime", id: "conversationProtocol.stopRecovery", stage: "activation" },
      { owner: "anchor-host", role: "runtime", id: "scheduler.stop", stage: "activation" },
      { owner: "anchor-host", role: "runtime", id: "inboundRouter.refuseNew", stage: "activation" },
      { owner: "anchor-local-executor", role: "runtime", id: "evidenceHandler.stopAccepting", stage: "activation" },
    ]);
  });

  it("preserves the established LIFO order and isolates one cleanup failure", async () => {
    const order: string[] = [];
    const logger = { error: vi.fn() };
    const normal = registry(logger);
    const lifecycle = new AssemblyLifecycleContributions(new StartupRollback());
    for (const identity of RUNTIME_IDENTITIES) {
      lifecycle.acquire(identity, () => {
        order.push(identity);
        if (identity === "execution.abortAllAndWait") {
          throw new Error("execution cleanup failed");
        }
      });
    }

    lifecycle.transferExactTo(normal, "post-server", ["confirmationBridge.dispose"]);
    lifecycle.transferExactTo(normal, "activation", [
      "execution.abortAllAndWait",
      "conversationProtocol.stopRecovery",
      "scheduler.stop",
      "inboundRouter.refuseNew",
      "evidenceHandler.stopAccepting",
    ]);
    lifecycle.assertTransferred();
    await normal.runAll("normal-close");

    expect(order).toEqual([
      "evidenceHandler.stopAccepting",
      "inboundRouter.refuseNew",
      "scheduler.stop",
      "conversationProtocol.stopRecovery",
      "execution.abortAllAndWait",
      "confirmationBridge.dispose",
    ]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("uses the same idempotent handles for gate failure and normal close", async () => {
    const rollback = new StartupRollback();
    const lifecycle = new AssemblyLifecycleContributions(rollback);
    const confirmation = vi.fn();
    const scheduler = vi.fn();
    lifecycle.acquire("confirmationBridge.dispose", confirmation);
    lifecycle.acquire("scheduler.stop", scheduler);
    const normal = registry();
    lifecycle.transferExactTo(normal, "post-server", ["confirmationBridge.dispose"]);
    lifecycle.transferExactTo(normal, "activation", ["scheduler.stop"]);

    await rollback.rollback();
    await normal.runAll("gate-failure");

    expect(confirmation).toHaveBeenCalledTimes(1);
    expect(scheduler).toHaveBeenCalledTimes(1);
  });

  it("fails closed on missing, duplicate, foreign, and wrong-stage input", () => {
    const rollback = new StartupRollback();
    const lifecycle = new AssemblyLifecycleContributions(rollback);
    lifecycle.acquire("execution.abortAllAndWait", () => undefined);
    expect(() => lifecycle.transferExactTo(registry(), "activation", [
      "execution.abortAllAndWait",
      "scheduler.stop",
    ])).toThrow("exact-set mismatch");
    expect(() => lifecycle.transferExactTo(registry(), "activation", [
      "execution.abortAllAndWait",
      "execution.abortAllAndWait",
    ])).toThrow("expected duplicate");
    expect(() => lifecycle.transferExactTo(
      registry(),
      "activation",
      ["confirmationBridge.dispose"],
    )).toThrow("does not belong to stage activation");

    const foreign = new StartupRollback().register("scheduler.stop", () => undefined);
    expect(() => lifecycle.contribute("scheduler.stop", foreign))
      .toThrow("does not belong to this StartupRollback");
  });

  it("rejects late contributions while allowing absent conditional resources", () => {
    const lifecycle = new AssemblyLifecycleContributions(new StartupRollback());
    lifecycle.acquire("scheduler.stop", () => undefined);
    const normal = registry();
    lifecycle.transferExactTo(normal, "post-server", []);
    lifecycle.transferExactTo(normal, "activation", ["scheduler.stop"]);
    expect(normal.size).toBe(1);
    expect(() => lifecycle.acquire("inboundRouter.refuseNew", () => undefined))
      .toThrow('stage "activation" is already transferred');
  });
});

function registry(logger = { error: vi.fn() }): CleanupRegistry {
  return new CleanupRegistry({
    activeOwners: ["anchor-host", "anchor-local-executor"],
    logger,
  });
}
