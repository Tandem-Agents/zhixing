import { promises as dnsPromises } from "node:dns";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isSsrfError, makeSecureLookup } from "../safe-fetcher-internal.js";
import { DEFAULT_BLOCKED_NETWORKS } from "../url-guard.js";

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lookup: vi.fn(),
    },
  };
});

const lookupMock = vi.mocked(dnsPromises.lookup);

function invokeLookup(
  hostname: string,
): Promise<{ err: NodeJS.ErrnoException | null; address: string; family: number }> {
  const lookup = makeSecureLookup(DEFAULT_BLOCKED_NETWORKS);
  return new Promise((resolve) => {
    lookup(hostname, {}, (err, address, family) => {
      resolve({ err, address, family });
    });
  });
}

describe("makeSecureLookup", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("解析到 IPv4 内网时回调 SsrfError(结构化字段)", async () => {
    lookupMock.mockResolvedValue({ address: "127.0.0.1", family: 4 });
    const { err } = await invokeLookup("evil.example.com");
    expect(err).not.toBeNull();
    expect(err?.code).toBe("ESSRFBLOCKED");
    expect(isSsrfError(err)).toBe(true);
    if (!isSsrfError(err)) throw new Error("type guard failed");
    expect(err.ssrf).toEqual({
      hostname: "evil.example.com",
      ip: "127.0.0.1",
      range: "127.0.0.0/8",
    });
  });

  it("解析到 IPv6 内网(::1)时拒绝并携带 ssrf 字段", async () => {
    lookupMock.mockResolvedValue({ address: "::1", family: 6 });
    const { err } = await invokeLookup("evil.example.com");
    expect(isSsrfError(err)).toBe(true);
    if (!isSsrfError(err)) throw new Error("type guard failed");
    expect(err.ssrf.range).toBe("::1/128");
    expect(err.ssrf.ip).toBe("::1");
  });

  it("解析到 IPv4-mapped IPv6 内网时仍命中 IPv4 防御", async () => {
    lookupMock.mockResolvedValue({ address: "::ffff:10.0.0.1", family: 6 });
    const { err } = await invokeLookup("ipv4mapped.example.com");
    expect(isSsrfError(err)).toBe(true);
    if (!isSsrfError(err)) throw new Error("type guard failed");
    expect(err.ssrf.range).toBe("10.0.0.0/8");
  });

  it("解析到公网 IPv4 时放行", async () => {
    lookupMock.mockResolvedValue({ address: "8.8.8.8", family: 4 });
    const { err, address, family } = await invokeLookup("dns.google");
    expect(err).toBeNull();
    expect(address).toBe("8.8.8.8");
    expect(family).toBe(4);
  });

  it("解析到公网 IPv6 时放行", async () => {
    lookupMock.mockResolvedValue({ address: "2001:4860:4860::8888", family: 6 });
    const { err, address, family } = await invokeLookup("dns.google");
    expect(err).toBeNull();
    expect(address).toBe("2001:4860:4860::8888");
    expect(family).toBe(6);
  });

  it("DNS 解析失败时透传原错误对象(非 SsrfError)", async () => {
    const dnsErr: NodeJS.ErrnoException = new Error("getaddrinfo ENOTFOUND");
    dnsErr.code = "ENOTFOUND";
    lookupMock.mockRejectedValue(dnsErr);
    const { err } = await invokeLookup("nonexistent.invalid");
    expect(err).toBe(dnsErr);
    expect(err?.code).toBe("ENOTFOUND");
    expect(isSsrfError(err)).toBe(false);
  });

  it("用追加的 blockedNetworks 拒绝公司内网段", async () => {
    lookupMock.mockResolvedValue({ address: "192.0.2.50", family: 4 });
    const lookup = makeSecureLookup([...DEFAULT_BLOCKED_NETWORKS, "192.0.2.0/24"]);
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      lookup("doc-example.com", {}, (e) => resolve(e));
    });
    expect(isSsrfError(err)).toBe(true);
    if (!isSsrfError(err)) throw new Error("type guard failed");
    expect(err.ssrf.range).toBe("192.0.2.0/24");
    expect(err.ssrf.hostname).toBe("doc-example.com");
  });
});

describe("isSsrfError 类型守卫", () => {
  it("非 Error 返回 false", () => {
    expect(isSsrfError(null)).toBe(false);
    expect(isSsrfError(undefined)).toBe(false);
    expect(isSsrfError("SSRF blocked")).toBe(false);
    expect(isSsrfError({ code: "ESSRFBLOCKED", ssrf: {} })).toBe(false);
  });

  it("普通 Error 返回 false", () => {
    expect(isSsrfError(new Error("anything"))).toBe(false);
  });

  it("仅有 ESSRFBLOCKED code 但无 ssrf 字段返回 false(防误识别)", () => {
    const err = new Error("x") as NodeJS.ErrnoException;
    err.code = "ESSRFBLOCKED";
    expect(isSsrfError(err)).toBe(false);
  });

  it("有 ssrf 字段但无 ESSRFBLOCKED code 返回 false", () => {
    const err = new Error("x") as Error & { ssrf: object };
    err.ssrf = { hostname: "x", ip: "1.2.3.4", range: "x/8" };
    expect(isSsrfError(err)).toBe(false);
  });
});
