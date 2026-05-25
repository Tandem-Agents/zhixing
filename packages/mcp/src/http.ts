/**
 * MCP 接入相关的 HTTP 文本 GET —— 查源（source）与搜索（search）共用的底座。
 *
 * 统一一个"返回状态码 + 文本体"的 GET 抽象：缺省走 SSRF-safe fetch（proxy 与 hub / probe
 * 同源 config.network.proxy），`HttpGetText` 可注入以便单测不真联网。
 */

import { createSafeFetch, type NetworkPolicy } from "@zhixing/network";

/** 文本 GET：返回 HTTP 状态码与响应体。注入点——测试用 mock 替换，避免真联网。 */
export type HttpGetText = (
  url: string,
  signal?: AbortSignal,
) => Promise<{ status: number; body: string }>;

/** 缺省 HTTP 文本 GET —— 走 SSRF-safe fetch；proxy 与 hub / probe 同源。 */
export function defaultHttpGetText(proxy?: NetworkPolicy["proxy"]): HttpGetText {
  const fetch = createSafeFetch(proxy ? { proxy } : undefined);
  return async (url, signal) => {
    const res = await fetch(url, signal ? { signal } : undefined);
    return { status: res.status, body: await res.text() };
  };
}

export function httpErrText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
