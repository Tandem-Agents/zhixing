// 知行网络出口原语 — 公共 API

// 安全 fetch
export { DEFAULT_NETWORK_POLICY, safeFetch } from "./safe-fetcher.js";

// URL / IP 防护
export { DEFAULT_BLOCKED_NETWORKS, classifyIp, validateUrl } from "./url-guard.js";

// 文本净化
export { sanitizeUntrustedText } from "./text-sanitizer.js";

// 类型契约
export type {
  FetchError,
  FetchResult,
  IpRange,
  NetworkPolicy,
  SanitizeOptions,
} from "./types.js";
