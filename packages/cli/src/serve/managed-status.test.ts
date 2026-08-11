import { describe, expect, it } from "vitest";
import { projectManagedHostStatus } from "./status.js";

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
});
