import { describe, expect, it, vi } from "vitest";
import { connectReplHost } from "../repl-host-startup.js";
import type { StartupCheckResult } from "../../startup.js";

function fixture() {
  return {
    connection: { ensure: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) },
    checkConfiguration: vi.fn<() => Promise<StartupCheckResult>>(),
    starting: vi.fn(), settled: vi.fn(),
  };
}

describe("REPL Host startup", () => {
  it("uses the authenticated Host without reading local credentials again", async () => {
    const f = fixture();
    expect(await connectReplHost(f)).toEqual({ kind: "connected" });
    expect(f.checkConfiguration).not.toHaveBeenCalled();
    expect(f.starting).toHaveBeenCalledOnce();
    expect(f.settled).toHaveBeenCalledOnce();
  });

  it.each([false, true])("only retries after completed setup (completed=%s)", async (completed) => {
    const f = fixture();
    const error = new Error("host failed");
    f.connection.ensure.mockRejectedValueOnce(error);
    f.checkConfiguration.mockResolvedValue({ kind: "ready", ...(completed ? { configurationCompleted: true } : {}) } as StartupCheckResult);
    expect(await connectReplHost(f)).toEqual(completed ? { kind: "connected" } : { kind: "unavailable", error });
    expect(f.connection.ensure).toHaveBeenCalledTimes(completed ? 2 : 1);
    expect(f.settled).toHaveBeenCalledTimes(completed ? 2 : 1);
    expect(f.settled.mock.invocationCallOrder[0]).toBeLessThan(f.checkConfiguration.mock.invocationCallOrder[0]!);
  });

  it("preserves cancellation and configuration errors without another launch", async () => {
    for (const result of [{ kind: "cancelled" }, { kind: "non-tty", missingLabels: ["model"] },
      { kind: "secret-store-error", filePath: "fixture", message: "locked" }] as const) {
      const f = fixture();
      f.connection.ensure.mockRejectedValue(new Error("not ready"));
      f.checkConfiguration.mockResolvedValue(result as StartupCheckResult);
      expect(await connectReplHost(f)).toEqual({ kind: "configuration", result });
      expect(f.connection.ensure).toHaveBeenCalledOnce();
    }
  });

  it("hands a failed post-setup connection to the existing read-only fallback", async () => {
    const f = fixture();
    const error = new Error("recovery failed");
    f.connection.ensure.mockRejectedValue(error);
    f.checkConfiguration.mockResolvedValue({ kind: "ready", configurationCompleted: true } as StartupCheckResult);
    expect(await connectReplHost(f)).toEqual({ kind: "unavailable", error });
    expect(f.connection.ensure).toHaveBeenCalledTimes(2);
    expect(f.checkConfiguration).toHaveBeenCalledOnce();
  });
});
