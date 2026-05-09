/**
 * Capability 能力分层 —— 工具按"是否当前会话需要完整 schema 暴露"动态分层。
 *
 * 四层语义：
 *   - always         永远以完整 schema 出现在 API tools[]（如 memory / recall_history /
 *                    request_capabilities 等元工具或会话级常用能力）
 *   - hot            本会话已激活且最近活跃；以完整 schema 出现在 API tools[]
 *   - discoverable   存在但未激活；不出现在 API tools[]，仅通过 system prompt
 *                    的工具使用引导让 LLM 知道存在 + 怎么用
 *   - cold           完全不暴露（sub-agent 隔离 / 用户禁用等场景）
 *
 * 与 ContextCompiler 的关系：
 *   ToolSchemaCompilerStage 按 layer 过滤入参 tools[]，仅保留 always + hot；
 *   discoverable 工具靠 system prompt 文本告诉 LLM 存在；cold 完全过滤掉。
 *
 * 与自动升级的关系：
 *   LLM 调用 discoverable 工具时 cli 静默升级到 hot 并直接执行，无重发 LLM call、
 *   无 +1 轮延迟（参数若猜错由常规 error→fix 循环消化，下一轮 LLM 视图已含完整 schema）。
 */
export type CapabilityLayer = "always" | "hot" | "discoverable" | "cold";

/**
 * 单个工具的能力记录。
 *
 * - layer 是当前层归属
 * - lastUseTurn 是最近一次 tool_use 命中的 turn 序号（LRU 降级评估的输入）；
 *   `always` 工具的 lastUseTurn 仅作诊断用途，不参与降级
 *
 * 不持久化 —— capability state 是 session-scoped 运行时状态，重启后由
 * `rebuildCapabilityFromHistory` 从 transcript 历史现学现用，避免与 transcript
 * 出现双源不一致风险。
 */
export interface CapabilityRecord {
  readonly toolName: string;
  layer: CapabilityLayer;
  /**
   * 最后一次该工具被 tool_use 命中时的 turn 序号（CapabilityState.currentTurn 同 frame）。
   * 从未命中过则为 undefined（discoverable 默认状态）。
   */
  lastUseTurn?: number;
}

/**
 * Hot LRU 窗口大小（轮）—— 与 capability-compiler 设计文档敲定值一致。
 *
 * 7 轮覆盖典型 task 流程，与人类工作记忆窗口（7±2）契合；
 * 任务切换后未活跃工具自然降级回 discoverable，自动瘦身。
 *
 * 硬编码不开放配置 —— 一致行为优先于灵活性。
 */
export const HOT_RETENTION_TURNS = 7;
