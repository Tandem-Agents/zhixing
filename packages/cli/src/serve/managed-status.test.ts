import { describe, expect, it } from "vitest";
import {
  buildManagedHostStatusSnapshot,
  projectManagedHostStatus,
} from "./status.js";

describe("managed host public status", () => {
  it.each([
    [{ desired: "none", process: "stopped" }, { state: "not-needed", label: "不需要后台运行" }],
    [{ desired: "on-demand", process: "stopped" }, { state: "not-needed", label: "不需要后台运行" }],
    [{
      desired: "managed",
      process: "stopped",
      service: { state: "enabled", running: false, matches: true },
    }, { state: "waiting-online", label: "等待开机上线" }],
    [{
      desired: "managed",
      process: "running",
      readiness: "recovering",
      service: { state: "enabled", running: true, matches: true },
    }, { state: "starting", label: "正在启动" }],
    [{
      desired: "managed",
      process: "running",
      readiness: "degraded",
      service: { state: "enabled", running: true, matches: true },
    }, { state: "ready", label: "可以使用" }],
    [{
      desired: "managed",
      process: "running",
      readiness: "stopping",
      service: { state: "enabled", running: true, matches: true },
    }, { state: "stopping", label: "正在结束当前工作" }],
  ] as const)("maps finite desired/service/process/readiness state", (input, expected) => {
    expect(projectManagedHostStatus(input)).toEqual(expected);
  });

  it("returns only stable product language and supported actions", () => {
    const status = projectManagedHostStatus({
      desired: "managed",
      process: "stopped",
      errorCode: "credentials-locked",
    });
    expect(status).toEqual({
      state: "needs-attention",
      label: "需要处理",
      action: "请解锁本机凭据",
    });
    expect(Object.keys(status).sort()).toEqual(["action", "label", "state"]);
    expect(JSON.stringify(status)).not.toMatch(/pid|path|device|role|epoch|secret|systemd|launchd/iu);
  });

  it("does not hide a failed recovery behind a running-unhealthy process", () => {
    expect(projectManagedHostStatus({
      desired: "managed",
      service: { state: "enabled", running: true, matches: true },
      process: "running-unhealthy",
      readiness: "failed",
    })).toEqual({
      state: "needs-attention",
      label: "需要处理",
      action: "请重新运行配对设置",
    });
  });

  it("does not hide definition drift or a running managed instance behind desired none", () => {
    expect(projectManagedHostStatus({
      desired: "none",
      service: { state: "enabled", running: true, matches: true },
      process: "running",
      readiness: "ready",
    })).toEqual({ state: "stopping", label: "正在结束当前工作" });
    expect(projectManagedHostStatus({
      desired: "none",
      service: { state: "disabled", running: false, matches: false },
      process: "stopped",
    })).toEqual({
      state: "needs-attention",
      label: "需要处理",
      action: "请重新运行配对设置",
    });
  });

  it("retries a changing current snapshot instead of mixing generations", async () => {
    const first = { localDeviceId: "device-a" };
    const second = { localDeviceId: "device-b" };
    const values = [first, second, second, second];
    const loads: string[] = [];
    const snapshot = await buildManagedHostStatusSnapshot(
      { status: "stopped" },
      {
        deps: {
          loadCurrent: async () => {
            const current = values.shift() ?? second;
            loads.push(current.localDeviceId);
            return current;
          },
          adapter: {
            inspect: async () => {
              throw new Error("no service should be inspected");
            },
          },
        },
      },
    );
    expect(loads).toEqual(["device-a", "device-b", "device-b", "device-b"]);
    expect(snapshot).toEqual({
      desired: "on-demand",
      process: "stopped",
      readiness: "recovering",
    });
  });
});
