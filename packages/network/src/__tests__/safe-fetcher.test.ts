import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createPinnedAgentMock } = vi.hoisted(() => ({
  createPinnedAgentMock: vi.fn(),
}));

vi.mock("../safe-fetcher-internal.js", () => ({
  createPinnedAgent: createPinnedAgentMock,
  // mock 路径下永远不触发 lookup hook,所以恒为 false 即可
  isSsrfError: () => false,
}));

import { safeFetch } from "../safe-fetcher.js";

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  createPinnedAgentMock.mockReturnValue(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
  vi.clearAllMocks();
});

// ─── 同步 SSRF 拦截(不发请求) ───

describe("safeFetch - 同步 SSRF 拦截", () => {
  it("拒绝 IPv4 私网字面量 URL", async () => {
    const result = await safeFetch("http://127.0.0.1/");
    expect(result).toEqual({
      kind: "ssrf-blocked",
      ip: "127.0.0.1",
      range: "127.0.0.0/8",
    });
  });

  it("拒绝 IPv6 loopback 字面量 URL", async () => {
    const result = await safeFetch("http://[::1]/");
    expect(result).toEqual({
      kind: "ssrf-blocked",
      ip: "::1",
      range: "::1/128",
    });
  });

  it("拒绝 IPv4-mapped IPv6 字面量 URL(SSRF bypass 防御)", async () => {
    // URL parser 把 [::ffff:10.0.0.1] 规范化为 [::ffff:a00:1] —— ip 字段反映规范化结果,
    // range 必须命中 IPv4 私网防御(否则 bypass 成立)。
    const result = await safeFetch("http://[::ffff:10.0.0.1]/");
    expect(result).toMatchObject({
      kind: "ssrf-blocked",
      range: "10.0.0.0/8",
    });
  });

  it("拒绝 link-local IPv4 字面量", async () => {
    const result = await safeFetch("http://169.254.169.254/latest/meta-data/");
    expect(result).toEqual({
      kind: "ssrf-blocked",
      ip: "169.254.169.254",
      range: "169.254.0.0/16",
    });
  });
});

// ─── URL 校验失败 ───

describe("safeFetch - URL 校验", () => {
  it("拒绝超长 URL", async () => {
    const long = `https://example.com/${"a".repeat(2050)}`;
    const result = await safeFetch(long);
    expect(result).toEqual({ kind: "url-invalid", reason: "too-long" });
  });

  it("拒绝非 URL 格式", async () => {
    const result = await safeFetch("not-a-url");
    expect(result).toEqual({ kind: "url-invalid", reason: "malformed" });
  });

  it("拒绝 file:// 协议", async () => {
    const result = await safeFetch("file:///etc/passwd");
    expect(result).toEqual({ kind: "url-invalid", reason: "protocol" });
  });

  it("拒绝 ftp:// 协议", async () => {
    const result = await safeFetch("ftp://example.com/");
    expect(result).toEqual({ kind: "url-invalid", reason: "protocol" });
  });

  it("拒绝 userinfo URL", async () => {
    const result = await safeFetch("https://admin:secret@example.com/");
    expect(result).toEqual({ kind: "url-invalid", reason: "userinfo" });
  });
});

// ─── 成功路径 ───

describe("safeFetch - 200 成功", () => {
  it("简单 GET 返回 FetchResult", async () => {
    mockAgent
      .get("http://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(200, "hello world", { headers: { "content-type": "text/plain" } });

    const result = await safeFetch("http://example.com/");
    if ("kind" in result) throw new Error(`Expected success, got ${result.kind}`);
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe("hello world");
    expect(result.finalUrl).toBe("http://example.com/");
    expect(result.redirectChain).toEqual(["http://example.com/"]);
  });

  it("空 body 返回零长 Uint8Array", async () => {
    mockAgent
      .get("http://example.com")
      .intercept({ path: "/empty", method: "GET" })
      .reply(200, "");

    const result = await safeFetch("http://example.com/empty");
    if ("kind" in result) throw new Error(`Expected success, got ${result.kind}`);
    expect(result.body.byteLength).toBe(0);
  });

  it("headers 透传", async () => {
    mockAgent
      .get("http://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(200, "ok", { headers: { "x-custom": "value", "content-type": "application/json" } });

    const result = await safeFetch("http://example.com/");
    if ("kind" in result) throw new Error(`Expected success, got ${result.kind}`);
    expect(result.headers.get("x-custom")).toBe("value");
    expect(result.headers.get("content-type")).toBe("application/json");
  });
});

// ─── 重定向 ───

describe("safeFetch - 重定向", () => {
  it("跟随同 host 单跳重定向", async () => {
    const pool = mockAgent.get("http://example.com");
    pool.intercept({ path: "/old", method: "GET" }).reply(302, "", {
      headers: { location: "/new" },
    });
    pool.intercept({ path: "/new", method: "GET" }).reply(200, "moved");

    const result = await safeFetch("http://example.com/old");
    if ("kind" in result) throw new Error(`Expected success, got ${result.kind}`);
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe("http://example.com/new");
    expect(result.redirectChain).toEqual(["http://example.com/old", "http://example.com/new"]);
  });

  it("跟随多跳同 host 重定向", async () => {
    const pool = mockAgent.get("http://example.com");
    pool.intercept({ path: "/a", method: "GET" }).reply(301, "", { headers: { location: "/b" } });
    pool.intercept({ path: "/b", method: "GET" }).reply(302, "", { headers: { location: "/c" } });
    pool.intercept({ path: "/c", method: "GET" }).reply(200, "final");

    const result = await safeFetch("http://example.com/a");
    if ("kind" in result) throw new Error(`Expected success, got ${result.kind}`);
    expect(result.finalUrl).toBe("http://example.com/c");
    expect(result.redirectChain).toHaveLength(3);
  });

  it("拒绝 cross-host 重定向", async () => {
    mockAgent
      .get("http://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(302, "", { headers: { location: "http://evil.com/payload" } });

    const result = await safeFetch("http://example.com/");
    expect(result).toMatchObject({
      kind: "redirect-blocked",
      reason: "cross-host",
      from: "http://example.com/",
      to: "http://evil.com/payload",
    });
  });

  it("检测重定向 loop", async () => {
    const pool = mockAgent.get("http://example.com");
    pool.intercept({ path: "/a", method: "GET" }).reply(302, "", { headers: { location: "/b" } });
    pool.intercept({ path: "/b", method: "GET" }).reply(302, "", { headers: { location: "/a" } });

    const result = await safeFetch("http://example.com/a");
    expect(result).toMatchObject({ kind: "redirect-blocked", reason: "loop" });
  });

  it("超过 maxRedirects 返回 too-many", async () => {
    const pool = mockAgent.get("http://example.com");
    for (let i = 0; i < 10; i++) {
      pool
        .intercept({ path: `/p${i}`, method: "GET" })
        .reply(302, "", { headers: { location: `/p${i + 1}` } });
    }
    const result = await safeFetch("http://example.com/p0", { maxRedirects: 3 });
    expect(result).toMatchObject({ kind: "redirect-blocked", reason: "too-many" });
  });

  it("30x 无 Location header 时返回 http-error", async () => {
    mockAgent.get("http://example.com").intercept({ path: "/", method: "GET" }).reply(302, "");

    const result = await safeFetch("http://example.com/");
    expect(result).toEqual({ kind: "http-error", status: 302 });
  });
});

// ─── HTTP 错误 ───

describe("safeFetch - HTTP 错误", () => {
  it("404 返回 http-error 含 bodySnippet", async () => {
    mockAgent
      .get("http://example.com")
      .intercept({ path: "/missing", method: "GET" })
      .reply(404, "Not Found");

    const result = await safeFetch("http://example.com/missing");
    expect(result).toMatchObject({
      kind: "http-error",
      status: 404,
      bodySnippet: "Not Found",
    });
  });

  it("500 返回 http-error", async () => {
    mockAgent
      .get("http://example.com")
      .intercept({ path: "/boom", method: "GET" })
      .reply(500, "Internal Error");

    const result = await safeFetch("http://example.com/boom");
    expect(result).toMatchObject({ kind: "http-error", status: 500 });
  });
});

// ─── body 大小限制 ───

describe("safeFetch - body 大小限制", () => {
  it("响应体超 maxBodyBytes 返回 too-large", async () => {
    const big = "x".repeat(2000);
    mockAgent
      .get("http://example.com")
      .intercept({ path: "/big", method: "GET" })
      .reply(200, big);

    const result = await safeFetch("http://example.com/big", { maxBodyBytes: 1000 });
    expect(result).toMatchObject({ kind: "too-large", limit: 1000 });
    if ("kind" in result && result.kind === "too-large") {
      expect(result.bytes).toBeGreaterThan(1000);
    }
  });

  it("响应体恰好等于 maxBodyBytes 时正常返回", async () => {
    const exact = "y".repeat(1000);
    mockAgent
      .get("http://example.com")
      .intercept({ path: "/exact", method: "GET" })
      .reply(200, exact);

    const result = await safeFetch("http://example.com/exact", { maxBodyBytes: 1000 });
    if ("kind" in result) throw new Error(`Expected success, got ${result.kind}`);
    expect(result.body.byteLength).toBe(1000);
  });
});

// ─── 策略覆盖 ───

describe("safeFetch - 策略覆盖", () => {
  it("追加的 blockedNetworks 不能关闭内置防御", async () => {
    // consumer 即使传 [] 也无法关闭
    const result = await safeFetch("http://127.0.0.1/", { blockedNetworks: [] });
    expect(result).toEqual({
      kind: "ssrf-blocked",
      ip: "127.0.0.1",
      range: "127.0.0.0/8",
    });
  });

  it("追加自定义 blockedNetworks 命中拒绝", async () => {
    const result = await safeFetch("http://192.0.2.1/", {
      blockedNetworks: ["192.0.2.0/24"],
    });
    expect(result).toEqual({
      kind: "ssrf-blocked",
      ip: "192.0.2.1",
      range: "192.0.2.0/24",
    });
  });

  it("仅允许 https 时 http URL 被拒", async () => {
    const result = await safeFetch("http://example.com/", { allowedProtocols: ["https"] });
    expect(result).toEqual({ kind: "url-invalid", reason: "protocol" });
  });
});

// ─── AbortSignal ───

describe("safeFetch - AbortSignal", () => {
  it("已 aborted 的 signal 立即终止", async () => {
    mockAgent
      .get("http://example.com")
      .intercept({ path: "/", method: "GET" })
      .reply(200, "should not reach");

    const controller = new AbortController();
    controller.abort();
    const result = await safeFetch("http://example.com/", undefined, {
      abortSignal: controller.signal,
    });
    // abort 会触发 fetch reject,被归为 FetchError
    // 关键不是分类精确,而是不 hang —— result 必须返回
    expect("kind" in result).toBe(true);
  });
});

// ─── 错误归类: dns vs connect-failed ───

describe("safeFetch - 错误归类", () => {
  it("ENOTFOUND code → kind: dns", async () => {
    const dnsErr: NodeJS.ErrnoException = new Error("getaddrinfo ENOTFOUND nonexistent.invalid");
    dnsErr.code = "ENOTFOUND";
    mockAgent
      .get("http://nonexistent.invalid")
      .intercept({ path: "/", method: "GET" })
      .replyWithError(dnsErr);

    const result = await safeFetch("http://nonexistent.invalid/");
    expect(result).toMatchObject({ kind: "dns", host: "nonexistent.invalid" });
    if ("kind" in result && result.kind === "dns") {
      expect(result.cause).toContain("ENOTFOUND");
    }
  });

  it("ECONNREFUSED code → kind: connect-failed", async () => {
    const connErr: NodeJS.ErrnoException = new Error("connect ECONNREFUSED 8.8.8.8:80");
    connErr.code = "ECONNREFUSED";
    mockAgent
      .get("http://refused.example")
      .intercept({ path: "/", method: "GET" })
      .replyWithError(connErr);

    const result = await safeFetch("http://refused.example/");
    expect(result).toMatchObject({ kind: "connect-failed", host: "refused.example" });
    if ("kind" in result && result.kind === "connect-failed") {
      expect(result.cause).toContain("ECONNREFUSED");
    }
  });

  it("EHOSTUNREACH code → kind: connect-failed", async () => {
    const connErr: NodeJS.ErrnoException = new Error("connect EHOSTUNREACH");
    connErr.code = "EHOSTUNREACH";
    mockAgent
      .get("http://unreachable.example")
      .intercept({ path: "/", method: "GET" })
      .replyWithError(connErr);

    const result = await safeFetch("http://unreachable.example/");
    expect(result).toMatchObject({ kind: "connect-failed", host: "unreachable.example" });
  });

  it("ETIMEDOUT code → kind: connect-failed(连接级超时,非整体 timeout)", async () => {
    const connErr: NodeJS.ErrnoException = new Error("connect ETIMEDOUT");
    connErr.code = "ETIMEDOUT";
    mockAgent
      .get("http://slow.example")
      .intercept({ path: "/", method: "GET" })
      .replyWithError(connErr);

    const result = await safeFetch("http://slow.example/");
    expect(result).toMatchObject({ kind: "connect-failed", host: "slow.example" });
  });

  it("未识别 code 兜底 → kind: connect-failed(假设是连接问题,非 DNS)", async () => {
    const unknownErr = new Error("some weird internal error");
    mockAgent
      .get("http://weird.example")
      .intercept({ path: "/", method: "GET" })
      .replyWithError(unknownErr);

    const result = await safeFetch("http://weird.example/");
    expect(result).toMatchObject({ kind: "connect-failed", host: "weird.example" });
  });
});
