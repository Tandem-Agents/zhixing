/**
 * 受控单跳网络传输原语（供模型调用、原生发现与可信目录抓取复用）。
 *
 * 职责边界（设计 §5.4）：
 * 1. 每跳先按连接代理策略（inherit / direct）、产品 network.proxy 与 NO_PROXY 判定直连或走受信代理，
 *    不把 NO_PROXY 命中交给黑盒 EnvHttpProxyAgent 而绕过直连 DNS SSRF 校验。
 * 2. 逐跳校验协议（公网默认 HTTPS；本机/私网 HTTP 须显式确认）、拒绝 URL userinfo 与未允许的认证查询参数、
 *    校验自定义认证头名称（排除路由与逐跳控制头）。
 * 3. 直连与 NO_PROXY 命中分支均使用受控 DNS lookup；私网/本机许可仅作用于用户已确认的连接来源，
 *    链路本地（169.254.0.0/16、fe80::/10）与云元数据地址始终拦截。
 * 4. 代理分支仍同步校验 URL、来源与字面 IP，并暴露脱敏代理描述与 `dnsResolvedBy: "proxy"`。
 * 5. 连接独占其 dispatcher 池并在退役释放时显式 close()，不提前关闭外部共享池。
 */

import { isIPv4, isIPv6 } from "node:net";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { makeSecureLookup, redactProxyUrl, resolveProxy } from "./safe-fetcher-internal.js";
import type { IpRange, NetworkPolicy } from "./types.js";
import { classifyIp, DEFAULT_BLOCKED_NETWORKS, extractHostname } from "./url-guard.js";

/**
 * 即便用户显式确认私网/本机连接来源，仍始终阻断的链路本地、云元数据与非单播保留段。
 */
export const ALWAYS_BLOCKED_NETWORKS: readonly IpRange[] = [
  "169.254.0.0/16", // IPv4 link-local & cloud metadata (169.254.169.254)
  "fe80::/10", // IPv6 link-local
  "0.0.0.0/8", // unspecified / current network
  "::/128", // IPv6 unspecified
  "224.0.0.0/4", // IPv4 multicast
  "240.0.0.0/4", // IPv4 reserved
  "ff00::/8", // IPv6 multicast
] as const;

/** 禁止作为自定义认证头使用的路由、逐跳控制与安全敏感请求头（小写）。 */
const FORBIDDEN_AUTH_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-type",
  "content-encoding",
  "forwarded",
  "via",
  "cookie",
  "set-cookie",
  "origin",
  "referer",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
]);

/** 常见 URL 查询字符串敏感认证键名（未显式声明时拒绝落入公开端点/请求）。 */
const SENSITIVE_QUERY_KEYS = new Set([
  "key",
  "api_key",
  "apikey",
  "access_token",
  "token",
  "auth",
  "authorization",
  "secret",
  "client_secret",
  "password",
  "passwd",
  "sig",
  "signature",
]);

const HTTP_HEADER_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

export type ConnectionProxyPolicy = "inherit" | "direct";

export type SingleHopRoute =
  | {
      readonly mode: "direct";
      readonly reason: "connection-direct" | "network-off" | "no-proxy" | "no-proxy-configured";
      readonly dnsResolvedBy: "local-controlled";
      readonly proxyDisplay: null;
    }
  | {
      readonly mode: "proxy";
      readonly proxyUrl: string;
      readonly proxyDisplay: string;
      readonly dnsResolvedBy: "proxy";
    };

export interface SingleHopSecurityError extends Error {
  readonly code:
    | "SINGLE_HOP_INVALID_URL"
    | "SINGLE_HOP_SCHEME_BLOCKED"
    | "SINGLE_HOP_USERINFO_BLOCKED"
    | "SINGLE_HOP_QUERY_BLOCKED"
    | "SINGLE_HOP_PRIVATE_ORIGIN_BLOCKED"
    | "SINGLE_HOP_LINK_LOCAL_BLOCKED"
    | "SINGLE_HOP_CROSS_ORIGIN_REDIRECT"
    | "SINGLE_HOP_INVALID_AUTH_HEADER";
  readonly redactedTarget: string;
  readonly route?: Pick<SingleHopRoute, "mode" | "proxyDisplay" | "dnsResolvedBy">;
}

export interface ControlledSingleHopOptions {
  /** 连接级代理策略：公网默认 inherit，用户确认的私网/本机默认 direct。 */
  readonly proxyPolicy?: ConnectionProxyPolicy;
  /** 产品级 network.proxy 配置。 */
  readonly networkProxy?: NetworkPolicy["proxy"];
  /** 环境变量（测试可注入，默认 process.env）。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 是否允许用户已确认来源的私网/本机 IP。 */
  readonly allowPrivateOrigin?: boolean;
  /** 允许使用私网/本机许可的唯一已确认连接来源（origin，如 http://127.0.0.1:11434）。 */
  readonly confirmedOrigin?: string;
  /** 是否允许对已确认来源使用明文 HTTP（默认仅对已确认的私网/本机来源放行，公网默认仅 HTTPS）。 */
  readonly allowConfirmedHttp?: boolean;
  /** 允许出现在请求 URL 中的查询参数键白名单；省略时放行普通非敏感查询参数，始终拒绝敏感认证查询键。 */
  readonly allowedQueryKeys?: readonly string[];
  /** 是否禁止所有未在 allowedQueryKeys 声明的查询参数。 */
  readonly strictQueryKeys?: boolean;
  /** 额外追加的禁止网段。 */
  readonly blockedNetworks?: readonly IpRange[];
  /** 可选底层 fetch 替换（仅用于单测注入）。 */
  readonly rawFetch?: typeof fetch;
  /** 可选 dispatcher 工厂替换（仅用于单测注入）。 */
  readonly createDispatcher?: (
    route: SingleHopRoute,
    blockedNetworks: readonly IpRange[],
  ) => Dispatcher;
}

export interface SingleHopResponse {
  readonly response: Response;
  readonly route: SingleHopRoute;
}

export interface ControlledSingleHopTransport {
  readonly routeFor: (url: URL) => SingleHopRoute;
  readonly validateUrl: (url: URL, route?: SingleHopRoute) => readonly IpRange[];
  readonly fetchHop: (url: URL, init?: RequestInit) => Promise<SingleHopResponse>;
  readonly close: () => Promise<void>;
}

/** 校验自定义认证头名称：拒绝非法 token、路由控制头、逐跳头与 x-forwarded-*。 */
export function validateSingleHopHeaderName(headerName: string): string | null {
  const trimmed = headerName.trim();
  if (!trimmed || trimmed !== headerName || !HTTP_HEADER_TOKEN_RE.test(trimmed)) {
    return "自定义认证头名称包含非法字符或空白";
  }
  const lower = trimmed.toLowerCase();
  if (FORBIDDEN_AUTH_HEADERS.has(lower) || lower.startsWith("x-forwarded-") || lower.startsWith("proxy-")) {
    return `不允许将路由或逐跳控制头 "${trimmed}" 用作自定义认证头`;
  }
  return null;
}

/** 将 URL 脱敏为仅含 scheme + host + port + pathname（去除 userinfo、query、hash）。 */
export function redactTargetUrl(url: string | URL): string {
  try {
    const parsed = typeof url === "string" ? new URL(url) : url;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

/** 判断 URL 主机名是否命中环境变量 no_proxy / NO_PROXY 规则（与 undici EnvHttpProxyAgent 语法与小写优先级对齐）。 */
export function isNoProxyMatch(
  targetUrl: URL,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.no_proxy ?? env.NO_PROXY;
  if (!raw || !raw.trim()) return false;

  const host = extractHostname(targetUrl).toLowerCase();
  const port = targetUrl.port || (targetUrl.protocol === "https:" ? "443" : "80");

  for (const part of raw.split(/[,\s]+/u)) {
    const entry = part.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;

    let patternHost = entry;
    let patternPort: string | undefined;

    if (entry.startsWith("[")) {
      const closeIdx = entry.indexOf("]");
      if (closeIdx > 0) {
        patternHost = entry.slice(1, closeIdx);
        if (entry[closeIdx + 1] === ":") {
          patternPort = entry.slice(closeIdx + 2);
        }
      }
    } else if (!entry.includes("/") && entry.indexOf(":") !== -1 && entry.indexOf(":") === entry.lastIndexOf(":")) {
      const colonIdx = entry.indexOf(":");
      patternHost = entry.slice(0, colonIdx);
      patternPort = entry.slice(colonIdx + 1);
    }

    if (patternPort && patternPort !== port) continue;

    if (patternHost.includes("/")) {
      if ((isIPv4(host) || isIPv6(host)) && classifyIp(host, [patternHost as IpRange]) !== null) {
        return true;
      }
      continue;
    }

    if (patternHost.startsWith("*.")) {
      patternHost = patternHost.slice(1);
    }
    if (patternHost.startsWith(".")) {
      const bare = patternHost.slice(1);
      if (bare && (host === bare || host.endsWith(patternHost))) return true;
    } else {
      if (host === patternHost || host.endsWith(`.${patternHost}`)) return true;
    }
  }
  return false;
}

function resolveSingleHopEnvProxy(
  networkProxy: NetworkPolicy["proxy"],
  env: NodeJS.ProcessEnv,
  targetUrl: URL,
): string | null {
  if (networkProxy === "off") return null;
  if (networkProxy !== undefined && networkProxy !== "auto") {
    return networkProxy;
  }
  // 与 undici EnvHttpProxyAgent 保持一致：小写优先，https 可回退 http 代理
  const httpProxy = env.http_proxy || env.HTTP_PROXY || null;
  const httpsProxy = env.https_proxy || env.HTTPS_PROXY || null;
  if (targetUrl.protocol === "http:") {
    return httpProxy;
  }
  if (targetUrl.protocol === "https:") {
    return httpsProxy ?? httpProxy;
  }
  return resolveProxy(networkProxy, env, targetUrl);
}

/**
 * 单跳路线判定：每跳显式区分直连与受信代理，保证 NO_PROXY 命中走受控直连 DNS 路径。
 */
export function resolveSingleHopRoute(
  targetUrl: URL,
  options: Pick<ControlledSingleHopOptions, "proxyPolicy" | "networkProxy" | "env">,
): SingleHopRoute {
  const env = options.env ?? process.env;
  if (options.proxyPolicy === "direct") {
    return {
      mode: "direct",
      reason: "connection-direct",
      dnsResolvedBy: "local-controlled",
      proxyDisplay: null,
    };
  }
  if (options.networkProxy === "off") {
    return {
      mode: "direct",
      reason: "network-off",
      dnsResolvedBy: "local-controlled",
      proxyDisplay: null,
    };
  }
  if (isNoProxyMatch(targetUrl, env)) {
    return {
      mode: "direct",
      reason: "no-proxy",
      dnsResolvedBy: "local-controlled",
      proxyDisplay: null,
    };
  }
  const proxyUrl = resolveSingleHopEnvProxy(options.networkProxy, env, targetUrl);
  if (!proxyUrl) {
    return {
      mode: "direct",
      reason: "no-proxy-configured",
      dnsResolvedBy: "local-controlled",
      proxyDisplay: null,
    };
  }
  return {
    mode: "proxy",
    proxyUrl,
    proxyDisplay: redactProxyUrl(proxyUrl),
    dnsResolvedBy: "proxy",
  };
}

function makeSecurityError(
  code: SingleHopSecurityError["code"],
  message: string,
  targetUrl: string | URL,
  route?: SingleHopRoute,
): SingleHopSecurityError {
  const err = new Error(message) as SingleHopSecurityError;
  err.name = "SingleHopSecurityError";
  (err as { code: SingleHopSecurityError["code"] }).code = code;
  (err as { redactedTarget: string }).redactedTarget = redactTargetUrl(targetUrl);
  if (route) {
    (err as { route: Pick<SingleHopRoute, "mode" | "proxyDisplay" | "dnsResolvedBy"> }).route = {
      mode: route.mode,
      proxyDisplay: route.proxyDisplay,
      dnsResolvedBy: route.dnsResolvedBy,
    };
  }
  return err;
}

function isConfirmedPrivateOrigin(
  url: URL,
  options: Pick<ControlledSingleHopOptions, "allowPrivateOrigin" | "confirmedOrigin">,
): boolean {
  if (!options.allowPrivateOrigin || !options.confirmedOrigin) return false;
  try {
    return new URL(options.confirmedOrigin).origin === url.origin;
  } catch {
    return false;
  }
}

export function isLocalOrPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local")) {
    return true;
  }
  if (isIPv4(lower) || isIPv6(lower)) {
    return (
      classifyIp(lower, DEFAULT_BLOCKED_NETWORKS) !== null &&
      classifyIp(lower, ALWAYS_BLOCKED_NETWORKS) === null
    );
  }
  return false;
}

/**
 * 创建连接独占的受控单跳传输实例。
 * 每次请求执行单跳 `redirect: "manual"`，不自行跟随跳转；跳转编排留给上层 delivery-transport。
 */
export function createControlledSingleHopTransport(
  options: ControlledSingleHopOptions = {},
): ControlledSingleHopTransport {
  const dispatchers = new Map<string, Dispatcher>();
  let closed = false;

  const extraBlocked = options.blockedNetworks ?? [];
  const allowedQuerySet = options.allowedQueryKeys
    ? new Set(options.allowedQueryKeys.map((key) => key.toLowerCase()))
    : undefined;

  const routeFor = (url: URL): SingleHopRoute => resolveSingleHopRoute(url, options);

  const validateUrl = (url: URL, route?: SingleHopRoute): readonly IpRange[] => {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw makeSecurityError(
        "SINGLE_HOP_SCHEME_BLOCKED",
        `不支持的模型请求协议 "${url.protocol}"，仅允许 HTTP(S)`,
        url,
        route,
      );
    }
    if (url.username !== "" || url.password !== "") {
      throw makeSecurityError(
        "SINGLE_HOP_USERINFO_BLOCKED",
        `模型端点 URL 不允许包含 userinfo 凭据：${redactTargetUrl(url)}`,
        url,
        route,
      );
    }

    const privatePermitted = isConfirmedPrivateOrigin(url, options);

    for (const [key] of url.searchParams) {
      const lower = key.toLowerCase();
      if (allowedQuerySet) {
        if (!allowedQuerySet.has(lower)) {
          throw makeSecurityError(
            "SINGLE_HOP_QUERY_BLOCKED",
            `模型请求 URL 包含未声明查询字段 "${key}"：${redactTargetUrl(url)}`,
            url,
            route,
          );
        }
      } else if (options.strictQueryKeys || SENSITIVE_QUERY_KEYS.has(lower)) {
        throw makeSecurityError(
          "SINGLE_HOP_QUERY_BLOCKED",
          `模型请求 URL 包含未允许的敏感或未声明查询字段 "${key}"：${redactTargetUrl(url)}`,
          url,
          route,
        );
      }
    }

    const blockedNetworks: readonly IpRange[] = privatePermitted
      ? [...ALWAYS_BLOCKED_NETWORKS, ...extraBlocked]
      : [...DEFAULT_BLOCKED_NETWORKS, ...extraBlocked];

    const host = extractHostname(url);
    if (isIPv4(host) || isIPv6(host)) {
      const alwaysHit = classifyIp(host, ALWAYS_BLOCKED_NETWORKS);
      if (alwaysHit) {
        throw makeSecurityError(
          "SINGLE_HOP_LINK_LOCAL_BLOCKED",
          `已拦截链路本地或保留地址 ${host}（命中 ${alwaysHit.range}）`,
          url,
          route,
        );
      }
      const blockedHit = classifyIp(host, blockedNetworks);
      if (blockedHit) {
        throw makeSecurityError(
          "SINGLE_HOP_PRIVATE_ORIGIN_BLOCKED",
          `已拦截未获确认的本机/私网地址 ${host}（命中 ${blockedHit.range}）`,
          url,
          route,
        );
      }
    } else if (!privatePermitted && isLocalOrPrivateHostname(host)) {
      throw makeSecurityError(
        "SINGLE_HOP_PRIVATE_ORIGIN_BLOCKED",
        `已拦截未获确认的本机/私网主机 ${host}`,
        url,
        route,
      );
    }

    const httpPermitted =
      url.protocol === "https:" ||
      (privatePermitted && (options.allowConfirmedHttp ?? true));
    if (!httpPermitted) {
      throw makeSecurityError(
        "SINGLE_HOP_SCHEME_BLOCKED",
        `公网模型端点默认要求 HTTPS；明文 HTTP 仅允许用于用户显式确认的本机/私网来源：${redactTargetUrl(url)}`,
        url,
        route,
      );
    }

    return blockedNetworks;
  };

  const getDispatcher = (route: SingleHopRoute, blockedNetworks: readonly IpRange[]): Dispatcher => {
    const key =
      route.mode === "proxy"
        ? `proxy:${route.proxyUrl}`
        : `direct:${blockedNetworks.join(",")}`;
    const existing = dispatchers.get(key);
    if (existing) return existing;

    const created = options.createDispatcher
      ? options.createDispatcher(route, blockedNetworks)
      : route.mode === "proxy"
        ? new ProxyAgent({ uri: route.proxyUrl })
        : new Agent({
            connect: {
              lookup: makeSecureLookup(blockedNetworks),
            },
          });
    dispatchers.set(key, created);
    return created;
  };

  return {
    routeFor,
    validateUrl,
    async fetchHop(url: URL, init?: RequestInit): Promise<SingleHopResponse> {
      if (closed) {
        throw new Error("模型连接传输已退役关闭，不能继续发起请求");
      }
      const route = routeFor(url);
      const blockedNetworks = validateUrl(url, route);
      if (options.rawFetch) {
        const response = await options.rawFetch(url, { ...init, redirect: "manual" });
        return { response, route };
      }
      const dispatcher = getDispatcher(route, blockedNetworks);
      const response = (await undiciFetch(url, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher,
        redirect: "manual",
      })) as unknown as Response;
      return { response, route };
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const toClose = [...dispatchers.values()];
      dispatchers.clear();
      await Promise.allSettled(toClose.map((dispatcher) => dispatcher.close()));
    },
  };
}
