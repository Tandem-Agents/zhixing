import type { ToolExecutionContext } from "@zhixing/core";
import type { McpHub, McpServerCatalog, McpServerStatus } from "@zhixing/mcp";
import { describe, expect, it, vi } from "vitest";
import { adaptMcpHub } from "../mcp-runtime-adapter.js";

function hubFixture() {
  let catalog: McpServerCatalog[] = [{
    server: { serverId: "demo", transport: "stdio" },
    tools: [{
      name: "read.item",
      description: "Read one item",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      readOnlyHint: true,
    }],
  }];
  let statuses: McpServerStatus[] = [{
    serverId: "demo",
    transport: "stdio",
    status: "connected",
    toolCount: 1,
  }];
  const connectAll = vi.fn(async () => undefined);
  const dispose = vi.fn(async () => undefined);
  const callTool = vi.fn(async () => ({ content: "ok" }));
  const hub: McpHub = {
    connectAll,
    applyConfig: vi.fn(async () => undefined),
    catalog: () => catalog,
    serverStatuses: () => statuses,
    callTool,
    dispose,
  };
  return {
    hub,
    connectAll,
    dispose,
    callTool,
    replaceCatalog(next: McpServerCatalog[]) {
      catalog = next;
    },
    replaceStatuses(next: McpServerStatus[]) {
      statuses = next;
    },
  };
}

describe("Host MCP runtime adapter", () => {
  it("projects one frozen coherent catalog and preserves call/security metadata", async () => {
    const fixture = hubFixture();
    const runtime = adaptMcpHub(fixture.hub);
    const snapshot = runtime.tools.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tools)).toBe(true);
    expect(Object.isFrozen(snapshot.tools[0])).toBe(true);
    expect(Object.isFrozen(snapshot.serverIds)).toBe(true);
    expect(snapshot.serverIds).toEqual(["demo"]);
    expect(snapshot.tools[0]).toMatchObject({
      name: "mcp__demo__read_item",
      isReadOnly: true,
      isParallelSafe: true,
      needsPermission: true,
      interruptBehavior: "grace",
      boundaries: [{ boundaryType: "external-service", access: "query", dynamic: false }],
    });

    const controller = new AbortController();
    await snapshot.tools[0]!.call(
      { id: "1" },
      { workingDirectory: "/tmp", abortSignal: controller.signal } as ToolExecutionContext,
    );
    expect(fixture.callTool).toHaveBeenCalledWith(
      "demo",
      "read.item",
      { id: "1" },
      { signal: controller.signal },
    );
  });

  it("takes a fresh all-or-one catalog snapshot for every runtime issue", () => {
    const fixture = hubFixture();
    const runtime = adaptMcpHub(fixture.hub);
    const first = runtime.tools.snapshot();
    fixture.replaceCatalog([{
      server: { serverId: "next", transport: "http" },
      tools: [{ name: "write", inputSchema: { type: "object" } }],
    }]);
    const second = runtime.tools.snapshot();

    expect(first.serverIds).toEqual(["demo"]);
    expect(first.tools.map((tool) => tool.name)).toEqual(["mcp__demo__read_item"]);
    expect(second.serverIds).toEqual(["next"]);
    expect(second.tools.map((tool) => tool.name)).toEqual(["mcp__next__write"]);
    expect(second.tools[0]!.interruptBehavior).toBe("cancel");
  });

  it("separates status and lifecycle without exposing the concrete hub", async () => {
    const fixture = hubFixture();
    const runtime = adaptMcpHub(fixture.hub);
    fixture.replaceStatuses([{
      serverId: "demo",
      transport: "stdio",
      status: "connecting",
      toolCount: 0,
      error: "offline",
    }]);

    const status = runtime.status.snapshot();
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(status[0])).toBe(true);
    expect(status).toEqual([{
      serverId: "demo",
      transport: "stdio",
      status: "connecting",
      toolCount: 0,
      error: "offline",
    }]);

    await runtime.lifecycle.connect();
    await runtime.lifecycle.close();
    expect(fixture.connectAll).toHaveBeenCalledTimes(1);
    expect(fixture.dispose).toHaveBeenCalledTimes(1);
  });
});
