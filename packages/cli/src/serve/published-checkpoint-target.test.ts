import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createPublishedCheckpointTargetInfrastructure } from "./published-checkpoint-target-infrastructure.js";
import {
  projectInventoryPublishedRecoveryCheckpointTarget,
  projectRetirablePublishedRecoveryCheckpointTarget,
  type InventoryPublishedRecoveryCheckpointTarget,
} from "./published-checkpoint-target.js";

describe("published checkpoint target boundary", () => {
  it("projects only the finite retirable and inventory capabilities", async () => {
    const writeDurable = vi.fn(async () => undefined);
    const read = vi.fn(async () => {
      throw new Error("unused");
    });
    const retire = vi.fn(async () => undefined);
    const inventory = vi.fn(async () => []);
    const physical = {
      targetId: "backup-device:target",
      independenceDomain: "device:target",
      writeDurable,
      read,
      retire,
      inventory,
      close: vi.fn(async () => undefined),
      physicalPath: "must-not-leak",
    } satisfies InventoryPublishedRecoveryCheckpointTarget & {
      readonly close: () => Promise<void>;
      readonly physicalPath: string;
    };

    const retirable = projectRetirablePublishedRecoveryCheckpointTarget(physical);
    const projected = projectInventoryPublishedRecoveryCheckpointTarget(physical);

    expect(Object.keys(retirable).sort()).toEqual([
      "independenceDomain",
      "read",
      "retire",
      "targetId",
      "writeDurable",
    ]);
    expect(Object.keys(projected).sort()).toEqual([
      "independenceDomain",
      "inventory",
      "read",
      "retire",
      "targetId",
      "writeDurable",
    ]);
    expect(Object.isFrozen(retirable)).toBe(true);
    expect(Object.isFrozen(projected)).toBe(true);
    await expect(projected.inventory("inventory-1")).resolves.toEqual([]);
    expect(inventory).toHaveBeenCalledWith("inventory-1", undefined);
  });

  it("owns canonical paired filesystem targets behind an idempotent bounded session", async () => {
    const home = await createTempDir("published-checkpoint-target");
    await mkdir(path.join(home, "distributed-runtime", "authority"), { recursive: true });
    const infrastructure = createPublishedCheckpointTargetInfrastructure({ zhixingHome: home });

    expect(Object.keys(infrastructure).sort()).toEqual([
      "deferredPaired",
      "directory",
      "directoryInventory",
      "paired",
    ]);
    const session = await infrastructure.paired.openPaired("device-target");
    expect(session.target.targetId).toBe("backup-device:device-target");
    expect(session.target.independenceDomain).toBe("device:device-target");
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.target)).toBe(true);
    await session.close();
    await expect(session.close()).resolves.toBeUndefined();
  });
});
