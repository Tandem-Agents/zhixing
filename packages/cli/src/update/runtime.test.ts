import { describe, expect, it, vi } from "vitest";
import type { ProgramUpdateReceipt } from "@zhixing/core/protocol";
import { createServerContext, DEFAULT_SERVER_CONFIG, startServer } from "@zhixing/server";
import {
  startAutomaticUpdateCheck,
  startManagedUpdateChecks,
  verifyLocalUpgradeHealth,
} from "./runtime.js";

describe("automatic update runtime", () => {
  it("never waits for the network and coalesces failures inside the controller", async () => {
    const checkFailSafe = vi.fn(async (): Promise<ProgramUpdateReceipt | undefined> => undefined);
    startAutomaticUpdateCheck({ controller: { checkFailSafe } as never });
    expect(checkFailSafe).toHaveBeenCalledOnce();
    await Promise.resolve();
  });

  it("runs a bounded managed schedule without creating a daemon", () => {
    const checkFailSafe = vi.fn(async (): Promise<ProgramUpdateReceipt | undefined> => undefined);
    let scheduled: (() => void) | undefined;
    const timer = { unref: vi.fn() };
    const clearIntervalFn = vi.fn();
    const stop = startManagedUpdateChecks({
      controller: { checkFailSafe } as never,
      setIntervalFn: ((callback: () => void) => {
        scheduled = callback;
        return timer;
      }) as never,
      clearIntervalFn: clearIntervalFn as never,
    });
    expect(checkFailSafe).toHaveBeenCalledOnce();
    expect(timer.unref).toHaveBeenCalledOnce();
    scheduled?.();
    expect(checkFailSafe).toHaveBeenCalledTimes(2);
    stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
  });

  it("verifies the exact target through the authenticated loopback RPC dispatcher", async () => {
    let endpoint = { host: "127.0.0.1", port: 1 };
    const expected = {
      releaseManifestDigest: `sha256:${"b".repeat(64)}`,
      protocolRange: { readMin: "1", readMax: "1", writeVersion: "1" },
      durableSchemas: [{ schemaId: "AuthorityCommitEnvelope", readMin: "1", readMax: "1", writeVersion: "1" }],
      homeId: "home-health",
      endpoint,
      rolePlan: { host: "anchor-host", loadExecutor: true },
    } as const;
    const context = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, host: endpoint.host, port: 0 },
      version: "0.1.0-test",
      token: "update-health-token",
      programUpdateHealth: async () => ({ ...expected, endpoint }),
    });
    const server = await startServer({ context });
    endpoint = { host: server.host, port: server.port };
    try {
      await expect(verifyLocalUpgradeHealth({
        endpoint,
        token: "update-health-token",
        expected: { ...expected, endpoint },
      })).resolves.toMatch(/^sha256:[a-f0-9]{64}$/u);
      await expect(verifyLocalUpgradeHealth({
        endpoint,
        token: "update-health-token",
        expected: { ...expected, endpoint, homeId: "wrong-home" },
      })).rejects.toThrow(/health does not match/iu);
    } finally {
      await server.close();
    }
  });
});
