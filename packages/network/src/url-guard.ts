/**
 * URL 与 IP 防护原语 — 纯函数,零 I/O。
 *
 * 职责切分:
 * - validateUrl: 同步可决定的检查(协议/长度/userinfo/格式)
 * - classifyIp: IP 字面量是否命中禁止网段(IPv4/IPv6/IPv4-mapped IPv6)
 * - extractHostname: URL 解析后剥离 IPv6 brackets
 * - DEFAULT_BLOCKED_NETWORKS: 内置防御网段(由 safe-fetcher 与 consumer 追加合并使用)
 *
 * 不在此文件:
 * - DNS 解析(safe-fetcher 的 lookup hook)
 * - 重定向追踪(safe-fetcher)
 */

import { isIPv4, isIPv6 } from "node:net";
import type { FetchError, IpRange, NetworkPolicy } from "./types.js";

// ─── 内置防御网段 ───

/**
 * 内置 SSRF 防御网段。覆盖 IPv4 与 IPv6 的私网/回环/链路本地/multicast/保留段。
 *
 * 此常量由 safe-fetcher 始终并入 NetworkPolicy.blockedNetworks,
 * consumer 传 [] 也无法关闭——blockedNetworks 字段语义是"追加"。
 */
export const DEFAULT_BLOCKED_NETWORKS: readonly IpRange[] = [
  // IPv4
  "127.0.0.0/8", // loopback
  "10.0.0.0/8", // private
  "172.16.0.0/12", // private
  "192.168.0.0/16", // private
  "169.254.0.0/16", // link-local
  "100.64.0.0/10", // CGNAT
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved
  "0.0.0.0/8", // current network / unspecified
  // IPv6
  "::1/128", // loopback
  "fc00::/7", // ULA
  "fe80::/10", // link-local
  "ff00::/8", // multicast
  "::/128", // unspecified
] as const;

// ─── IP 解析(internal) ───

interface ParsedIp {
  value: bigint;
  family: 4 | 6;
}

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (n < 0 || n > 255) return null;
    result = (result << 8n) | BigInt(n);
  }
  return result;
}

function ipv6ToBigInt(ip: string): bigint | null {
  const sides = ip.split("::");
  let groups: string[];
  if (sides.length === 1) {
    groups = (sides[0] ?? "").split(":");
    if (groups.length !== 8) return null;
  } else if (sides.length === 2) {
    const before = sides[0] ?? "";
    const after = sides[1] ?? "";
    const headGroups = before === "" ? [] : before.split(":");
    const tailGroups = after === "" ? [] : after.split(":");
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    groups = [...headGroups, ...Array<string>(missing).fill("0"), ...tailGroups];
  } else {
    return null;
  }
  let result = 0n;
  for (const part of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    result = (result << 16n) | BigInt(`0x${part}`);
  }
  return result;
}

/** IPv4-mapped IPv6 前缀 ::ffff:0:0/96 在 bigint 高 96 位的标记值 */
const IPV4_MAPPED_PREFIX = 0xffffn;
/** 32 位 IPv4 在 bigint 内的掩码 */
const IPV4_MASK = 0xffffffffn;

function parseIp(ip: string): ParsedIp | null {
  // 文本形式 ::ffff:a.b.c.d
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) {
    const v4 = mapped[1];
    if (!v4 || !isIPv4(v4)) return null;
    const value = ipv4ToBigInt(v4);
    if (value === null) return null;
    return { value, family: 4 };
  }
  if (isIPv4(ip)) {
    const value = ipv4ToBigInt(ip);
    if (value === null) return null;
    return { value, family: 4 };
  }
  if (isIPv6(ip)) {
    const value = ipv6ToBigInt(ip);
    if (value === null) return null;
    // 规范化 hex 形式的 IPv4-mapped IPv6(如 ::ffff:a00:1 等价于 ::ffff:10.0.0.1):
    // URL parser 会把文本形式自动转成 hex 形式,必须在 bigint 层一并识别,否则
    // 攻击者可用 [::ffff:a00:1] 绕过文本 regex 检查访问 10.0.0.1。
    if (value >> 32n === IPV4_MAPPED_PREFIX) {
      return { value: value & IPV4_MASK, family: 4 };
    }
    return { value, family: 6 };
  }
  return null;
}

// ─── CIDR 匹配(internal) ───

interface ParsedCidr {
  network: bigint;
  prefixLen: number;
  family: 4 | 6;
}

function parseCidr(range: IpRange): ParsedCidr | null {
  const idx = range.indexOf("/");
  if (idx === -1) return null;
  const addr = range.slice(0, idx);
  const prefix = range.slice(idx + 1);
  if (!/^\d+$/.test(prefix)) return null;
  const parsed = parseIp(addr);
  if (!parsed) return null;
  const prefixLen = Number.parseInt(prefix, 10);
  const totalBits = parsed.family === 4 ? 32 : 128;
  if (prefixLen < 0 || prefixLen > totalBits) return null;
  const mask = buildMask(prefixLen, totalBits);
  return { network: parsed.value & mask, prefixLen, family: parsed.family };
}

function buildMask(prefixLen: number, totalBits: number): bigint {
  if (prefixLen === 0) return 0n;
  return ((1n << BigInt(prefixLen)) - 1n) << BigInt(totalBits - prefixLen);
}

function ipInRange(ip: ParsedIp, cidr: ParsedCidr): boolean {
  if (ip.family !== cidr.family) return false;
  const totalBits = cidr.family === 4 ? 32 : 128;
  const mask = buildMask(cidr.prefixLen, totalBits);
  return (ip.value & mask) === cidr.network;
}

// ─── 公共 API ───

/**
 * 判断 IP 字面量是否命中任一禁止网段。
 *
 * 安全语义:
 * - IPv4-mapped IPv6 (::ffff:a.b.c.d) 自动按 IPv4 处理,封堵经典 SSRF bypass
 * - 非法 IP 字面量返回 null(语义为"不在禁止列表",由 validateUrl 上游捕获非法格式)
 *
 * @param ip IP 字面量(IPv4 / IPv6,不含 brackets)
 * @param blockedNetworks 禁止网段列表(safe-fetcher 已并入 DEFAULT_BLOCKED_NETWORKS)
 * @returns 命中范围对象 | null
 */
export function classifyIp(
  ip: string,
  blockedNetworks: readonly IpRange[],
): { range: IpRange } | null {
  const parsed = parseIp(ip);
  if (!parsed) return null;
  for (const range of blockedNetworks) {
    const cidr = parseCidr(range);
    if (cidr && ipInRange(parsed, cidr)) {
      return { range };
    }
  }
  return null;
}

/**
 * 提取 URL hostname 并剥离 IPv6 brackets。
 * Node URL.hostname 对 IPv6 形如 "[::1]"——本函数返回纯地址 "::1"。
 */
export function extractHostname(url: URL): string {
  const h = url.hostname;
  if (h.startsWith("[") && h.endsWith("]")) {
    return h.slice(1, -1);
  }
  return h;
}

/**
 * 校验 URL 是否符合 NetworkPolicy 的同步约束(协议/长度/userinfo/可解析性)。
 *
 * 不做 IP / DNS 检查——见模块顶部职责切分注释。
 *
 * @returns null 表示通过；FetchError 表示拒绝
 */
export function validateUrl(rawUrl: string, policy: NetworkPolicy): FetchError | null {
  if (rawUrl.length > policy.maxUrlLength) {
    return { kind: "url-invalid", reason: "too-long" };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { kind: "url-invalid", reason: "malformed" };
  }
  const protocol = parsed.protocol.replace(/:$/, "");
  if (!policy.allowedProtocols.includes(protocol as "http" | "https")) {
    return { kind: "url-invalid", reason: "protocol" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { kind: "url-invalid", reason: "userinfo" };
  }
  if (!parsed.hostname) {
    return { kind: "url-invalid", reason: "malformed" };
  }
  return null;
}
