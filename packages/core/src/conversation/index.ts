export type {
  Conversation,
  ConversationScope,
  CreateConversationOptions,
  EnsureConversationOptions,
  IConversationRepository,
  TaskItem,
  TaskListOp,
  TaskListState,
  SegmentMeta,
  SegmentRecord,
  SegmentMetadata,
} from "./types.js";
export {
  DEFAULT_CONVERSATION_ID,
  DEFAULT_CONVERSATION_NAME,
} from "./types.js";

export { ConversationRepository, conversationsDir } from "./repository.js";

export {
  LOCAL_CONVERSATION_PREFIX,
  WORKSCENE_CONVERSATION_PREFIX,
  assertLocalConversationIdForDevice,
  isLocalConversationId,
  localConversationId,
  parseLocalConversationId,
  worksceneConversationId,
  parseConversationId,
  type LocalConversationIdentity,
  type ParsedConversationId,
} from "./scope-id.js";

export type {
  InferConversationName,
  MaybeAutoNameFirstTurnOptions,
} from "./auto-name.js";
export {
  maybeAutoNameFirstTurn,
  sanitizeConversationName,
  buildConversationNamerPrompt,
} from "./auto-name.js";
