import { describe, expect, it, vi } from "vitest";
import type { ZhixingConfig } from "@zhixing/providers";
import type { ServerInfoResult } from "../rpc-management-facade.js";
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
    let config = {
      llm: { main: { provider: "anthropic", model: "claude-a" } },
      network: { proxy: "off" },
    } as unknown as ZhixingConfig;
    const management = {
      serverInfo: vi.fn(async () => serverInfo("/ws-a")),
    };
    const view = new ReplLocalView({
      management,
      loadConfig: () => config,
    });

    await view.refresh();
    expect(view.config.llm?.main?.model).toBe("claude-a");
    expect(view.workspaceRoot).toBe("/ws-a");
    expect(view.networkProxy.mode).toBe("off");

    config = {
      llm: { main: { provider: "openai", model: "gpt-next" } },
      network: { proxy: "auto" },
    } as unknown as ZhixingConfig;
    management.serverInfo.mockResolvedValueOnce(serverInfo("/ws-b"));

    await view.refresh();
    expect(view.config.llm?.main?.model).toBe("gpt-next");
    expect(view.workspaceRoot).toBe("/ws-b");
    expect(view.networkProxy.mode).toBe("auto");
  });

  it("serverInfo 不可用时保留配置派生,workspace 降为 null", async () => {
    const config = {
      llm: { main: { provider: "openai", model: "gpt-next" } },
    } as unknown as ZhixingConfig;
    const view = new ReplLocalView({
      management: { serverInfo: vi.fn(async () => Promise.reject(new Error("down"))) },
      loadConfig: () => config,
    });

    await view.refresh();

    expect(view.config).toBe(config);
    expect(view.hostInfo).toBeNull();
    expect(view.workspaceRoot).toBeNull();
  });
});
