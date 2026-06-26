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
  emptyAssistantMessage,
  extractFirstText,
  extractText,
  extractToolCalls,
  findLastAssistantMessage,
  findLastUserIndex,
  hasToolCalls,
  replaceFirstText,
  toolResultMessage,
  userMessage,
} from "./messages.js";

// ─── 用户 turn 输入类型 ───
export type {
  ModelInputCapabilities,
  ModelInputCapabilityOverride,
  ResolveModelInputCapabilitiesInput,
  UserInputImagePart,
  UserInputPart,
  UserInputTextPart,
  UserTurnInput,
  UserTurnInputLike,
} from "./user-input.js";
export {
  extractUserTurnInputText,
  hasUserTurnInputContent,
  isNonEmptyUserTurnInput,
  isUserTurnInput,
  messageContainsImage,
  normalizeUserTurnInput,
  resolveModelInputCapabilities,
  userMessageFromTurnInput,
  userTurnInputFromText,
  validateMessagesAgainstInputCapabilities,
} from "./user-input.js";

// ─── 工具类型 ───
export type {
  JsonSchema,
  JsonSchemaProperty,
  FileDiffChangeStats,
  FileDiffHunk,
  FileDiffLine,
  FileDiffPresentationArtifact,
  GrepResultsContextLine,
  GrepResultsDiagnostics,
  GrepResultsFile,
  GrepResultsLineText,
  GrepResultsMatch,
  GrepResultsPresentationArtifact,
  GrepResultsQuerySummary,
  ToolDefinition,
  ToolExecutionContext,
  ToolPresentationArtifact,
  ToolResult,
  ToolSpec,
  TurnContext,
  TurnOrigin,
} from "./tools.js";
export { toToolSpec, generateTurnId } from "./tools.js";

// ─── LLM 类型 ───
export type {
  ChatRequest,
  ThinkingConfig,
  ThinkingControl,
  ResolvedRoleThinking,
  LLMProvider,
  LLMRole,
  LLMRoles,
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
  TextCallLLMFn,
  TokenUsage,
} from "./llm.js";
export {
  emptyUsage,
  mergeUsage,
  getTotalInputTokens,
  validateThinkingConfig,
} from "./llm.js";

// ─── 事件类型 ───
export type {
  AgentEventMap,
  AgentRunEndReason,
  OrchestrationEventIssue,
  OrchestrationRunEventStatus,
  WorkModeSwitchIntent,
} from "./agent-events.js";

// ─── 错误类型 ───
export type { AgentErrorType, UserFacingError } from "./errors.js";
export {
  AgentError,
  isAgentError,
  isUserFacingError,
  toAgentError,
} from "./errors.js";

// ─── 可重置组件 ───
export type { Resettable } from "./resettable.js";
