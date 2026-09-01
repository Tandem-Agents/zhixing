import { describe, expect, it, vi } from "vitest";
import type { ServerInfoResult } from "../rpc-management-facade.js";
import type { ReplRuntimeConfigurationProjection } from "../runtime-configuration-provider.js";
import { ReplLocalView } from "../repl-local-view.js";

function serverInfo(workspace: string): ServerInfoResult {
  return {
    version: "0.0.0",
    protocol: 1,
    pid: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    uptimeSec: 0,
    activeConversations: 0,
    busyConversations: 0,
    connectionCount: 1,
    memoryRssBytes: 1,
    workspace,
  };
}

describe("ReplLocalView", () => {
  it("refresh 同步最新 config / workspace / proxy 派生视图", async () => {
    let configuration = replConfiguration("anthropic", "claude-a", "off");
    const management = {
      serverInfo: vi.fn(async () => serverInfo("/ws-a")),
    };
    const view = new ReplLocalView({
      management,
      configuration: { readReplSurface: () => configuration },
    });

    await view.refresh();
    expect(view.primaryModel.model).toBe("claude-a");
    expect(view.workspaceRoot).toBe("/ws-a");
    expect(view.networkProxy.mode).toBe("off");

    configuration = replConfiguration("openai", "gpt-next", "auto");
    management.serverInfo.mockResolvedValueOnce(serverInfo("/ws-b"));

    await view.refresh();
    expect(view.primaryModel.model).toBe("gpt-next");
    expect(view.workspaceRoot).toBe("/ws-b");
    expect(view.networkProxy.mode).toBe("auto");
  });

  it("serverInfo 不可用时保留配置派生,workspace 降为 null", async () => {
    const configuration = replConfiguration("openai", "gpt-next", "auto");
    const view = new ReplLocalView({
      management: { serverInfo: vi.fn(async () => Promise.reject(new Error("down"))) },
      configuration: { readReplSurface: () => configuration },
    });

    const snapshot = await view.refresh();

    expect(snapshot.primaryModel).toBe(configuration.primaryModel);
    expect(view.hostInfo).toBeNull();
    expect(view.workspaceRoot).toBeNull();
  });
});

function replConfiguration(
  providerId: string,
  model: string,
  proxyMode: "off" | "auto",
): ReplRuntimeConfigurationProjection {
  return Object.freeze({
    primaryModel: Object.freeze({ providerId, model }),
    networkProxy: Object.freeze({
      mode: proxyMode,
      hasResolvedProxy: false,
      display: proxyMode,
    }),
  });
}
