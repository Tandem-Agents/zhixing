import { beforeEach, describe, expect, it, vi } from "vitest";

// mock undici 的 fetch —— 验证 createSafeFetch 强制传给底层的 redirect 策略；
// createDispatcher 用到的 Agent/ProxyAgent 等保留真实实现（importOriginal）。
const { undiciFetchMock } = vi.hoisted(() => ({ undiciFetchMock: vi.fn() }));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: undiciFetchMock };
});

const { createSafeFetch } = await import("../safe-fetcher.js");

describe("createSafeFetch — redirect 防护", () => {
  beforeEach(() => {
    undiciFetchMock.mockReset();
    undiciFetchMock.mockResolvedValue(new Response("ok"));
  });

  it("强制 redirect:error（堵 redirect 绕过 SSRF）", async () => {
    await createSafeFetch()("https://example.com/mcp");
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "https://example.com/mcp",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("调用方传 redirect:follow 也被强制覆盖为 error", async () => {
    await createSafeFetch()("https://example.com/mcp", { redirect: "follow" });
    const init = undiciFetchMock.mock.calls.at(-1)?.[1] as
      | { redirect?: string }
      | undefined;
    expect(init?.redirect).toBe("error");
  });
});
