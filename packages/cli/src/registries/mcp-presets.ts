/**
 * UI 暴露的 MCP server 预设——CLI 接入流程共享的"一键接入"名单。
 *
 * 与 @zhixing/mcp 的连接能力解耦：预设只产出 config 形态（McpServerConfigEntry）+ 密钥
 * 字段描述，由接入流程写进 config.mcp / credentials.mcp，再由装配层连接。新增预设 = 加一
 * 项数据，无需改代码。
 *
 * 密钥落地方式由 server 的 transport 决定（不在字段里冗余声明）：stdio → 环境变量、
 * http → 请求头，与 `parseServerSpecs` 的注入规则一致；`McpSecretFieldSpec.key` 即环境
 * 变量名 / 请求头名。
 *
 * 增加预设流程：
 *   1. 这里加一项（连接模板 entry + 需用户填的 secretFields）
 *   2. id 须是合法 server id（无 `__` 等，见 @zhixing/mcp 的 isValidServerId）
 */

import type { McpServerConfigEntry } from "@zhixing/providers";

/** 预设里一个需用户填写的密钥字段——驱动接入面板的单字段引导。 */
export interface McpSecretFieldSpec {
  /**
   * 凭证 key——写入 credentials.mcp.<server>.<key>，连接时按 transport 注入：
   * stdio → 环境变量名，http → 请求头名。
   */
  key: string;
  /** UI 标签（如 "GitHub Personal Access Token"）。 */
  label: string;
  /** 一句话指引：从哪获取、需要什么权限。 */
  hint: string;
  /** 输入占位示例。 */
  example: string;
  /** 文档链接——input panel 单独渲染为可点击行。 */
  docUrl?: string;
  /**
   * 可选值模板：把用户输入包进固定串再写入，`{value}` 为占位符；缺省 = 直接用用户输入。
   * 用于"裸 token 不能直接当凭证"的 server——如 Authorization 头要 `Bearer {value}`，
   * 或要把 token 包进一组 JSON 请求头。
   */
  template?: string;
}

/**
 * 一个内置 MCP server 预设——连接字段模板 + 需用户填的密钥字段。
 */
export interface McpPreset {
  /** 预设 id，同时作为默认 server id（须是合法 server id）。 */
  id: string;
  /** UI 显示名。 */
  label: string;
  /** 短描述：这个 server 能做什么。 */
  description: string;
  /** 连接配置模板（不含密钥；密钥在 secretFields，连接时按 transport 注入）。 */
  entry: McpServerConfigEntry;
  /** 用户需填写的密钥字段（通常一个 token）。 */
  secretFields: McpSecretFieldSpec[];
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "github",
    label: "GitHub",
    description: "读写仓库、Issue / PR、代码搜索",
    // GitHub 官方现以远程 Streamable HTTP server 提供（旧的 npx @modelcontextprotocol/
    // server-github 已停止支持）；PAT 经 Authorization 头鉴权。URL 末尾斜杠与官方一致——
    // 缺斜杠可能触发重定向，而连接层 fetch 禁止跟随重定向（SSRF 防护）。
    entry: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
    },
    secretFields: [
      {
        key: "Authorization",
        label: "GitHub Personal Access Token",
        hint: "GitHub → Settings → Developer settings → Personal access tokens 生成，按需勾选 repo 等权限。",
        example: "ghp_xxxxxxxxxxxxxxxxxxxx",
        docUrl: "https://github.com/settings/tokens",
        // 远程 server 要 `Authorization: Bearer <PAT>`，故把裸 token 包成 Bearer 头。
        template: "Bearer {value}",
      },
    ],
  },
  {
    id: "notion",
    label: "Notion",
    description: "读写 Notion 页面与数据库",
    entry: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
    },
    secretFields: [
      {
        key: "NOTION_TOKEN",
        label: "Notion Integration Token",
        hint: "Notion → Settings → Connections 新建 integration，复制 Internal Integration Token，并把目标页面共享给它。",
        example: "ntn_xxxxxxxxxxxx",
        docUrl: "https://www.notion.so/profile/integrations",
      },
    ],
  },
];

/** 按 id 查预设；未命中返回 undefined。 */
export function findMcpPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.id === id);
}

/**
 * 把用户填的密钥值按字段（含可选 `template`）组装成可写入 credentials.mcp.<id> 的凭证条目。
 *
 * - 带 `template` 的字段把用户输入包进模板（`{value}` 占位）
 * - 空 / 缺失输入跳过（必填校验由调用方做）
 * - inputs 以 `secretField.key` 为键（与字段身份一致）
 *
 * 预设接入与 LLM 推断接入共用，保证两条路径密钥落地规则一致。
 */
export function applyMcpSecretFields(
  fields: readonly McpSecretFieldSpec[],
  inputs: Record<string, string>,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const field of fields) {
    const input = inputs[field.key];
    if (input === undefined || input === "") continue;
    // 用函数式替换而非字符串：String.replaceAll 的字符串替换会把 input 里的 `$&`/`$$`
    // 等当特殊模式解释，污染含 `$` 的 token；函数返回值按字面写入，杜绝此问题。
    secrets[field.key] = field.template
      ? field.template.replaceAll("{value}", () => input)
      : input;
  }
  return secrets;
}

/**
 * 预设 + 用户填的密钥 → 可写入的 config 条目与凭证条目。
 *
 * - entry：深拷贝预设模板（避免后续 mutate 污染预设常量），直接写 config.mcp.servers.<id>
 * - secrets：见 applyMcpSecretFields
 */
export function applyMcpPreset(
  preset: McpPreset,
  secretInputs: Record<string, string>,
): { entry: McpServerConfigEntry; secrets: Record<string, string> } {
  return {
    entry: structuredClone(preset.entry),
    secrets: applyMcpSecretFields(preset.secretFields, secretInputs),
  };
}
