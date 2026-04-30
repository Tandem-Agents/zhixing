/**
 * WebFetch 工具 — 抓取 URL 内容,可选用 secondary LLM 蒸馏。
 *
 * 设计要点:
 * - 编排型工具: 只串联 @zhixing/network(safeFetch/sanitize)、processContent(charset+turndown)、
 *   ctx.llm.secondary(distill);自身不发明任何能力
 * - 21A 自描述: boundaries + permissionArgumentKey 让 SecurityPipeline 自动接入
 * - graceful degrade: !ctx.llm || !prompt 时退到 raw markdown(单测/automation/无 secondary 配置场景)
 * - 错误是 ToolResult.isError, 不抛异常 —— 任何 FetchError 转成 LLM 友好的描述
 */

import {
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
  userMessage,
} from "@zhixing/core";
import type { FetchError, NetworkPolicy } from "@zhixing/network";
import { safeFetch, sanitizeUntrustedText } from "@zhixing/network";
import { WEB_FETCH_PREAPPROVED_HOSTS } from "./web-fetch-rules.js";
import {
  DISTILL_SYSTEM_PROMPT,
  buildDistillPrompt,
  collectStream,
} from "./web-fetch/distill.js";
import {
  type ContentFormat,
  cacheKey,
  contentCache,
  defaultWebFetchPolicy,
  processContent,
} from "./web-fetch/internal.js";

const MAX_RAW_CHARS = 100_000;
const DEFAULT_MAX_CHARS = 100_000;
const MIN_USER_MAX_CHARS = 1000;
const MAX_USER_MAX_CHARS = 200_000;
const MAX_PROMPT_LENGTH = 1000;

/**
 * 自描述 system-prompt 提示——cli 的 buildToolUsage 自动追加到 ## Tool Usage 段。
 * preapproved hosts 直接拼自 WEB_FETCH_PREAPPROVED_HOSTS,与 builtin rule 同源。
 */
const WEB_FETCH_SYSTEM_PROMPT_HINTS: readonly string[] = [
  "- Use `web_fetch` to read content from a URL the user provided or that you already know — this tool fetches a URL, it does not search the web",
  "- Two modes: with `prompt`, a secondary LLM extracts only the requested information (preferred for large pages); without `prompt`, raw Markdown is returned (use for short or specific pages)",
  `- Pre-approved hosts (no user confirmation needed): ${WEB_FETCH_PREAPPROVED_HOSTS.join(", ")}`,
  "- Do not invent URLs — only fetch what the user gave you or what appeared in prior tool results",
  "- If the user asks a question without a URL, do not call `web_fetch` with a guessed URL — ask for the URL or suggest a search engine",
];

export interface WebFetchToolOptions {
  /**
   * 网络代理配置（透传给 safeFetch）。
   *   - undefined / "auto"：从环境变量读 HTTP_PROXY/HTTPS_PROXY/NO_PROXY
   *   - "off"：显式禁用代理
   *   - "http://host:port"：显式代理 URL
   *
   * 默认 undefined → safeFetch 默认 "auto" 行为。
   * 详见 [network-egress.md §十三](../../../research/design/specifications/network-egress.md)。
   */
  proxy?: NetworkPolicy["proxy"];
}

export function createWebFetchTool(opts: WebFetchToolOptions = {}): ToolDefinition {
  return {
    name: "web_fetch",
    description:
      "Fetch a URL and return its content as Markdown. " +
      "Provide `prompt` to extract specific information using a secondary LLM " +
      "(falls back to raw content when secondary is unavailable). " +
      "Without prompt, returns raw Markdown.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL to fetch (https or http only)",
        },
        prompt: {
          type: "string",
          description: "Optional prompt to extract specific information using a secondary LLM",
        },
        format: {
          type: "string",
          enum: ["markdown", "text"],
          description: 'Output format: "markdown" (default, HTML→Markdown) or "text" (HTML stripped)',
        },
        maxChars: {
          type: "number",
          description:
            `Maximum characters of raw content to return ` +
            `(${MIN_USER_MAX_CHARS}–${MAX_USER_MAX_CHARS}, default ${DEFAULT_MAX_CHARS}). ` +
            `Ignored in distill mode.`,
        },
      },
      required: ["url"],
    },
    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: true,
    subAgentSafe: true,
    boundaries: [{ boundaryType: "network", access: "egress", dynamic: false }],
    permissionArgumentKey: "url",
    systemPromptHints: WEB_FETCH_SYSTEM_PROMPT_HINTS,
    maxResultChars: MAX_RAW_CHARS,

    async call(input, context): Promise<ToolResult> {
      const parsed = parseInput(input);
      if ("error" in parsed) return parsed.error;

      const fetched = await fetchAndProcess(parsed, context.abortSignal, opts.proxy);
      if ("error" in fetched) return fetched.error;

      // graceful degrade: 无 secondary 注入 / 无 prompt → 返回 raw
      if (!context.llm || !parsed.prompt) {
        return formatResult(parsed.url, fetched.text);
      }

      return distill(parsed, fetched.text, context);
    },
  };
}

// ─── 输入解析 ───

interface ParsedInput {
  url: string;
  prompt?: string;
  format: ContentFormat;
  maxChars: number;
}

function parseInput(input: Record<string, unknown>): ParsedInput | { error: ToolResult } {
  const url = input.url;
  if (typeof url !== "string" || url.length === 0) {
    return errorResult("`url` must be a non-empty string");
  }

  let prompt: string | undefined;
  if (input.prompt !== undefined) {
    if (typeof input.prompt !== "string") {
      return errorResult("`prompt` must be a string");
    }
    if (input.prompt.length > MAX_PROMPT_LENGTH) {
      return errorResult(`\`prompt\` exceeds ${MAX_PROMPT_LENGTH} chars`);
    }
    if (input.prompt.length > 0) prompt = input.prompt;
  }

  let format: ContentFormat = "markdown";
  if (input.format !== undefined) {
    if (input.format !== "markdown" && input.format !== "text") {
      return errorResult('`format` must be "markdown" or "text"');
    }
    format = input.format;
  }

  let maxChars = DEFAULT_MAX_CHARS;
  if (input.maxChars !== undefined) {
    if (typeof input.maxChars !== "number" || !Number.isFinite(input.maxChars)) {
      return errorResult("`maxChars` must be a finite number");
    }
    const v = Math.floor(input.maxChars);
    if (v < MIN_USER_MAX_CHARS || v > MAX_USER_MAX_CHARS) {
      return errorResult(
        `\`maxChars\` must be between ${MIN_USER_MAX_CHARS} and ${MAX_USER_MAX_CHARS}`,
      );
    }
    maxChars = v;
  }

  const result: ParsedInput = { url, format, maxChars };
  if (prompt !== undefined) result.prompt = prompt;
  return result;
}

// ─── fetch + 内容处理 ───

async function fetchAndProcess(
  parsed: ParsedInput,
  abortSignal: AbortSignal | undefined,
  proxy: NetworkPolicy["proxy"],
): Promise<{ text: string } | { error: ToolResult }> {
  const key = cacheKey(parsed.url, parsed.format);
  const cached = contentCache.get(key);
  if (cached !== undefined) {
    return { text: cached };
  }

  const result = await safeFetch(
    parsed.url,
    { ...defaultWebFetchPolicy, proxy },
    { abortSignal },
  );
  if ("kind" in result) {
    return { error: formatFetchError(parsed.url, result) };
  }

  const processed = await processContent(result, parsed.format);
  // distill 模式给 secondary 全量(100K)做摘要;raw 模式按用户 maxChars 截断
  const targetMax = parsed.prompt ? MAX_RAW_CHARS : parsed.maxChars;
  const sanitized = sanitizeUntrustedText(processed, { maxChars: targetMax });

  contentCache.set(key, sanitized);
  return { text: sanitized };
}

// ─── distill 路径 ───

async function distill(
  parsed: ParsedInput,
  content: string,
  context: ToolExecutionContext,
): Promise<ToolResult> {
  if (!context.llm || !parsed.prompt) {
    // 编译器穷尽性需要——caller 已经 check 过
    return formatResult(parsed.url, content);
  }

  try {
    const summary = await collectStream(
      context.llm.secondary.chat({
        systemPrompt: DISTILL_SYSTEM_PROMPT,
        messages: [userMessage(buildDistillPrompt(parsed.url, content, parsed.prompt))],
        tools: [],
        ...(context.abortSignal !== undefined && { abortSignal: context.abortSignal }),
      }),
    );
    const trimmed = summary.trim();
    if (trimmed.length === 0) {
      // secondary 返回空 → 退到 raw
      return formatResult(parsed.url, content, "(secondary returned empty distill, showing raw content)");
    }
    return formatResult(parsed.url, trimmed);
  } catch (err) {
    // distill 失败 → 退到 raw,把错误原因放在 source 段提示 LLM
    return formatResult(
      parsed.url,
      content,
      `(distill failed: ${err instanceof Error ? err.message : String(err)}, showing raw content)`,
    );
  }
}

// ─── ToolResult 构造 ───

function formatResult(url: string, content: string, note?: string): ToolResult {
  const header = note ? `Source: ${url}\n${note}` : `Source: ${url}`;
  return { content: `${header}\n\n${content}`, isError: false };
}

function errorResult(message: string): { error: ToolResult } {
  return { error: { content: `web_fetch: ${message}`, isError: true } };
}

/** 命中此范围时附加代理 fake-IP 的诊断提示 */
const FAKE_IP_RANGE = "198.18.0.0/15";

function formatFetchError(url: string, err: FetchError): ToolResult {
  let detail: string;
  switch (err.kind) {
    case "url-invalid":
      detail = `Invalid URL (${err.reason})`;
      break;
    case "ssrf-blocked":
      detail = `Blocked: target IP ${err.ip} is in restricted network ${err.range}`;
      if (err.range === FAKE_IP_RANGE) {
        detail +=
          " (this range is commonly used by proxy software fake-IP modes; your system proxy may be intercepting DNS without forwarding traffic — check proxy configuration or try a direct connection)";
      }
      break;
    case "redirect-blocked":
      detail = `Redirect blocked (${err.reason}): ${err.from} → ${err.to}`;
      break;
    case "too-large":
      detail = `Response too large (${err.bytes} bytes exceeds ${err.limit} limit)`;
      break;
    case "timeout":
      detail = `Request timed out after ${err.ms}ms`;
      break;
    case "dns":
      detail = `DNS resolution failed for ${err.host}: ${err.cause}`;
      break;
    case "connect-failed":
      detail = `Connection failed for ${err.host}: ${err.cause}`;
      break;
    case "http-error":
      detail = `HTTP ${err.status}${err.bodySnippet ? ` — ${err.bodySnippet.slice(0, 200)}` : ""}`;
      break;
  }
  return { content: `Failed to fetch ${url}: ${detail}`, isError: true };
}
