/**
 * 一次性 server 探测 —— 接入引导在写盘前用它验证配置：临时连上 + 列工具，连上即自证
 * 配置正确，无论成败都关闭、不留连接（与 hub 的常驻连接分开）。
 *
 * 用独立的更长超时：stdio server 首次 `npx` 下载常 >10s，复用 hub 的常驻连接超时会误判
 * 失败。复用 hub 同一套安全连接路径（connectAndListTools → 同一个 createTransport）。
 */

import type { NetworkPolicy } from "@zhixing/network";
import {
  connectAndListTools,
  type ConnectedClient,
  type CreateTransportFn,
} from "./connect.js";
import { createTransport as defaultCreateTransport } from "./transport.js";
import type { McpServerSpec, McpToolDescriptor } from "./types.js";

/** 探测超时 —— 给足首次 npx 下载的时间，独立于 hub 常驻连接超时。 */
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

export interface ProbeOptions {
  /** 探测超时（毫秒），默认 60s。 */
  timeoutMs?: number;
  /** 网络代理 —— 透传给 http transport 的 SSRF-safe fetch。 */
  proxy?: NetworkPolicy["proxy"];
  /** transport 构造注入点 —— 默认造真实 transport，测试注入内存传输。 */
  createTransport?: CreateTransportFn;
  /** 中断信号 —— abort 时探测立即失败并关闭连接（面板 loading 态按 Esc 取消用）。 */
  signal?: AbortSignal;
}

/** 探测结果 —— ok 带发现的工具，失败带明确原因（供面板卡点提示）。 */
export type ProbeResult =
  | { ok: true; tools: McpToolDescriptor[] }
  | { ok: false; error: string };

export async function probeServer(
  spec: McpServerSpec,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const createTransport = options.createTransport ?? defaultCreateTransport;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  let connected: ConnectedClient | undefined;
  try {
    connected = await connectAndListTools(spec, {
      createTransport,
      proxy: options.proxy,
      timeoutMs,
      signal: options.signal,
    });
    return { ok: true, tools: connected.tools };
  } catch (err) {
    // 失败时 connectAndListTools 已释放建链资源；这里只把原因透传给面板卡点。
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // 成功路径：探测用完即关，不把连接留给 hub。
    if (connected) {
      await connected.client.close().catch(() => {});
      await connected.disposeTransport?.().catch(() => {});
    }
  }
}
