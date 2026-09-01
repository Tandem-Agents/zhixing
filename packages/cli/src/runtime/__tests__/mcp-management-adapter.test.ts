import { beforeEach, describe, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({
  probeServer: vi.fn(),
  searchMcpServers: vi.fn(),
  fetchMcpServerSource: vi.fn(),
}));

vi.mock("@zhixing/mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zhixing/mcp")>()),
  isValidServerId: (serverId: string) =>
    serverId.length > 0 && serverId.length <= 40 && !serverId.includes("__") &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]*[a-zA-Z0-9])?$/.test(serverId),
  probeServer: doubles.probeServer,
  searchMcpServers: doubles.searchMcpServers,
  fetchMcpServerSource: doubles.fetchMcpServerSource,
}));

import { createMcpManagementAdapter } from "../mcp-management-adapter.js";

describe("MCP management infrastructure adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.probeServer.mockResolvedValue({ ok: true, tools: [] });
    doubles.searchMcpServers.mockResolvedValue([]);
    doubles.fetchMcpServerSource.mockResolvedValue({ kind: "not-found" });
  });

  it("strictly projects and freezes the finite Host status snapshot", async () => {
    const adapter = createMcpManagementAdapter({
      readStatusWire: async () => [{
        serverId: "docs",
        transport: "http",
        status: "connected",
        toolCount: 3,
      }],
    });

    const snapshot = await adapter.snapshot();
    expect(snapshot).toEqual([{
      serverId: "docs",
      transport: "http",
      status: "connected",
      toolCount: 3,
    }]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    await expect(createMcpManagementAdapter({
      readStatusWire: async () => [{
        serverId: "docs",
        transport: "http",
        status: "connected",
        toolCount: 3,
        extra: true,
      }],
    }).snapshot()).rejects.toThrow("MCP status entry is invalid");
  });

  it("owns concrete spec conversion and keeps credentials behind the probe boundary", async () => {
    const signal = new AbortController().signal;
    const adapter = createMcpManagementAdapter({
      proxy: "off",
      readStatusWire: async () => [],
    });
    await adapter.probe({
      serverId: "local",
      transport: "stdio",
      command: "npx",
      args: ["-y", "local-mcp"],
      credentials: { TOKEN: "secret" },
    }, signal);
    await adapter.probe({
      serverId: "remote",
      transport: "http",
      url: "https://mcp.example.test",
      credentials: { Authorization: "Bearer secret" },
    }, signal);

    expect(doubles.probeServer).toHaveBeenNthCalledWith(1, {
      serverId: "local",
      transport: "stdio",
      command: "npx",
      args: ["-y", "local-mcp"],
      env: { TOKEN: "secret" },
    }, { proxy: "off", signal });
    expect(doubles.probeServer).toHaveBeenNthCalledWith(2, {
      serverId: "remote",
      transport: "http",
      url: "https://mcp.example.test",
      headers: { Authorization: "Bearer secret" },
    }, { proxy: "off", signal });
  });

  it("maps probe/search/source results and propagates the same proxy and cancellation", async () => {
    doubles.probeServer.mockResolvedValueOnce({ ok: false, error: "connect failed" });
    doubles.searchMcpServers.mockResolvedValueOnce([{
      name: "docs-mcp",
      description: "Docs",
      keywords: ["mcp"],
      downloads: 42,
    }]);
    doubles.fetchMcpServerSource.mockResolvedValueOnce({
      kind: "found",
      readme: "# docs",
      homepage: "https://docs.example.test",
    });
    const signal = new AbortController().signal;
    const adapter = createMcpManagementAdapter({
      proxy: "http://proxy.example.test",
      readStatusWire: async () => [],
    });

    await expect(adapter.probe({
      serverId: "docs",
      transport: "stdio",
      command: "docs-mcp",
      credentials: {},
    }, signal)).resolves.toEqual({ ok: false, error: "connect failed" });
    await expect(adapter.search("docs", signal)).resolves.toEqual([{
      name: "docs-mcp",
      description: "Docs",
      keywords: ["mcp"],
      downloads: 42,
    }]);
    await expect(adapter.readSource("docs-mcp", signal)).resolves.toEqual({
      kind: "found",
      readme: "# docs",
      homepage: "https://docs.example.test",
    });
    expect(doubles.searchMcpServers).toHaveBeenCalledWith("docs", {
      proxy: "http://proxy.example.test",
      signal,
    });
    expect(doubles.fetchMcpServerSource).toHaveBeenCalledWith("docs-mcp", {
      proxy: "http://proxy.example.test",
      signal,
    });
    expect(adapter.isServerIdValid("bad__id")).toBe(false);
  });
});
