/**
 * Cancel intent 默认关键词集。
 *
 * 设计约束(INV-R2 词集互斥):cancel 关键词必须与 `confirmation/match.ts` 的
 * APPROVE_SET / DENY_SET 完全不相交 —— 否则同一个词("取消"/"停"/"cancel")在
 * pending confirmation 场景下会有两种解释("拒绝该 confirmation" vs "中止整个 turn"),
 * 用户体验歧义。
 *
 * 当前 confirmation DENY_SET 已包含"取消" / "停" / "cancel" / "stop";因此 cancel
 * 关键词选择**显式控制意图**(slash 前缀)+ 独立中文词("中止" / "中断"):
 *   - slash 前缀("/cancel"等)是跨平台 IM 中明确的"控制命令"语义,与自然语言确认拒绝
 *     ("cancel")完全区分开
 *   - "中止" / "中断"为汉语中"主动终止某个动作"的强意图词,不在 confirmation DENY_SET 内
 *
 * 词集互斥由 `intent-classifier.ts` 启动时静态校验,在添加新词时如与现有
 * confirmation 词集冲突会立即 throw,fail-fast 暴露配置错误。
 */
export const DEFAULT_CANCEL_KEYWORDS: ReadonlyArray<string> = [
  // 显式控制命令(跨平台,与自然语言确认完全不歧义)
  "/cancel",
  "/stop",
  "/abort",
  "abort",
  // 独立中文词
  "中止",
  "中断",
];
