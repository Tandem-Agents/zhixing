/**
 * MCP 接入引导编排 —— 把"用户选预设 / 输入标识"变成"可验证、可写盘的接入候选"。
 *
 * 两条路径殊途同归到 McpSetupCandidate：
 *   - 预设命中：直接用内置预设（registries/mcp-presets）
 *   - 非预设：调注入的 light LLM 从包名 / URL / 命令推断启动方式
 *
 * 纯编排：discovery 探测（probe）与 LLM 都是注入依赖，便于单测、可取消（透传 AbortSignal）。
 * 验证用**带密钥**的 spec（用户填的密钥按 transport 注入，复用 toServerSpec 与运行时同一套
 * 路由），既证启动方式也证鉴权，避免"启动即需密钥"的 server 在引导里走进死路。
 */

import { isValidServerId } from "@zhixing/mcp";
import type {
  McpServerSpec,
  McpToolDescriptor,
  ProbeResult,
} from "@zhixing/mcp";
import type { McpServerConfigEntry } from "@zhixing/providers";
import {
  applyMcpSecretFields,
  findMcpPreset,
  MCP_PRESETS,
  type McpPreset,
  type McpSecretFieldSpec,
} from "../registries/index.js";
import { toServerSpec } from "../runtime/mcp-config.js";

/**
 * 接入引导所需的 LLM 能力 —— 由 config-editor ctx 注入（light 模型），与工具调用上下文无关。
 * 收 AbortSignal 以支持面板 loading 态的取消（注入方把它透传给底层 LLM 调用）。
 */
export type McpSetupLlm = (prompt: string, signal?: AbortSignal) => Promise<string>;

/** discovery 探测函数 —— 由调用方注入（默认 @zhixing/mcp 的 probeServer），测试注入 mock。 */
export type McpProbe = (
  spec: McpServerSpec,
  signal?: AbortSignal,
) => Promise<ProbeResult>;

/** 一次接入的候选方案 —— 预设命中或 LLM 推断，面板据此引导填密钥 + 验证 + 写盘。 */
export interface McpSetupCandidate {
  /** 默认 server id（预设 id / 从标识推导；用户可在面板改名）。 */
  serverId: string;
  /** 连接配置（不含密钥）。 */
  entry: McpServerConfigEntry;
  /** 需用户填的密钥字段。 */
  secretFields: McpSecretFieldSpec[];
  /** 来源：预设命中 vs LLM 推断（面板可对推断结果加"请核对"提示）。 */
  source: "preset" | "inferred";
}

export type McpResolveResult =
  | { ok: true; candidate: McpSetupCandidate }
  | { ok: false; error: string };

export type McpValidateResult =
  | { ok: true; tools: McpToolDescriptor[] }
  | { ok: false; error: string };

/** 预设 → 候选（深拷贝 entry，避免污染预设常量）。 */
export function presetToCandidate(preset: McpPreset): McpSetupCandidate {
  return {
    serverId: preset.id,
    entry: structuredClone(preset.entry),
    secretFields: preset.secretFields,
    source: "preset",
  };
}

/**
 * 解析用户输入为接入候选：先按 id / 名称匹配预设，未命中走 LLM 推断。
 *
 * 面板"选预设"可直接 presetToCandidate；此函数服务"统一输入框"（用户键入包名 / URL / 预设名）。
 */
export async function resolveMcpSetup(
  input: string,
  llm: McpSetupLlm,
  signal?: AbortSignal,
): Promise<McpResolveResult> {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, error: "请输入 server 标识" };

  const byId = findMcpPreset(trimmed);
  if (byId) return { ok: true, candidate: presetToCandidate(byId) };
  const byLabel = MCP_PRESETS.find(
    (p) => p.label.toLowerCase() === trimmed.toLowerCase(),
  );
  if (byLabel) return { ok: true, candidate: presetToCandidate(byLabel) };

  return inferMcpSetup(trimmed, llm, signal);
}

/**
 * 非预设：调 light LLM 从标识（包名 / URL / 命令）推断启动方式，解析成候选。
 *
 * 失败 graceful（LLM 异常 / 输出不可解析 / 推不出合法 id）—— 返回明确原因，由面板提示
 * "改用预设或核对标识"，不退回让用户手填技术字段。
 */
export async function inferMcpSetup(
  identifier: string,
  llm: McpSetupLlm,
  signal?: AbortSignal,
): Promise<McpResolveResult> {
  let raw: string;
  try {
    raw = await llm(buildInferencePrompt(identifier), signal);
  } catch (err) {
    return { ok: false, error: `推断失败：${errMsg(err)}` };
  }

  const parsed = parseInference(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const serverId = deriveServerId(identifier);
  if (!isValidServerId(serverId)) {
    return { ok: false, error: `无法从 "${identifier}" 推导合法 server id，请改用预设或手动命名` };
  }

  return {
    ok: true,
    candidate: {
      serverId,
      entry: parsed.entry,
      secretFields: parsed.secretFields,
      source: "inferred",
    },
  };
}

/**
 * discovery 验证：用候选 + 用户已填密钥组装 spec，临时连接 + 列工具，证启动方式 **与鉴权** 都对。
 *
 * 带密钥探测（密钥按 transport 注入，复用 toServerSpec）—— 不要求密钥的 server 传空 inputs 即退化
 * 为纯启动验证；要求密钥的 server 则连真实凭证，避免"启动即需密钥"的 server 在引导里走进死路。
 */
export async function validateMcpSetup(
  candidate: McpSetupCandidate,
  secretInputs: Record<string, string>,
  probe: McpProbe,
  signal?: AbortSignal,
): Promise<McpValidateResult> {
  const secrets = applyMcpSecretFields(candidate.secretFields, secretInputs);
  const spec = toServerSpec(candidate.serverId, candidate.entry, secrets);
  const result = await probe(spec, signal);
  return result.ok
    ? { ok: true, tools: result.tools }
    : { ok: false, error: result.error };
}

/**
 * 候选 + 用户填的密钥 → 可写入的 config 条目与凭证条目（对接写入原语 upsertMcpServer /
 * patchMcpSecrets）。entry 深拷贝避免共享引用。
 */
export function applyMcpSetup(
  candidate: McpSetupCandidate,
  secretInputs: Record<string, string>,
): { entry: McpServerConfigEntry; secrets: Record<string, string> } {
  return {
    entry: structuredClone(candidate.entry),
    secrets: applyMcpSecretFields(candidate.secretFields, secretInputs),
  };
}

/**
 * 从标识推导一个合法默认 server id —— URL 取 host 主体、包名取末段，消毒成 `[a-z0-9-]`。
 * 推不出合法 id 时返回空串（调用方据 isValidServerId 兜底）。用户可在面板改名。
 */
export function deriveServerId(identifier: string): string {
  let base = identifier.trim();
  if (/^https?:\/\//i.test(base)) {
    try {
      base = new URL(base).hostname.replace(/^www\./, "");
    } catch {
      // 非法 URL —— 退回按普通字符串消毒
    }
  }
  // npm scope/path 取末段：@scope/server-x → server-x
  base = base.replace(/^@[^/]+\//, "");
  base = base.split("/").pop() ?? base;

  const id = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return id;
}

/** 构造给推断 LLM 的提示 —— 要求严格 JSON 输出。 */
function buildInferencePrompt(identifier: string): string {
  return [
    "你是 MCP server 接入助手。给定一个 MCP server 标识（npm 包名 / 可执行命令 / URL），",
    "判断它的启动方式，只输出 JSON、不要解释、不要代码围栏。",
    `标识：${identifier}`,
    "JSON 格式：",
    '{"transport":"stdio"|"http","command":"stdio 的命令(通常 npx)","args":["stdio 参数(通常 -y 和包名)"],"url":"http 的端点 URL","secretFields":[{"key":"环境变量名或请求头名","label":"展示名","hint":"获取方式","example":"示例","docUrl":"获取该密钥的页面 URL(如有)"}]}',
    "规则：stdio 用 command+args、不要 url；http 用 url、不要 command/args；无密钥需求时 secretFields 为 []；docUrl 不确定就省略。",
  ].join("\n");
}

interface ParsedInference {
  entry: McpServerConfigEntry;
  secretFields: McpSecretFieldSpec[];
}

/** 解析 LLM 推断输出为连接配置 + 密钥字段；不可解析 / 字段缺失则返回明确错误。 */
function parseInference(
  raw: string,
): ({ ok: true } & ParsedInference) | { ok: false; error: string } {
  const json = extractJsonObject(raw);
  if (json === undefined) {
    return { ok: false, error: "推断输出不是可解析的 JSON" };
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "推断输出不是可解析的 JSON" };
  }

  const transport = data.transport;
  if (transport !== "stdio" && transport !== "http") {
    return { ok: false, error: "推断未给出有效 transport（stdio / http）" };
  }

  const entry: McpServerConfigEntry = { type: transport };
  if (transport === "stdio") {
    if (typeof data.command !== "string" || data.command === "") {
      return { ok: false, error: "stdio server 推断缺少 command" };
    }
    entry.command = data.command;
    if (Array.isArray(data.args)) {
      entry.args = data.args.filter((a): a is string => typeof a === "string");
    }
  } else {
    if (typeof data.url !== "string" || data.url === "") {
      return { ok: false, error: "http server 推断缺少 url" };
    }
    entry.url = data.url;
  }

  return { ok: true, entry, secretFields: parseSecretFields(data.secretFields) };
}

/** 容错解析推断出的密钥字段（只取合法项，缺省字段补空）。 */
function parseSecretFields(value: unknown): McpSecretFieldSpec[] {
  if (!Array.isArray(value)) return [];
  const fields: McpSecretFieldSpec[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.key !== "string" || rec.key === "") continue;
    const field: McpSecretFieldSpec = {
      key: rec.key,
      label: typeof rec.label === "string" && rec.label !== "" ? rec.label : rec.key,
      hint: typeof rec.hint === "string" ? rec.hint : "",
      example: typeof rec.example === "string" ? rec.example : "",
    };
    // docUrl 可选——有则带上，让推断来的 server 也能显示可点击的"取密钥"链接（同预设）
    if (typeof rec.docUrl === "string" && rec.docUrl !== "") field.docUrl = rec.docUrl;
    fields.push(field);
  }
  return fields;
}

/** 从可能带文字 / 代码围栏的 LLM 输出里抠出第一个 JSON 对象（首 `{` 到末 `}`）。 */
function extractJsonObject(raw: string): string | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  return raw.slice(start, end + 1);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
