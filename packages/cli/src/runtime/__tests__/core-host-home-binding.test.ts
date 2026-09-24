import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  discover: vi.fn(),
  spawn: vi.fn(async () => ({ ok: true, status: "ready" })),
  stop: vi.fn(async () => ({ status: "stopped" })),
  surface: vi.fn(),
  reconcile: vi.fn(async () => ({ plan: { mode: "on-demand" } })),
}));
vi.mock("@zhixing/server", async (original) => ({
  ...await original<typeof import("@zhixing/server")>(),
  discoverServer: calls.discover,
}));
vi.mock("../../serve/daemon.js", () => ({ spawnDaemon: calls.spawn }));
vi.mock("../../serve/stop.js", () => ({ runStopCommand: calls.stop }));
vi.mock("../../serve/managed-service-runtime.js", () => ({
  reconcileCurrentManagedService: calls.reconcile,
}));
vi.mock("../surface-core-host-link.js", () => ({
  createCurrentAnchorSurfaceRpcClient: calls.surface,
}));

import { defaultCoreHostConnectionDeps } from "../core-host-connection.js";

describe("CoreHost default dependency home binding", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("keeps discovery, lazy spawn, turnover stop and remote surface on the entry root", async () => {
    const home = path.resolve("test-bound-home-a");
    const other = path.resolve("test-bound-home-b");
    const deps = defaultCoreHostConnectionDeps(home);
    const otherDeps = defaultCoreHostConnectionDeps(other);
    vi.stubEnv("ZHIXING_HOME", path.resolve("test-unrelated-home"));
    vi.stubEnv("ZHIXING_CONFIG_PATH", path.join(other, "override.jsonc"));

    await deps.discover();
    await otherDeps.discover();
    await deps.discover();
    expect(calls.discover.mock.calls.map(([paths]) => paths)).toEqual(
      [home, other, home].map((root) => ({
        pidPath: path.join(root, "server.pid"),
        portPath: path.join(root, "server.port"),
        tokenPath: path.join(root, "server.token"),
      })),
    );
    await deps.spawn();
    expect(calls.reconcile).toHaveBeenCalledWith("host-missing", undefined, home);
    expect(calls.spawn).toHaveBeenCalledWith(expect.objectContaining({ zhixingHome: home }));
    const endpoint = { pid: { pid: 42 } } as never;
    await deps.stopUnresponsiveHost!(endpoint, new Error("unresponsive"));
    expect(calls.stop).toHaveBeenCalledWith(expect.objectContaining({
      zhixingHome: home,
      expectedLock: { pid: 42 },
      respectBlockers: true,
    }));
    await deps.createSurfaceClient!();
    expect(calls.surface).toHaveBeenCalledWith({ zhixingHome: home });
  });

  it("passes one deadline and cancellation through to the daemon without a second recovery window", async () => {
    const attempt = { deadlineAt: Date.now() + 30_000, signal: new AbortController().signal };
    const result = await defaultCoreHostConnectionDeps(path.resolve("test-bound-home")).spawn(attempt);
    expect(calls.spawn).toHaveBeenCalledWith(expect.objectContaining({ ...attempt, reportFailure: false }));
    expect(result).toMatchObject({ ok: true, recoverable: false, mode: "on-demand" });
  });

  it("does not spawn after preparation has exhausted the startup budget", async () => {
    const result = await defaultCoreHostConnectionDeps(path.resolve("test-bound-home")).spawn({
      deadlineAt: Date.now() - 1, signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ ok: false, publicReason: "本机启动准备超时，请查看运行日志。" });
    expect(calls.spawn).not.toHaveBeenCalled();
  });
});
