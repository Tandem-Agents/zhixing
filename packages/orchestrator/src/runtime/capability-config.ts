/**
 * Capability 始终可用工具 (always layer) 的单一事实源。
 *
 * 同时被两处消费：
 * - `create-agent-runtime.ts`：装配期决定哪些工具初始化为 always layer
 * - `system-prompt.ts:buildCapabilityToolUsage`：在 prompt 中告诉 LLM 哪些工具
 *   "始终在 tools[] 中"且每个工具的简短用途描述
 *
 * Map 形态而非 Set —— 让 always 工具名 + prompt 描述同源单写：新增 always
 * 工具时只需在此 Map 加一行，prompt 与装配自动同步。
 *
 * 描述风格：动词短语，主语隐含为"用户"或"LLM"。配合 buildCapabilityToolUsage
 * 输出 `- \`<name>\` — <description>` 行格式。description 不出现在 API tools[]
 * 字段中（那是 ToolDefinition.description 的事），仅用于 system prompt 的
 * "always 集合"段语义说明。
 */
export const ALWAYS_TOOL_PROMPT_DESCRIPTIONS = {
  memory: "save / search / manage the user's persistent memories",
  request_capabilities: "activate the tools listed below",
} as const;

export const ALWAYS_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.keys(ALWAYS_TOOL_PROMPT_DESCRIPTIONS),
);
