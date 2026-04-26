import type { LLMRoles, StreamEvent, ToolExecutionContext } from "@zhixing/core";
import type { FetchResult } from "@zhixing/network";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetchMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
}));

vi.mock("@zhixing/network", async (importActual) => {
  const actual = await importActual<typeof import("@zhixing/network")>();
  return {
    ...actual,
    safeFetch: safeFetchMock,
  };
});

import { createWebFetchTool } from "../../web-fetch.js";
import { contentCache } from "../internal.js";

const tool = createWebFetchTool();

beforeEach(() => {
  contentCache.clear();
  safeFetchMock.mockReset();
});

afterEach(() => {
  contentCache.clear();
});

// ─── Test fixtures ───

function makeFetchResult(html: string, contentType = "text/html"): FetchResult {
  return {
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    body: new TextEncoder().encode(html),
    finalUrl: "https://example.com/",
    redirectChain: ["https://example.com/"] as readonly string[],
  };
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    workingDirectory: "/tmp",
    ...overrides,
  };
}

function makeRoles(events: StreamEvent[] | (() => AsyncGenerator<StreamEvent, void, undefined>)): LLMRoles {
  async function* gen(): AsyncGenerator<StreamEvent, void, undefined> {
    if (typeof events === "function") {
      yield* events();
    } else {
      for (const e of events) yield e;
    }
  }
  const main = {
    provider: { id: "mock", models: [], chat: () => gen() },
    model: "mock-main",
    chat: () => gen(),
  };
  const secondary = {
    provider: { id: "mock", models: [], chat: () => gen() },
    model: "mock-secondary",
    chat: () => gen(),
  };
  return { main, secondary };
}

// ─── tool definition shape ───

describe("createWebFetchTool definition", () => {
  it("name=web_fetch + needsPermission + boundaries + permissionArgumentKey", () => {
    expect(tool.name).toBe("web_fetch");
    expect(tool.needsPermission).toBe(true);
    expect(tool.isReadOnly).toBe(true);
    expect(tool.isParallelSafe).toBe(true);
    expect(tool.boundaries).toEqual([
      { boundaryType: "network", access: "egress", dynamic: false },
    ]);
    expect(tool.permissionArgumentKey).toBe("url");
  });
});

// ─── input 校验 ───

describe("input validation", () => {
  it("缺 url 返回 isError", async () => {
    const r = await tool.call({}, makeContext());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("`url`");
  });

  it("url 非 string 返回 isError", async () => {
    const r = await tool.call({ url: 123 }, makeContext());
    expect(r.isError).toBe(true);
  });

  it("prompt 非 string 返回 isError", async () => {
    const r = await tool.call({ url: "https://x.com/", prompt: 123 }, makeContext());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("`prompt`");
  });

  it("prompt 超长返回 isError", async () => {
    const r = await tool.call(
      { url: "https://x.com/", prompt: "x".repeat(2000) },
      makeContext(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("1000");
  });

  it("format 非法返回 isError", async () => {
    const r = await tool.call({ url: "https://x.com/", format: "xml" }, makeContext());
    expect(r.isError).toBe(true);
  });

  it("maxChars 越界返回 isError", async () => {
    const r1 = await tool.call({ url: "https://x.com/", maxChars: 100 }, makeContext());
    expect(r1.isError).toBe(true);
    const r2 = await tool.call({ url: "https://x.com/", maxChars: 999_999 }, makeContext());
    expect(r2.isError).toBe(true);
  });
});

// ─── graceful degrade ───

describe("graceful degrade", () => {
  it("无 ctx.llm + prompt → 退到 raw markdown", async () => {
    safeFetchMock.mockResolvedValue(makeFetchResult("<h1>Hi</h1>"));
    const r = await tool.call(
      { url: "https://x.com/", prompt: "summarize" },
      makeContext(),
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Source: https://x.com/");
    expect(r.content).toContain("# Hi");
  });

  it("有 ctx.llm + 无 prompt → 退到 raw markdown(不调 secondary)", async () => {
    safeFetchMock.mockResolvedValue(makeFetchResult("<h1>Hi</h1>"));
    const chatSpy = vi.fn();
    const roles = makeRoles([]);
    roles.secondary.chat = chatSpy;
    const r = await tool.call({ url: "https://x.com/" }, makeContext({ llm: roles }));
    expect(r.isError).toBe(false);
    expect(r.content).toContain("# Hi");
    expect(chatSpy).not.toHaveBeenCalled();
  });
});

// ─── distill 主路径 ───

describe("distill 主路径", () => {
  it("ctx.llm + prompt → 调用 secondary.chat 并返回 distill 结果", async () => {
    safeFetchMock.mockResolvedValue(makeFetchResult("<p>Big content here</p>"));
    const roles = makeRoles([{ type: "text_delta", text: "Distilled answer" }]);
    const r = await tool.call(
      { url: "https://x.com/", prompt: "what is this?" },
      makeContext({ llm: roles }),
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Distilled answer");
    expect(r.content).not.toContain("Big content");
  });

  it("传入 abortSignal 透传到 secondary.chat", async () => {
    safeFetchMock.mockResolvedValue(makeFetchResult("<p>X</p>"));
    const chatSpy = vi.fn(async function* (): AsyncGenerator<StreamEvent, void, undefined> {
      yield { type: "text_delta", text: "ok" };
    });
    const roles = makeRoles([]);
    roles.secondary.chat = chatSpy as unknown as LLMRoles["secondary"]["chat"];
    const ac = new AbortController();
    await tool.call(
      { url: "https://x.com/", prompt: "x" },
      makeContext({ llm: roles, abortSignal: ac.signal }),
    );
    const callArg = chatSpy.mock.calls[0]?.[0] as { abortSignal?: AbortSignal };
    expect(callArg?.abortSignal).toBe(ac.signal);
  });

  it("secondary 抛错 → graceful degrade 到 raw + 提示", async () => {
    safeFetchMock.mockResolvedValue(makeFetchResult("<p>Raw content</p>"));
    const chatThrow = vi.fn(async function* (): AsyncGenerator<StreamEvent, void, undefined> {
      throw new Error("LLM unavailable");
    });
    const roles = makeRoles([]);
    roles.secondary.chat = chatThrow as unknown as LLMRoles["secondary"]["chat"];
    const r = await tool.call(
      { url: "https://x.com/", prompt: "x" },
      makeContext({ llm: roles }),
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("distill failed");
    expect(r.content).toContain("LLM unavailable");
    expect(r.content).toContain("Raw content");
  });

  it("secondary 返回空 → 退到 raw + 提示", async () => {
    safeFetchMock.mockResolvedValue(makeFetchResult("<p>Raw</p>"));
    const roles = makeRoles([{ type: "text_delta", text: "   " }]);
    const r = await tool.call(
      { url: "https://x.com/", prompt: "x" },
      makeContext({ llm: roles }),
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("empty distill");
    expect(r.content).toContain("Raw");
  });
});

// ─── 缓存 ───

describe("缓存", () => {
  it("同 url + 同 format 第二次调用不重复 fetch", async () => {
    safeFetchMock.mockResolvedValue(makeFetchResult("<h1>X</h1>"));
    await tool.call({ url: "https://x.com/" }, makeContext());
    await tool.call({ url: "https://x.com/" }, makeContext());
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("不同 format 算独立 cache key", async () => {
    safeFetchMock.mockResolvedValue(makeFetchResult("<h1>X</h1>"));
    await tool.call({ url: "https://x.com/", format: "markdown" }, makeContext());
    await tool.call({ url: "https://x.com/", format: "text" }, makeContext());
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });
});

// ─── FetchError → ToolResult ───

describe("FetchError 转 ToolResult", () => {
  it("ssrf-blocked 友好 message", async () => {
    safeFetchMock.mockResolvedValue({
      kind: "ssrf-blocked",
      ip: "127.0.0.1",
      range: "127.0.0.0/8",
    });
    const r = await tool.call({ url: "http://localhost/" }, makeContext());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Blocked");
    expect(r.content).toContain("127.0.0.1");
    expect(r.content).toContain("127.0.0.0/8");
  });

  it("url-invalid 友好 message", async () => {
    safeFetchMock.mockResolvedValue({ kind: "url-invalid", reason: "protocol" });
    const r = await tool.call({ url: "ftp://x.com/" }, makeContext());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Invalid URL");
    expect(r.content).toContain("protocol");
  });

  it("timeout 友好 message", async () => {
    safeFetchMock.mockResolvedValue({ kind: "timeout", ms: 30000 });
    const r = await tool.call({ url: "https://slow.com/" }, makeContext());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("timed out");
    expect(r.content).toContain("30000");
  });

  it("dns 友好 message", async () => {
    safeFetchMock.mockResolvedValue({ kind: "dns", host: "missing.invalid", cause: "ENOTFOUND" });
    const r = await tool.call({ url: "https://missing.invalid/" }, makeContext());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("DNS resolution failed");
    expect(r.content).toContain("missing.invalid");
  });

  it("connect-failed 友好 message", async () => {
    safeFetchMock.mockResolvedValue({
      kind: "connect-failed",
      host: "refused.example",
      cause: "ECONNREFUSED: connect ECONNREFUSED 1.2.3.4:80",
    });
    const r = await tool.call({ url: "https://refused.example/" }, makeContext());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Connection failed");
    expect(r.content).toContain("refused.example");
    expect(r.content).toContain("ECONNREFUSED");
  });

  it("ssrf-blocked 命中 198.18.0.0/15 时附代理 fake-IP 提示", async () => {
    safeFetchMock.mockResolvedValue({
      kind: "ssrf-blocked",
      ip: "198.18.1.44",
      range: "198.18.0.0/15",
    });
    const r = await tool.call({ url: "https://docs.python.org/3/" }, makeContext());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("198.18.1.44");
    expect(r.content).toContain("fake-IP");
    expect(r.content).toContain("proxy");
  });

  it("ssrf-blocked 命中其他 range 不附 fake-IP 提示", async () => {
    safeFetchMock.mockResolvedValue({
      kind: "ssrf-blocked",
      ip: "127.0.0.1",
      range: "127.0.0.0/8",
    });
    const r = await tool.call({ url: "http://localhost/" }, makeContext());
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain("fake-IP");
  });

  it("http-error 友好 message 含 bodySnippet", async () => {
    safeFetchMock.mockResolvedValue({
      kind: "http-error",
      status: 404,
      bodySnippet: "Not Found",
    });
    const r = await tool.call({ url: "https://x.com/missing" }, makeContext());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("HTTP 404");
    expect(r.content).toContain("Not Found");
  });

  it("redirect-blocked 友好 message", async () => {
    safeFetchMock.mockResolvedValue({
      kind: "redirect-blocked",
      from: "https://a.com/",
      to: "https://b.com/",
      reason: "cross-host",
    });
    const r = await tool.call({ url: "https://a.com/" }, makeContext());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("cross-host");
  });

  it("too-large 友好 message", async () => {
    safeFetchMock.mockResolvedValue({
      kind: "too-large",
      bytes: 10_000_000,
      limit: 5_242_880,
    });
    const r = await tool.call({ url: "https://big.com/" }, makeContext());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("too large");
  });
});

// ─── abortSignal 透传到 safeFetch ───

describe("abortSignal", () => {
  it("透传到 safeFetch opts", async () => {
    safeFetchMock.mockResolvedValue(makeFetchResult("<p>x</p>"));
    const ac = new AbortController();
    await tool.call({ url: "https://x.com/" }, makeContext({ abortSignal: ac.signal }));
    const optsArg = safeFetchMock.mock.calls[0]?.[2] as { abortSignal?: AbortSignal };
    expect(optsArg?.abortSignal).toBe(ac.signal);
  });
});
