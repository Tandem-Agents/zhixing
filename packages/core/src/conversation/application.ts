import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiFactEvent,
  defineProductApiQuery,
  type ProductApiContribution,
} from "../product-api/catalog.js";
import type { RunRecordWithRef } from "../transcript/shard/reader.js";

/** Persisted Conversation identity projected by the domain storage port. */
export interface ConversationDirectoryRecord {
  readonly conversationId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastActiveAt: string;
}

export interface ConversationHistoryCursor {
  readonly shardId: string;
  readonly runIndex: number;
}

export interface ConversationHistoryPage {
  readonly runs: readonly RunRecordWithRef[];
  readonly hasMore: boolean;
}

export interface ConversationRuntimeProjection {
  readonly lastActiveAt?: string;
  readonly active: boolean;
  readonly busy: boolean;
  readonly observerCount: number;
  readonly pendingCount: number;
}

export interface ConversationAdvancementRubricDraftProjection {
  readonly draftId: string;
  readonly originalTurnId: string;
  readonly source: "matched" | "generated";
  readonly candidateRubricIds: readonly string[];
  readonly candidateRubrics?: readonly Readonly<{
    id: string;
    title: string;
    description: string;
    source: "own" | "linked";
    matchScore?: number;
  }>[];
  readonly title: string;
  readonly description: string;
  readonly content: Readonly<{
    passCriteria: readonly string[];
    evidenceRequirements?: readonly Readonly<{
      id: string;
      kind:
        | "file-diff"
        | "test-result"
        | "build-result"
        | "log"
        | "artifact"
        | "conversation-fact"
        | "none";
      description: string;
      required?: boolean;
      locator?: Readonly<{ paths?: readonly string[] }>;
    }>[];
    failureHandling: readonly Readonly<{
      id: string;
      scenario: string;
      reply: string;
    }>[];
  }>;
  readonly createdAt: string;
}

export interface ConversationAdvancementProjection {
  readonly advancementSessionId: string;
  readonly status: "awaiting-rubric-confirmation" | "active";
  readonly rubricTitle?: string;
  readonly rubricDraftId?: string;
  readonly pendingRubricDraft?: ConversationAdvancementRubricDraftProjection;
  readonly outstandingProxyMessageId?: string;
  readonly lastReview?: Readonly<{
    id: string;
    runIndex: number;
    round: number;
    decision: "passed" | "failed" | "exit";
    reviewedAt: string;
  }>;
}

export interface ConversationDirectoryEntry extends ConversationDirectoryRecord {
  readonly active: boolean;
  readonly busy: boolean;
  readonly observerCount: number;
  readonly pendingCount: number;
  readonly advancement?: ConversationAdvancementProjection;
}

export type ConversationAvailability =
  | Readonly<{ mode: "anchor" }>
  | Readonly<{
      mode: "local-only";
      unavailableCapabilities: readonly string[];
    }>;

export interface ConversationDirectoryView {
  readonly conversations: readonly ConversationDirectoryEntry[];
  readonly availability?: ConversationAvailability;
}

/** Conversation-owned demand-side storage contract. */
export interface ConversationDirectoryStorage {
  list(): Promise<readonly ConversationDirectoryRecord[]>;
  create(): Promise<ConversationDirectoryRecord>;
  rename(
    conversationId: string,
    name: string,
  ): Promise<ConversationDirectoryRecord | null>;
  readHistory(
    conversationId: string,
    input: Readonly<{
      limit: number;
      before?: ConversationHistoryCursor;
    }>,
  ): Promise<ConversationHistoryPage>;
}

/** Read-only external facts used to decorate the durable directory. */
export interface ConversationRuntimeProjectionReader {
  read(conversationId: string): ConversationRuntimeProjection | undefined;
}

/** Advancement remains a separate domain; Conversation only consumes its projection. */
export interface ConversationAdvancementProjectionReader {
  read(
    conversationId: string,
  ): Promise<ConversationAdvancementProjection | undefined>;
}

export type ConversationDirectoryQuery =
  | Readonly<{ kind: "list" }>
  | Readonly<{
      kind: "history";
      conversationId: string;
      limit?: number;
      before?: ConversationHistoryCursor;
    }>;

export type ConversationDirectoryCommand =
  | Readonly<{ kind: "create" }>
  | Readonly<{
      kind: "rename";
      conversationId: string;
      name: string;
    }>;

export interface ConversationCreatedResult {
  readonly conversationId: string;
  readonly name: string;
}

export interface ConversationRenamedFact {
  readonly kind: "conversation-renamed";
  readonly conversationId: string;
  readonly name: string;
}

export interface ConversationRenamedResult {
  readonly conversationId: string;
  readonly name: string;
  readonly fact: ConversationRenamedFact;
}

export class ConversationApplicationError extends Error {
  constructor(
    readonly code: "invalid-input" | "not-found",
    message: string,
  ) {
    super(message);
    this.name = "ConversationApplicationError";
  }
}

export interface ConversationDirectoryApplication {
  queryList(): Promise<ConversationDirectoryView>;
  queryHistory(
    query: Extract<ConversationDirectoryQuery, { readonly kind: "history" }>,
  ): Promise<ConversationHistoryPage>;
  create(): Promise<ConversationCreatedResult>;
  rename(
    command: Extract<ConversationDirectoryCommand, { readonly kind: "rename" }>,
  ): Promise<ConversationRenamedResult>;
}

const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 200;

function orderDurableConversationRecords(
  records: readonly ConversationDirectoryRecord[],
): ConversationDirectoryRecord[] {
  return [...records].sort(
    (left, right) =>
      new Date(right.lastActiveAt).getTime() -
      new Date(left.lastActiveAt).getTime(),
  );
}

export class ConversationDirectoryApplicationService
  implements ConversationDirectoryApplication
{
  constructor(
    private readonly input: Readonly<{
      storage: ConversationDirectoryStorage;
      runtime?: ConversationRuntimeProjectionReader;
      advancement?: ConversationAdvancementProjectionReader;
      availability?: ConversationAvailability;
    }>,
  ) {}

  async queryList(): Promise<ConversationDirectoryView> {
    const records = orderDurableConversationRecords(
      await this.input.storage.list(),
    );
    const conversations = await Promise.all(
      records.map(async (record): Promise<ConversationDirectoryEntry> => {
        const runtime = this.input.runtime?.read(record.conversationId);
        const advancement = await this.input.advancement?.read(
          record.conversationId,
        );
        return Object.freeze({
          ...record,
          lastActiveAt: runtime?.lastActiveAt ?? record.lastActiveAt,
          active: runtime?.active ?? false,
          busy: runtime?.busy ?? false,
          observerCount: runtime?.observerCount ?? 0,
          pendingCount: runtime?.pendingCount ?? 0,
          ...(advancement ? { advancement } : {}),
        });
      }),
    );
    return Object.freeze({
      conversations: Object.freeze(conversations),
      ...(this.input.availability
        ? { availability: this.input.availability }
        : {}),
    });
  }

  async queryHistory(
    query: Extract<ConversationDirectoryQuery, { readonly kind: "history" }>,
  ): Promise<ConversationHistoryPage> {
    if (typeof query.conversationId !== "string") {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation history requires a conversation id",
      );
    }
    if (
      query.limit !== undefined &&
      (!Number.isInteger(query.limit) || query.limit < 1)
    ) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation history limit must be a positive integer",
      );
    }
    if (
      query.before !== undefined &&
      (typeof query.before.shardId !== "string" ||
        !Number.isInteger(query.before.runIndex))
    ) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation history cursor is invalid",
      );
    }
    return this.input.storage.readHistory(query.conversationId, {
      limit: Math.min(query.limit ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT),
      ...(query.before ? { before: query.before } : {}),
    });
  }

  async create(): Promise<ConversationCreatedResult> {
    const created = await this.input.storage.create();
    return Object.freeze({
      conversationId: created.conversationId,
      name: created.name,
    });
  }

  async rename(
    command: Extract<ConversationDirectoryCommand, { readonly kind: "rename" }>,
  ): Promise<ConversationRenamedResult> {
    if (typeof command.conversationId !== "string") {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation rename requires a conversation id",
      );
    }
    if (typeof command.name !== "string" || command.name.trim().length === 0) {
      throw new ConversationApplicationError(
        "invalid-input",
        "Conversation name must be non-empty",
      );
    }
    const renamed = await this.input.storage.rename(
      command.conversationId,
      command.name.trim(),
    );
    if (!renamed) {
      throw new ConversationApplicationError(
        "not-found",
        `Conversation not found: ${command.conversationId}`,
      );
    }
    const fact = Object.freeze({
      kind: "conversation-renamed" as const,
      conversationId: command.conversationId,
      name: renamed.name,
    });
    return Object.freeze({
      conversationId: command.conversationId,
      name: renamed.name,
      fact,
    });
  }
}

export const CONVERSATION_RENAMED_FACT_EVENT = defineProductApiFactEvent<
  "conversation-renamed",
  ConversationRenamedFact
>("conversation-renamed");

export const CONVERSATION_LIST_QUERY = defineProductApiQuery<
  "conversation-directory.query.list",
  Extract<ConversationDirectoryQuery, { readonly kind: "list" }>,
  ConversationDirectoryView
>("conversation-directory.query.list");

export const CONVERSATION_HISTORY_QUERY = defineProductApiQuery<
  "conversation-directory.query.history",
  Extract<ConversationDirectoryQuery, { readonly kind: "history" }>,
  ConversationHistoryPage
>("conversation-directory.query.history");

export const CONVERSATION_CREATE_COMMAND = defineProductApiCommand<
  "conversation-directory.command.create",
  Extract<ConversationDirectoryCommand, { readonly kind: "create" }>,
  ConversationCreatedResult,
  never
>("conversation-directory.command.create", []);

export const CONVERSATION_RENAME_COMMAND = defineProductApiCommand<
  "conversation-directory.command.rename",
  Extract<ConversationDirectoryCommand, { readonly kind: "rename" }>,
  ConversationRenamedResult,
  ConversationRenamedFact
>("conversation-directory.command.rename", [CONVERSATION_RENAMED_FACT_EVENT]);

export const CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET =
  defineProductApiExactSet({
    operations: [
      CONVERSATION_LIST_QUERY,
      CONVERSATION_HISTORY_QUERY,
      CONVERSATION_CREATE_COMMAND,
      CONVERSATION_RENAME_COMMAND,
    ],
    factEvents: [CONVERSATION_RENAMED_FACT_EVENT],
  });

export function createConversationDirectoryProductApiContribution(
  application: ConversationDirectoryApplication,
): ProductApiContribution {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(CONVERSATION_LIST_QUERY, async () => ({
        result: await application.queryList(),
        facts: [],
      })),
      bindProductApiOperation(CONVERSATION_HISTORY_QUERY, async (query) => ({
        result: await application.queryHistory(query),
        facts: [],
      })),
      bindProductApiOperation(CONVERSATION_CREATE_COMMAND, async () => ({
        result: await application.create(),
        facts: [],
      })),
      bindProductApiOperation(CONVERSATION_RENAME_COMMAND, async (command) => {
        const result = await application.rename(command);
        return { result, facts: [result.fact] };
      }),
    ],
    factEvents: [CONVERSATION_RENAMED_FACT_EVENT],
  });
}

/** Cross-owner list merge remains Conversation-owned; topology supplies inputs only. */
export function mergeConversationDirectoryViews(
  local: ConversationDirectoryView,
  remoteEntries: readonly ConversationDirectoryEntry[],
): ConversationDirectoryView {
  const conversations = [...local.conversations, ...remoteEntries];
  conversations.sort(
    (left, right) =>
      right.lastActiveAt.localeCompare(left.lastActiveAt, "en-US") ||
      left.conversationId.localeCompare(right.conversationId, "en-US"),
  );
  return Object.freeze({
    conversations: Object.freeze(conversations),
    ...(local.availability ? { availability: local.availability } : {}),
  });
}
