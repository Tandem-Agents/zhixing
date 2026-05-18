/**
 * 默认 profile 工厂 —— 主 agent 与子 agent 的标准 profile 起点。
 *
 * 设计要点:
 *   - mainProfile().instructions 持当前 system prompt 身份段的 verbatim 文本,
 *     保证主路径 buildSystemPrompt 输出 byte-equal(无回归)
 *   - subAgentProfile() 是子 agent dispatch 时的起点,实际派生时按 task 字段
 *     生成 instructions
 */

import { getAgentIdentity } from "@zhixing/core";
import type { WorkScene } from "@zhixing/core";
import type { AgentRoleProfile } from "./agent-role-profile.js";

/**
 * 主 agent 身份段文本 —— 与历史 buildIdentity 输出 byte-equal,
 * 单独导出供 byte-equal 回归测试比对。
 */
export const MAIN_IDENTITY_INSTRUCTIONS = [
  "You are Zhixing (知行), a personal intelligent assistant.",
  'Your name means "unity of knowledge and action" — you understand problems and take action to solve them.',
].join("\n");

/**
 * 主 agent 启用的工具集 —— builtin 与 Task 的权威源。
 *
 * 包含：
 *   - 8 个内置工具（由 BUILTIN_TOOL_FACTORIES 提供实例）
 *   - Task（启用子 agent 派发；create-agent-runtime 后置装配）
 *
 * **不含外部依赖型工具**（如 schedule 需要 scheduler ref，由 cli 通过
 * `options.extraTools` 注入；profile 声明 builtin / Task，extraTools 补充
 * 实例，二者协同装配最终 tools[]）。
 */
const MAIN_ENABLED_TOOLS = [
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "bash",
  "memory",
  "web_fetch",
  "Task",
] as const;

/**
 * 子 agent 启用的工具集 —— 任务专注，不可派生子 agent（无 Task）。
 *
 * 当前限定为只读探索类工具：read / glob / grep。
 */
const SUB_AGENT_ENABLED_TOOLS = ["read", "glob", "grep"] as const;

/**
 * 主 agent profile。name 来自全局 setAgentIdentity 单例,可由 zhixing.config.json
 * 的 agent.displayName 覆盖。
 */
export function mainProfile(): AgentRoleProfile {
  return {
    name: getAgentIdentity().displayName,
    role: "main",
    instructions: MAIN_IDENTITY_INSTRUCTIONS,
    constraints: [],
    enabledTools: MAIN_ENABLED_TOOLS,
    capabilities: { canSpawnSubAgents: true, userFacing: true },
  };
}

export interface SubAgentProfileOptions {
  /** 子 agent 唯一 id —— 用于显示名截断与 lineage 派生 */
  subAgentId: string;
  /** 派发给子 agent 的具体任务文本(主 agent 的 Task 工具 prompt 入参) */
  task: string;
}

/**
 * 子 agent profile —— 任务专注,自我隔离,不可再派生。
 *
 * 子 agent 的输出仅给主 agent 看,所以 instructions 中明确"输出自包含、不引用上下文"
 * 等约束,避免子 agent 模仿主 agent 与用户对话的语气。
 */
/**
 * 无 workdir 工作场景的工具集 —— 从主工具集剔除全部本地文件类工具
 * （bash/read/write/edit/glob/grep）。**by-construction 文件作用域隔离**：
 * 无 workdir = 该场景不涉本地文件，装配期即无文件工具，根本不存在"文件
 * 工具无根"问题；与"无 workdir power 的 workingDirectory 不落 cwd"互为
 * 主防线（无文件操作面）与纵深防御。
 */
const WORKSCENE_NON_FILE_TOOLS = [
  "memory",
  "web_fetch",
  "Task",
] as const;

/**
 * 工作场景 power agent profile —— 用户面对的主对话循环，专注单一工作场景。
 *
 * 复用 subAgentProfile 把动态文本编进 instructions 的现成手法：同一 scene
 * 输出固定 → 静态前缀 byte-equal，多次进入缓存可复用。
 *
 * 工具集按 scene.workdir 有无二分（by-construction）：
 *   - 有 workdir：主工具全集（文件工具在 workdir 内操作）
 *   - 无 workdir：剔除本地文件类，仅留非文件工具（memory/web_fetch/Task）
 *
 * capabilities 同 mainProfile（用户面对、可派 Task）。
 */
export function powerProfile(scene: WorkScene): AgentRoleProfile {
  const hasWorkdir = Boolean(scene.workdir);
  return {
    name: getAgentIdentity().displayName,
    role: "main",
    instructions:
      `${MAIN_IDENTITY_INSTRUCTIONS}\n\n` +
      `You are now focused on the work scene "${scene.name}". ` +
      `Work and memory in this scene are isolated from personal scope and other scenes. ` +
      `When the work in this scene is done — or the user signals they want to step back to the broader conversation — ` +
      `judge for yourself that the scene is complete and call the workmode_exit tool to return to the main conversation. ` +
      `Do not just narrate that you are done; leaving the scene only happens when you call workmode_exit.`,
    constraints: [],
    enabledTools: hasWorkdir
      ? MAIN_ENABLED_TOOLS
      : WORKSCENE_NON_FILE_TOOLS,
    capabilities: { canSpawnSubAgents: true, userFacing: true },
  };
}

export function subAgentProfile(opts: SubAgentProfileOptions): AgentRoleProfile {
  const shortId = opts.subAgentId.slice(0, 6);
  return {
    name: `Sub-Agent #${shortId}`,
    role: "sub",
    instructions:
      `# Your Role\n` +
      `You are a sub-agent dispatched by the main agent to perform the following task:\n\n` +
      "```\n" +
      `${opts.task}\n` +
      "```",
    constraints: [
      "Your output is read by the main agent only — the user does not see it. Make your output self-contained; do not reference 'just now' or other context the user might assume.",
      "Use as few tool calls as possible. When you have enough to answer, finalize.",
      "You do not have access to the Task tool — you cannot dispatch further sub-agents.",
      "Stay focused on the assigned task. Do not initiate user conversation, do not send external messages.",
    ],
    enabledTools: SUB_AGENT_ENABLED_TOOLS,
    capabilities: { canSpawnSubAgents: false, userFacing: false },
  };
}
