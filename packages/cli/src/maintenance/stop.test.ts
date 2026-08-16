import { describe, expect, it, vi } from "vitest";
import { runMaintenanceStop } from "./stop.js";

function managed() {
  return {
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
  };
}

describe("runMaintenanceStop", () => {
  it.each([
    { status: "nothing-to-stop" as const },
    { status: "stopped" as const, pid: 7, tookMs: 10, path: "rpc" as const },
  ])("keeps future launch disabled only after the safe stop terminal $status", async (result) => {
    const handle = managed();
    await expect(runMaintenanceStop({
      prepareManaged: async () => handle,
      stop: async () => result,
    })).resolves.toEqual(result);
    expect(handle.commit).toHaveBeenCalledOnce();
    expect(handle.rollback).not.toHaveBeenCalled();
  });

  it.each([
    { status: "error" as const, pid: 7, reason: "timeout" },
    { status: "refused" as const, pid: 7, reason: "busy", blockers: ["active"] },
  ])("restores only this operation's future-launch change after $status", async (result) => {
    const handle = managed();
    await expect(runMaintenanceStop({
      prepareManaged: async () => handle,
      stop: async () => result,
    })).resolves.toEqual(result);
    expect(handle.rollback).toHaveBeenCalledOnce();
    expect(handle.commit).not.toHaveBeenCalled();
  });

  it("rolls back when commit cannot prove the exact stopped definition", async () => {
    const handle = managed();
    handle.commit.mockRejectedValueOnce(new Error("definition changed"));
    await expect(runMaintenanceStop({
      prepareManaged: async () => handle,
      stop: async () => ({ status: "nothing-to-stop" }),
    })).rejects.toThrow("definition changed");
    expect(handle.rollback).toHaveBeenCalledOnce();
  });
});
