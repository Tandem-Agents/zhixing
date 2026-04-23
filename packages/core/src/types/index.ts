// ─── 消息类型 ───
export type {
  ContentBlock,
  ImageBlock,
  ImageSource,
  Message,
  Role,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "./messages.js";
export {
  assistantMessage,
  extractText,
  extractToolCalls,
  hasToolCalls,
  toolResultMessage,
  userMessage,
} from "./messages.js";

// ─── 工具类型 ───
export type {
  JsonSchema,
  JsonSchemaProperty,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  ToolSpec,
  TurnContext,
  TurnOrigin,
} from "./tools.js";
export { toToolSpec, generateTurnId } from "./tools.js";

// ─── LLM 类型 ───
export type {
  ChatRequest,
  LLMProvider,
  ModelInfo,
  StopReason,
  StreamError,
  StreamEvent,
  StreamMessageEnd,
  StreamMessageStart,
  StreamTextDelta,
  StreamThinkingDelta,
  StreamToolCallDelta,
  StreamToolCallEnd,
  StreamToolCallStart,
  TokenUsage,
} from "./llm.js";
export { emptyUsage, mergeUsage } from "./llm.js";

// ─── 事件类型 ───
export type { AgentEventMap, AgentRunEndReason } from "./agent-events.js";

// ─── 错误类型 ───
export type { AgentErrorType, UserFacingError } from "./errors.js";
export {
  AgentError,
  isAgentError,
  isUserFacingError,
  toAgentError,
} from "./errors.js";
