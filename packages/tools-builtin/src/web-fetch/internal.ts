/**
 * WebFetch 工具的内部依赖 — 默认策略 / LRU 缓存 / 内容处理。
 *
 * 切分目的:
 * - web-fetch.ts 主体保持声明式风格,具体实现下沉到本文件
 * - turndown 用动态 import,启动时不加载(70KB 仅在实际抓 HTML 时付出)
 * - LRU 与 charset 探测都是纯函数/纯状态,可独立单测
 */

import type { FetchResult, NetworkPolicy } from "@zhixing/network";

// ─── 默认 fetch policy ───

/**
 * WebFetch 工具特定的 NetworkPolicy 覆盖(目前为空——使用 safeFetch 内置默认)。
 * 留作扩展点: 未来若需调整 timeout / maxBodyBytes 等,集中在此修改而非散落工具主体。
 */
export const defaultWebFetchPolicy: Partial<NetworkPolicy> = {};

// ─── 内容缓存(LRU) ───

/**
 * 极简 LRU 缓存。
 * 利用 Map 的 insertion-order 性质: get 命中时 delete + re-set 把项移到末尾,
 * 容量满时 keys().next() 取出最旧 key 删除。30 行内自实现,无外部依赖。
 */
class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error("LruCache capacity 必须 > 0");
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.capacity) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

const CONTENT_CACHE_CAPACITY = 50;

/**
 * 内容缓存——key 为 `${url}|${format}`,value 为 sanitized 文本。
 * 仅缓存 raw content(不缓存 distill 结果): 同 URL + 不同 prompt 应独立蒸馏。
 * 进程级,不持久化。
 */
export const contentCache = new LruCache<string, string>(CONTENT_CACHE_CAPACITY);

export function cacheKey(url: string, format: ContentFormat): string {
  return `${url}|${format}`;
}

// ─── 内容解码与转换 ───

export type ContentFormat = "markdown" | "text";

const HTML_CONTENT_TYPE_PATTERNS = ["text/html", "application/xhtml+xml"];

/**
 * 探测响应体的 charset。
 * 优先级: Content-Type header > BOM > utf-8 兜底。
 * BOM 仅识别 UTF-8 / UTF-16 (LE/BE);不做基于内容的猜测。
 */
export function detectCharset(headers: Headers, body: Uint8Array): string {
  const ct = headers.get("content-type");
  if (ct) {
    const match = /charset=([^;]+)/i.exec(ct);
    if (match?.[1]) {
      return match[1].trim().toLowerCase().replace(/['"]/g, "");
    }
  }
  if (body.byteLength >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    return "utf-8";
  }
  if (body.byteLength >= 2) {
    if (body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
    if (body[0] === 0xfe && body[1] === 0xff) return "utf-16be";
  }
  return "utf-8";
}

/**
 * 用指定 charset 解码 body。
 * TextDecoder 不支持的 charset 名(如非常见编码)会退回 utf-8——返回值不抛异常。
 */
export function decodeBody(body: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(body);
  }
}

export function isHtmlContent(headers: Headers): boolean {
  const ct = headers.get("content-type")?.toLowerCase() ?? "";
  return HTML_CONTENT_TYPE_PATTERNS.some((t) => ct.includes(t));
}

/**
 * 把 FetchResult 处理为 LLM 可读文本。
 *
 * 流程:
 *   1. 探测 charset → 解码 body 为 string
 *   2. 非 HTML 内容(text/plain 等)直接返回
 *   3. HTML + format="markdown" → turndown 转 markdown
 *   4. HTML + format="text" → 去标签 + 折叠空白
 *
 * turndown 用动态 import,只在 HTML markdown 路径加载,启动 bundle 不付 70KB。
 */
export async function processContent(
  result: FetchResult,
  format: ContentFormat,
): Promise<string> {
  const charset = detectCharset(result.headers, result.body);
  const text = decodeBody(result.body, charset);

  if (!isHtmlContent(result.headers)) {
    return text;
  }

  if (format === "text") {
    return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  const TurndownModule = await import("turndown");
  const TurndownService = TurndownModule.default;
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  return turndown.turndown(text);
}
