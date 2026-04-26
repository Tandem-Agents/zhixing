/**
 * safe-fetcher 内部依赖 — DNS 解析与 Agent 工厂。
 *
 * 提取为独立模块的目的:
 * 1. SSRF 拦截逻辑(makeSecureLookup)可单测——无需起真实 socket
 * 2. createPinnedAgent 可被 vi.mock 替换为 undici.MockAgent,让 safeFetch 测试不发真实请求
 * 3. 重定向时为新 hostname 创建新 Agent(每个 hop 独立 lookup hook 上下文)
 *
 * 错误传递契约:
 * - SSRF 拦截信息通过 Error.ssrf 结构化字段携带,而非 message string parsing
 * - undici 把 lookup err 包装成 cause chain,自定义字段被引用传递保留
 * - safeFetch 用 isSsrfError 类型守卫沿 cause chain 提取
 */

import { promises as dnsPromises } from "node:dns";
import { Agent, type Dispatcher } from "undici";
import type { IpRange } from "./types.js";
import { classifyIp } from "./url-guard.js";

/**
 * dns.lookup 风格的 callback 签名。
 * 与 Node 标准 LookupFunction 完全一致(address/family 必传),
 * 才能赋值给 undici Agent 的 connect.lookup 字段(其类型源自 LookupFunction)。
 * 错误路径调 callback(err, "", 0) —— 调用方应先检查 err 才读后续参数。
 */
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string,
  family: number,
) => void;

/** SSRF 拦截的结构化信息,挂在 Error.ssrf 字段上 */
export interface SsrfBlockInfo {
  /** 触发拦截的 hostname(URL 中的) */
  hostname: string;
  /** DNS 解析得到的实际 IP */
  ip: string;
  /** 命中的禁止网段(CIDR) */
  range: string;
}

interface SsrfError extends NodeJS.ErrnoException {
  ssrf: SsrfBlockInfo;
}

/**
 * 类型守卫:判断 unknown 是不是带 SSRF 拦截信息的 Error。
 *
 * 同时检查 code === "ESSRFBLOCKED" 与 ssrf 字段存在,双重保障避免误识别。
 * undici 把 connect lookup 失败包成 cause chain,classifyFetchError 沿 cause 走时
 * 用此守卫提取结构化数据,避免依赖 message string parsing(脆弱契约)。
 */
export function isSsrfError(err: unknown): err is SsrfError {
  return (
    err instanceof Error
    && (err as NodeJS.ErrnoException).code === "ESSRFBLOCKED"
    && typeof (err as Partial<SsrfError>).ssrf === "object"
    && (err as SsrfError).ssrf !== null
  );
}

/** SSRF 错误 message 的人类可读前缀,仅用于日志/调试,不参与契约判别 */
const SSRF_MESSAGE_PREFIX = "SSRF blocked";

/**
 * 创建带 SSRF 防御的 dns.lookup 实现。
 *
 * 流程: dnsPromises.lookup → classifyIp(address)
 *   - 命中禁止网段: callback(SsrfError) — err.ssrf 携带结构化拦截信息
 *   - 否则: callback(null, address, family) 放行
 */
export function makeSecureLookup(blockedNetworks: readonly IpRange[]) {
  return function secureLookup(
    hostname: string,
    _options: unknown,
    callback: LookupCallback,
  ): void {
    dnsPromises
      .lookup(hostname, { family: 0 })
      .then(({ address, family }) => {
        const cls = classifyIp(address, blockedNetworks);
        if (cls) {
          const err = new Error(
            `${SSRF_MESSAGE_PREFIX}: ${hostname} resolved to ${address} (in ${cls.range})`,
          ) as SsrfError;
          err.code = "ESSRFBLOCKED";
          err.ssrf = { hostname, ip: address, range: cls.range };
          callback(err, "", 0);
          return;
        }
        callback(null, address, family);
      })
      .catch((err: unknown) => {
        callback(err as NodeJS.ErrnoException, "", 0);
      });
  };
}

/**
 * 创建挂载了 secureLookup 的 undici Agent。
 *
 * 每次重定向都会调本函数为新 hostname 创建新 Agent(禁止跨 hop 复用 lookup 上下文,
 * 防御 DNS rebinding —— 攻击者在第二跳响应中改 DNS 解析结果)。
 */
export function createPinnedAgent(blockedNetworks: readonly IpRange[]): Dispatcher {
  return new Agent({
    connect: {
      lookup: makeSecureLookup(blockedNetworks),
    },
  });
}
