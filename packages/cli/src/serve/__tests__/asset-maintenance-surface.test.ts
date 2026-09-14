import { describe, expect, it } from "vitest";
import { startAssetMaintenance, type StartAssetMaintenanceInput } from "../access-surfaces.js";
import { StartupRollback } from "../startup-rollback.js";
import { AssemblyLifecycleContributions } from "../assembly-lifecycle.js";

describe("Host asset maintenance", () => {
  it("collects on the single-machine topology and transfers the same cleanup", async () => {
    let collections = 0;
    const startupRollback = new StartupRollback();
    const input = Object.freeze({
      authorityRuntime: {
        surfaceAssets: {
          collectExpiredTemporaryAssets: async () => {
            collections += 1;
            return { processed: 0, removed: 0, hasMore: false };
          },
        },
      },
      lifecycleContributions: new AssemblyLifecycleContributions(startupRollback),
    }) as unknown as StartAssetMaintenanceInput;
    const maintenance = await startAssetMaintenance(input);
    try {
      expect(collections).toBe(1);
      expect(maintenance).toBeDefined();
      expect(input).not.toHaveProperty("assetMaintenance");
      expect(input.lifecycleContributions.has("assetMaintenance.stop")).toBe(true);
    } finally {
      await startupRollback.rollback();
      await maintenance.stop();
    }
  });

  it("requires its authority rather than silently omitting a core responsibility", async () => {
    await expect(startAssetMaintenance({} as never)).rejects.toThrow("requires the authority");
  });
});
