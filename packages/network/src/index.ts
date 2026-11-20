// 知行网络出口原语 — 公共 API

// 安全 fetch
export {
  createSafeFetch,
  DEFAULT_NETWORK_POLICY,
  safeFetch,
} from "./safe-fetcher.js";
export type { SafeFetch } from "./safe-fetcher.js";

// URL / IP 防护
export { DEFAULT_BLOCKED_NETWORKS, classifyIp, validateUrl } from "./url-guard.js";

// 文本净化
export { sanitizeUntrustedText } from "./text-sanitizer.js";

// 代理诊断
//   - resolveProxy:     返回实际生效的 URL（dispatcher / cause 标注内部用）
//   - describeProxy:    返回 user-facing 描述（mode/resolved/display 三元组，cli /status 等）
//   - redactProxyUrl:   凭证脱敏 util（任何 user/LLM-facing 显示点都应过这层）
export {
  describeProxy,
  redactProxyUrl,
  resolveProxy,
} from "./proxy.js";

// 受控单跳传输原语（供模型适配、发现与可信目录抓取复用）
export {
  ALWAYS_BLOCKED_NETWORKS,
  createControlledSingleHopTransport,
  isLocalOrPrivateHostname,
  isNoProxyMatch,
  redactTargetUrl,
  resolveSingleHopRoute,
  validateSingleHopHeaderName,
} from "./single-hop.js";
export type {
  ConnectionProxyPolicy,
  ControlledSingleHopOptions,
  ControlledSingleHopTransport,
  SingleHopResponse,
  SingleHopRoute,
  SingleHopSecurityError,
} from "./single-hop.js";

// 类型契约
export type {
  FetchError,
  FetchResult,
  IpRange,
  NetworkPolicy,
  ProxyDescription,
  SanitizeOptions,
} from "./types.js";
