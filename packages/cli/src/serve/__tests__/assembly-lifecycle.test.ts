import { CleanupRegistry } from "@zhixing/server";
import { describe, expect, it, vi } from "vitest";
import {
  ASSEMBLY_LIFECYCLE_DESCRIPTORS,
  AssemblyLifecycleContributions,
} from "../assembly-lifecycle.js";
import { StartupRollback } from "../startup-rollback.js";

function registry() {
  return new CleanupRegistry({
    activeOwners: ["anchor-host", "anchor-local-executor"],
    logger: { error() {} },
  });
}

describe("typed pre-server lifecycle contributions", () => {
  it("freezes the production identity and owner exact-set", () => {
    expect(ASSEMBLY_LIFECYCLE_DESCRIPTORS).toEqual([
      { owner: "anchor-host", role: "common", id: "authorityRuntime.stopStorageMaintenance", stage: "foundation" },
      { owner: "anchor-local-executor", role: "common", id: "localWorkspaceHost.close", stage: "foundation" },
      { owner: "anchor-local-executor", role: "runtime", id: "localConversationOwner.close", stage: "foundation" },
      { owner: "anchor-host", role: "common", id: "channels.dispose", stage: "surface" },
      { owner: "anchor-host", role: "common", id: "deliveryStack.stop", stage: "surface" },
      { owner: "anchor-host", role: "common", id: "mcpHub.dispose", stage: "surface" },
      { owner: "anchor-host", role: "runtime", id: "meshRuntime.stop", stage: "runtime" },
      { owner: "anchor-local-executor", role: "runtime", id: "executorDataPlane.close", stage: "runtime" },
      { owner: "anchor-host", role: "runtime", id: "jobStatus.dispose", stage: "runtime" },
      { owner: "anchor-host", role: "runtime", id: "assetMaintenance.stop", stage: "runtime" },
      { owner: "anchor-local-executor", role: "runtime", id: "executorJobOwner.close", stage: "runtime" },
      { owner: "anchor-host", role: "runtime", id: "losslessDataPlane.close", stage: "runtime" },
      { owner: "anchor-host", role: "runtime", id: "ephemeralRuntime.dispose", stage: "runtime" },
    ]);
  });

  it("rejects duplicate contribution and transfer ownership", () => {
    const rollback = new StartupRollback();
    const contributions = new AssemblyLifecycleContributions(rollback);
    contributions.acquire("mcpHub.dispose", () => undefined);
    expect(() => contributions.acquire("mcpHub.dispose", () => undefined))
      .toThrow("already exists");

    const foreignRollback = new StartupRollback();
    const foreignHandle = foreignRollback.register(
      "channels.dispose",
      () => undefined,
    );
    expect(() => contributions.contribute("deliveryStack.stop", foreignHandle))
      .toThrow("handle identity mismatch");

    const sameNameForeignHandle = foreignRollback.register(
      "deliveryStack.stop",
      () => undefined,
    );
    expect(() => contributions.contribute("deliveryStack.stop", sameNameForeignHandle))
      .toThrow("does not belong to this StartupRollback");

    const ownedHandle = rollback.register("deliveryStack.stop", () => undefined);
    expect(contributions.contribute("deliveryStack.stop", ownedHandle)).toBe(ownedHandle);

    contributions.transferTo(registry(), "surface");
    expect(() => contributions.transferTo(registry(), "surface"))
      .toThrow("already transferred");
    expect(() => contributions.acquire("channels.dispose", () => undefined))
      .toThrow("already transferred");
  });

  it("uses the same handle for startup rollback and normal close exactly once", async () => {
    const cleanup = vi.fn(async () => undefined);
    const rollback = new StartupRollback();
    const contributions = new AssemblyLifecycleContributions(rollback);
    contributions.acquire("mcpHub.dispose", cleanup);
    const normal = registry();
    contributions.transferTo(normal, "surface");
    contributions.assertTransferred();

    await rollback.rollback();
    await normal.runAll("normal-close");

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("keeps acquired setup resources in reverse rollback order after a failure", async () => {
    const order: string[] = [];
    const rollback = new StartupRollback();
    const contributions = new AssemblyLifecycleContributions(rollback);
    contributions.acquire("mcpHub.dispose", () => {
      order.push("mcp");
    });
    contributions.acquire("authorityRuntime.stopStorageMaintenance", () => {
      order.push("authority");
      throw new Error("authority cleanup failed");
    });
    contributions.acquire("assetMaintenance.stop", () => {
      order.push("assets");
    });

    await expect(rollback.rollback()).rejects.toBeInstanceOf(AggregateError);
    expect(order).toEqual(["assets", "authority", "mcp"]);
  });

  it("preserves normal LIFO order while omitting inapplicable topology resources", async () => {
    const order: string[] = [];
    const contributions = new AssemblyLifecycleContributions(new StartupRollback());
    contributions.acquire("authorityRuntime.stopStorageMaintenance", () => {
      order.push("authority");
    });
    contributions.acquire("mcpHub.dispose", () => {
      order.push("mcp");
    });
    contributions.acquire("assetMaintenance.stop", () => {
      order.push("assets");
    });
    expect(contributions.has("localWorkspaceHost.close")).toBe(false);
    expect(contributions.has("executorDataPlane.close")).toBe(false);

    const normal = registry();
    contributions.transferTo(normal, "foundation");
    contributions.transferTo(normal, "surface");
    contributions.transferTo(normal, "runtime");
    contributions.assertTransferred();
    await normal.runAll("anchor-only");

    expect(order).toEqual(["assets", "mcp", "authority"]);
  });

  it("fails closed when an acquired contribution was not transferred", () => {
    const contributions = new AssemblyLifecycleContributions(new StartupRollback());
    contributions.acquire("meshRuntime.stop", () => undefined);
    expect(() => contributions.assertTransferred()).toThrow(
      "meshRuntime.stop",
    );
  });
});
