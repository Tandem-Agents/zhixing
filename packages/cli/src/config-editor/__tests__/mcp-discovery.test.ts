/**
 * MCP 搜索引导测试 —— mock complete（LLM 决策）+ mock search + mock fetchSource，
 * 无真网、无真 LLM、无定时器。重点验证场景护栏:换词重搜、编造候选被 reject、≤5、空→没找到。
 */

import { describe, expect, it, vi } from "vitest";
import {
  mcpProgressText,
  runMcpDiscovery,
  type McpDiscoveryDeps,
} from "../mcp-discovery.js";
import type { McpSearchResult, McpSourceResult } from "@zhixing/mcp";

function pkg(name: string, downloads = 0, keywords: string[] = ["mcp"]): McpSearchResult {
  return { name, description: `${name} desc`, keywords, downloads };
}

/** 按序返回脚本化决策。 */
function scripted(...responses: string[]): McpDiscoveryDeps["complete"] {
  let i = 0;
  return vi.fn(async () => responses[i++] ?? '{"final":{"choices":[]}}');
}

const noSource: McpDiscoveryDeps["fetchSource"] = async () =>
  ({ kind: "not-found" }) as McpSourceResult;

const call = (tool: string, input: Record<string, unknown>) =>
  JSON.stringify({ call: { tool, input } });
const final = (choices: unknown) => JSON.stringify({ final: { choices } });

describe("runMcpDiscovery", () => {
  it("搜到 + final 真实候选 → ok choices", async () => {
    const search = vi.fn(async () => [pkg("@upstash/context7-mcp", 1735792)]);
    const complete = scripted(
      call("search_npm", { query: "context7" }),
      final([{ name: "@upstash/context7-mcp", summary: "MCP server for Context7", reason: "下载最高" }]),
    );
    const r = await runMcpDiscovery("context7", { search, fetchSource: noSource, complete });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.choices).toHaveLength(1);
      expect(r.choices[0]?.name).toBe("@upstash/context7-mcp");
      expect(r.choices[0]?.summary).toContain("Context7");
    }
  });

  it("一次没搜到 → 换关键词再搜 → 出候选", async () => {
    const search = vi.fn(async (q: string) => (q.includes("mcp") ? [pkg("weather-mcp", 500)] : []));
    const complete = scripted(
      call("search_npm", { query: "weather" }),
      call("search_npm", { query: "weather mcp" }),
      final([{ name: "weather-mcp", summary: "天气", reason: "唯一" }]),
    );
    const r = await runMcpDiscovery("weather", { search, fetchSource: noSource, complete });
    expect(search).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.choices[0]?.name).toBe("weather-mcp");
  });

  it("编造的候选（不在搜索结果里）→ reject 回灌 → LLM 改用真实包", async () => {
    const search = vi.fn(async () => [pkg("real-mcp", 100)]);
    const complete = scripted(
      call("search_npm", { query: "x" }),
      final([{ name: "totally-fake-pkg", summary: "假", reason: "编的" }]),
      final([{ name: "real-mcp", summary: "真", reason: "搜到的" }]),
    );
    const r = await runMcpDiscovery("x", { search, fetchSource: noSource, complete });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.choices).toHaveLength(1);
      expect(r.choices[0]?.name).toBe("real-mcp");
    }
  });

  it("候选多于 5 个 → reject 让 LLM 精选", async () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((n) => pkg(`${n}-mcp`, 1));
    const search = vi.fn(async () => six);
    const complete = scripted(
      call("search_npm", { query: "x" }),
      final(six.map((p) => ({ name: p.name, summary: "s", reason: "r" }))), // 6 个 → reject
      final(six.slice(0, 5).map((p) => ({ name: p.name, summary: "s", reason: "r" }))),
    );
    const r = await runMcpDiscovery("x", { search, fetchSource: noSource, complete });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.choices).toHaveLength(5);
  });

  it("LLM 判断没有合适的 → ok:false 诚实没找到", async () => {
    const search = vi.fn(async () => []);
    const complete = scripted(call("search_npm", { query: "nonsense" }), final([]));
    const r = await runMcpDiscovery("nonsense", { search, fetchSource: noSource, complete });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("没找到");
  });

  it("用尽轮数仍不收尾 → ok:false（诚实，不卡死）", async () => {
    const search = vi.fn(async () => [pkg("x-mcp")]);
    const complete = vi.fn(async () => call("search_npm", { query: "x" })); // 恒搜不收尾
    const r = await runMcpDiscovery("x", { search, fetchSource: noSource, complete });
    expect(r.ok).toBe(false);
    expect(search.mock.calls.length).toBeGreaterThan(1); // 跑了多轮
  });

  it("read_readme 工具可用（LLM 据此确认用途）", async () => {
    const search = vi.fn(async () => [pkg("foo-mcp", 10)]);
    const fetchSource = vi.fn(
      async (): Promise<McpSourceResult> => ({ kind: "found", readme: "# foo-mcp\nMCP server" }),
    );
    const complete = scripted(
      call("search_npm", { query: "foo" }),
      call("read_readme", { name: "foo-mcp" }),
      final([{ name: "foo-mcp", summary: "确认是 MCP", reason: "README 写了" }]),
    );
    const r = await runMcpDiscovery("foo", { search, fetchSource, complete });
    expect(fetchSource.mock.calls[0]?.[0]).toBe("foo-mcp");
    expect(r.ok).toBe(true);
  });
});

describe("mcpProgressText", () => {
  it("deciding → 分析中", () => {
    expect(mcpProgressText({ round: 1, phase: "deciding" })).toBe("正在分析…");
  });
  it("search_npm → 正在搜索 关键词", () => {
    expect(
      mcpProgressText({ round: 1, phase: "calling", tool: "search_npm", input: { query: "c7" } }),
    ).toBe("正在搜索 “c7”…");
  });
  it("read_readme → 正在读取 包名 的说明", () => {
    expect(
      mcpProgressText({ round: 2, phase: "calling", tool: "read_readme", input: { name: "x-mcp" } }),
    ).toBe("正在读取 x-mcp 的说明…");
  });
});
