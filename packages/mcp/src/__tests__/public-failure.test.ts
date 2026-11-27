import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { recordingFixture } from "../../../core/src/logging/__tests__/recording.js";
import { createMcpHub } from "../hub.js";
import { MCP_LOG_SOURCE, MCP_LOG_SOURCE_V1 } from "../logging.js";
import { probeServer } from "../probe.js";
import { wrapStdioTransportStart } from "../transport.js";
import { McpStdioSpawnError, classifyMcpPublicFailure } from "../failure.js";
import type { McpServerSpec } from "../types.js";

describe("MCP public failure classification, dual callTool error paths, and log v2", () => {
  it("wrapStdioTransportStart classifies ENOENT spawn error cleanly as McpStdioSpawnError", async () => {
    const wrapped = wrapStdioTransportStart({
      start: async () => {
        const err = new Error("spawn /usr/bin/SYNTHETIC_TEST_ONLY_SECRET_CMD ENOENT") as Error & {
          code: string;
        };
        err.code = "ENOENT";
        throw err;
      },
      close: async () => {},
      send: async () => {},
    });

    let caught: unknown;
    try {
      await wrapped.start();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpStdioSpawnError);
    expect((caught as McpStdioSpawnError).reason).toBe("command-not-found");
    expect((caught as Error).message).not.toContain("SYNTHETIC_TEST_ONLY");
    expect(classifyMcpPublicFailure("spawn", caught)).toEqual({
      stage: "spawn",
      reason: "command-not-found",
    });

    const spec: McpServerSpec = {
      serverId: "missing-bin",
      transport: "stdio",
      command: "SYNTHETIC_TEST_ONLY_missing_binary_xyz",
    };
    const probe = await probeServer(spec, { createTransport: () => ({ transport: wrapped }) });
    expect(probe.ok).toBe(false);
    if (!probe.ok) {
      expect(probe.error).toBe("spawn:command-not-found");
      expect(probe.failure).toEqual({ stage: "spawn", reason: "command-not-found" });
      expect(JSON.stringify(probe)).not.toContain("SYNTHETIC_TEST_ONLY");
    }
  });

  it("preserves outcome.isError !== true verbatim and sanitizes both outcome.isError === true and thrown errors + logs", async () => {
    const logs = recordingFixture();
    const records = logs.bind(MCP_LOG_SOURCE, { scope: "conversation:c1" }, [{ kind: "run", id: "r1" }]);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server(
      { name: "dual-error-test", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "ok_tool", inputSchema: { type: "object" } },
        { name: "err_result_tool", inputSchema: { type: "object" } },
        { name: "throw_tool", inputSchema: { type: "object" } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (req.params.name === "ok_tool") {
        return {
          content: [{ type: "text", text: "ok-payload-123" }],
        };
      }
      if (req.params.name === "err_result_tool") {
        return {
          isError: true,
          content: [
            { type: "text", text: "Secret failure detail: SYNTHETIC_TEST_ONLY_DB_PASS=abc" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
        };
      }
      throw new Error("Transport boom with SYNTHETIC_TEST_ONLY_BEARER_TOKEN_XYZ");
    });
    await server.connect(serverTransport);

    const hub = createMcpHub(
      [
        { serverId: "demo", transport: "http", url: "https://example.com/mcp?token=SYNTHETIC_TEST_ONLY_Q" },
      ],
      {
        records,
        createTransport: () => ({ transport: clientTransport }),
      },
    );

    try {
      await hub.connectAll();
      expect(hub.serverStatuses()).toEqual([
        { serverId: "demo", transport: "http", status: "connected", toolCount: 3 },
      ]);
      expect(hub.serverStatusesV2()).toEqual([
        { serverId: "demo", transport: "http", status: "connected", toolCount: 3 },
      ]);

      // 1. 正常业务返回 100% 原样保留
      const okRes = await hub.callTool("demo", "ok_tool", {}, { toolCallId: "c-ok" });
      expect(okRes).toEqual({ content: "ok-payload-123", isError: false });

      // 2. 协议返回 isError: true -> 脱敏 MpcPublicFailure（零哨兵串）
      const errResultRes = await hub.callTool("demo", "err_result_tool", {}, { toolCallId: "c-err" });
      expect(errResultRes.isError).toBe(true);
      expect(errResultRes.content).not.toContain("SYNTHETIC_TEST_ONLY");
      expect(errResultRes.content).toContain('"reason":"tool-error-result"');
      expect(errResultRes.content).toContain('"contentBlocks":2');

      // 3. SDK/传输抛错 -> 脱敏 McpPublicFailure（零哨兵串）
      const thrownRes = await hub.callTool("demo", "throw_tool", {}, { toolCallId: "c-throw" });
      expect(thrownRes.isError).toBe(true);
      expect(thrownRes.content).not.toContain("SYNTHETIC_TEST_ONLY");
      expect(thrownRes.content).toContain('"stage":"call-tool"');
    } finally {
      await hub.dispose();
      await logs.finish();
    }

    const dumped = JSON.stringify(logs.records());
    expect(dumped).not.toContain("SYNTHETIC_TEST_ONLY");
    expect(MCP_LOG_SOURCE.version).toBe(2);
    expect(MCP_LOG_SOURCE_V1.version).toBe(1);
    expect(logs.recorder.health().captureFailures).toBe(0);
  });
});
