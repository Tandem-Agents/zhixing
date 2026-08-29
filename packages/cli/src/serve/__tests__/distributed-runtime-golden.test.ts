import { CleanupRegistry } from "@zhixing/server";
import { assertGolden } from "@zhixing/test-utils";
import { describe, it, vi } from "vitest";
import { AssemblyLifecycleContributions } from "../assembly-lifecycle.js";
import { StartupRollback } from "../startup-rollback.js";
import { AnchorHostShellLifecycle } from "../anchor-host-shell-lifecycle.js";

describe("runtime lifecycle migration golden", () => {
  it("matches registration and cleanup order", async () => {
    const executed: string[] = [];
    const registry = new CleanupRegistry({ logger: { error() {} } });
    const register = vi.spyOn(registry, "register");
    const rollback = new StartupRollback();
    const lifecycleContributions = new AssemblyLifecycleContributions(rollback);
    const shell = new AnchorHostShellLifecycle({
      startupRollback: rollback,
      processInfo: { startTime: null, startedAt: "t" },
      dependencies: {
        acquireLock: vi.fn(async () => undefined),
        readLock: vi.fn(async () => null),
        releaseLock: vi.fn(async () => undefined),
      },
    });
    const endpoint = {
      host: "127.0.0.1",
      port: 3210,
      httpServer: { listening: true },
      close: vi.fn(async () => {
        executed.push("server.close");
      }),
    };
    shell.acquireBinding(endpoint as never);
    shell.acquireStateFile({
      cleanup: async () => {
        executed.push("stateFile.cleanup");
      },
      heartbeat: async () => undefined,
      markReady: async () => undefined,
      markRunning: async () => undefined,
      markStopped: async () => {
        executed.push("stateFile.markStopped");
      },
      markStopping: async () => {
        executed.push("stateFile.markStopping");
      },
    });
    shell.acquireCheckpointOwner({
      stop: async () => {
        executed.push("authorityCheckpointOwner.stop");
      },
    });
    shell.acquireServerLog({
      stop: () => executed.push("serverLogLifecycle.stop"),
    });
    shell.transferPreparedServer(endpoint as never, registry);
    lifecycleContributions.acquire("mcpHub.dispose", async () => {
      executed.push("mcpHub.dispose");
    });
    lifecycleContributions.acquire("channels.dispose", async () => {
      executed.push("channels.dispose");
    });
    lifecycleContributions.acquire("deliveryStack.stop", async () => {
      executed.push("deliveryStack.stop");
    });
    lifecycleContributions.transferTo(registry, "foundation");
    lifecycleContributions.transferTo(registry, "surface");
    const registered = register.mock.calls.map(([name]) => name);
    await registry.runAll("golden-shutdown");

    await assertGolden(
      new URL("./__goldens__/runtime-lifecycle.golden.json", import.meta.url),
      { registered, executed },
    );
  });
});
