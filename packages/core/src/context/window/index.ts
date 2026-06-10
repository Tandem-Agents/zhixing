// 注意力窗口运行态 —— "给 LLM 看什么"的唯一内存权威（持久化的派生视图）

export type {
  AcceptRunInput,
  AttentionWindowState,
  CreateAttentionWindowOptions,
  WindowCompact,
  WindowFoldOutcome,
  WindowResetReason,
} from "./types.js";
export { createAttentionWindow } from "./attention-window.js";
