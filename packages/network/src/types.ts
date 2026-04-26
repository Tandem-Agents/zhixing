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
  /**
   * 代理配置(undefined 等价于 "auto"):
   *   - undefined / "auto": 从环境变量读 HTTP_PROXY/HTTPS_PROXY/NO_PROXY(Unix 惯例)
   *   - "off": 显式禁用,即使环境变量有也不用代理
   *   - "http://host:port" / "https://host:port": 显式代理 URL(支持 Basic Auth)
   *
   * 不支持 SOCKS(MVP),用户在代理软件里启用 HTTP 端口即可。
   * 启用代理后 IP-resolved SSRF 防御在目标 hostname 路径上失效——目标 DNS
   * 由代理服务器解析,client 端 lookup hook 不被调用。URL 字面 IP 检查
   * (validateUrl + classifyIp)仍同步生效,封堵 http://127.0.0.1/ 等字面攻击。
   */
  proxy?: "auto" | "off" | string;
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

// ─── 代理诊断 ───

/**
 * 代理配置的 user-facing 描述（cli `/status` 等展示路径用）。
 *
 * 与 `resolveProxy` 的职责切分：
 * - `resolveProxy`：返回**实际生效**的 URL（dispatcher 内部 / cause 标注用）
 * - `describeProxy`：返回**配置语义 + 解析结果 + 安全显示串**三元组（用户面板用）
 *
 * 区分四态（否则 `string | null` 二值无法判别"用户禁用"还是"未检测到 env"）：
 *   1. `mode=off`：用户显式禁用 → `resolved=null`
 *   2. `mode=auto` + `resolved=null`：未检测到 HTTP_PROXY/HTTPS_PROXY env
 *   3. `mode=auto` + `resolved=string`：从 env 自动识别
 *   4. `mode=explicit`：用户显式配置 URL
 *
 * 未来加新 mode（如 SOCKS）只需扩 union，调用方 `switch(mode)` 自动得到穷尽性。
 */
export interface ProxyDescription {
  mode: "off" | "auto" | "explicit";
  /**
   * 实际会用的代理 URL（**原始**，未脱敏；`resolveProxy` 等价值）。
   * - `mode=off`：始终 null
   * - `mode=auto`：env 没设时为 null
   * - `mode=explicit`：始终是配置值本身
   *
   * 保留原始值是为未来可能需要重连/比对（如配置热重载场景）。user-facing
   * 展示请用 `display`，不要直接打印 `resolved`（可能含明文凭证）。
   */
  resolved: string | null;
  /**
   * 已脱敏的人类可读字符串，可直接打印到终端/日志/LLM 上下文。
   * 形如：`"off (explicitly disabled)"` / `"http://***@proxy:8080 (auto: from env)"` /
   * `"direct (auto: no HTTP_PROXY/HTTPS_PROXY env detected)"`。
   */
  display: string;
}

// ─── 文本净化 ───

export interface SanitizeOptions {
  /** 字符级长度上限。超长时尾部用 truncationMarker 替代 */
  maxChars?: number;
  /** Unicode 归一化形式（默认 NFC） */
  normalizeForm?: "NFC" | "NFKC";
  /** 截断标记（默认 "[... truncated]"） */
  truncationMarker?: string;
}
