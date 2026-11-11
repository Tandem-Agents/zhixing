/**
 * 模型调用的受控传输：按一次调用记账，证明“整次调用都没送达”。
 *
 * SDK 内部重试已关，一次调用只发一次 fetch；但 fetch 默认跟随跳转，首跳收到请求并回 307、下一跳拒连时，
 * 最终错误与直接拒连完全相同。这里每一跳都以 redirect:'manual' 发出，收到任何响应都记为已响应；
 * 是跳转就按 fetch 规范的同一组规则逐跳接着走（方法改写），保持原有可用入口；来源一旦变化只带语义白名单里的头，
 * 新来源拿不到原来源的认证头。
 * 只有本次调用恰好一次 fetch、首跳在连接阶段被拒、此前没有任何响应，才算未送达。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { isConnectPhaseFailure } from "@zhixing-ai/core/resilience";

export interface DeliveryRecord {
  attempts: number;
  responded: boolean;
  refused: boolean;
  /** 这次调用里有 fetch 没走受控路径（body 不可重放、调用方自设 redirect、入参不是 URL），不出证明 */
  untracked: boolean;
}

const current = new AsyncLocalStorage<DeliveryRecord>();

export function newDelivery(): DeliveryRecord {
  return { attempts: 0, responded: false, refused: false, untracked: false };
}

/** 在一次调用的记账范围内运行 SDK 请求；SDK 发出的 fetch 都记到这条记录上。 */
export function withDelivery<T>(record: DeliveryRecord, run: () => Promise<T>): Promise<T> {
  return current.run(record, run);
}

export function provenUndelivered(record: DeliveryRecord): boolean {
  return record.attempts === 1 && record.refused && !record.responded && !record.untracked;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** 与 fetch 规范的跳转次数上限一致 */
const MAX_REDIRECTS = 20;
const BODY_HEADERS = ["content-encoding", "content-language", "content-location", "content-type", "content-length"];
/** 换到另一个来源时只带这些与请求语义有关的头：SDK 的认证头名各家不同（authorization、x-api-key 等），
 *  按名单删总会漏，新来源一律拿不到原来源的任何其他头 */
const CROSS_ORIGIN_SAFE_HEADERS = new Set(["accept", "content-type", "user-agent"]);

function replayable(body: RequestInit["body"]): boolean {
  return body === undefined || body === null || typeof body === "string" ||
    body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof URLSearchParams;
}

/** 交给 SDK 的 fetch：记账范围外原样调用全局 fetch。 */
export const deliveryFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const record = current.getStore();
  if (!record) return fetch(input, init);
  record.attempts++;
  if (input instanceof Request || (init?.redirect !== undefined && init.redirect !== "follow") || !replayable(init?.body)) {
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
      if (!record.responded && isConnectPhaseFailure(error)) record.refused = true;
      throw error;
    }
    record.responded = true;
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;
    await response.body?.cancel().catch(() => undefined);
    if (hops >= MAX_REDIRECTS) throw new TypeError("fetch failed: too many redirects");
    const next = new URL(location, url);
    request = redirected(request, url, next, response.status);
    url = next;
  }
};

/**
 * 每一跳都由这里按 fetch 规范的 HTTP-redirect fetch 改写请求（不交回默认跟随，否则后续跨源时认证头会被带过去）：
 * 303 与 POST 的 301/302 改为不带正文的 GET；来源一旦变化，只保留语义白名单里的头，原来源的认证头一律不带。
 */
function redirected(request: RequestInit, from: URL, next: URL, status: number): RequestInit {
  if (next.protocol !== "http:" && next.protocol !== "https:") throw new TypeError("fetch failed: unsupported redirect scheme");
  let headers = new Headers(request.headers);
  let method = (request.method ?? "GET").toUpperCase();
  let body = request.body;
  if ((status === 303 && method !== "GET" && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST")) {
    method = "GET";
    body = null;
    for (const name of BODY_HEADERS) headers.delete(name);
  }
  if (next.origin !== from.origin) {
    const kept = new Headers();
    for (const [name, value] of headers) if (CROSS_ORIGIN_SAFE_HEADERS.has(name.toLowerCase())) kept.set(name, value);
    headers = kept;
  }
  return { ...request, method, headers, body, redirect: "manual" };
}
