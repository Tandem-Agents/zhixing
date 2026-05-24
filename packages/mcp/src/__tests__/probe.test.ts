import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { probeServer } from "../probe.js";
import type { McpServerSpec } from "../types.js";

const spec: McpServerSpec = { serverId: "x", transport: "stdio", command: "noop" };

/**
 * 起一个 in-memory MCP server，返回 client 端 transport（并 spy 其 close，验证探测用完
 * 必关）。`failList` 让 server 在 tools/list 时报错，模拟"连上但不支持列工具"。
 */
function startProbeServer(opts: { failList?: boolean } = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const closeSpy = vi.fn(clientTransport.close.bind(clientTransport));
  clientTransport.close = closeSpy;
  const server = new Server(
    { name: "probe-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (opts.failList) throw new Error("tools/list not supported");
    return {
      tools: [
        { name: "echo", inputSchema: { type: "object", properties: {} } },
        { name: "search", inputSchema: { type: "object", properties: {} } },
      ],
    };
  });
  void server.connect(serverTransport);
  return { clientTransport, closeSpy };
}

describe("probeServer — 一次性探测", () => {
  it("连上并列工具，返回 ok + tools，用完关闭连接", async () => {
    const { clientTransport, closeSpy } = startProbeServer();
    const result = await probeServer(spec, {
      createTransport: () => ({ transport: clientTransport }),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tools.map((t) => t.name)).toEqual(["echo", "search"]);
    }
    // 探测用完即关，不把连接留下
    expect(closeSpy).toHaveBeenCalled();
  });

  it("建链失败返回 ok:false + 明确原因（供面板卡点）", async () => {
    const result = await probeServer(spec, {
      createTransport: () => {
        throw new Error("spawn failed: command not found");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("spawn failed");
  });

  it("连上但 tools/list 失败返回 ok:false", async () => {
    const { clientTransport } = startProbeServer({ failList: true });
    const result = await probeServer(spec, {
      createTransport: () => ({ transport: clientTransport }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("tools/list");
  });

  it("透传 http 连接池 dispose —— 成功后一并释放", async () => {
    const { clientTransport } = startProbeServer();
    const disposeSpy = vi.fn(async () => {});
    const result = await probeServer(spec, {
      createTransport: () => ({ transport: clientTransport, dispose: disposeSpy }),
    });
    expect(result.ok).toBe(true);
    expect(disposeSpy).toHaveBeenCalled();
  });

  it("signal 已 abort → 立即失败并关闭连接（取消真正中断、不留连接）", async () => {
    const { clientTransport, closeSpy } = startProbeServer();
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    const result = await probeServer(spec, {
      createTransport: () => ({ transport: clientTransport }),
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    // 中断也要清理建链资源（kill 子进程 / 关连接池）
    expect(closeSpy).toHaveBeenCalled();
  });
});
