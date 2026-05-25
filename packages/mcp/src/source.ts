/**
 * MCP server 接入信息源抓取 —— 事实驱动接入的"查源"层。
 *
 * 给定 npm 包名，从 registry（大陆默认 npmmirror 镜像）确认其存在性并取回 README 与主页，
 * 供上层（接入引导）据**真实文本**提取连接方式 / 密钥要求，而不是让 LLM 凭记忆臆造。
 *
 * 三态返回，绝不混淆：
 *   - found      ：包存在，带回 README（可能为空字符串）与主页
 *   - not-found  ：registry 明确返回不存在（404）
 *   - error      ：查询本身失败（网络不可达 / 非 JSON 等）——区别于"没这个包"
 * 让上层能对用户诚实区分"没这个包"与"暂时查不到"。
 *
 * HTTP 经 SSRF-safe fetch；`httpGetText` 可注入以便单测（不真联网）。
 */

import type { NetworkPolicy } from "@zhixing/network";
import { defaultHttpGetText, httpErrText, type HttpGetText } from "./http.js";

// 查源与搜索共用的 HTTP 底座现集中在 ./http.js；此处再导出 HttpGetText 保持既有引用路径。
export type { HttpGetText } from "./http.js";

export type McpSourceResult =
  | { kind: "found"; readme: string; homepage?: string }
  | { kind: "not-found" }
  | { kind: "error"; reason: string };

export interface FetchMcpSourceOptions {
  /** 注入 HTTP 文本 GET（缺省走 SSRF-safe fetch）。 */
  httpGetText?: HttpGetText;
  /** 网络代理（透传给缺省 fetch，与 hub / probe 同源 config.network.proxy）。 */
  proxy?: NetworkPolicy["proxy"];
  signal?: AbortSignal;
}

// 大陆稳定镜像优先；registry 元数据不带 readme 时回退 jsdelivr 取 README.md
// （不假设 registry.readme 字段在镜像上一定存在）。
const REGISTRY_BASE = "https://registry.npmmirror.com";
const JSDELIVR_BASE = "https://cdn.jsdelivr.net/npm";

export async function fetchMcpServerSource(
  packageName: string,
  options: FetchMcpSourceOptions = {},
): Promise<McpSourceResult> {
  const get = options.httpGetText ?? defaultHttpGetText(options.proxy);
  const name = packageName.trim();

  let res: { status: number; body: string };
  try {
    res = await get(`${REGISTRY_BASE}/${name}`, options.signal);
  } catch (err) {
    return { kind: "error", reason: httpErrText(err) };
  }
  if (res.status === 404) return { kind: "not-found" };
  if (res.status !== 200) {
    return { kind: "error", reason: `registry 返回 HTTP ${res.status}` };
  }

  let packument: Record<string, unknown>;
  try {
    packument = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    return { kind: "error", reason: "registry 响应不是合法 JSON" };
  }

  const homepage = extractHomepage(packument);
  let readme = extractReadme(packument);
  // 镜像 packument 不带 readme → 回退 jsdelivr 取 README.md
  if (!readme) {
    readme = (await fetchReadmeFile(name, get, options.signal)) ?? "";
  }
  return homepage ? { kind: "found", readme, homepage } : { kind: "found", readme };
}

/** packument 顶层 readme，缺则取 latest 版本的 readme。 */
function extractReadme(packument: Record<string, unknown>): string {
  if (typeof packument.readme === "string" && packument.readme) {
    return packument.readme;
  }
  const fromVersion = latestVersionField(packument, "readme");
  return typeof fromVersion === "string" ? fromVersion : "";
}

/** 主页：latest 版本的 homepage > 顶层 homepage > repository.url。 */
function extractHomepage(packument: Record<string, unknown>): string | undefined {
  const fromVersion = latestVersionField(packument, "homepage");
  if (typeof fromVersion === "string" && fromVersion) return fromVersion;
  if (typeof packument.homepage === "string" && packument.homepage) {
    return packument.homepage;
  }
  const repo = latestVersionField(packument, "repository");
  if (repo && typeof repo === "object" && typeof (repo as { url?: unknown }).url === "string") {
    return (repo as { url: string }).url;
  }
  return undefined;
}

function latestVersionField(packument: Record<string, unknown>, field: string): unknown {
  const latest = (packument["dist-tags"] as { latest?: string } | undefined)?.latest;
  const versions = packument.versions as Record<string, Record<string, unknown>> | undefined;
  if (!latest || !versions) return undefined;
  return versions[latest]?.[field];
}

/** registry 无 readme 时的回退：jsdelivr 取仓库内 README.md（大陆 CDN）。 */
async function fetchReadmeFile(
  name: string,
  get: HttpGetText,
  signal?: AbortSignal,
): Promise<string | undefined> {
  for (const file of ["README.md", "readme.md"]) {
    try {
      const r = await get(`${JSDELIVR_BASE}/${name}/${file}`, signal);
      if (r.status === 200 && r.body.trim()) return r.body;
    } catch {
      // 回退源失败不致命——返回 undefined，上层据"无 README"走诚实提示
    }
  }
  return undefined;
}
