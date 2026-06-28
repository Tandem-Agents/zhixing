/**
 * 系统提示词组装
 *
 * 段集架构 + 缓存分界标记。"始终段"必出,"条件段"按 ctx.tools 是否含触发工具决定:
 *
 * ┌─ 静态区(Stable Prefix,可跨会话缓存)──────────────┐
 * │ Identity              始终  身份定义(profile.instructions) │
 * │ Principles            始终  工作原则                          │
 * │ Meta Protocol         始终  消息流元信息标签解释              │
 * │ Tool Usage            始终  从工具列表动态生成                 │
 * │ Sub-Agent Delegation  条件  ctx.tools 含 Task 才渲染          │
 * │ Style                 始终  输出风格                          │
 * │ Safety                始终  安全边界                          │
 * ├─ __ZHIXING_CACHE_BOUNDARY__ ─────────────────────────────────┤
 * │ Environment           始终  工作目录、平台(每会话不同)       │
 * └──────────────────────────────────────────────────────────────┘
 *
 * 段顺序与 MAIN_AGENT_SEGMENTS 定义一致;调用方通过 ctx.segments 传入子集
 * (如 SUB_AGENT_SEGMENTS)切换为子 agent 等其他角色配置。
 *
 * 设计决策:
 * - 缓存分界借鉴 Claude Code / OpenClaw,静态区不含任何会话特有信息
 * - 工具使用段从注册工具的 systemPromptHints 动态生成,添加/移除工具时自动适应
 * - 条件段返回 null 时被 buildSystemPrompt 跳过,不留空白(无空段噪声)
 *   —— 让 ctx.tools 不含 memory / Task 时输出 byte-equal 历史,守住既有锚点
 * - 元协议段在工具段之前:LLM 解析 messages 的基础协议(<system-meta> 标签等)
 *   是看懂工具调用的前置知识,语义上先于工具使用引导
 * - 环境信息放在分界后(每个项目不同),保护静态区缓存前缀
 * - 项目上下文（如 ZHIXING.md）不进 system prompt,以保护静态区缓存前缀
 */

import * as os from "node:os";
import {
  COMMITMENT_SIGNAL,
  SYSTEM_META_PROMPT_SECTION,
  type ToolDefinition,
} from "@zhixing/core";
import type { AgentRoleProfile } from "../profile/agent-role-profile.js";
import { mainProfile } from "../profile/default-profiles.js";

// ─── 缓存分界标记 ───

export const CACHE_BOUNDARY = "\n__ZHIXING_CACHE_BOUNDARY__\n";

// ─── 段标识 ───

/**
 * 静态段标识 —— 调用方按列表顺序选择启用哪些段(主 agent 用全集,子 agent 通常子集)。
 * Environment 不在此列举(始终在缓存分界之后,作为独立动态段)。
 *
 * 各段适配策略(条件性 vs 始终):
 *   identity / principles / meta-protocol / tool-usage / style / safety  始终输出
 *   sub-agent-delegation   条件:tools 含 Task 才渲染(避免让 LLM 看到不存在的 Task 工具说明)
 *   working-mode           条件:tools 含 workmode_enter 才渲染(仅 main runtime 装配此工具;
 *                          power / 子 agent / 无 workmode 装配点 → 段缺省,历史输出 byte-equal)
 *
 * meta-protocol 段说明:LLM 在 messages 历史中可能遇到 `<system-meta kind="...">`
 * 标签(由 compact / drop 等机制层插入),本段告知 LLM 如何识别并不当作用户原话回应。
 */
export type SystemPromptSegment =
  | "identity"
  | "principles"
  | "meta-protocol"
  | "tool-usage"
  | "sub-agent-delegation"
  | "working-mode"
  | "skill-index"
  | "style"
  | "safety";

/**
 * 主 agent 默认启用的全段集合,顺序与历史输出一致(byte-equal 保证)。
 *
 * sub-agent-delegation 紧跟 tool-usage:概念上 delegation 是 Task 工具使用的
 * 延伸说明,放工具段后是自然语义流;条件性渲染保证 tools 不含 Task 时
 * 输出仍 byte-equal 历史(段返 null 被 buildSystemPrompt 跳过,不留空白)。
 *
 * skill-index 紧随 working-mode:都是模式相关的条件段(working-mode 看是否工作
 * 场景,skill-index 看当前模式有无可注入技能),作为参考资料置于行为段(style /
 * safety)之前;无技能时段返 null 被跳过,无技能用户的输出仍 byte-equal 历史。
 */
export const MAIN_AGENT_SEGMENTS: readonly SystemPromptSegment[] = [
  "identity",
  "principles",
  "meta-protocol",
  "tool-usage",
  "sub-agent-delegation",
  "working-mode",
  "skill-index",
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
 *   sub-agent-delegation ✗ sub-agent profile.enabledTools 不含 Task 防递归,子 agent 工具集不含 Task,delegation 段无意义
 *   style       ✗ 子 agent 输出回写父 tool_result,不直接对话用户,
 *                 风格指引("be concise"等)会让子误解为对话场景
 *
 * 不继承的内容:
 *   - 项目上下文(ZHIXING.md / enriched 动态上下文)—— 由主 agent 在 Task prompt
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
  "meta-protocol",
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
  /**
   * 预渲染的「Available Skills」索引段文本 —— 由装配方按当前模式取 top-N 经
   * renderSkillIndex 生成。无可注入技能时为 null / 省略 → skill-index 段跳过,
   * 输出 byte-equal 历史(无技能用户无回归)。本字段只承载已构造好的字符串,
   * buildSystemPrompt 借此保持纯同步、不触磁盘 —— 技能扫描的 I/O 归装配方。
   */
  skillIndex?: string | null;
  /**
   * 段内容运行时覆盖 —— 数据驱动段(如 skill-index)在注意力窗口边界经
   * updateSystemPromptSegment 贡献的最新内容。renderSegment 渲染每段前先查此处:
   * 命中(含显式 null=清空该段)即用之、不走默认渲染。装配方据此让 system prompt
   * 的数据驱动段随窗口边界重建,而无需把可变数据源耦进本纯函数。
   */
  segmentOverrides?: Partial<Record<SystemPromptSegment, string | null>>;
}

// ─── 主构建函数 ───

/**
 * 构建系统提示词。
 *
 * 默认主 agent 段顺序(MAIN_AGENT_SEGMENTS):
 *   Identity → Principles → Tool Usage
 *     → Sub-Agent Delegation (条件:tools 含 Task)
 *     → Working Mode        (条件:tools 含 workmode_enter)
 *     → Skill Index         (条件:当前模式有可注入技能,ctx.skillIndex 非空)
 *     → Style → Safety
 *   + 缓存分界 + Environment(动态段,始终)
 *
 * 条件段返回 null 时跳过(不留空白),保证 tools 不含触发工具时输出 byte-equal
 * 历史,既有锚点测试自动守住无回归。
 *
 * 调用方传 profile / segments 切换为其他角色配置(如 SUB_AGENT_SEGMENTS 子 agent
 * 精简集——仅 identity / principles / tool-usage / safety 四段,其余由子任务
 * 专注 / 输出回写父 / prompt cache 友好等理由排除)。
 *
 * ─── 调用契约: SystemPrompt 在「一个 cache 周期」内 byte-equal 不变 ───
 * 这是 prompt cache 的死线 —— 系统提示词作为缓存前缀的最前段,任何变化
 * (插入时间戳 / 重排段顺序 / 让 ctx.tools 在装配后变化等)都会破坏前缀缓存,
 * 让此后所有消息都得重新计费。cache 周期的范围因调用方而异:
 *   - 主 agent(main / power,走 create-agent-runtime):cache 周期 = 单个**注意力
 *     窗口**;窗口内 byte-equal 不动,跨窗口边界(段切换 / compact / clear / resume)
 *     才允许重建,重建是「检查→变了才换、没变 byte-equal 不动」(本意见
 *     skill-system.md §3.1 / lifecycle-concepts.md)。运行时跨窗口重建尚未落地
 *     (规划见 agent-runtime-lifecycle.md),故现状是装配期构造一次。
 *   - 子 agent(走 subagent/factory):不启用段切换、无窗口换代,整个子 agent 生命
 *     周期 byte-equal(byte-equal-across-spawns,见 context-management-v3-redesign.md §8.4)。
 * 两类都在装配阶段构造一次、把字符串绑定到对应生命周期上下文,后续每轮 run() /
 * LLM call 一律透传,**不得在 run() / loop / LLM call 路径里重建**(那在窗口/生命
 * 周期内),不得在末尾追加 per-turn 信息。
 *
 * Per-turn 动态信息(当前时间 / 任务状态 / 工作目录变更等)通过 turn-context
 * 注入到末尾 user message,**不**进入 systemPrompt(参见 TimeProvider /
 * TurnContextInjector 注释)。tools[] 在 session 创建后冻结不变(reload 级、比注意
 * 力窗口更强),prompt 内 tool-usage 段与 API tools[] 字段同源稳定。
 */
export function buildSystemPrompt(ctx: PromptBuildContext): string {
  const profile = ctx.profile ?? mainProfile();
  const segments = ctx.segments ?? MAIN_AGENT_SEGMENTS;

  // 跳过 null —— 段在当前 ctx 下不适用(如 sub-agent-delegation 在 tools 不含 Task
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
  // 运行时段覆盖优先 —— 数据驱动段经窗口边界更新写入 segmentOverrides;
  // 命中(含显式 null=清空该段)即用之、不走默认渲染。
  if (ctx.segmentOverrides && segment in ctx.segmentOverrides) {
    return ctx.segmentOverrides[segment] ?? null;
  }
  switch (segment) {
    case "identity":
      return renderIdentity(profile);
    case "principles":
      return buildPrinciples();
    case "meta-protocol":
      return buildMetaProtocol();
    case "tool-usage":
      return buildToolUsage(ctx.tools);
    case "sub-agent-delegation":
      return buildSubAgentDelegation(ctx.tools);
    case "working-mode":
      return buildWorkingMode(ctx.tools);
    case "skill-index":
      // 装配期预渲染好的索引文本;无技能(null/省略)→ 跳过,byte-equal 历史。
      return ctx.skillIndex ?? null;
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
- When the user asks you to act, use the appropriate tools proactively; tool permissions and safety checks still apply
- Read before edit: always read a file before modifying it to ensure exact text match
- Edit over write: prefer targeted replacement over full overwrite when modifying existing files
- Search before act: use glob/grep to discover relevant files before reading or editing
- If a command fails, analyze the error and try an alternative approach
- For non-obvious decisions, briefly state the evidence, assumptions, and tradeoffs`;
}

// ─── Segment: Meta Protocol(消息流元信息标签解释) ───

/**
 * 告知 LLM 对话历史中可能出现的 `<system-meta kind="...">` 标签格式与处理规则。
 *
 * 这些标签由上下文管理机制(compact / drop 等)插入,不是用户原话。
 * 文本内容由 `@zhixing/core` 的 `SYSTEM_META_PROMPT_SECTION` 常量提供 ——
 * 与产生标签的 `system-meta` 模块同源,改一处自动同步。
 */
function buildMetaProtocol(): string {
  return SYSTEM_META_PROMPT_SECTION;
}

// ─── Segment: Tool Usage(动态生成) ───

/**
 * 从注册的工具列表动态生成工具使用偏好。
 * 添加/移除工具时,此段落自动适应。
 *
 * Tools[] 在 session 创建后冻结不变；本函数输出的文本也随之 byte-equal 稳定。
 */
function buildToolUsage(tools: ToolDefinition[]): string {
  return buildToolUsageLines(tools);
}

function buildToolUsageLines(tools: ToolDefinition[]): string {
  const lines = ["## Tool Usage"];

  for (const tool of tools) {
    if (tool.systemPromptHints) {
      lines.push(...tool.systemPromptHints);
    }
  }
  if (tools.some((t) => t.isParallelSafe)) {
    lines.push("- When multiple independent tasks exist, use tools in parallel where safe");
  }
  if (tools.some((t) => t.mayCommitToUser)) {
    lines.push(
      `- If a tool result ends with \`${COMMITMENT_SIGNAL}\`, the tool already sent a user-visible confirmation. Do not restate that confirmation unless you have additional insight.`,
    );
  }

  return lines.join("\n");
}

// ─── Segment: Sub-Agent Delegation(仅当 Task 工具注册时生效) ───

/**
 * Sub-Agent Delegation 段的文本内容(byte-equal 锚点导出,供测试断言)。
 *
 * 引导主 agent 何时合理使用 Task 工具派生子 agent 完成研究型子任务,
 * 与 Task 工具自身的 description(给 LLM 看的工具描述)互补:
 *   - Task.description 偏"工具 API 文档"(参数 / 输出 / 失败处理)
 *   - 本段偏"产品哲学"(何时 worth dispatching / 失败时的责任契约)
 *
 * 关键约束:Task 失败时,主 agent **必须**在 final response 中暴露失败,
 * 不可静默吞掉 —— 这是产品级语义契约,与 Task.description 中的同条规则
 * 形成双重提醒。
 */
export const SUB_AGENT_DELEGATION_TEXT = `## Sub-Agent Delegation (Task tool)

Use \`Task\` for isolated research-style sub-tasks that need multiple tool rounds, parallel comparison, or separate review perspectives.

You may launch up to 3 Tasks in one turn. They run in parallel.

If a Task fails, surface the failure in your final response; do not silently continue or imply it succeeded.`;

/**
 * Sub-Agent Delegation 段渲染。
 *
 * 返回类型 `string | null`:
 *   - `null`:tools 不含 Task 工具时此段不适用,buildSystemPrompt 自动跳过
 *   - `string`:含 Task 时输出完整段(SUB_AGENT_DELEGATION_TEXT)
 *
 * 工具名 "Task" 大小写敏感比对 —— 与 createTaskTool 装配的 name 字段一致;
 * 若未来 Task 工具改名,本段自动跟随(段内文本仍引用 "Task" 字面值,需同步,
 * 这是有意的 prompt-text 显式契约,避免动态拼接让段文本不可静态审查)。
 */
function buildSubAgentDelegation(tools: ToolDefinition[]): string | null {
  const hasTask = tools.some((t) => t.name === "Task");
  if (!hasTask) return null;
  return SUB_AGENT_DELEGATION_TEXT;
}

// ─── Segment: Working Mode ───

/**
 * Working Mode 指引 —— 教主对话何时进入工作场景、模糊时先探后问。
 *
 * 仅当 tools 含 `workmode_enter`（main runtime 装配的 main-only 工具）才渲染：
 * power runtime 只有 workmode_exit（其退出自判走 powerProfile 身份段，不靠本段）；
 * 子 agent / serve / 无 workmode 装配点无此工具，段缺省、历史输出 byte-equal。
 *
 * 段文本显式引用工具名字面值（workmode_enter / workscene_memory_query /
 * workscene_change_approve）—— 与 sub-agent-delegation 同款"prompt-text 显式
 * 契约"：宁可工具改名时同步本文本，也不动态拼接让段不可静态审查。
 */
export const WORKING_MODE_TEXT = `## Working Mode (work scenes)

A work scene is an isolated context for a bounded line of work, with its own working directory, private memory, and model. Entering one switches the conversation into that scene; leaving returns here.

Tools:
- \`workmode_enter\`: enter a work scene; the switch takes effect after the current turn.
- \`workscene_memory_query\`: inspect existing scene memory before deciding.
- \`workscene_change_approve\`: create, rename, or remove scenes with confirmation.

How to decide:
- Clear scene fit: call \`workmode_enter\` with that scene id; if none fits but one is warranted, propose it via \`workscene_change_approve\`.
- Ambiguous fit: probe with \`workscene_memory_query\` before asking or switching.
- Casual or one-off questions: stay in the main conversation.

After \`workmode_enter\`, finish the current turn normally; do not assume you are already inside the scene.`;

/**
 * Working Mode 段渲染。返回 `string | null`：
 *   - `null`：tools 不含 workmode_enter（power / 子 agent / serve / 无 workmode
 *     装配点）→ buildSystemPrompt 跳过，历史输出 byte-equal 无回归。
 *   - `string`：含 workmode_enter（main runtime）→ 完整段。
 */
function buildWorkingMode(tools: ToolDefinition[]): string | null {
  const hasEnter = tools.some((t) => t.name === "workmode_enter");
  if (!hasEnter) return null;
  return WORKING_MODE_TEXT;
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

/**
 * Working directory 字段语义：用户心智模型里"工作目录"就是用户配置的工作区
 * （workspace）—— 用户配置 workspace 的目的就是为了让它成为工作目录。本字段
 * 优先使用 workspace 路径；workspace 未配置时 fallback 到 cwd（cli 启动位置）。
 *
 * **不暴露 `process.cwd()` 给 LLM**：cwd 是 cli 实现细节（用户在哪里启动 cli），
 * 与用户认知的"工作目录"无关。同时暴露 cwd 与 workspace 双字段会让 LLM 在中
 * 英文翻译时（中文"工作目录" ↔ 英文 "Working directory"）选错路径——单一字段
 * 消除歧义，与 chrome welcome 的"工作目录 {workspaceRoot}"用户视角一致。
 */
function buildEnvironment(ctx: PromptBuildContext): string {
  const lines = ["## Environment"];

  const workingDirectory = ctx.workspace ?? ctx.cwd;
  lines.push(`- Working directory: ${workingDirectory}`);

  if (ctx.workspace) {
    lines.push("- This workspace is the user's trusted zone; routine file reads/writes inside are low-impact, while operations outside require clear user intent or confirmation");
    if (ctx.globalConfigPath) {
      lines.push(`- Configured in: ${ctx.globalConfigPath} (field: workspace.root)`);
      lines.push("- To change the working directory, edit that config file; confirmation is handled by the security system and changes apply after restart.");
    }
  } else {
    lines.push("- No workspace is configured; the working directory defaults to the CLI launch location and serves as the trusted zone.");
  }

  // 当前时间已移至 per-turn <turn-context> 注入(TimeProvider),不再 session-level 冻结
  lines.push(`- Platform: ${os.platform()} ${os.arch()}`);
  lines.push(`- Node.js: ${process.version}`);

  if (ctx.shell) {
    lines.push(`- Shell: ${ctx.shell}`);
  }

  return lines.join("\n");
}
