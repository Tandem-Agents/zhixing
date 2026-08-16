import { describe, expect, it, vi } from "vitest";
import { prepareApplicationUninstall } from "./prepare-uninstall.js";

function managed() {
  return {
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
  };
}

describe("prepareApplicationUninstall", () => {
  it("unregisters future launch only after current execution safely stops", async () => {
    const handle = managed();
    const order: string[] = [];
    handle.commit.mockImplementation(async () => { order.push("unregister"); });
    await prepareApplicationUninstall({
      prepareManaged: async () => handle,
      stop: async () => {
        order.push("stop");
        return { status: "stopped", pid: 7, tookMs: 10, path: "rpc" };
      },
    });
    expect(order).toEqual(["stop", "unregister"]);
    expect(handle.rollback).not.toHaveBeenCalled();
  });

  it.each([
    { status: "error" as const, pid: 7, reason: "timeout" },
    { status: "refused" as const, pid: 7, reason: "busy", blockers: ["active"] },
  ])("restores future launch and keeps the package after $status", async (result) => {
    const handle = managed();
    await expect(prepareApplicationUninstall({
      prepareManaged: async () => handle,
      stop: async () => result,
    })).rejects.toThrow("程序保持不变");
    expect(handle.commit).not.toHaveBeenCalled();
    expect(handle.rollback).toHaveBeenCalledOnce();
  });

  it("reports an actionable stable failure if compensation cannot be proven", async () => {
    const handle = managed();
    handle.rollback.mockRejectedValueOnce(new Error("read-back failed"));
    await expect(prepareApplicationUninstall({
      prepareManaged: async () => handle,
      stop: async () => ({ status: "error", pid: 7, reason: "timeout" }),
    })).rejects.toThrow("请运行 zz doctor");
  });
});
