/**
 * MCP server 搜索 —— 事实驱动接入的"按关键词找真实包"层。
 *
 * 给定关键词，打 npm registry 搜索接口（大陆默认 npmmirror 镜像），返回 registry 里
 * **真实存在**的包列表（名 / 描述 / keywords / 下载量）。本层**不做** is-mcp 过滤或主流度
 * 排序——那是判断、交给上层 LLM 据这些真实事实去做；本层只保证"返回的都是真实搜索结果"。
 *
 * HTTP 经 SSRF-safe fetch；`httpGetText` 可注入以便单测（不真联网）。失败抛错（由上层的
 * 工具循环 catch 后回灌给 LLM，让它重试 / 换词 / 收尾，而非直接中断）。
 */

import type { NetworkPolicy } from "@zhixing/network";
import { defaultHttpGetText, httpErrText, type HttpGetText } from "./http.js";

/** 一条真实搜索结果 —— 字段均取自 registry 返回，未加工。 */
export interface McpSearchResult {
  /** 包名（真实存在，可直接用于接入）。 */
  name: string;
  /** 包描述（registry 原文，可能为空）。 */
  description: string;
  /** 包自己声明的 keywords（判断"是不是 mcp"的事实信号之一）。 */
  keywords: string[];
  /** 下载量（镜像口径，用于判断主流度的事实信号）。 */
  downloads: number;
}

export interface SearchMcpServersOptions {
  /** 取回条数（默认 25，给上层 LLM 足够候选去判断 / 筛选）。 */
  size?: number;
  /** 注入 HTTP 文本 GET（缺省走 SSRF-safe fetch）。 */
  httpGetText?: HttpGetText;
  /** 网络代理（与 hub / probe / 查源同源 config.network.proxy）。 */
  proxy?: NetworkPolicy["proxy"];
  signal?: AbortSignal;
}

const REGISTRY_SEARCH = "https://registry.npmmirror.com/-/v1/search";

export async function searchMcpServers(
  query: string,
  options: SearchMcpServersOptions = {},
): Promise<McpSearchResult[]> {
  const get = options.httpGetText ?? defaultHttpGetText(options.proxy);
  const size = options.size ?? 25;
  const url = `${REGISTRY_SEARCH}?text=${encodeURIComponent(query.trim())}&size=${size}`;

  let res: { status: number; body: string };
  try {
    res = await get(url, options.signal);
  } catch (err) {
    throw new Error(`搜索失败：${httpErrText(err)}`);
  }
  if (res.status !== 200) {
    throw new Error(`搜索返回 HTTP ${res.status}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(res.body);
  } catch {
    throw new Error("搜索响应不是合法 JSON");
  }

  const objects = (data as { objects?: unknown }).objects;
  if (!Array.isArray(objects)) return [];
  return objects
    .map(toResult)
    .filter((r): r is McpSearchResult => r !== null);
}

/** 从 registry 搜索结果对象提取需要的真实字段；缺名字（无法接入）则丢弃。 */
function toResult(o: unknown): McpSearchResult | null {
  if (typeof o !== "object" || o === null) return null;
  const rec = o as Record<string, unknown>;
  const pkg = rec.package as Record<string, unknown> | undefined;
  if (!pkg || typeof pkg.name !== "string") return null;
  const downloads = rec.downloads as { all?: unknown } | undefined;
  return {
    name: pkg.name,
    description: typeof pkg.description === "string" ? pkg.description : "",
    keywords: Array.isArray(pkg.keywords)
      ? pkg.keywords.filter((k): k is string => typeof k === "string")
      : [],
    downloads: typeof downloads?.all === "number" ? downloads.all : 0,
  };
}
