import type { NetworkPolicy, ProxyDescription } from "./types.js";
export type { ProxyDescription } from "./types.js";

/**
 * 解析 effective proxy URL —— 仅用于诊断标注（拼接到 FetchError.cause 的
 * "(via proxy ...)" 后缀）/ describeProxy 内部复用。
 *
 * **不影响 dispatch**：EnvHttpProxyAgent 内部自决最终用哪个 env 变量（按 URL
 * scheme 选 HTTP_PROXY 还是 HTTPS_PROXY，以及 NO_PROXY 白名单）。本函数双层读
 * env 是可接受的微小冗余（μs 级 + 无副作用）。
 *
 * **scheme-aware**（可选 `targetUrl` 参数，与 EnvHttpProxyAgent 对齐）：
 * - target 是 http: → 优先 `HTTP_PROXY`（fallback `HTTPS_PROXY` → 小写）
 * - target 是 https: / 未传 → 优先 `HTTPS_PROXY`（fallback `HTTP_PROXY` → 小写）
 *
 * 不传 `targetUrl` 时沿用 https-first（覆盖 99% 场景，且 `/status` 启动时无具体目标
 * 也用此作为通用默认）。
 *
 * **已知限制**：本函数不识别 `NO_PROXY` 白名单——undici 内部正确处理 NO_PROXY，
 * 本函数只用于诊断显示与 enrich 标注；NO_PROXY 命中时此函数返回的 URL 在 cause
 * 标注里不精确（实际未走代理却显示走了），是可接受的诊断不精确——真实 dispatch
 * 行为不受影响。
 *
 * @param proxy     NetworkPolicy.proxy 字段值
 * @param env       环境变量对象,默认 process.env(测试时可注入)
 * @param targetUrl 目标请求 URL（可选，scheme-aware）
 * @returns null 表示直连（无代理），string 表示生效的代理 URL
 */
export function resolveProxy(
  proxy: NetworkPolicy["proxy"],
  env: NodeJS.ProcessEnv = process.env,
  targetUrl?: string | URL,
): string | null {
  if (proxy === "off") return null;
  if (proxy === undefined || proxy === "auto") {
    return resolveFromEnv(env, targetUrl);
  }
  return proxy; // 显式 URL
}

/** 内部：按 target scheme 选 env 优先级，返回首个非空 */
function resolveFromEnv(env: NodeJS.ProcessEnv, targetUrl?: string | URL): string | null {
  if (parseTargetScheme(targetUrl) === "http") {
    return env.HTTP_PROXY ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.https_proxy ?? null;
  }
  return env.HTTPS_PROXY ?? env.HTTP_PROXY ?? env.https_proxy ?? env.http_proxy ?? null;
}

/** "http" / "https" / "other"（含未传 / 解析失败 / 非 http(s) 协议） */
function parseTargetScheme(targetUrl?: string | URL): "http" | "https" | "other" {
  if (targetUrl === undefined) return "other";
  try {
    const u = typeof targetUrl === "string" ? new URL(targetUrl) : targetUrl;
    if (u.protocol === "https:") return "https";
    if (u.protocol === "http:") return "http";
    return "other";
  } catch {
    return "other";
  }
}

/**
 * 把 proxy URL 中的 `username:password@` 部分替换为 `***@`，返回脱敏副本。
 *
 * 设计契约：
 * - **幂等**：已脱敏的 URL 再传不变（`***` 无 password，再 redact 仍是 `***`）
 * - **容错**：非法 URL 原样返回，不抛异常
 * - **零信任**：username 单独存在（无 password）也脱敏——username 本身可能是
 *   敏感信息（domain account / API key 形式等）
 *
 * 用于：
 * - safeFetch 主循环 enrichWithProxyContext 拼到 cause（避免明文凭证进 LLM
 *   上下文 / transcript JSONL）
 * - cli `/status` 等 user-facing 展示（避免明文凭证进终端 / 日志录屏）
 *
 * 所有 user/LLM-facing 的 proxy URL 字符串都应该过这层。
 */
export function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = "***";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 计算代理配置的 user-facing 描述（cli `/status` 等展示路径用）。
 *
 * 与 `resolveProxy` 的职责切分：
 * - `resolveProxy`：返回**实际生效**的 URL（dispatcher / cause 标注用，原始）
 * - `describeProxy`：返回 `ProxyDescription` 三元组（mode 判别 + 原始 + 脱敏显示）
 *
 * 区分四态——见 `ProxyDescription` 类型注释。
 *
 * @param proxy NetworkPolicy.proxy 字段值
 * @param env   环境变量对象,默认 process.env(测试时可注入)
 */
export function describeProxy(
  proxy: NetworkPolicy["proxy"],
  env: NodeJS.ProcessEnv = process.env,
): ProxyDescription {
  if (proxy === "off") {
    return { mode: "off", resolved: null, display: "off (explicitly disabled)" };
  }
  if (proxy === undefined || proxy === "auto") {
    const resolved = resolveProxy(proxy, env);
    if (resolved === null) {
      return {
        mode: "auto",
        resolved: null,
        display: "direct (auto: no HTTP_PROXY/HTTPS_PROXY env detected)",
      };
    }
    return {
      mode: "auto",
      resolved,
      display: `${redactProxyUrl(resolved)} (auto: from env)`,
    };
  }
  return {
    mode: "explicit",
    resolved: proxy,
    display: `${redactProxyUrl(proxy)} (from config)`,
  };
}
