import { describe, expect, it, vi } from "vitest";
import {
  DURABLE_SCHEMA_INVENTORY,
  type DeviceLifecycleOperation,
  type ProgramUpdateReceipt,
  type ReleaseManifest,
} from "@zhixing/core/protocol";
import { createServerContext, DEFAULT_SERVER_CONFIG, startServer } from "@zhixing/server";
import {
  startAutomaticUpdateCheck,
  startManagedUpdateChecks,
  buildProgramUpdateProjection,
  buildProgramUpdateHealthSnapshot,
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
      trust: { generation: 1, digest: `sha256:${"c".repeat(64)}` },
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

  it("binds candidate health to the exact signed Node runtime", () => {
    const manifest = {
      nodeVersion: "22.18.0",
      protocolRange: { readMin: "1", readMax: "1", writeVersion: "1" },
      durableSchemas: DURABLE_SCHEMA_INVENTORY,
    } as ReleaseManifest;
    const input = {
      manifest,
      manifestDigest: `sha256:${"b".repeat(64)}`,
      homeId: "home-health",
      endpoint: { host: "127.0.0.1", port: 39_801 },
      rolePlan: { host: "anchor-host", loadExecutor: true },
      trust: { generation: 1, digest: `sha256:${"c".repeat(64)}` },
    } as const;
    expect(buildProgramUpdateHealthSnapshot({ ...input, runtimeVersion: "22.18.0" }))
      .toMatchObject({ releaseManifestDigest: input.manifestDigest });
    expect(() => buildProgramUpdateHealthSnapshot({ ...input, runtimeVersion: "22.19.0" }))
      .toThrow("runtime version does not match");
  });

  it("projects only a receipt that agrees with pointer, stage, lifecycle and health", () => {
    const source = `sha256:${"1".repeat(64)}`;
    const candidate = `sha256:${"2".repeat(64)}`;
    const receipt = {
      v: 1,
      currentManifestDigest: source,
      target: "linux-x64",
      candidateManifestDigest: candidate,
      phase: "handed-off",
      operationId: "upgrade-status",
      notice: "none",
    } as const satisfies ProgramUpdateReceipt;
    const lifecycle = {
      identity: {
        v: 1,
        kind: "upgrade",
        requestId: "request-status",
        operationId: receipt.operationId,
        homeId: "home-status",
        localDeviceId: "device-status",
        fromReleaseVersion: "1.0.0",
        fromManifestDigest: source,
        targetReleaseVersion: "1.1.0",
        targetManifestDigest: candidate,
        stageDigest: `sha256:${"3".repeat(64)}`,
        pointerGeneration: 1,
        host: { pid: 1, startTime: 1, endpoint: { host: "127.0.0.1", port: 39_801 } },
      },
      subjectDeviceId: "device-status",
      phase: "gate-closed",
      evidence: [],
      recordDigests: {},
      peerEffects: [],
    } as unknown as DeviceLifecycleOperation;
    expect(buildProgramUpdateProjection({
      receipt,
      pointerCurrentManifestDigest: source,
      stagedManifestDigest: candidate,
      lifecycle,
    })).toMatchObject({ state: "installing", message: "正在更新" });
    expect(buildProgramUpdateProjection({
      receipt,
      pointerCurrentManifestDigest: candidate,
      stagedManifestDigest: candidate,
      lifecycle,
    })).toMatchObject({ state: "action-required", code: "update-state-inconsistent" });
    expect(buildProgramUpdateProjection({
      receipt: {
        v: 1,
        currentManifestDigest: candidate,
        target: "linux-x64",
        phase: "idle",
        notice: "updated",
      },
      pointerCurrentManifestDigest: candidate,
      health: { releaseManifestDigest: source } as never,
    })).toMatchObject({ state: "action-required", code: "update-state-inconsistent" });
  });
});
