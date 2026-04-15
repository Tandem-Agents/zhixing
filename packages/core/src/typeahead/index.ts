// Typeahead 输入补全 — 公开 API

// ── Step 2 类型（命令 + 参数 + registry + usage） ──
export type {
  ArgChoice,
  ArgChoiceProvider,
  ArgQueryContext,
  ArgSchema,
  AsyncEnumArg,
  BooleanArg,
  CommandCategory,
  CommandDef,
  CommandExecution,
  CommandHandler,
  CommandHandlerContext,
  CommandHandlerResult,
  CommandVisibility,
  DynamicCommandSource,
  FreeTextArg,
  ICommandRegistry,
  IUsageTracker,
  NumberArg,
  PathArg,
  RendererTarget,
  RuntimeContext,
  StaticEnumArg,
  Unregister,
  Unsubscribe,
  UsageEntry,
} from "./types.js";

// ── Step 3 类型（provider + broker + trigger + suggestion） ──
export type {
  AcceptPayload,
  AcceptResult,
  ArgumentHint,
  GhostText,
  ITypeaheadBroker,
  SuggestionItem,
  SuggestionProvider,
  ThemeColorKey,
  TriggerContext,
  TriggerMatch,
  TypeaheadBrokerSnapshot,
  TypeaheadMode,
  TypeaheadSessionHandle,
  TypeaheadSessionState,
} from "./types.js";

// ── Registry ──
export {
  DefaultCommandRegistry,
  type CommandRegistryOptions,
} from "./registry.js";

// ── Builtin 命令 ──
export {
  buildBuiltinCommands,
  registerBuiltinCommands,
} from "./builtin-commands.js";

// ── Usage tracker ──
export {
  UsageTracker,
  type UsageTrackerOptions,
  HALF_LIFE_HOURS,
  MAX_SCORE,
  GC_THRESHOLD,
  // 纯函数导出 —— 测试 + provider 层可直接用
  decayAndIncrement,
  currentScoreOf,
} from "./usage-tracker.js";

// ── Step 3: trigger matcher / sort / fuzzy index ──
export {
  findTriggerToken,
  type FindTriggerTokenOptions,
  type TriggerTokenMatch,
} from "./trigger-matcher.js";
export {
  createCandidateComparator,
  sortCandidates,
  type SortableCandidate,
} from "./sort.js";
export {
  getCommandFuse,
  type CommandIndexItem,
  type CommandFuseResult,
} from "./fuzzy-index.js";

// ── Step 3: events ──
export {
  noopEventSink,
  type ProviderErrorEvent,
  type QueryAbortedEvent,
  type QueryCompletedEvent,
  type QueryStartedEvent,
  type SessionEndedEvent,
  type SessionStartedEvent,
  type SuggestionAcceptedEvent,
  type TriggerClearedEvent,
  type TriggerDetectedEvent,
  type TypeaheadEvent,
  type TypeaheadEventSink,
  type TypeaheadEventType,
} from "./events.js";

// ── Step 3: broker ──
export {
  DefaultTypeaheadBroker,
  type TypeaheadBrokerOptions,
} from "./broker.js";

// ── Step 3: command provider ──
export {
  CommandProvider,
  type CommandProviderOptions,
} from "./providers/command-provider.js";
