/**
 * 模型调用的受控传输：组合 `@zhixing-ai/network` 单跳受控传输，保留唯一一份跳转编排与整次调用送达账本。
 *
 * 契约（设计 §5.4）：
 * 1. 每跳经受控单跳原语先判路线（直连 / NO_PROXY 受控直连 DNS / 受信代理）、逐跳安全校验、手动跳转。
 * 2. 同源跳转按 fetch 规范改写方法与正文并重检；跨源跳转在联系新来源前立即停止并展示脱敏目的地。
 * 3. 送达记账保护：仅当首跳在连接建立阶段被拒且此前未收到任何响应、且未建立代理隧道时标为未送达；
 *    收到首跳 3xx 或任意响应即记为已响应；代理隧道建立后发生的远端错误不得轻率标为未送达。
 * 4. 每个连接传输独占其 dispatcher 并在连接退役时显式 close()，不提前关闭共享池。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { isConnectPhaseFailure } from "@zhixing-ai/core/resilience";
import {
  createControlledSingleHopTransport,
  type ControlledSingleHopOptions,
  type ControlledSingleHopTransport,
  type SingleHopRoute,
  type SingleHopSecurityError,
} from "@zhixing-ai/network";

export interface DeliveryRecord {
  attempts: number;
  responded: boolean;
  refused: boolean;
  /** 代理隧道已建立（或无法证明失败发生在代理连接建立前），禁止轻率判未送达 */
  proxyTunnelEstablished: boolean;
  /** 这次调用里有 fetch 没走受控路径（body 不可重放、调用方自设 redirect、入参不是 URL），不出证明 */
  untracked: boolean;
}

const current = new AsyncLocalStorage<DeliveryRecord>();

export function newDelivery(): DeliveryRecord {
  return {
    attempts: 0,
    responded: false,
    refused: false,
    proxyTunnelEstablished: false,
    untracked: false,
  };
}

/** 在一次调用的记账范围内运行 SDK 请求；SDK 发出的 fetch 都记到这条记录上。 */
export function withDelivery<T>(record: DeliveryRecord, run: () => Promise<T>): Promise<T> {
  return current.run(record, run);
}

export function provenUndelivered(record: DeliveryRecord): boolean {
  return (
    record.attempts === 1 &&
    record.refused &&
    !record.responded &&
    !record.proxyTunnelEstablished &&
    !record.untracked
  );
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** 与 fetch 规范的跳转次数上限一致 */
const MAX_REDIRECTS = 20;
const BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-location",
  "content-type",
  "content-length",
];

function replayable(body: RequestInit["body"]): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof URLSearchParams
  );
}

function isLocalProxyConnectRefusal(error: unknown): boolean {
  if (!isConnectPhaseFailure(error)) return false;
  // 代理路径上若错误明确来自远端 TLS/HTTP 或隧道后断连，绝不判未送达；
  // 仅允许明确指向代理 TCP 建连失败（如 ECONNREFUSED/EHOSTUNREACH/ENETUNREACH 且无 tunnel/TLS 信号）。
  const chain: unknown[] = [];
  let cursor: unknown = error;
  for (let depth = 0; cursor && depth < 6; depth += 1) {
    chain.push(cursor);
    cursor = cursor instanceof Error ? cursor.cause : undefined;
  }
  for (const item of chain) {
    if (item instanceof Error) {
      const msg = item.message.toLowerCase();
      if (
        msg.includes("tunnel") ||
        msg.includes("tls") ||
        msg.includes("ssl") ||
        msg.includes("certificate") ||
        msg.includes("socket hang up") ||
        msg.includes("econnreset") ||
        msg.includes("closed")
      ) {
        return false;
      }
    }
  }
  return true;
}

function redactOriginOnly(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function makeCrossOriginRedirectError(from: URL, next: URL, route: SingleHopRoute): SingleHopSecurityError {
  const safeFrom = redactOriginOnly(from);
  const safeNext = redactOriginOnly(next);
  const err = new Error(
    `模型请求遇到跨源重定向，已在联系新来源前停止（来源 ${safeFrom} → 目的地 ${safeNext}）`,
  ) as SingleHopSecurityError;
  err.name = "SingleHopSecurityError";
  (err as { code: SingleHopSecurityError["code"] }).code = "SINGLE_HOP_CROSS_ORIGIN_REDIRECT";
  (err as { redactedTarget: string }).redactedTarget = safeNext;
  (err as { route: Pick<SingleHopRoute, "mode" | "proxyDisplay" | "dnsResolvedBy"> }).route = {
    mode: route.mode,
    proxyDisplay: route.proxyDisplay,
    dnsResolvedBy: route.dnsResolvedBy,
  };
  return err;
}

export interface ConnectionDeliveryTransport {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly routeFor: (url: URL) => SingleHopRoute;
  readonly close: () => Promise<void>;
}

async function normalizeFetchInput(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{ readonly url: URL; readonly request: RequestInit; readonly requestedRedirect?: RequestInit["redirect"] }> {
  if (!(input instanceof Request)) {
    return {
      url: new URL(String(input)),
      request: { ...init },
      requestedRedirect: init?.redirect,
    };
  }
  const mergedHeaders = new Headers(input.headers);
  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => {
      mergedHeaders.set(key, value);
    });
  }
  let body: RequestInit["body"];
  if (init && "body" in init) {
    body = init.body;
  } else if (input.body !== null) {
    body = new Uint8Array(await input.arrayBuffer());
  }
  const method = init?.method ?? input.method;
  const signal = init?.signal ?? input.signal;
  const requestedRedirect = init?.redirect ?? input.redirect;
  return {
    url: new URL(input.url),
    request: {
      ...init,
      method,
      headers: mergedHeaders,
      ...(body !== undefined ? { body } : {}),
      ...(signal ? { signal } : {}),
    },
    requestedRedirect,
  };
}

/**
 * 为指定连接创建受控单跳 + 唯一跳转编排 + 送达记账 fetch 实例。
 */
export function createConnectionDeliveryFetch(
  options: ControlledSingleHopOptions & {
    readonly transport?: ControlledSingleHopTransport;
  } = {},
): ConnectionDeliveryTransport {
  const transport = options.transport ?? createControlledSingleHopTransport(options);

  const controlledFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const record = current.getStore();
    if (record) record.attempts++;

    const normalized = await normalizeFetchInput(input, init);
    if (
      (normalized.requestedRedirect !== undefined &&
        normalized.requestedRedirect !== "follow" &&
        normalized.requestedRedirect !== "manual") ||
      !replayable(normalized.request.body)
    ) {
      if (record) record.untracked = true;
      const { response } = await transport.fetchHop(normalized.url, normalized.request);
      if (record) record.responded = true;
      return response;
    }

    let url = normalized.url;
    let request: RequestInit = { ...normalized.request, redirect: "manual" };

    for (let hops = 0; ; hops++) {
      const route = transport.routeFor(url);
      let response: Response;
      try {
        const result = await transport.fetchHop(url, request);
        response = result.response;
      } catch (error) {
        if (record && !record.responded && hops === 0) {
          if (route.mode === "proxy") {
            if (isLocalProxyConnectRefusal(error)) {
              record.refused = true;
            } else {
              record.proxyTunnelEstablished = true;
            }
          } else if (isConnectPhaseFailure(error)) {
            record.refused = true;
          }
        }
        throw error;
      }

      if (record) record.responded = true;

      const location = response.headers.get("location");
      if (!REDIRECT_STATUSES.has(response.status) || location === null) {
        return response;
      }

      await response.body?.cancel().catch(() => undefined);
      if (hops >= MAX_REDIRECTS) {
        throw new TypeError("fetch failed: too many redirects");
      }

      const next = new URL(location, url);
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new TypeError("fetch failed: unsupported redirect scheme");
      }
      if (next.origin !== url.origin) {
        throw makeCrossOriginRedirectError(url, next, route);
      }

      request = redirectedSameOrigin(request, response.status);
      url = next;
    }
  };

  return {
    fetch: controlledFetch,
    routeFor: transport.routeFor,
    close: () => transport.close(),
  };
}

/**
 * 同源跳转按 fetch 规范改写请求方法与正文；跨源跳转已在上层拦截，绝不携带认证头联系新来源。
 */
function redirectedSameOrigin(request: RequestInit, status: number): RequestInit {
  const headers = new Headers(request.headers);
  let method = (request.method ?? "GET").toUpperCase();
  let body = request.body;
  if (
    (status === 303 && method !== "GET" && method !== "HEAD") ||
    ((status === 301 || status === 302) && method === "POST")
  ) {
    method = "GET";
    body = null;
    for (const name of BODY_HEADERS) headers.delete(name);
  }
  return { ...request, method, headers, body, redirect: "manual" };
}

/**
 * 默认兼容导出：未显式绑定连接传输策略时，保留原有逐跳记账行为（用于兼容直接单测）。
 * 生产连接实例应通过 `createConnectionDeliveryFetch` 绑定连接代理、私网许可与显式 close()。
 */
export const deliveryFetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const record = current.getStore();
  if (!record) return fetch(input, init);
  record.attempts++;
  if (
    input instanceof Request ||
    (init?.redirect !== undefined && init.redirect !== "follow") ||
    !replayable(init?.body)
  ) {
    record.untracked = true;
    return fetch(input, init);
  }
  let url = new URL(String(input));
  let request: RequestInit = { ...init, redirect: "manual" };
  for (let hops = 0; ; hops++) {
    let response: Response;
    try {
      response = await fetch(url, request);
    } catch (error) {
      if (!record.responded && hops === 0 && isConnectPhaseFailure(error)) {
        record.refused = true;
      }
      throw error;
    }
    record.responded = true;
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;
    await response.body?.cancel().catch(() => undefined);
    if (hops >= MAX_REDIRECTS) throw new TypeError("fetch failed: too many redirects");
    const next = new URL(location, url);
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new TypeError("fetch failed: unsupported redirect scheme");
    }
    if (next.origin !== url.origin) {
      throw makeCrossOriginRedirectError(url, next, {
        mode: "direct",
        reason: "no-proxy-configured",
        dnsResolvedBy: "local-controlled",
        proxyDisplay: null,
      });
    }
    request = redirectedSameOrigin(request, response.status);
    url = next;
  }
};
