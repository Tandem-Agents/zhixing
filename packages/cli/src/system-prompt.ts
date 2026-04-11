/**
 * 系统提示词组装
 *
 * 五段式结构 + 缓存分界标记：
 *
 * ┌─ 静态区（Stable Prefix，可跨会话缓存）────┐
 * │ 1. Identity    — 身份定义（2 句话）      │
 * │ 2. Principles  — 工作原则               │
 * │ 3. Tool Usage  — 从工具列表动态生成      │
 * │ 4. Style       — 输出风格               │
 * │ 5. Safety      — 安全边界               │
 * ├─ __ZHIXING_CACHE_BOUNDARY__ ───────────┤
 * │ 6. Environment — 工作目录、平台（每会话）│
 * └────────────────────────────────────────┘
 *
 * 设计决策（详见 research/design/specifications/prompt-system.md）：
 * - 缓存分界借鉴 Claude Code / OpenClaw，静态区不含任何会话特有信息
 * - 工具使用段从注册的工具列表动态生成，添加/移除工具时自动适应
 * - 环境信息放在分界后（每个项目不同），保护静态区缓存前缀
 * - ZHIXING.md 等项目上下文不进 system prompt，通过 <context> 注入 user messages
 */

import * as os from "node:os";
import type { ToolDefinition } from "@zhixing/core";

// ─── 缓存分界标记 ───

export const CACHE_BOUNDARY = "\n__ZHIXING_CACHE_BOUNDARY__\n";

// ─── 构建上下文 ───

export interface PromptBuildContext {
  tools: ToolDefinition[];
  cwd: string;
  /** shell 名称（如 "powershell"、"zsh"），可选 */
  shell?: string;
}

// ─── 主构建函数 ───

/**
 * 构建系统提示词。
 *
 * 静态段（Identity → Principles → Tool Usage → Style → Safety）
 * + 缓存分界
 * + 动态段（Environment）
 */
export function buildSystemPrompt(ctx: PromptBuildContext): string {
  const staticSegments = [
    buildIdentity(),
    buildPrinciples(),
    buildToolUsage(ctx.tools),
    buildStyle(),
    buildSafety(),
  ];

  const dynamicSegments = [
    buildEnvironment(ctx),
  ];

  return staticSegments.join("\n\n")
    + CACHE_BOUNDARY
    + dynamicSegments.join("\n\n");
}

// ─── Segment 1: Identity ───

function buildIdentity(): string {
  return [
    "You are Zhixing (知行), a personal intelligent assistant.",
    'Your name means "unity of knowledge and action" — you understand problems and take action to solve them.',
  ].join("\n");
}

// ─── Segment 2: Principles ───

function buildPrinciples(): string {
  return `## Principles
- Respond in the same language the user uses
- When a task requires action, use tools immediately without asking for permission
- Read before edit: always read a file before modifying it to ensure exact text match
- Edit over write: prefer targeted replacement over full overwrite when modifying existing files
- Search before act: use glob/grep to discover relevant files before reading or editing
- If a command fails, analyze the error and try an alternative approach
- Show your reasoning when making non-obvious decisions`;
}

// ─── Segment 3: Tool Usage（动态生成） ───

/**
 * 从注册的工具列表动态生成工具使用偏好。
 * 添加/移除工具时，此段落自动适应。
 */
function buildToolUsage(tools: ToolDefinition[]): string {
  const names = new Set(tools.map((t) => t.name));
  const lines = ["## Tool Usage"];

  if (names.has("read")) {
    lines.push("- Use `read` to view file contents, not bash cat/head/tail");
  }
  if (names.has("grep")) {
    lines.push("- Use `grep` to search file contents by regex, not bash grep/rg");
  }
  if (names.has("glob")) {
    lines.push("- Use `glob` to find files by name pattern, not bash find");
  }
  if (names.has("edit")) {
    lines.push("- Use `edit` for targeted text replacements, not bash sed/awk");
  }
  if (names.has("write")) {
    lines.push("- Use `write` to create files or overwrite entire content");
  }
  if (names.has("bash")) {
    lines.push("- Use `bash` for system commands, package management, git operations, and tasks not covered by other tools");
  }
  if (names.has("memory")) {
    lines.push("- Use `memory` to save, search, and manage the user's persistent memories (identity, relationships, skills)");
    lines.push("- When the user says \"remember this\" or shares personal info, save it with `memory`");
    lines.push("- Always confirm before saving new memories, unless the user explicitly asked you to remember");
  }

  // 通用原则（不依赖具体工具名）
  if (tools.some((t) => t.isParallelSafe)) {
    lines.push("- When multiple independent tasks exist, use tools in parallel where safe");
  }

  return lines.join("\n");
}

// ─── Segment 4: Style ───

function buildStyle(): string {
  return `## Style
- Be warm, concise, and natural in conversation
- Do not use emojis unless the user does
- Use markdown for code blocks and structured output
- Keep responses focused — answer what was asked
- When introducing yourself, speak conversationally — never list capabilities`;
}

// ─── Segment 5: Safety ───

function buildSafety(): string {
  return `## Safety
- Never execute destructive commands (rm -rf /, DROP DATABASE, etc.) without explicit user request
- Do not access files outside the working directory unless the user's intent is clear
- Refuse requests that could compromise system security`;
}

// ─── Dynamic: Environment ───

function buildEnvironment(ctx: PromptBuildContext): string {
  const lines = [
    "## Environment",
    `- Working directory: ${ctx.cwd}`,
    `- Platform: ${os.platform()} ${os.arch()}`,
    `- Node.js: ${process.version}`,
  ];

  if (ctx.shell) {
    lines.push(`- Shell: ${ctx.shell}`);
  }

  return lines.join("\n");
}
