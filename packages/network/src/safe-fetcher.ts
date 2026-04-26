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
import { createPinnedAgent, isSsrfError } from "./safe-fetcher-internal.js";
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
      dispatcher: createPinnedAgent(policy.blockedNetworks),
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
    return outcome;
  }

  // 超过 maxRedirects(循环退出未 return)
  const from = redirectChain[redirectChain.length - 2] ?? url;
  return { kind: "redirect-blocked", from, to: currentUrl, reason: "too-many" };
}

// ─── 错误归类 ───

/**
 * 把 undici/fetch 抛出的异常归类为 FetchError。
 *
 * undici 把 lookup hook 错误包装成 cause chain,沿 cause 走找 SsrfError
 * (用 isSsrfError 类型守卫识别),提取结构化 ssrf 字段还原为 ssrf-blocked。
 */
function classifyFetchError(err: unknown, hostname: string): FetchError {
  let current: unknown = err;
  while (current) {
    if (isSsrfError(current)) {
      return { kind: "ssrf-blocked", ip: current.ssrf.ip, range: current.ssrf.range };
    }
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA") {
        return { kind: "dns", host: hostname, cause: current.message };
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "dns", host: hostname, cause: message };
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
