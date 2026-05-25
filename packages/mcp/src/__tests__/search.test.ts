import { describe, expect, it } from "vitest";
import { searchMcpServers, type McpSearchResult } from "../search.js";
import type { HttpGetText } from "../http.js";

/** 按 url 命中返回固定响应的 mock GET——不真联网。 */
function mockGet(status: number, body: string): HttpGetText {
  return async () => ({ status, body });
}

/** 构造一条 npmmirror 搜索结果对象。 */
function obj(name: string, opts: { description?: string; keywords?: string[]; downloads?: number } = {}) {
  return {
    package: {
      name,
      description: opts.description ?? "",
      keywords: opts.keywords ?? [],
    },
    downloads: { all: opts.downloads ?? 0 },
  };
}

describe("searchMcpServers", () => {
  it("解析真实字段：name / description / keywords / downloads.all", async () => {
    const body = JSON.stringify({
      total: 2,
      objects: [
        obj("@upstash/context7-mcp", {
          description: "MCP server for Context7",
          keywords: ["mcp", "modelcontextprotocol"],
          downloads: 1735792,
        }),
        obj("context7", { description: "CLI", keywords: ["cli"], downloads: 11384 }),
      ],
    });
    const r = await searchMcpServers("context7", { httpGetText: mockGet(200, body) });
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual<McpSearchResult>({
      name: "@upstash/context7-mcp",
      description: "MCP server for Context7",
      keywords: ["mcp", "modelcontextprotocol"],
      downloads: 1735792,
    });
    expect(r[1]?.downloads).toBe(11384);
  });

  it("不做 is-mcp 过滤 / 排序——原样返回真实结果（判断交给上层）", async () => {
    const body = JSON.stringify({
      objects: [obj("ctx7", { keywords: ["cli"] }), obj("x-mcp", { keywords: ["mcp"] })],
    });
    const r = await searchMcpServers("x", { httpGetText: mockGet(200, body) });
    expect(r.map((x) => x.name)).toEqual(["ctx7", "x-mcp"]); // 顺序与下载量都不被本层改动
  });

  it("缺字段容错：无 description/keywords/downloads → 空串 / [] / 0；无 name → 丢弃", async () => {
    const body = JSON.stringify({
      objects: [{ package: { name: "a" } }, { package: {} }, { notpackage: 1 }],
    });
    const r = await searchMcpServers("a", { httpGetText: mockGet(200, body) });
    expect(r).toEqual([{ name: "a", description: "", keywords: [], downloads: 0 }]);
  });

  it("objects 缺失 → 空数组", async () => {
    const r = await searchMcpServers("a", { httpGetText: mockGet(200, JSON.stringify({ total: 0 })) });
    expect(r).toEqual([]);
  });

  it("非 200 → 抛错（由上层工具循环回灌）", async () => {
    await expect(searchMcpServers("a", { httpGetText: mockGet(500, "oops") })).rejects.toThrow("HTTP 500");
  });

  it("响应非 JSON → 抛错", async () => {
    await expect(searchMcpServers("a", { httpGetText: mockGet(200, "<html>") })).rejects.toThrow("JSON");
  });

  it("网络抛错 → 抛错（带原因）", async () => {
    const httpGetText: HttpGetText = async () => {
      throw new Error("ECONNRESET");
    };
    await expect(searchMcpServers("a", { httpGetText })).rejects.toThrow("ECONNRESET");
  });

  it("query 进 URL 时转义", async () => {
    let seen = "";
    const httpGetText: HttpGetText = async (url) => {
      seen = url;
      return { status: 200, body: JSON.stringify({ objects: [] }) };
    };
    await searchMcpServers("@scope/x mcp", { httpGetText });
    expect(seen).toContain("text=%40scope%2Fx%20mcp");
  });
});
