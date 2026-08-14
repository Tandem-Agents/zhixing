import { describe, expect, it, vi } from "vitest";
import { inspectProgramHealth, printProgramDoctorReport } from "./doctor.js";

describe("offline program doctor", () => {
  it("uses the shared update projection and exposes one stable action without raw errors", async () => {
    const report = await inspectProgramHealth({
      store: {
        loadPointer: async () => ({
          v: 1,
          target: "linux-x64",
          generation: 1,
          current: {
            manifestDigest: `sha256:${"a".repeat(64)}`,
            releaseVersion: "0.1.0",
            releaseSequence: "1",
            directory: "0.1.0-a",
          },
        }),
        loadReceipt: async () => ({
          v: 1,
          currentManifestDigest: `sha256:${"a".repeat(64)}`,
          target: "linux-x64",
          phase: "idle",
          notice: "failed-safe",
          code: "network-unavailable",
          action: "retry-update",
        }),
      } as never,
      statusDeps: {
        readLockFn: async () => null,
      },
      managedStatus: async () => ({ state: "not-needed", label: "不需要后台运行" }),
      checkpointConfiguration: async () => "not-configured",
    });
    expect(report).toEqual({
      code: "network-unavailable",
      message: "自动更新失败，仍在使用原版本",
      action: "retry-update",
    });
  });

  it("uses local update facts only when topology proves this device is current authority", async () => {
    const store = {
      loadPointer: async () => ({
        v: 1,
        target: "linux-x64",
        generation: 1,
        current: {
          manifestDigest: `sha256:${"a".repeat(64)}`,
          releaseVersion: "0.1.0",
          releaseSequence: "1",
          directory: "0.1.0-a",
        },
      }),
      loadReceipt: async () => ({
        v: 1,
        currentManifestDigest: `sha256:${"a".repeat(64)}`,
        target: "linux-x64",
        phase: "idle",
        notice: "failed-safe",
        code: "network-unavailable",
        action: "retry-update",
      }),
    } as never;
    const currentAuthorityStatus = async () => ({ availability: "unavailable" as const });

    await expect(inspectProgramHealth({
      store,
      currentAuthorityStatus,
      localIsCurrentAuthority: async () => false,
    })).resolves.toEqual({
      code: "current-authority-unavailable",
      message: "当前权威设备暂不可达，无法确认更新状态",
      action: "retry-update",
    });
    await expect(inspectProgramHealth({
      store,
      currentAuthorityStatus,
      localIsCurrentAuthority: async () => true,
    })).resolves.toEqual({
      code: "network-unavailable",
      message: "自动更新失败，仍在使用原版本",
      action: "retry-update",
    });
  });

  it("projects unreadable local state to a fixed safe problem code", async () => {
    const report = await inspectProgramHealth({
      store: { loadReceipt: async () => { throw new Error("C:\\secret\\token raw"); } } as never,
    });
    expect(report).toEqual({
      code: "local-state-unreadable",
      message: "本机状态无法安全确认",
      action: "contact-support",
    });
    const log = vi.fn();
    printProgramDoctorReport(report, { log });
    expect(log.mock.calls.flat().join(" ")).not.toContain("secret");
  });

  it("reports an incomplete installation without touching managed or checkpoint state", async () => {
    const managedStatus = vi.fn();
    const checkpointConfiguration = vi.fn();
    const report = await inspectProgramHealth({
      store: {
        loadPointer: async () => undefined,
        loadReceipt: async () => undefined,
      } as never,
      managedStatus,
      checkpointConfiguration,
    });
    expect(report).toEqual({
      code: "program-not-installed",
      message: "知行应用尚未完整安装",
      action: "contact-support",
    });
    expect(managedStatus).not.toHaveBeenCalled();
    expect(checkpointConfiguration).not.toHaveBeenCalled();
  });
});
