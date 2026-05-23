import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpHub } from "../hub.js";
import type { McpServerSpec } from "../types.js";

/**
 * 起一个 in-memory MCP server（不 spawn 子进程），连上 server 端 transport，
 * 返回 client 端 transport 供 hub 通过注入的 createTransport 使用。
 */
async function startTestServer(tools: Array<Record<string, unknown>>) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = new Server(
    { name: "test-server", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [
      {
        type: "text",
        text: `called ${req.params.name} args=${JSON.stringify(
          req.params.arguments ?? {},
        )}`,
      },
    ],
  }));
  await server.connect(serverTransport);
  return clientTransport;
}

const spec = (serverId: string): McpServerSpec => ({
  serverId,
  transport: "stdio",
  command: "noop",
});

describe("McpHub — 连接 / 发现 / 调用 / 关闭", () => {
  it("连接后暴露工具目录并能调用", async () => {
    const clientTransport = await startTestServer([
      {
        name: "echo",
        description: "echoes input",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ]);
    const hub = createMcpHub([spec("demo")], {
      createTransport: () => clientTransport,
    });
    await hub.connectAll();

    const catalog = hub.catalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]!.server).toEqual({ serverId: "demo", transport: "stdio" });
    expect(catalog[0]!.tools[0]!.name).toBe("echo");
    expect(catalog[0]!.tools[0]!.readOnlyHint).toBe(true);

    const result = await hub.callTool("demo", "echo", { a: 1 }, {});
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("called echo");
    expect(result.content).toContain('"a":1');

    await hub.dispose();
    expect(hub.catalog()).toEqual([]);
  });

  it("abort 触发时让异常冒泡（交 tool-executor 统一中断），不吞成 isError", async () => {
    const clientTransport = await startTestServer([
      { name: "echo", inputSchema: { type: "object", properties: {} } },
    ]);
    const hub = createMcpHub([spec("demo")], {
      createTransport: () => clientTransport,
    });
    await hub.connectAll();

    const controller = new AbortController();
    controller.abort(new Error("user aborted"));
    await expect(
      hub.callTool("demo", "echo", {}, { signal: controller.signal }),
    ).rejects.toThrow("user aborted");

    await hub.dispose();
  });

  it("单 server 连接失败被隔离，其余照常", async () => {
    const clientTransport = await startTestServer([
      { name: "ok", inputSchema: { type: "object", properties: {} } },
    ]);
    const hub = createMcpHub([spec("good"), spec("bad")], {
      createTransport: (s) => {
        if (s.serverId === "bad") throw new Error("spawn failed");
        return clientTransport;
      },
    });
    await hub.connectAll();

    expect(hub.catalog().map((c) => c.server.serverId)).toEqual(["good"]);
    const bad = await hub.callTool("bad", "x", {}, {});
    expect(bad.isError).toBe(true);
    await hub.dispose();
  });
});

describe("McpHub — no-op（空配置）", () => {
  it("空 spec 列表所有方法 no-op、调用方零判空", async () => {
    const hub = createMcpHub([]);
    await hub.connectAll();
    expect(hub.catalog()).toEqual([]);
    const r = await hub.callTool("ghost", "x", {}, {});
    expect(r.isError).toBe(true);
    expect(r.content).toContain("ghost");
    await hub.dispose(); // 不抛
  });
});
