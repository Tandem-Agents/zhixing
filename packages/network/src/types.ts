/**
 * 知行网络出口原语 — 公共类型契约。
 *
 * 设计原则：
 * - 错误是返回值不是异常：safeFetch 返回 FetchResult | FetchError 判别联合
 * - consumer 用 `if ("kind" in result)` 判别错误分支
 * - 类型字段命名遵循 web 标准（status / headers / body）
 */

// ─── IP / CIDR 表达 ───

/**
 * CIDR 表达的 IP 范围（如 "192.168.0.0/16" / "fe80::/10"）。
 * IPv4 与 IPv6 共用此类型，由 parseCidr 自动识别。
 */
export type IpRange = string;

// ─── 策略 ───

/**
 * 网络出口策略。consumer 通过 Partial<NetworkPolicy> 覆盖默认值。
 *
 * 不变量：safeFetch 内部强制把 DEFAULT_BLOCKED_NETWORKS 并入 blockedNetworks，
 * consumer 传 [] 也无法关闭内置防御——blockedNetworks 字段只能追加，不能删减。
 */
export interface NetworkPolicy {
  /** 允许的协议（默认 ["https", "http"]） */
  allowedProtocols: readonly ("http" | "https")[];
  /** URL 最大长度（默认 2048） */
  maxUrlLength: number;
  /** 响应体最大字节数（默认 5 MB） */
  maxBodyBytes: number;
  /** 单次请求超时（默认 30s） */
  timeoutMs: number;
  /** 最大重定向跳数（默认 5） */
  maxRedirects: number;
  /** 重定向策略：仅同 host / 跟随所有（默认同 host） */
  redirectPolicy: "same-host-only" | "follow-all";
  /** 追加的禁止 IP 范围。DEFAULT_BLOCKED_NETWORKS 始终生效，无法被此字段覆盖 */
  blockedNetworks: readonly IpRange[];
}

// ─── safeFetch 返回值 ───

export interface FetchResult {
  status: number;
  headers: Headers;
  body: Uint8Array;
  /** 经历重定向后的最终 URL（无重定向时等于请求 URL） */
  finalUrl: string;
  /** 重定向链：第一个元素是请求 URL，最后一个等于 finalUrl */
  redirectChain: readonly string[];
}

/**
 * safeFetch 错误（discriminated union）。
 *
 * redirect-blocked.reason:
 *   - "cross-host":  跳转目标 host 不同（redirectPolicy=same-host-only 时）
 *   - "ssrf":        跳转目标解析到内置/追加的 blocked 网段
 *   - "loop":        跳转链中出现重复 URL
 *   - "too-many":    跳转次数超过 maxRedirects
 *
 * dns vs connect-failed 区分：
 *   - dns:            明确的 DNS 解析失败(ENOTFOUND / EAI_AGAIN / EAI_NODATA / EAI_SERVICE)
 *   - connect-failed: 连接级失败(ECONNREFUSED / ECONNRESET / ETIMEDOUT /
 *                     EHOSTUNREACH / ENETUNREACH / EPIPE 等),也是未识别错误的兜底归类
 *                     (兜底偏向 connect-failed 而非 dns —— DNS 错误有明确 code,
 *                     未知错误更可能是连接/socket/proxy 问题)
 */
export type FetchError =
  | { kind: "url-invalid"; reason: "protocol" | "userinfo" | "too-long" | "malformed" }
  | { kind: "ssrf-blocked"; ip: string; range: IpRange }
  | {
      kind: "redirect-blocked";
      from: string;
      to: string;
      reason: "cross-host" | "ssrf" | "loop" | "too-many";
    }
  | { kind: "too-large"; bytes: number; limit: number }
  | { kind: "timeout"; ms: number }
  | { kind: "dns"; host: string; cause: string }
  | { kind: "connect-failed"; host: string; cause: string }
  | { kind: "http-error"; status: number; bodySnippet?: string };

// ─── 文本净化 ───

export interface SanitizeOptions {
  /** 字符级长度上限。超长时尾部用 truncationMarker 替代 */
  maxChars?: number;
  /** Unicode 归一化形式（默认 NFC） */
  normalizeForm?: "NFC" | "NFKC";
  /** 截断标记（默认 "[... truncated]"） */
  truncationMarker?: string;
}
