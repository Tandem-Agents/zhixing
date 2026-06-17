// Agent Loop — 核心循环模块的公开 API
export { runAgentLoop, drainAgentLoop } from "./agent-loop.js";
export { streamLLMCall } from "./llm-call.js";
export { executeToolCalls, COMMITMENT_SIGNAL } from "./tool-executor.js";
export { stripPresentationFromAgentYield } from "./presentation.js";
export { MockLLMProvider, mockTextProvider, mockSequenceProvider } from "./mock-provider.js";
export {
  buildRunRecord,
  deriveToolCalls,
  finalAssistantMessageOf,
  userMessageOf,
} from "./run-record-builder.js";

export type {
  AgentLoopParams,
  AgentLoopDeps,
  LoopState,
  AgentResult,
  AgentYield,
  ContinueReason,
  LLMCallResult,
  RunResult,
  WindowChangeReason,
  WindowLifecycle,
} from "./types.js";
export type { BuildRunRecordInput } from "./run-record-builder.js";
export type { MockResponse, MockToolCall } from "./mock-provider.js";
