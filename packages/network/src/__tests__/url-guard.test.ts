import { describe, expect, it } from "vitest";
import {
  DEFAULT_BLOCKED_NETWORKS,
  classifyIp,
  extractHostname,
  validateUrl,
} from "../url-guard.js";
import type { NetworkPolicy } from "../types.js";

const basePolicy: NetworkPolicy = {
  allowedProtocols: ["https", "http"],
  maxUrlLength: 2048,
  maxBodyBytes: 5 * 1024 * 1024,
  timeoutMs: 30_000,
  maxRedirects: 5,
  redirectPolicy: "same-host-only",
  blockedNetworks: DEFAULT_BLOCKED_NETWORKS,
};

describe("validateUrl", () => {
  it("通过合法 https URL", () => {
    expect(validateUrl("https://example.com/path", basePolicy)).toBeNull();
  });

  it("通过合法 http URL", () => {
    expect(validateUrl("http://example.com/", basePolicy)).toBeNull();
  });

  it("拒绝超长 URL", () => {
    const long = `https://example.com/${"a".repeat(2050)}`;
    expect(validateUrl(long, basePolicy)).toEqual({
      kind: "url-invalid",
      reason: "too-long",
    });
  });

  it("拒绝非 URL 格式", () => {
    expect(validateUrl("not-a-url", basePolicy)).toEqual({
      kind: "url-invalid",
      reason: "malformed",
    });
  });

  it("拒绝禁止协议 file://", () => {
    expect(validateUrl("file:///etc/passwd", basePolicy)).toEqual({
      kind: "url-invalid",
      reason: "protocol",
    });
  });

  it("拒绝禁止协议 ftp://", () => {
    expect(validateUrl("ftp://example.com/", basePolicy)).toEqual({
      kind: "url-invalid",
      reason: "protocol",
    });
  });

  it("拒绝包含 username 的 URL", () => {
    expect(validateUrl("https://admin@example.com/", basePolicy)).toEqual({
      kind: "url-invalid",
      reason: "userinfo",
    });
  });

  it("拒绝包含 username:password 的 URL", () => {
    expect(validateUrl("https://admin:secret@example.com/", basePolicy)).toEqual({
      kind: "url-invalid",
      reason: "userinfo",
    });
  });

  it("仅允许 https 时拒绝 http", () => {
    const httpsOnly: NetworkPolicy = { ...basePolicy, allowedProtocols: ["https"] };
    expect(validateUrl("http://example.com/", httpsOnly)).toEqual({
      kind: "url-invalid",
      reason: "protocol",
    });
  });

  it("通过 IPv6 字面量 URL", () => {
    expect(validateUrl("https://[2001:db8::1]/", basePolicy)).toBeNull();
  });
});

describe("classifyIp - IPv4 内置范围", () => {
  const blocked = DEFAULT_BLOCKED_NETWORKS;

  it.each([
    ["127.0.0.1", "127.0.0.0/8"],
    ["127.255.255.254", "127.0.0.0/8"],
    ["10.0.0.1", "10.0.0.0/8"],
    ["10.255.255.255", "10.0.0.0/8"],
    ["172.16.0.1", "172.16.0.0/12"],
    ["172.31.255.254", "172.16.0.0/12"],
    ["192.168.0.1", "192.168.0.0/16"],
    ["192.168.255.255", "192.168.0.0/16"],
    ["169.254.0.1", "169.254.0.0/16"],
    ["100.64.0.1", "100.64.0.0/10"],
    ["100.127.255.254", "100.64.0.0/10"],
    ["224.0.0.1", "224.0.0.0/4"],
    ["239.255.255.255", "224.0.0.0/4"],
    ["240.0.0.1", "240.0.0.0/4"],
    ["0.0.0.0", "0.0.0.0/8"],
    ["0.255.255.254", "0.0.0.0/8"],
    // IANA 测试与基准保留段
    ["192.0.2.1", "192.0.2.0/24"],
    ["192.0.2.255", "192.0.2.0/24"],
    ["198.51.100.1", "198.51.100.0/24"],
    ["198.51.100.254", "198.51.100.0/24"],
    ["203.0.113.1", "203.0.113.0/24"],
    ["203.0.113.254", "203.0.113.0/24"],
    ["198.18.0.1", "198.18.0.0/15"],
    ["198.18.1.44", "198.18.0.0/15"], // Clash 默认 fake-IP 起始
    ["198.19.255.254", "198.18.0.0/15"], // 198.18.0.0/15 末端
  ])("拒绝 %s（命中 %s）", (ip, range) => {
    expect(classifyIp(ip, blocked)).toEqual({ range });
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1", // 172.16/12 之外的 172.x
    "172.15.255.255",
    "100.63.255.255", // CGNAT 之外
    "100.128.0.0",
    "223.255.255.255", // multicast 之前
    "11.0.0.1", // 10/8 之外
  ])("放行公网 IP %s", (ip) => {
    expect(classifyIp(ip, blocked)).toBeNull();
  });
});

describe("classifyIp - IPv6 内置范围", () => {
  const blocked = DEFAULT_BLOCKED_NETWORKS;

  it.each([
    ["::1", "::1/128"],
    ["fc00::1", "fc00::/7"],
    ["fdff::1", "fc00::/7"],
    ["fe80::1", "fe80::/10"],
    ["febf::1", "fe80::/10"],
    ["ff02::1", "ff00::/8"],
    ["::", "::/128"],
  ])("拒绝 %s（命中 %s）", (ip, range) => {
    expect(classifyIp(ip, blocked)).toEqual({ range });
  });

  it.each([
    "2001:db8::1",
    "2606:4700:4700::1111", // Cloudflare DNS
    "2001:4860:4860::8888", // Google DNS
  ])("放行公网 IPv6 %s", (ip) => {
    expect(classifyIp(ip, blocked)).toBeNull();
  });

  it("大小写混合的 IPv6 命中", () => {
    expect(classifyIp("FE80::ABCD", blocked)).toEqual({ range: "fe80::/10" });
  });
});

describe("classifyIp - IPv4-mapped IPv6 (SSRF bypass 防御)", () => {
  const blocked = DEFAULT_BLOCKED_NETWORKS;

  it("::ffff:127.0.0.1 命中 IPv4 loopback", () => {
    expect(classifyIp("::ffff:127.0.0.1", blocked)).toEqual({ range: "127.0.0.0/8" });
  });

  it("::ffff:10.0.0.1 命中 IPv4 私网", () => {
    expect(classifyIp("::ffff:10.0.0.1", blocked)).toEqual({ range: "10.0.0.0/8" });
  });

  it("::ffff:192.168.1.1 命中 IPv4 私网", () => {
    expect(classifyIp("::ffff:192.168.1.1", blocked)).toEqual({ range: "192.168.0.0/16" });
  });

  it("::FFFF:127.0.0.1（大写）也命中", () => {
    expect(classifyIp("::FFFF:127.0.0.1", blocked)).toEqual({ range: "127.0.0.0/8" });
  });

  it("::ffff:8.8.8.8（公网）放行", () => {
    expect(classifyIp("::ffff:8.8.8.8", blocked)).toBeNull();
  });

  it("规范化 hex 形式 ::ffff:a00:1（=10.0.0.1）命中 IPv4 私网", () => {
    expect(classifyIp("::ffff:a00:1", blocked)).toEqual({ range: "10.0.0.0/8" });
  });

  it("规范化 hex 形式 ::ffff:7f00:1（=127.0.0.1）命中 loopback", () => {
    expect(classifyIp("::ffff:7f00:1", blocked)).toEqual({ range: "127.0.0.0/8" });
  });

  it("规范化 hex 形式 ::ffff:c0a8:101（=192.168.1.1）命中私网", () => {
    expect(classifyIp("::ffff:c0a8:101", blocked)).toEqual({ range: "192.168.0.0/16" });
  });

  it("规范化 hex 形式 ::ffff:808:808（=8.8.8.8）公网放行", () => {
    expect(classifyIp("::ffff:808:808", blocked)).toBeNull();
  });
});

describe("classifyIp - 自定义追加网段", () => {
  it("用户追加的范围生效", () => {
    const blocked = [...DEFAULT_BLOCKED_NETWORKS, "192.0.2.0/24"];
    expect(classifyIp("192.0.2.50", blocked)).toEqual({ range: "192.0.2.0/24" });
  });

  it("追加后 DEFAULT 仍生效", () => {
    const blocked = [...DEFAULT_BLOCKED_NETWORKS, "192.0.2.0/24"];
    expect(classifyIp("127.0.0.1", blocked)).toEqual({ range: "127.0.0.0/8" });
  });

  it("空 blockedNetworks 全部放行（仅 classifyIp 层面，safe-fetcher 会强制并入 DEFAULT）", () => {
    expect(classifyIp("127.0.0.1", [])).toBeNull();
  });
});

describe("classifyIp - 非法输入", () => {
  it("非法 IP 字面量返回 null", () => {
    expect(classifyIp("not-an-ip", DEFAULT_BLOCKED_NETWORKS)).toBeNull();
  });

  it("空字符串返回 null", () => {
    expect(classifyIp("", DEFAULT_BLOCKED_NETWORKS)).toBeNull();
  });

  it("数字超限的 IPv4 返回 null", () => {
    expect(classifyIp("256.0.0.1", DEFAULT_BLOCKED_NETWORKS)).toBeNull();
  });

  it("非法 CIDR 不命中（容错）", () => {
    expect(classifyIp("127.0.0.1", ["bad/range", "10/abc"])).toBeNull();
  });
});

describe("extractHostname", () => {
  it("普通 hostname 原样返回", () => {
    expect(extractHostname(new URL("https://example.com/"))).toBe("example.com");
  });

  it("IPv4 字面量原样返回", () => {
    expect(extractHostname(new URL("http://1.2.3.4/"))).toBe("1.2.3.4");
  });

  it("IPv6 字面量去除 brackets", () => {
    expect(extractHostname(new URL("http://[::1]/"))).toBe("::1");
  });

  it("IPv6 公网地址去除 brackets", () => {
    expect(extractHostname(new URL("http://[2001:db8::1]/"))).toBe("2001:db8::1");
  });
});
