/**
 * 系统提示词组装
 *
 * 六段式结构 + 缓存分界标记:
 *
 * ┌─ 静态区(Stable Prefix,可跨会话缓存)─────────┐
 * │ 1. Identity         — 身份定义(2 句话)      │
 * │ 2. Principles       — 工作原则               │
 * │ 3. Tool Usage       — 从工具列表动态生成      │
 * │ 4. Skill Evolution  — 技能进化指导            │
 * │ 5. Style            — 输出风格               │
 * │ 6. Safety           — 安全边界               │
 * ├─ __ZHIXING_CACHE_BOUNDARY__ ────────────────┤
 * │ 7. Environment      — 工作目录、平台(每会话)│
 * └──────────────────────────────────────────────┘
 *
 * 设计决策(详见 research/design/specifications/prompt-system.md):
 * - 缓存分界借鉴 Claude Code / OpenClaw,静态区不含任何会话特有信息
 * - 工具使用段从注册的工具列表动态生成,添加/移除工具时自动适应
 * - 技能进化指导引导 Agent 在复杂任务后反思并提议保存/更新技能
 * - 环境信息放在分界后(每个项目不同),保护静态区缓存前缀
 * - ZHIXING.md 等项目上下文不进 system prompt,通过 <context> 注入 user messages
 */

import * as os from "node:os";
import { COMMITMENT_SIGNAL, type ToolDefinition } from "@zhixing/core";
import type { AgentRoleProfile } from "../profile/agent-role-profile.js";
import { mainProfile } from "../profile/default-profiles.js";

// ─── 缓存分界标记 ───

export const CACHE_BOUNDARY = "\n__ZHIXING_CACHE_BOUNDARY__\n";

// ─── 段标识 ───

/**
 * 静态段标识 —— 调用方按列表顺序选择启用哪些段(主 agent 用全集,子 agent 通常子集)。
 * Environment 不在此列举(始终在缓存分界之后,作为独立动态段)。
 */
export type SystemPromptSegment =
  | "identity"
  | "principles"
  | "tool-usage"
  | "skill-evolution"
  | "style"
  | "safety";

/** 主 agent 默认启用的全段集合,顺序与历史输出一致(byte-equal 保证) */
export const MAIN_AGENT_SEGMENTS: readonly SystemPromptSegment[] = [
  "identity",
  "principles",
  "tool-usage",
  "skill-evolution",
  "style",
  "safety",
];

/**
 * 子 agent 默认段集合 —— 任务专注、输出回写父、prompt cache 友好。
 *
 * 设计原则(每段的取舍理由):
 *   identity    ✓ 角色身份 / Constraints 必需
 *   principles  ✓ "Read before edit" 等硬约束子 agent 同样适用
 *   tool-usage  ✓ 工具描述按子 agent 装配的 childTools 动态生成
 *   safety      ✓ destructive 命令防护是绝对底线,子 agent 不可豁免
 *   skill-evolution ✗ Memory 工具 subAgentSafe:false 已硬隔离写入,
 *                     提示反思保存技能对子 agent 是无效噪声
 *   style       ✗ 子 agent 输出回写父 tool_result,不直接对话用户,
 *                 风格指引("be concise"等)会让子误解为对话场景
 *
 * 不继承的内容:
 *   - 项目上下文(ZHIXING.md / enriched skills)—— 由主 agent 在 Task prompt
 *     中显式提炼相关部分传给子,避免子 system prompt 膨胀且利于跨 spawn 的
 *     prompt cache 命中(同角色子 agent 的静态前缀 byte-identical)
 *   - 用户记忆段 —— 同上,且 Memory 工具不暴露给子 agent
 *
 * 调用方装配子 agent 时参考:
 *   buildSystemPrompt({ profile: subAgentProfile({ subAgentId, task }),
 *                       segments: SUB_AGENT_SEGMENTS, tools: childTools, ... })
 */
export const SUB_AGENT_SEGMENTS: readonly SystemPromptSegment[] = [
  "identity",
  "principles",
  "tool-usage",
  "safety",
];

// ─── 构建上下文 ───

export interface PromptBuildContext {
  tools: ToolDefinition[];
  cwd: string;
  /** 工作区路径(安全信任边界),null 表示无工作区 */
  workspace?: string | null;
  /** 工作区来源标识 */
  workspaceSource?: string;
  /** 全局配置文件路径(如 ~/.zhixing/config.json) */
  globalConfigPath?: string;
  /** shell 名称(如 "powershell"、"zsh"),可选 */
  shell?: string;
  /**
   * 角色 profile —— 主 agent 默认 mainProfile();子 agent 由 dispatch 路径
   * 传入 subAgentProfile()。Identity 段从 profile.instructions / constraints / tone
   * 渲染。
   */
  profile?: AgentRoleProfile;
  /**
   * 启用的静态段集合(顺序即输出顺序)。默认 MAIN_AGENT_SEGMENTS。
   * 子 agent 通常传子集(只 identity + tool-usage + safety 之类的最小集)。
   */
  segments?: readonly SystemPromptSegment[];
}

// ─── 主构建函数 ───

/**
 * 构建系统提示词。
 *
 * 默认配置(主 agent):Identity → Principles → Tool Usage → Skill Evolution
 *   → Style → Safety + 缓存分界 + 动态段(Environment)
 *
 * 调用方传 profile / segments 切换为其他角色配置(如子 agent 精简集)。
 */
export function buildSystemPrompt(ctx: PromptBuildContext): string {
  const profile = ctx.profile ?? mainProfile();
  const segments = ctx.segments ?? MAIN_AGENT_SEGMENTS;

  // 跳过 null —— 段在当前 ctx 下不适用(如 skill-evolution 在 tools 不含 memory
  // 时返回 null)。用 `=== null` 判别而非 falsy,与"段输出空字符串"语义清晰区分,
  // 避免 join 在空字符串处产生连续 \n\n\n\n 的多余空白。
  const staticSegments: string[] = [];
  for (const segment of segments) {
    const rendered = renderSegment(segment, ctx, profile);
    if (rendered !== null) staticSegments.push(rendered);
  }

  const dynamicSegments = [
    buildEnvironment(ctx),
  ];

  return staticSegments.join("\n\n")
    + CACHE_BOUNDARY
    + dynamicSegments.join("\n\n");
}

/**
 * Segment renderer dispatcher。返回 `string | null`:
 *   - `string`:正常输出(包括空内容也用 string 表达,如未来某段可能输出 "")
 *   - `null`:该段在当前 ctx 下"不适用",由 buildSystemPrompt 跳过
 */
function renderSegment(
  segment: SystemPromptSegment,
  ctx: PromptBuildContext,
  profile: AgentRoleProfile,
): string | null {
  switch (segment) {
    case "identity":
      return renderIdentity(profile);
    case "principles":
      return buildPrinciples();
    case "tool-usage":
      return buildToolUsage(ctx.tools);
    case "skill-evolution":
      return buildSkillEvolution(ctx.tools);
    case "style":
      return buildStyle();
    case "safety":
      return buildSafety();
  }
}

// ─── Segment: Identity ───

/**
 * 从 profile 渲染身份段。
 *
 * 输出形态:
 *   - profile.tone 存在:`# Tone\n<tone>` 一节前置
 *   - profile.instructions:逐字输出(profile 自带的 markdown 头由 profile 拥有)
 *   - profile.constraints 非空:追加 `# Constraints` 列表
 *
 * 主 agent 默认 profile 的 tone/constraints 都为空,instructions 是历史 2 行身份文本,
 * 因此默认输出与历史 buildIdentity() byte-equal。
 */
export function renderIdentity(profile: AgentRoleProfile): string {
  const parts: string[] = [];
  if (profile.tone) {
    parts.push(`# Tone\n${profile.tone}`);
  }
  parts.push(profile.instructions);
  if (profile.constraints.length > 0) {
    parts.push(
      `# Constraints\n` + profile.constraints.map((c) => `- ${c}`).join("\n"),
    );
  }
  return parts.join("\n\n");
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

// ─── Segment 3: Tool Usage(动态生成) ───

/**
 * 从注册的工具列表动态生成工具使用偏好。
 * 添加/移除工具时,此段落自动适应。
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
  if (names.has("schedule")) {
    lines.push("- Use `schedule` to create, list, update, delete, or run scheduled tasks");
    lines.push("- When the user wants recurring actions (reminders, periodic checks, timed notifications), create a scheduled task");
    lines.push('- Convert natural language time to schedule: "每天早上8点" → cron "0 8 * * *", "每30分钟" → interval 1800000, "明天下午3点" → once with ISO datetime');
    lines.push("- For cron expressions, default timezone to Asia/Shanghai unless the user specifies otherwise");
    lines.push("- Always confirm the schedule with the user before creating (e.g. \"I'll set up a task to run daily at 8:00 AM\")");
  }
  // 工具自描述提示——任何工具声明 systemPromptHints 都自动追加在此。
  // 与 boundaries / permissionArgumentKey 同属"工具自描述"模式,新工具按此路径
  // 自助接入 system-prompt 引导,无需修改本文件。
  for (const tool of tools) {
    if (tool.systemPromptHints) {
      lines.push(...tool.systemPromptHints);
    }
  }

  // 通用原则(不依赖具体工具名)
  if (tools.some((t) => t.isParallelSafe)) {
    lines.push("- When multiple independent tasks exist, use tools in parallel where safe");
  }

  // Tool-authored commitment 抑制原则(所有工具通用)
  // 直接 import @zhixing/core 的 COMMITMENT_SIGNAL 常量,保证系统提示里的字面串与
  // tool-executor 附加到 content 的信号逐字一致;LLM 基于此字符串识别是否抑制叙述。
  lines.push(
    `- If a tool result ends with \`${COMMITMENT_SIGNAL}\`, the user has already seen the tool's confirmation directly via a commit message. Do NOT restate what the tool just did (no "已创建..." / "I've scheduled..."). If no additional insight is needed, end the turn with a brief acknowledgment or no text.`,
  );

  return lines.join("\n");
}

// ─── Segment 4: Skill Evolution(仅当 memory 工具注册时生效) ───

/**
 * 技能进化指导。
 *
 * 引导 Agent 在复杂任务后反思并提议保存/更新技能。
 * 这不是后台静默操作(区别于 Hermes),而是在回复中自然提议,用户确认后执行。
 * 零额外 LLM 成本——反思是最终回复的一部分。
 *
 * 返回类型 `string | null`:
 *   - `null`:tools 不含 memory 工具时此段不适用,buildSystemPrompt 自动跳过
 *   - `string`:含 memory 时输出完整段落
 *
 * 用 `null` 而非 `""` 表达"不适用"语义,避免 join 在空字符串处产生多余空白,
 * 也让段渲染契约清晰:返回 null = 这段不该出现在最终 prompt 里。
 */
function buildSkillEvolution(tools: ToolDefinition[]): string | null {
  const hasMemory = tools.some((t) => t.name === "memory");
  if (!hasMemory) return null;

  return `## Skill Evolution
After completing a complex task (one that required multiple tool calls, trial-and-error, or iterative problem-solving), reflect on whether the approach contains a reusable methodology.

Ask yourself:
- Did I discover a non-obvious approach through trial and error?
- Did the user correct my initial approach, revealing a better method?
- Does a similar skill already exist that should be updated with new learnings?

If the approach is worth saving, propose it naturally at the end of your response:

  "💡 这个过程中我总结了一套方法,要存为技能吗?
   名称:[skill name]
   适用场景:[when this would be useful]
   核心要点:[brief summary]"

If you used an existing skill but found improvements, propose an update:

  "💡 我发现之前的技能「[name]」可以改进,要更新吗?
   改进点:[what changed]"

Rules:
- Never silently create or update skills — always propose and wait for confirmation
- At most one skill proposal per conversation
- Only propose after complex tasks, not simple Q&A
- When the user confirms, use the \`memory\` tool with action "save" and category "skill"`;
}

// ─── Segment 5: Style ───

function buildStyle(): string {
  return `## Style
- Be warm, concise, and natural in conversation
- Do not use emojis unless the user does
- Use markdown for code blocks and structured output
- Keep responses focused — answer what was asked
- When introducing yourself, speak conversationally — never list capabilities`;
}

// ─── Segment 6: Safety ───

function buildSafety(): string {
  return `## Safety
- Never execute destructive commands (rm -rf /, DROP DATABASE, etc.) without explicit user request
- Do not access files outside the workspace unless the user's intent is clear
- Refuse requests that could compromise system security`;
}

// ─── Dynamic: Environment ───

function buildEnvironment(ctx: PromptBuildContext): string {
  const lines = [
    "## Environment",
    `- Working directory: ${ctx.cwd}`,
  ];

  if (ctx.workspace) {
    lines.push(`- Workspace: ${ctx.workspace}`);
    lines.push("- The workspace is the user's trusted zone — routine file reads/writes inside it are low-impact; operations outside require confirmation");
    if (ctx.workspace !== ctx.cwd) {
      lines.push("- Note: workspace and working directory differ — workspace is the security boundary, working directory is where the CLI was launched");
    }
    if (ctx.globalConfigPath) {
      lines.push(`- Workspace is configured in: ${ctx.globalConfigPath} (field: workspace.root)`);
      lines.push("- You CAN help the user change the workspace by editing that config file — the security system will ask the user to confirm (this confirmation cannot be skipped). Changes take effect on next session restart.");
    }
  }

  // 当前时间已移至 per-turn <turn-context> 注入(TimeProvider),不再 session-level 冻结
  lines.push(`- Platform: ${os.platform()} ${os.arch()}`);
  lines.push(`- Node.js: ${process.version}`);

  if (ctx.shell) {
    lines.push(`- Shell: ${ctx.shell}`);
  }

  return lines.join("\n");
}
