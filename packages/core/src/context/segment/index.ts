/**
 * 段切换模块公共导出。
 *
 * 当前仅暴露纯函数与类型；编排类 SegmentManager 与持久化实现在
 * 后续 step 加入后会从本 barrel 一并导出。
 */

export { composeNewSegmentMessages, type ComposeInput } from "./compose.js";
export { decideSegmentAction, type DecideInput } from "./decision.js";
export { parseSummary } from "./parser.js";
export {
  createSegmentPersistence,
  type ConversationSegmentRepo,
  type SegmentPersistenceDeps,
} from "./persist.js";
export { SEGMENT_SUMMARIZE_INSTRUCTION } from "./prompts.js";
export {
  createSegmentSummarizeFn,
  type SegmentStreamFactory,
} from "./llm-fn.js";
export {
  createSegmentManager,
  SegmentManager,
  type SegmentManagerConfig,
} from "./segment-manager.js";
export type {
  ParsedSummary,
  SegmentDecision,
  SegmentManagerInput,
  SegmentManagerOutput,
  SegmentPersistence,
  SegmentSummarizeLLMFn,
  SegmentSummarizeRequest,
  SegmentThresholds,
  SegmentTransitionContext,
  SegmentTransitionHook,
  TaskListReader,
} from "./types.js";
