import type { ToolExecutionContext } from "@zhixing/core";
import { describe, expect, it } from "vitest";
import { mapServerTools } from "../mapping.js";
import type { McpCallFn, McpServerContext, McpToolDescriptor } from "../types.js";

const ctx: ToolExecutionContext = { workingDirectory: "/tmp" };
const noop: McpCallFn = async () => ({ content: "" });

const stdioGithub: McpServerContext = { serverId: "github", transport: "stdio" };

function desc(
  partial: Partial<McpToolDescriptor> & { name: string },
): McpToolDescriptor {
  return { inputSchema: { type: "object", properties: {} }, ...partial };
}

describe("mapServerTools — 字段映射", () => {
  it("只读工具：可并发、access=query、自动放行语义", () => {
    const t = mapServerTools(stdioGithub, [desc({ name: "list", readOnlyHint: true })], noop)[0]!;
    expect(t.name).toBe("mcp__github__list");
    expect(t.isReadOnly).toBe(true);
    expect(t.isParallelSafe).toBe(true);
    expect(t.boundaries).toEqual([
      { boundaryType: "external-service", access: "query", dynamic: false },
    ]);
  });

  it("非只读工具（fail-closed 缺省）：不可并发、access=invoke", () => {
    const t = mapServerTools(stdioGithub, [desc({ name: "create" })], noop)[0]!;
    expect(t.isReadOnly).toBe(false);
    expect(t.isParallelSafe).toBe(false);
    expect(t.boundaries![0]!.access).toBe("invoke");
  });

  it("固定声明 needsPermission 与 maxResultChars", () => {
    const t = mapServerTools(stdioGithub, [desc({ name: "x" })], noop)[0]!;
    expect(t.needsPermission).toBe(true);
    expect(t.maxResultChars).toBe(100_000);
  });

  it("interruptBehavior 随 server.transport：stdio→grace / http→cancel", () => {
    const stdio = mapServerTools(stdioGithub, [desc({ name: "x" })], noop)[0]!;
    const http = mapServerTools(
      { serverId: "github", transport: "http" },
      [desc({ name: "x" })],
      noop,
    )[0]!;
    expect(stdio.interruptBehavior).toBe("grace");
    expect(http.interruptBehavior).toBe("cancel");
  });

  it("描述超长截断到 2048", () => {
    const t = mapServerTools(
      stdioGithub,
      [desc({ name: "x", description: "z".repeat(3000) })],
      noop,
    )[0]!;
    expect(t.description.length).toBe(2048);
  });

  it("inputSchema：合规 object 透传同引用，异常顶层兜底为空 object", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(
      mapServerTools(stdioGithub, [desc({ name: "x", inputSchema: schema })], noop)[0]!.inputSchema,
    ).toBe(schema);
    expect(
      mapServerTools(stdioGithub, [desc({ name: "x", inputSchema: "not-object" })], noop)[0]!
        .inputSchema,
    ).toEqual({ type: "object" });
  });

  it("permissionArgumentKey：取 required 中第一个 string 字段（跳过非 string）", () => {
    const t = mapServerTools(
      stdioGithub,
      [
        desc({
          name: "x",
          inputSchema: {
            type: "object",
            properties: { count: { type: "number" }, url: { type: "string" } },
            required: ["count", "url"],
          },
        }),
      ],
      noop,
    )[0]!;
    expect(t.permissionArgumentKey).toBe("url");
  });

  it("permissionArgumentKey：无 required string 字段 → 不设（回退默认启发式）", () => {
    const t = mapServerTools(
      stdioGithub,
      [
        desc({
          name: "x",
          inputSchema: {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
          },
        }),
      ],
      noop,
    )[0]!;
    expect(t.permissionArgumentKey).toBeUndefined();
  });
});

describe("mapServerTools — 命名与去重", () => {
  it("工具名经消毒后再拼接", () => {
    const t = mapServerTools(stdioGithub, [desc({ name: "create.issue" })], noop)[0]!;
    expect(t.name).toBe("mcp__github__create_issue");
  });

  it("同 server 消毒后重名加 -2 / -3 后缀", () => {
    const tools = mapServerTools(
      stdioGithub,
      [desc({ name: "a.b" }), desc({ name: "a/b" }), desc({ name: "a b" })],
      noop,
    );
    expect(tools.map((t) => t.name)).toEqual([
      "mcp__github__a_b",
      "mcp__github__a_b-2",
      "mcp__github__a_b-3",
    ]);
  });
});

describe("mapServerTools — call 转发", () => {
  it("转发 MCP 原始工具名（非消毒名）并透传 abortSignal", async () => {
    const calls: Array<{ server: string; tool: string; signal?: AbortSignal }> = [];
    const callTool: McpCallFn = async (server, tool, _input, opts) => {
      calls.push({ server, tool, signal: opts.signal });
      return { content: "ok" };
    };
    const t = mapServerTools(stdioGithub, [desc({ name: "create.issue" })], callTool)[0]!;
    const controller = new AbortController();

    const result = await t.call(
      { title: "hi" },
      { workingDirectory: "/tmp", abortSignal: controller.signal },
    );

    expect(result).toEqual({ content: "ok" });
    expect(calls[0]).toEqual({
      server: "github",
      tool: "create.issue", // 原始名，未消毒
      signal: controller.signal,
    });
  });

  it("非 abort 异常被防御性转成 isError，不冒泡", async () => {
    const callTool: McpCallFn = async () => {
      throw new Error("boom");
    };
    const t = mapServerTools(stdioGithub, [desc({ name: "x" })], callTool)[0]!;
    const result = await t.call({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("boom");
    expect(result.content).toContain("mcp__github__x");
  });

  it("abort 触发时让异常冒泡（交 tool-executor 统一中断），不吞成 isError", async () => {
    const callTool: McpCallFn = async () => {
      throw new Error("aborted by user");
    };
    const t = mapServerTools(stdioGithub, [desc({ name: "x" })], callTool)[0]!;
    const controller = new AbortController();
    controller.abort();
    await expect(
      t.call({}, { workingDirectory: "/tmp", abortSignal: controller.signal }),
    ).rejects.toThrow("aborted by user");
  });
});
