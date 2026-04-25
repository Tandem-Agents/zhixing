/**
 * ToolArgumentExtractor + defaultExtractArgument 单元测试
 *
 * 覆盖：
 * - 工具显式声明 permissionArgumentKey → 命中正确字段（不依赖字段顺序）
 * - 多 string 字段工具的字段歧义场景（关键正确性保障）
 * - 工具未声明 / 声明字段缺失 → fallback 到 defaultExtractArgument
 * - defaultExtractArgument 自身行为（priority list / 第一字段 fallback / 空）
 * - 大小写归一
 * - 动态 register / unregister API（forward-looking for MCP / 插件接入）
 * - bash 在 fallback 路径上走第一字段命中（M3 后无 bash 特例）
 */

import { describe, expect, it } from "vitest";

import { defaultExtractArgument } from "../permission-store.js";
import { ToolArgumentExtractor } from "../tool-aware-extractor.js";
import type { SecurityRequest } from "../types.js";
import type { ToolDefinition } from "../../types/tools.js";

// ─── 测试辅助 ───

function makeTool(
  name: string,
  permissionArgumentKey?: string,
): ToolDefinition {
  return {
    name,
    description: `mock ${name}`,
    inputSchema: { type: "object" },
    permissionArgumentKey,
    async call() {
      return { content: "" };
    },
  };
}

function makeRequest(
  tool: string,
  args: Record<string, unknown>,
): SecurityRequest {
  return {
    tool,
    arguments: args,
    context: {
      cwd: "/tmp",
      workspace: null,
      sessionType: "interactive",
    },
  };
}

// ─── ToolArgumentExtractor.fromTools ───

describe("ToolArgumentExtractor.fromTools (启动时 snapshot 模式)", () => {
  it("工具显式声明 permissionArgumentKey → 命中声明字段", () => {
    const extractor = ToolArgumentExtractor.fromTools([
      makeTool("web_fetch", "url"),
    ]);

    const result = extractor.extract(
      makeRequest("web_fetch", {
        prompt: "irrelevant",
        url: "https://example.com",
      }),
    );
    expect(result).toBe("https://example.com");
  });

  it("多 string 字段工具：字段顺序不影响命中（核心正确性）", () => {
    // allowed_domains 字母序在 query 之前——若走 priority list / 第一字段 fallback，
    // 会错误命中 allowed_domains
    const extractor = ToolArgumentExtractor.fromTools([
      makeTool("web_search", "query"),
    ]);

    expect(
      extractor.extract(
        makeRequest("web_search", {
          allowed_domains: "example.com",
          query: "search term",
        }),
      ),
    ).toBe("search term");
  });

  it("工具未声明 permissionArgumentKey → 走 defaultExtractArgument fallback", () => {
    const extractor = ToolArgumentExtractor.fromTools([
      makeTool("read", undefined),
    ]);

    expect(
      extractor.extract(
        makeRequest("read", { path: "/etc/passwd", verbose: true }),
      ),
    ).toBe("/etc/passwd");
  });

  it("声明的字段缺失或非 string → 降级到 fallback（不抛错）", () => {
    const extractor = ToolArgumentExtractor.fromTools([
      makeTool("edit", "path"),
    ]);

    // path 字段缺失，但有 file_path（priority list 第二项）
    expect(
      extractor.extract(makeRequest("edit", { file_path: "/tmp/a.txt" })),
    ).toBe("/tmp/a.txt");

    // path 字段是 number 而非 string，降级到第一个 string 字段
    expect(
      extractor.extract(
        makeRequest("edit", {
          path: 42 as unknown,
          file_path: "/tmp/b.txt",
        }),
      ),
    ).toBe("/tmp/b.txt");
  });

  it("工具名查询大小写不敏感", () => {
    const extractor = ToolArgumentExtractor.fromTools([
      makeTool("WebFetch", "url"),
    ]);

    expect(
      extractor.extract(makeRequest("webfetch", { url: "https://a.com" })),
    ).toBe("https://a.com");
    expect(
      extractor.extract(makeRequest("WEBFETCH", { url: "https://b.com" })),
    ).toBe("https://b.com");
  });

  it("不在 tools 列表中的工具 → 走 fallback", () => {
    const extractor = ToolArgumentExtractor.fromTools([
      makeTool("known_tool", "x"),
    ]);

    expect(
      extractor.extract(makeRequest("unknown_tool", { path: "/tmp/foo" })),
    ).toBe("/tmp/foo");
  });

  it("bash 工具：M3 显式声明 command → 命中（不依赖 fallback 中已删除的 bash 特例）", () => {
    const extractor = ToolArgumentExtractor.fromTools([
      makeTool("bash", "command"),
    ]);
    expect(
      extractor.extract(makeRequest("bash", { command: "ls -la" })),
    ).toBe("ls -la");
  });

  it("bash 未声明 → 走 fallback：第一字段就是 command（行为兼容）", () => {
    // M3 后 fallback 不再含 bash 特例；bash schema 第一个 string 字段
    // 就是 command（参见 bash.ts inputSchema），所以兼容
    const extractor = ToolArgumentExtractor.fromTools([]);
    expect(
      extractor.extract(makeRequest("bash", { command: "ls -la", timeout: 5000 })),
    ).toBe("ls -la");
  });

  it("空 tools 数组：所有请求都走 fallback", () => {
    const extractor = ToolArgumentExtractor.fromTools([]);
    expect(
      extractor.extract(makeRequest("anything", { path: "/x" })),
    ).toBe("/x");
  });
});

// ─── 动态 register / unregister（forward-looking for MCP / 插件）───

describe("ToolArgumentExtractor: 动态 register / unregister", () => {
  it("register 注册新工具的 argument key，extract 立即生效", () => {
    const extractor = new ToolArgumentExtractor();
    expect(
      extractor.extract(
        makeRequest("mcp_tool", { url: "https://x.com", prompt: "p" }),
      ),
    ).toBe("https://x.com"); // 走 priority list 不命中 → 第一字段 fallback (url)

    extractor.register("mcp_tool", "prompt");
    expect(
      extractor.extract(
        makeRequest("mcp_tool", { url: "https://x.com", prompt: "p" }),
      ),
    ).toBe("p");
  });

  it("register 同 toolName 覆盖旧 key", () => {
    const extractor = new ToolArgumentExtractor();
    extractor.register("tool", "field_a");
    extractor.register("tool", "field_b");

    expect(
      extractor.extract(makeRequest("tool", { field_a: "a", field_b: "b" })),
    ).toBe("b");
  });

  it("register 拒绝空字符串 / 非 string", () => {
    const extractor = new ToolArgumentExtractor();
    expect(() => extractor.register("tool", "")).toThrow(/非空字符串/);
  });

  it("unregister 移除工具的 key 声明（回退到 fallback）", () => {
    const extractor = ToolArgumentExtractor.fromTools([
      makeTool("web_fetch", "url"),
    ]);
    expect(
      extractor.extract(
        makeRequest("web_fetch", { url: "https://x.com", path: "/y" }),
      ),
    ).toBe("https://x.com");

    extractor.unregister("web_fetch");
    expect(
      extractor.extract(
        makeRequest("web_fetch", { url: "https://x.com", path: "/y" }),
      ),
    ).toBe("/y"); // 走 priority list 命中 path
  });

  it("list 返回当前已注册的工具名（小写）", () => {
    const extractor = new ToolArgumentExtractor();
    extractor.register("WebFetch", "url");
    extractor.register("WEB_SEARCH", "query");

    const list = extractor.list();
    expect(list).toContain("webfetch");
    expect(list).toContain("web_search");
    expect(list).toHaveLength(2);
  });

  it("MCP 接入场景：fromTools snapshot + 后续 register 动态扩展", () => {
    const extractor = ToolArgumentExtractor.fromTools([
      makeTool("bash", "command"),
    ]);

    // 模拟 /mcp connect 后注册新工具的 argument key
    extractor.register("mcp_http", "url");
    expect(
      extractor.extract(
        makeRequest("mcp_http", { method: "GET", url: "https://api.com" }),
      ),
    ).toBe("https://api.com");

    // 模拟 /mcp disconnect 后注销
    extractor.unregister("mcp_http");
    // 走 fallback：priority list 全不命中，第一字段 fallback (method)
    expect(
      extractor.extract(
        makeRequest("mcp_http", { method: "GET", url: "https://api.com" }),
      ),
    ).toBe("GET");
  });
});

// ─── defaultExtractArgument （M3 后无 bash 特例）───

describe("defaultExtractArgument", () => {
  it("priority list 顺序：path > file_path > target > destination", () => {
    expect(
      defaultExtractArgument(
        makeRequest("read", {
          destination: "d",
          target: "t",
          file_path: "f",
          path: "p",
        }),
      ),
    ).toBe("p");

    expect(
      defaultExtractArgument(
        makeRequest("read", {
          destination: "d",
          target: "t",
          file_path: "f",
        }),
      ),
    ).toBe("f");

    expect(
      defaultExtractArgument(
        makeRequest("read", { destination: "d", target: "t" }),
      ),
    ).toBe("t");

    expect(
      defaultExtractArgument(makeRequest("read", { destination: "d" })),
    ).toBe("d");
  });

  it("priority list 全无 → 第一个 string 字段（顺序取决于 Object.values）", () => {
    expect(
      defaultExtractArgument(makeRequest("noop", { onlyOne: "value" })),
    ).toBe("value");
  });

  it("无任何 string 字段 → 空字符串", () => {
    expect(
      defaultExtractArgument(makeRequest("noop", { count: 42, ok: true })),
    ).toBe("");
  });

  it("bash 工具：无特例 → 走 priority list 不命中，第一字段 fallback 命中 command", () => {
    // M3 后 fallback 不再含 `if (tool === "bash")` 特例分支；
    // bash schema 第一个 string 字段就是 command，行为兼容
    expect(
      defaultExtractArgument(
        makeRequest("bash", { command: "ls -la", timeout: 5000 }),
      ),
    ).toBe("ls -la");
  });

  it("bash command 非 string + 无其他 string 字段 → 空字符串", () => {
    expect(
      defaultExtractArgument(
        makeRequest("bash", { command: 42 as unknown, timeout: 1000 }),
      ),
    ).toBe("");
  });
});
