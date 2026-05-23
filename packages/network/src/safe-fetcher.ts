/**
 * safeFetch — SSRF 安全的 HTTP GET。
 *
 * 公共 API,接受 url + 可选策略覆盖,返回判别联合 FetchResult | FetchError。
 * 错误是返回值不是异常 —— consumer 用 `if ("kind" in result)` 判别。
 *
 * 安全契约:
 * - DNS pinning 双层: URL 预校验 IP 字面量 + Agent lookup hook 重做 SSRF 检查
 * - 重定向逐跳完整复检: redirect: "manual" + 自追踪,每跳重做 validateUrl + IP 检查 + 新 Agent
 * - body 大小限制: 流式累计字节,超限立即取消
 * - 超时与中止: HopLifecycle 统一管理 timer + abortSignal,覆盖整个 hop(fetch + body 读取)
 */

import { isIPv4, isIPv6 } from "node:net";
import { fetch as undiciFetch } from "undici";
import {
  createDispatcher,
  isSsrfError,
  redactProxyUrl,
  resolveProxy,
} from "./safe-fetcher-internal.js";
import type { FetchError, FetchResult, NetworkPolicy } from "./types.js";
import {
  DEFAULT_BLOCKED_NETWORKS,
  classifyIp,
  extractHostname,
  validateUrl,
} from "./url-guard.js";

export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
  allowedProtocols: ["https", "http"],
  maxUrlLength: 2048,
  maxBodyBytes: 5 * 1024 * 1024,
  timeoutMs: 30_000,
  maxRedirects: 5,
  redirectPolicy: "same-host-only",
  blockedNetworks: DEFAULT_BLOCKED_NETWORKS,
  proxy: "auto",
};

const HTTP_ERROR_BODY_SNIPPET_BYTES = 4096;

/**
 * 合并 consumer 覆盖与默认策略。
 * blockedNetworks 是追加语义: DEFAULT 始终生效,consumer 传 [] 也无法关闭防御。
 */
function mergePolicy(override?: Partial<NetworkPolicy>): NetworkPolicy {
  if (!override) return DEFAULT_NETWORK_POLICY;
  const blockedNetworks = override.blockedNetworks
    ? [...DEFAULT_BLOCKED_NETWORKS, ...override.blockedNetworks]
    : DEFAULT_BLOCKED_NETWORKS;
  return { ...DEFAULT_NETWORK_POLICY, ...override, blockedNetworks };
}

function isIpLiteral(host: string): boolean {
  return isIPv4(host) || isIPv6(host);
}

// ─── Hop 生命周期(timer + abort 资源管理) ───

/**
 * 单次 hop 的资源容器。
 *
 * 解决"timeout 在 fetch 阶段后立即清理 → body 读取无 protection"的债务:
 * - lifecycle 由主循环创建/dispose,覆盖整个 hop(fetch + 处理响应 + 读 body)
 * - performHop / readBody* 仅消费 lifecycle.signal,不自建 controller
 * - signal abort 由 timer 或 consumer abort 触发,通过 isTimedOut 区分两者
 */
interface HopLifecycle {
  /** signal 触发条件: timeout 到时 OR consumer abortSignal abort */
  readonly signal: AbortSignal;
  /** policy.timeoutMs 的回显,timeout 错误构造时使用 */
  readonly timeoutMs: number;
  /** 区分 abort 来源 — true: 因超时, false: 未 abort 或 consumer 主动 abort */
  isTimedOut(): boolean;
  /** 释放 timer 与 listener,幂等。主循环每个 hop 在 finally 中调用 */
  dispose(): void;
}

function createHopLifecycle(
  timeoutMs: number,
  userAbortSignal: AbortSignal | undefined,
): HopLifecycle {
  const controller = new AbortController();
  let timedOut = false;
  let disposed = false;

  const onUserAbort = () => controller.abort();
  if (userAbortSignal) {
    if (userAbortSignal.aborted) {
      controller.abort();
    } else {
      userAbortSignal.addEventListener("abort", onUserAbort, { once: true });
    }
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timeoutMs,
    isTimedOut: () => timedOut,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeoutId);
      userAbortSignal?.removeEventListener("abort", onUserAbort);
    },
  };
}

// ─── Hop 三态结果(显式 union,主循环穷尽匹配) ───

type HopOutcome =
  | { kind: "redirect"; nextUrl: string }
  | { kind: "result"; status: number; headers: Headers; body: Uint8Array }
  | FetchError;

/**
 * 执行一次 hop: fetch + 路由响应。
 * lifecycle 由 caller 创建并 dispose,本函数全程仅消费 lifecycle.signal。
 */
async function performHop(
  url: string,
  policy: NetworkPolicy,
  hostname: string,
  lifecycle: HopLifecycle,
): Promise<HopOutcome> {
  let response: Response;
  try {
    response = (await undiciFetch(url, {
      dispatcher: createDispatcher(policy.blockedNetworks, policy.proxy),
      redirect: "manual",
      signal: lifecycle.signal,
    })) as unknown as Response;
  } catch (err) {
    if (lifecycle.isTimedOut()) return { kind: "timeout", ms: lifecycle.timeoutMs };
    return classifyFetchError(err, hostname);
  }

  if (response.status >= 300 && response.status < 400) {
    return resolveRedirect(url, hostname, response, policy);
  }

  if (response.status >= 400) {
    const bodySnippet = await readBodySnippet(
      response,
      HTTP_ERROR_BODY_SNIPPET_BYTES,
      lifecycle,
      hostname,
    );
    return { kind: "http-error", status: response.status, bodySnippet };
  }

  // 2xx
  const bodyResult = await readBodyWithLimit(response, policy.maxBodyBytes, lifecycle, hostname);
  if ("kind" in bodyResult) return bodyResult;
  return {
    kind: "result",
    status: response.status,
    headers: response.headers,
    body: bodyResult.body,
  };
}

/** 解析重定向响应 → 下一跳 URL 或拒绝原因。纯函数,无 I/O */
function resolveRedirect(
  url: string,
  hostname: string,
  response: Response,
  policy: NetworkPolicy,
): HopOutcome {
  const location = response.headers.get("location");
  if (!location) return { kind: "http-error", status: response.status };
  let nextUrl: string;
  try {
    nextUrl = new URL(location, url).toString();
  } catch {
    return { kind: "redirect-blocked", from: url, to: location, reason: "cross-host" };
  }
  if (policy.redirectPolicy === "same-host-only") {
    const nextHost = extractHostname(new URL(nextUrl));
    if (nextHost !== hostname) {
      return { kind: "redirect-blocked", from: url, to: nextUrl, reason: "cross-host" };
    }
  }
  return { kind: "redirect", nextUrl };
}

// ─── 主入口 ───

/**
 * 发起 SSRF 安全的 HTTP GET。
 *
 * @param url           目标 URL
 * @param policyOverride 部分策略覆盖,blockedNetworks 是追加语义
 * @param opts.abortSignal consumer 中止信号(与 timeout 任一触发即取消)
 * @returns FetchResult(成功) | FetchError(失败,通过 `kind` 字段判别)
 */
export async function safeFetch(
  url: string,
  policyOverride?: Partial<NetworkPolicy>,
  opts?: { abortSignal?: AbortSignal },
): Promise<FetchResult | FetchError> {
  const policy = mergePolicy(policyOverride);
  const visited = new Set<string>();
  const redirectChain: string[] = [];
  let currentUrl = url;

  for (let hop = 0; hop <= policy.maxRedirects; hop++) {
    if (visited.has(currentUrl)) {
      const from = redirectChain[redirectChain.length - 1] ?? url;
      return { kind: "redirect-blocked", from, to: currentUrl, reason: "loop" };
    }
    visited.add(currentUrl);
    redirectChain.push(currentUrl);

    const validation = validateUrl(currentUrl, policy);
    if (validation) return validation;

    const parsed = new URL(currentUrl);
    const hostname = extractHostname(parsed);

    // 同步 SSRF: hostname 是 IP 字面量时不走 DNS,直接 classifyIp
    if (isIpLiteral(hostname)) {
      const cls = classifyIp(hostname, policy.blockedNetworks);
      if (cls) return { kind: "ssrf-blocked", ip: hostname, range: cls.range };
    }

    const lifecycle = createHopLifecycle(policy.timeoutMs, opts?.abortSignal);
    let outcome: HopOutcome;
    try {
      outcome = await performHop(currentUrl, policy, hostname, lifecycle);
    } finally {
      lifecycle.dispose();
    }

    if (outcome.kind === "redirect") {
      currentUrl = outcome.nextUrl;
      continue;
    }
    if (outcome.kind === "result") {
      return {
        status: outcome.status,
        headers: outcome.headers,
        body: outcome.body,
        finalUrl: currentUrl,
        redirectChain,
      };
    }
    // outcome 是 FetchError —— 注入代理上下文标注（每跳用本跳 currentUrl
    // scheme-aware 计算 effectiveProxy；重定向中 cross-scheme 也得到精确标注）
    return enrichWithProxyContext(outcome, policy.proxy, currentUrl);
  }

  // 超过 maxRedirects(循环退出未 return)
  const from = redirectChain[redirectChain.length - 2] ?? url;
  return { kind: "redirect-blocked", from, to: currentUrl, reason: "too-many" };
}

// ─── SSRF 安全的标准 fetch（供长连接 / 第三方 client 注入） ───

/**
 * 标准 fetch 形态（与第三方 client 的 FetchLike 结构兼容）+ close（释放底层连接池）。
 * 长连接消费者（如 MCP HTTP transport）断开时应调 close 显式释放 socket，而非依赖 GC。
 */
export interface SafeFetch {
  (url: string | URL, init?: RequestInit): Promise<Response>;
  /** 关闭底层 undici Agent 的连接池，释放保持的 socket。 */
  close(): Promise<void>;
}

/**
 * 创建 SSRF 安全的标准 fetch —— 供需要原生 Response / 长连接（如 SSE）的第三方
 * client 注入（如 MCP HTTP transport）。
 *
 * 与 safeFetch 的分工：safeFetch 是 GET-only 高层（逐跳 redirect 复检 + body 字节
 * 限制 + FetchResult union），适合"抓取一个 URL 的内容"；本函数返回标准 fetch，不
 * 限制 method / body / 流，SSRF 防护落在两层、与 safeFetch 主循环同一安全模型：
 *   - 同步：对请求 URL 做 validateUrl + 字面 IP 检查（覆盖代理路径——代理 Agent 不
 *     挂 lookup hook，目标字面 IP 必须在此同步拦截）
 *   - 连接：dispatcher 的 DNS-pinning lookup hook（直连路径）
 *   - redirect：强制禁止（redirect:"error"）—— 本函数为支持 SSE 放弃了 safeFetch 的
 *     逐跳复检，无法校验 redirect 目标；故一律不 follow、redirect 即报错，杜绝 redirect
 *     绕过 SSRF（字面 IP / 代理路径的 redirect 目标都不经 lookup hook）。需要 follow
 *     redirect 的场景用 safeFetch（逐跳复检）。
 * 代理路径的目标解析在代理端、不挂 lookup hook（用户对自配代理负责，与 createDispatcher 一致）。
 *
 * SSRF / 非法 URL 同步抛 Error（标准 fetch 失败契约）；连接级错误由 undici 抛。
 */
export function createSafeFetch(policyOverride?: Partial<NetworkPolicy>): SafeFetch {
  const policy = mergePolicy(policyOverride);
  const dispatcher = createDispatcher(policy.blockedNetworks, policy.proxy);

  const safeFetch = async (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();

    const validation = validateUrl(url, policy);
    if (validation) {
      throw new Error(`Request blocked by network policy (${validation.kind})`);
    }
    const hostname = extractHostname(new URL(url));
    if (isIpLiteral(hostname)) {
      const cls = classifyIp(hostname, policy.blockedNetworks);
      if (cls) {
        throw new Error(
          `SSRF blocked: ${hostname} is in restricted network ${cls.range}`,
        );
      }
    }

    const undiciInit = {
      ...init,
      dispatcher,
      // 强制覆盖调用方的 redirect —— 安全契约不可被外部放宽（见上方 redirect 说明）。
      redirect: "error",
    } as Parameters<typeof undiciFetch>[1];
    return (await undiciFetch(url, undiciInit)) as unknown as Response;
  };

  return Object.assign(safeFetch, {
    // 包成 async 显式返回 void —— undici dispatcher.close() resolve 值不保证为
    // undefined，调用方只关心"已关闭"。
    close: async () => {
      await dispatcher.close();
    },
  });
}

// ─── 代理上下文标注 ───

/**
 * 在 connect-failed 错误的 cause 中注入 "(via proxy ...)" 标注。
 *
 * 设计意图（单一职责）：
 * - classifyFetchError 保持纯归类，不知道是否走代理
 * - safeFetch 主循环唯一持有 policy + currentUrl，在 catch 后调用本函数注入上下文
 * - 仅 connect-failed 需要（其他 kind 跟代理无关）
 *
 * 关键：effectiveProxy 在本调用点用 `currentUrl` scheme-aware 解析（与
 * EnvHttpProxyAgent 实际选择对齐），避免 HTTP_PROXY/HTTPS_PROXY 不一致时
 * 标注误指；嵌入 cause 的 URL 走 `redactProxyUrl` 脱敏，避免明文凭证进
 * LLM 上下文 / transcript JSONL。
 *
 * 是否加 "ProxyConnectFailed:" 前缀：用**原始**（未脱敏）effectiveProxy 的
 * host:port 在 cause 字符串里查找——cause 来自 undici 实际报错，含的是真实
 * 通路的 host:port；命中即认为是代理 host 不可达（本地代理软件没运行的典型场景），
 * 给前缀帮助 LLM 直接诊断。
 */
function enrichWithProxyContext(
  error: FetchError,
  proxy: NetworkPolicy["proxy"],
  targetUrl: string,
): FetchError {
  if (error.kind !== "connect-failed") return error;
  const effectiveProxy = resolveProxy(proxy, undefined, targetUrl);
  if (!effectiveProxy) return error;

  const isProxyHostFailure = causeIncludesProxyHost(error.cause, effectiveProxy);
  const prefix = isProxyHostFailure ? "ProxyConnectFailed: " : "";
  const display = redactProxyUrl(effectiveProxy);
  return {
    ...error,
    cause: `${prefix}${error.cause} (via proxy ${display})`,
  };
}

/** 检查 cause 字符串是否含代理 hostname:port,用于识别"代理 host 不可达"场景 */
function causeIncludesProxyHost(cause: string, proxyUrl: string): boolean {
  try {
    const u = new URL(proxyUrl);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    const hostname = u.hostname.replace(/^\[|\]$/g, ""); // 去 IPv6 brackets
    return cause.includes(`${hostname}:${port}`);
  } catch {
    return false;
  }
}

// ─── 错误归类 ───

/** 明确的 DNS 解析失败 code(libuv getaddrinfo 错误) */
const DNS_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NODATA",
  "EAI_SERVICE",
  "EAI_FAIL",
]);

/** 连接级失败 code(socket 层错误) */
const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
  "EHOSTDOWN",
]);

/**
 * 把 undici/fetch 抛出的异常归类为 FetchError。
 *
 * undici 把 lookup hook 错误包装成 cause chain,沿 cause 走找 SsrfError
 * (用 isSsrfError 类型守卫识别),提取结构化 ssrf 字段还原为 ssrf-blocked。
 *
 * 归类优先级:
 *   1. SsrfError(任意 cause 层级) → ssrf-blocked
 *   2. 明确 DNS code → dns
 *   3. 明确 connect code → connect-failed
 *   4. 兜底未识别 → connect-failed(假设连接级问题,因为 DNS 错误一般有明确 code)
 */
function classifyFetchError(err: unknown, hostname: string): FetchError {
  let current: unknown = err;
  while (current) {
    if (isSsrfError(current)) {
      return { kind: "ssrf-blocked", ip: current.ssrf.ip, range: current.ssrf.range };
    }
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      if (code) {
        if (DNS_ERROR_CODES.has(code)) {
          return { kind: "dns", host: hostname, cause: `${code}: ${current.message}` };
        }
        if (CONNECT_ERROR_CODES.has(code)) {
          return { kind: "connect-failed", host: hostname, cause: `${code}: ${current.message}` };
        }
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "connect-failed", host: hostname, cause: message };
}

// ─── body 读取 ───

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  lifecycle: HopLifecycle,
  hostname: string,
): Promise<{ body: Uint8Array } | FetchError> {
  if (!response.body) return { body: new Uint8Array(0) };
  const reader = response.body.getReader();

  // 进入 body 阶段时若 signal 已 abort(consumer 抢跑或 fetch 阶段刚 abort),
  // 立即取消并归类,无需进入 read 循环。
  if (lifecycle.signal.aborted) {
    await reader.cancel().catch(() => {});
    return lifecycle.isTimedOut()
      ? { kind: "timeout", ms: lifecycle.timeoutMs }
      : classifyFetchError(new Error("aborted"), hostname);
  }

  // signal abort 时主动 cancel reader,触发 read() 抛错,catch 路径归类
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  lifecycle.signal.addEventListener("abort", onAbort);

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { kind: "too-large", bytes: total, limit: maxBytes };
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (lifecycle.isTimedOut()) return { kind: "timeout", ms: lifecycle.timeoutMs };
    return classifyFetchError(err, hostname);
  } finally {
    lifecycle.signal.removeEventListener("abort", onAbort);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body };
}

async function readBodySnippet(
  response: Response,
  maxBytes: number,
  lifecycle: HopLifecycle,
  hostname: string,
): Promise<string | undefined> {
  const result = await readBodyWithLimit(response, maxBytes, lifecycle, hostname);
  if ("kind" in result) return undefined;
  return new TextDecoder("utf-8", { fatal: false }).decode(result.body);
}
