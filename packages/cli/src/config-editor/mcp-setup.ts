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
  McpSourceResult,
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

/** 信息源抓取函数 —— 由调用方注入（默认 @zhixing/mcp 的 fetchMcpServerSource），测试注入 mock。 */
export type McpSourceFetcher = (
  packageName: string,
  signal?: AbortSignal,
) => Promise<McpSourceResult>;

/** resolveMcpSetup 的注入依赖：查真实信息源 + 据源文本提取的 LLM。 */
export interface McpResolveDeps {
  fetchSource: McpSourceFetcher;
  llm: McpSetupLlm;
}

/** 一次接入的候选方案 —— 预设命中或 LLM 推断，面板据此引导填密钥 + 验证 + 写盘。 */
export interface McpSetupCandidate {
  /** server id（预设 id / 从标识推导）；撞名时由输入页提示换标识重输，不在候选页改名。 */
  serverId: string;
  /** 连接配置（不含密钥）。 */
  entry: McpServerConfigEntry;
  /** 需用户填的密钥字段。 */
  secretFields: McpSecretFieldSpec[];
  /** 来源：预设命中 vs LLM 推断（面板可对推断结果加"请核对"提示）。 */
  source: "preset" | "inferred";
  /**
   * 项目主页（仅查源得到的真实地址，源未给则缺省）——当某密钥字段没有 docUrl 时，面板
   * 据此给"获取地址未提供，可查项目主页"的诚实兜底，不臆造获取链接。
   */
  homepage?: string;
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
 * 解析用户输入为接入候选 —— 事实驱动，每个字段都有真实出处，绝不靠 LLM 凭记忆臆造：
 *   - 预设名 / id   → curated 预设（人工核过的事实）
 *   - URL           → http 候选，地址就是用户给的（确定性，不经 LLM）
 *   - 完整命令（含空格，如 `npx -y @x/y`）→ stdio 候选，按空格拆即用户给的事实（确定性）
 *   - 裸包名        → 查 npm 真实信息源（README），据真实文本提取启动方式 / 密钥（grounded）
 *
 * 查不到 / 源里没写的，一律返回诚实的失败原因，引导用户改输完整命令或 URL，不填假值。
 * 面板"选预设"可直接 presetToCandidate；此函数服务"统一输入框"。
 */
export async function resolveMcpSetup(
  input: string,
  deps: McpResolveDeps,
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

  // URL：远程 server，地址即事实，不经 LLM
  if (/^https?:\/\//i.test(trimmed)) return buildUrlCandidate(trimmed);

  // 完整命令（含空格）：用户给出的确切启动命令即事实，按空格拆，不经 LLM
  if (/\s/.test(trimmed)) return buildCommandCandidate(trimmed);

  // 裸包名：查真实源 + 据 README 文本 grounded 提取
  return groundFromSource(trimmed, deps, signal);
}

/** URL → http 候选：地址原样，无需 LLM；只兜底 server 名推导。 */
function buildUrlCandidate(url: string): McpResolveResult {
  const serverId = deriveServerId(url);
  if (!isValidServerId(serverId)) {
    return { ok: false, error: "无法从该 URL 推导合法 server 名，请确认地址是否正确" };
  }
  return {
    ok: true,
    candidate: { serverId, entry: { type: "http", url }, secretFields: [], source: "inferred" },
  };
}

/** 完整命令 → stdio 候选：按空格拆 command + args，server 名取最像包名的实参。 */
function buildCommandCandidate(commandLine: string): McpResolveResult {
  const tokens = commandLine.split(/\s+/).filter(Boolean);
  const command = tokens[0];
  if (command === undefined) return { ok: false, error: "命令为空，请重新输入" };
  const args = tokens.slice(1);
  // server 名取第一个非 flag 实参（通常是包名 / 子命令）；取首参而非末参——末参常是
  // 路径 / URL 等取值（如 `npx -y @x/fs /some/path` 末参是路径），会推出 "path" 这种错名。
  const pkgish = args.find((t) => !t.startsWith("-")) ?? command;
  const serverId = deriveServerId(pkgish);
  if (!isValidServerId(serverId)) {
    return { ok: false, error: "无法从该命令推导合法 server 名，请检查命令是否正确" };
  }
  return {
    ok: true,
    candidate: {
      serverId,
      entry: { type: "stdio", command, args },
      secretFields: [],
      source: "inferred",
    },
  };
}

/**
 * 裸包名 → 查 npm 真实信息源（README）→ 据真实文本提取启动配置（grounded）。
 *
 * 三态诚实失败，绝不臆造：
 *   - 包确不存在        → "没找到这个包"
 *   - 查询失败（网络等）→ "暂时查不到，请重试或直接输入完整命令 / URL"
 *   - 找到但无 README   → "没有可用的设置说明，请直接输入完整命令或改用预设"
 * 有 README 才交给 LLM 抽取，且只让它用给定文本、缺的标 null（见 buildExtractionPrompt）。
 */
async function groundFromSource(
  packageName: string,
  deps: McpResolveDeps,
  signal?: AbortSignal,
): Promise<McpResolveResult> {
  const serverId = deriveServerId(packageName);
  if (!isValidServerId(serverId)) {
    return {
      ok: false,
      error: `无法从 "${packageName}" 推导合法 server 名，请直接输入完整启动命令或远程 URL`,
    };
  }

  const source = await deps.fetchSource(packageName, signal);
  if (source.kind === "not-found") {
    return { ok: false, error: `没找到 npm 包 "${packageName}"，请核对名称是否正确` };
  }
  if (source.kind === "error") {
    return {
      ok: false,
      error: `暂时查不到 "${packageName}"（${source.reason}）——请重试，或直接输入完整启动命令 / 远程 URL`,
    };
  }
  if (source.readme.trim() === "") {
    return {
      ok: false,
      error: `找到了 "${packageName}" 但没有可用的设置说明——请直接输入完整启动命令（如 \`npx -y ${packageName}\`）或改用预设`,
    };
  }

  let raw: string;
  try {
    raw = await deps.llm(buildExtractionPrompt(packageName, source.readme), signal);
  } catch (err) {
    return { ok: false, error: `读取设置说明失败：${errMsg(err)}` };
  }
  const parsed = parseExtraction(raw, packageName);

  return {
    ok: true,
    candidate: {
      serverId,
      entry: parsed.entry,
      secretFields: parsed.secretFields,
      source: "inferred",
      // 真实主页透传给面板，作密钥字段无 docUrl 时的诚实"去哪找"兜底
      ...(source.homepage ? { homepage: source.homepage } : {}),
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

// README 截断上限：覆盖绝大多数包的"安装 / 配置 / 用法"段（多在开头），又不撑爆 token 预算。
const README_MAX_CHARS = 12000;

/** README 过长时截断，并明确告知 LLM 文本被截断（避免它以为后文无内容而臆造）。 */
function truncateReadme(readme: string): string {
  if (readme.length <= README_MAX_CHARS) return readme;
  return `${readme.slice(0, README_MAX_CHARS)}\n…（README 已截断）`;
}

/**
 * 给提取 LLM 的提示 —— 只让它从给定 README 文本里抽启动配置，严禁用自身知识补全 / 猜测。
 * 这是事实驱动的核心：源里有什么就抽什么，没有的标 null，由上层据此做诚实兜底（基线命令）。
 */
function buildExtractionPrompt(packageName: string, readme: string): string {
  return [
    `下面是 npm 包 "${packageName}" 的 README。请从中提取把它作为 MCP server 启动所需的配置。`,
    "只依据下面的 README 文本，文本里没有写的就输出 null / 空数组，禁止用你自己的知识补全或猜测。",
    "只输出 JSON，不要解释、不要代码围栏。",
    "JSON 格式：",
    '{"command":"启动命令(README 配置示例里的，通常 npx；没有则 null)","args":["启动参数(README 配置示例里的，通常含包名；没有则 []）"],"secretFields":[{"key":"环境变量名/请求头名","label":"展示名","hint":"README 里写的获取方式","docUrl":"README 里给的获取链接(没有则 null)"}]}',
    "规则：secretFields 只列 README 明确要求的密钥；README 没提密钥就给 []；docUrl 只填 README 里真实出现的链接，没有就 null。",
    "--- README 开始 ---",
    truncateReadme(readme),
    "--- README 结束 ---",
  ].join("\n");
}

interface ParsedInference {
  entry: McpServerConfigEntry;
  secretFields: McpSecretFieldSpec[];
}

/**
 * 解析提取输出为 stdio 启动配置 + 密钥字段。
 *
 * 裸包名经 npx 运行是 MCP server 的事实基线，故 command/args 缺失或不可解析时回落
 * `npx -y <包名>`（仍是确定性的真实命令，最终由实连验证证伪），不再当作硬失败。
 */
function parseExtraction(raw: string, packageName: string): ParsedInference {
  const baselineArgs = ["-y", packageName];
  const json = extractJsonObject(raw);
  if (json === undefined) {
    return { entry: { type: "stdio", command: "npx", args: baselineArgs }, secretFields: [] };
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { entry: { type: "stdio", command: "npx", args: baselineArgs }, secretFields: [] };
  }

  const command =
    typeof data.command === "string" && data.command !== "" ? data.command : "npx";
  const parsedArgs = Array.isArray(data.args)
    ? data.args.filter((a): a is string => typeof a === "string")
    : [];
  const args = parsedArgs.length > 0 ? parsedArgs : baselineArgs;

  return {
    entry: { type: "stdio", command, args },
    secretFields: parseSecretFields(data.secretFields),
  };
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
