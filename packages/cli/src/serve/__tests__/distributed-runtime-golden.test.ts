import { CleanupRegistry } from "@zhixing/server";
import { assertGolden } from "@zhixing/test-utils";
import { describe, it, vi } from "vitest";
import {
  registerCoreCleanup,
  registerTailCleanup,
  type ShutdownChainResources,
} from "../shutdown-chain.js";

describe("runtime lifecycle migration golden", () => {
  it("matches registration and cleanup order", async () => {
    const executed: string[] = [];
    const registry = new CleanupRegistry({ logger: { error() {} } });
    const register = vi.spyOn(registry, "register");
    const resources: ShutdownChainResources = {
      heartbeatTimerRef: { current: null },
      stateFile: {
        cleanup: async () => {
          executed.push("stateFile.cleanup");
        },
        markStopped: async () => {
          executed.push("stateFile.markStopped");
        },
        markStopping: async () => {
          executed.push("stateFile.markStopping");
        },
      } as never,
      scheduler: {
        stop: async () => {
          executed.push("scheduler.stop");
        },
      } as never,
      mcpHub: {
        dispose: async () => {
          executed.push("mcpHub.dispose");
        },
      } as never,
      channels: {
        dispose: async () => {
          executed.push("channels.dispose");
        },
      } as never,
      deliveryStack: {
        stop: async () => {
          executed.push("deliveryStack.stop");
        },
      } as never,
    };

    registerTailCleanup(registry, resources);
    registry.register("server.close", () => {
      executed.push("server.close");
    });
    registerCoreCleanup(registry, resources);
    const registered = register.mock.calls.map(([name]) => name);
    await registry.runAll("golden-shutdown");

    await assertGolden(
      new URL("./__goldens__/runtime-lifecycle.golden.json", import.meta.url),
      { registered, executed },
    );
  });
});
