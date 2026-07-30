import { describe, expect, it } from "vitest";
import { createAssemblyUnits } from "../access-surfaces.js";
import type { AssemblyContext } from "../access-surface.js";
import { PROFILES } from "../profile.js";
import { StartupRollback } from "../startup-rollback.js";

const assetMaintenanceSurface = createAssemblyUnits({}).find(
  (surface) => surface.name === "asset-maintenance",
)!;

/**
 * 资产回收的所有权验收：它必须在默认单机拓扑下也被真正装配并驱动。
 *
 * 此前该调度挂在只于多机拓扑创建的 mesh 控制面上，默认单机锚点因而永不回收；
 * 这些用例锁住"持有者在全部拓扑下都存在"这一结论，而不是只测调度器本身。
 */
describe("asset maintenance surface", () => {
  it("is enabled by the server profile and ordered after the authority runtime", () => {
    expect(PROFILES.full.surfaces).toContain("asset-maintenance");
    const names = createAssemblyUnits({}).map((surface) => surface.name);
    expect(names.indexOf("asset-maintenance")).toBeGreaterThan(
      names.indexOf("authority-runtime"),
    );
    expect(assetMaintenanceSurface.phase).toBe("pre-server");
  });

  it("drives collection on the single-machine topology", async () => {
    let collections = 0;
    const ctx = {
      enabledRoles: ["anchor"],
      authorityRuntime: {
        surfaceAssets: {
          collectExpiredTemporaryAssets: async () => {
            collections += 1;
            return { processed: 0, removed: 0, hasMore: false };
          },
        },
      },
      // 单机拓扑：没有 mesh bootstrap，也不会创建 mesh 控制面。
      meshBootstrap: { mode: "single-machine" },
      startupRollback: new StartupRollback(),
      startupCleanups: {},
    } as unknown as AssemblyContext;

    await assetMaintenanceSurface.setup(ctx);
    expect(collections).toBe(1);
    expect(ctx.assetMaintenance).toBeDefined();
    await ctx.assetMaintenance!.stop();
  });

  it("stays inert when the anchor role is not enabled", async () => {
    const ctx = {
      enabledRoles: ["executor"],
      authorityRuntime: undefined,
      meshBootstrap: { mode: "single-machine" },
    } as unknown as AssemblyContext;

    await assetMaintenanceSurface.setup(ctx);
    expect(ctx.assetMaintenance).toBeUndefined();
  });
});
