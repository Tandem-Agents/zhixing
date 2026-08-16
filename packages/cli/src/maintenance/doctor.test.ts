import { describe, expect, it, vi } from "vitest";
import { inspectLocalHealth } from "./doctor.js";

describe("inspectLocalHealth", () => {
  it("does not create config or credentials when setup has not started", async () => {
    const inspectConfig = vi.fn();
    const inspectBackup = vi.fn();
    const inspectManaged = vi.fn();
    await expect(inspectLocalHealth({
      configExists: async () => false,
      inspectConfig,
      inspectBackup,
      inspectManaged,
    })).resolves.toEqual({
      code: "setup-required",
      message: "知行尚未完成首次设置",
      action: "运行 zz 完成设置",
    });
    expect(inspectConfig).not.toHaveBeenCalled();
    expect(inspectBackup).not.toHaveBeenCalled();
    expect(inspectManaged).not.toHaveBeenCalled();
  });

  it("projects one managed-service recovery action from existing local facts", async () => {
    await expect(inspectLocalHealth({
      configExists: async () => true,
      inspectConfig: vi.fn(),
      inspectBackup: vi.fn(async () => undefined),
      inspectManaged: vi.fn(async () => ({ state: "needs-attention", action: "运行 zz 恢复托管" })),
    })).resolves.toEqual({
      code: "local-runtime-needs-attention",
      message: "本机运行状态需要处理",
      action: "运行 zz 恢复托管",
    });
  });

  it("does not leak raw local-state failures", async () => {
    const report = await inspectLocalHealth({
      configExists: async () => true,
      inspectConfig: () => { throw new Error("C:\\secret\\config.jsonc"); },
    });
    expect(report.code).toBe("local-state-unreadable");
    expect(JSON.stringify(report)).not.toContain("secret");
  });
});
