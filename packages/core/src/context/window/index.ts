// 注意力窗口运行态 —— "给 LLM 看什么"的唯一内存权威（持久化的派生视图）

export type {
  AttentionWindowSnapshotErrorCodeV1,
  AttentionWindowSnapshotErrorV1,
  AttentionWindowSnapshotStrategyV1,
  AttentionWindowSnapshotV1,
  SnapshotAttentionWindowOptionsV1,
  SnapshotAttentionWindowResultV1,
} from "./snapshot.js";
export {
  snapshotAttentionWindowV1,
} from "./snapshot.js";

export type {
  AcceptRunInput,
  AttentionWindowState,
  CreateAttentionWindowOptions,
  WindowCompact,
  WindowFoldOutcome,
  WindowResetReason,
} from "./types.js";
export { createAttentionWindow } from "./attention-window.js";
