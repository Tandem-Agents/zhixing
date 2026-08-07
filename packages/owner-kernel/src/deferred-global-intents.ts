import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type {
  ArtifactRef,
  AuthorityCallContext,
  CommitEnvelope,
  DeferredGlobalIntent,
  DeferredGlobalIntentPort,
  IntentStreamRecord,
  JsonValue,
} from "@zhixing/core/contracts";
import type {
  AuthorityCommitLog,
  DurableProjectionMutation,
  DurableProjectionReadContext,
  ProjectionTransactionContext,
} from "@zhixing/core/authority";
import {
  assertPrincipalAllowsAuthorityMethod,
  deferredGlobalIntentDigest,
  deferredIntentMutationDigest,
  deferredIntentStream,
  isDeferredIntentStream,
  reduceDeferredGlobalIntent,
  validateDeferredGlobalIntent,
  validateDeferredIntentMutation,
  validateIntentStreamRecord,
} from "@zhixing/core/protocol";

export const DEFERRED_INTENT_PROJECTION_ID = "deferred-global-intents-v1";
const INTENT_PREFIX = "intent:";
const LOCATOR_PREFIX = "locator:";
const ORDER_PREFIX = "order:";
const REQUEST_PREFIX = "request:";

interface StoredIntent {
  readonly intent: DeferredGlobalIntent;
  readonly firstLsn: number;
}

export interface DeferredGlobalIntentRepositoryOptions {
  readonly log: AuthorityCommitLog;
  readonly localDomainId: string;
  readonly mode: "local" | "anchor";
  readonly acceptsConversationId: (conversationId: string) => boolean;
  readonly conversationExists: (conversationId: string) => boolean | Promise<boolean>;
  readonly isCurrentOwner?: (conversationId: string) => boolean | Promise<boolean>;
  readonly clock?: () => string;
}

/** Conversation-owned deferred intent repository and its single authority port. */
export class DeferredGlobalIntentRepository implements DeferredGlobalIntentPort {
  readonly #options: DeferredGlobalIntentRepositoryOptions;
  readonly #projection;
  readonly #clock: () => string;

  constructor(options: DeferredGlobalIntentRepositoryOptions) {
    if (!options.localDomainId.startsWith("local:")) {
      throw new TypeError("Deferred intent repository requires a local domain id");
    }
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#projection = options.log.durableProjection<IntentStreamRecord>({
      projectionId: DEFERRED_INTENT_PROJECTION_ID,
      reducerVersion: 1,
      reduce: reduceIntentProjection,
    });
  }

  async recover(): Promise<void> {
    await this.#options.log.transactDurableProjection(
      DEFERRED_INTENT_PROJECTION_ID,
      () => ({ kind: "return", value: undefined }),
    );
  }

  async rebuild(): Promise<void> {
    await this.#projection.rebuild();
  }

  async record(
    conversationId: string,
    mutation: DeferredGlobalIntent["mutation"],
    timeSensitive: boolean,
    context: AuthorityCallContext,
  ): Promise<{ intentId: string }> {
    this.#admit(context, "intent.record");
    if (this.#options.mode !== "local") {
      throw new TypeError("Anchor owners cannot record deferred global intents");
    }
    await this.#assertOwnedConversation(conversationId);
    validateDeferredIntentMutation(mutation, timeSensitive);
    const mutationDigest = deferredIntentMutationDigest(mutation, timeSensitive);
    const intentId = intentIdFor({
      localDomainId: this.#options.localDomainId,
      conversationId,
      requestId: context.requestId,
    });
    const candidateReferences = mutationReferences(mutation);
    return this.#options.log.transactDurableProjection<IntentStreamRecord, { intentId: string }>(
      DEFERRED_INTENT_PROJECTION_ID,
      async (projection, transaction) => {
        const existing = readStoredIntent(
          await projection.get(intentKey(intentId)),
        );
        if (existing) {
          if (
            existing.intent.localDomainId !== this.#options.localDomainId ||
            existing.intent.conversationId !== conversationId ||
            deferredIntentMutationDigest(
              existing.intent.mutation,
              existing.intent.timeSensitive,
            ) !== mutationDigest
          ) {
            throw new TypeError("Deferred intent request id was reused with another operation");
          }
          return { kind: "return", value: { intentId } };
        }
        const intent: DeferredGlobalIntent = {
          intentId,
          localDomainId: this.#options.localDomainId,
          conversationId,
          mutation: structuredClone(mutation),
          recordedAt: transaction.at,
          timeSensitive,
          status: "pending",
        };
        return {
          kind: "append",
          entries: [{
            stream: deferredIntentStream(conversationId),
            body: { t: "intent", intent },
          }],
          value: { intentId },
        };
      },
      candidateReferences.length > 0 ? { candidateReferences } : undefined,
    ).then((result) => result.value);
  }

  async list(
    conversationId: string,
    context: AuthorityCallContext,
  ): Promise<DeferredGlobalIntent[]> {
    this.#admit(context, "intent.list");
    await this.#assertOwnedConversation(conversationId);
    await this.recover();
    const prefix = orderPrefix(conversationId);
    const result: DeferredGlobalIntent[] = [];
    let continuation: string | undefined;
    do {
      const page = await this.#projection.scan(
        { gte: prefix, lt: `${prefix}\uffff` },
        128,
        continuation,
      );
      for (const entry of page.entries) {
        if (typeof entry.value !== "string") {
          throw new TypeError("Deferred intent order projection is invalid");
        }
        const stored = readStoredIntent(
          await this.#projection.get(intentKey(entry.value)),
          true,
        );
        result.push(structuredClone(stored.intent));
      }
      continuation = page.continuation;
    } while (continuation !== undefined);
    return result;
  }

  async decide(
    intentId: string,
    decision: "confirmed" | "discarded",
    context: AuthorityCallContext,
  ): Promise<void> {
    this.#admit(context, "intent.decide");
    const located = await this.locate(intentId);
    await this.#assertOwnedConversation(located.intent.conversationId);
    if (decision === "confirmed") {
      throw new TypeError("Deferred intent confirmation requires the anchor review service");
    }
    await this.#options.log.transactDurableProjection<IntentStreamRecord, void>(
      DEFERRED_INTENT_PROJECTION_ID,
      async (projection, transaction) => {
        const stored = readStoredIntent(
          await projection.get(intentKey(intentId)),
          true,
        );
        if (stored.intent.status === "discarded") {
          return { kind: "return", value: undefined };
        }
        if (stored.intent.status !== "pending") {
          throw new TypeError("Deferred intent already has the opposite terminal decision");
        }
        return {
          kind: "append",
          entries: [{
            stream: deferredIntentStream(stored.intent.conversationId),
            body: {
              t: "intent",
              intent: {
                ...structuredClone(stored.intent),
                status: "discarded",
                reviewedAt: transaction.at,
              },
            },
          }],
          value: undefined,
        };
      },
    );
  }

  async locate(intentId: string): Promise<StoredIntent> {
    await this.recover();
    return readStoredIntent(
      await this.#projection.get(intentKey(intentId)),
      true,
    );
  }

  async locateConversation(intentId: string): Promise<string> {
    await this.recover();
    const value = await this.#projection.get(`${LOCATOR_PREFIX}${intentId}`);
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== "conversationId" ||
      typeof value.conversationId !== "string"
    ) {
      throw new TypeError("Deferred intent locator does not exist or is invalid");
    }
    return value.conversationId;
  }

  async readAt(
    projection: DurableProjectionReadContext,
    intentId: string,
  ): Promise<StoredIntent> {
    return readStoredIntent(await projection.get(intentKey(intentId)), true);
  }

  get projectionId(): string {
    return DEFERRED_INTENT_PROJECTION_ID;
  }

  #admit(
    context: AuthorityCallContext,
    method: "intent.record" | "intent.list" | "intent.decide",
  ): void {
    assertPrincipalAllowsAuthorityMethod(context.principal.kind, method);
    if (!context.requestId) throw new TypeError("Deferred intent request id is required");
    const deadline = Date.parse(context.deadlineAt);
    const now = Date.parse(this.#clock());
    if (!Number.isFinite(deadline) || deadline < now) {
      throw new TypeError("Deferred intent request is expired");
    }
  }

  async #assertOwnedConversation(conversationId: string): Promise<void> {
    if (!this.#options.acceptsConversationId(conversationId)) {
      throw new TypeError("Deferred intent conversation belongs to another domain");
    }
    if (!(await this.#options.conversationExists(conversationId))) {
      throw new TypeError("Deferred intent conversation does not exist");
    }
    if (
      this.#options.isCurrentOwner &&
      !(await this.#options.isCurrentOwner(conversationId))
    ) {
      throw new TypeError("Deferred intent conversation is not owned by this owner");
    }
  }
}

async function reduceIntentProjection(
  envelope: CommitEnvelope<IntentStreamRecord>,
  current: DurableProjectionReadContext,
): Promise<readonly DurableProjectionMutation[]> {
  const mutations: DurableProjectionMutation[] = [];
  const overlay = new Map<string, JsonValue | undefined>();
  const get = async (key: string): Promise<JsonValue | undefined> =>
    overlay.has(key) ? overlay.get(key) : current.get(key);
  const put = (key: string, value: JsonValue): void => {
    overlay.set(key, value);
    mutations.push({ kind: "put", key, value });
  };
  for (const logical of envelope.entries) {
    if (!isDeferredIntentStream(logical.stream)) continue;
    validateIntentStreamRecord(logical.body, logical.stream);
    const previous = readStoredIntent(
      await get(intentKey(logical.body.intent.intentId)),
    );
    const intent = reduceDeferredGlobalIntent(
      previous?.intent,
      logical.body,
      logical.stream,
    );
    const firstLsn = previous?.firstLsn ?? envelope.lsn;
    const stored: JsonValue = {
      firstLsn,
      intent: intent as unknown as JsonValue,
    };
    put(intentKey(intent.intentId), stored);
    put(`${LOCATOR_PREFIX}${intent.intentId}`, {
      conversationId: intent.conversationId,
    });
    put(requestKey(intent.intentId), {
      intentId: intent.intentId,
      intentDigest: deferredGlobalIntentDigest(intent),
    });
    if (!previous) {
      put(orderKey(intent.conversationId, firstLsn, intent.intentId), intent.intentId);
    }
  }
  return mutations;
}

function readStoredIntent(
  value: JsonValue | undefined,
  required: true,
): StoredIntent;
function readStoredIntent(
  value: JsonValue | undefined,
  required?: false,
): StoredIntent | undefined;
function readStoredIntent(
  value: JsonValue | undefined,
  required = false,
): StoredIntent | undefined {
  if (value === undefined) {
    if (required) throw new TypeError("Deferred intent does not exist");
    return undefined;
  }
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.firstLsn) ||
    (value.firstLsn as number) < 1
  ) {
    throw new TypeError("Deferred intent projection entry is invalid");
  }
  const intent = value.intent;
  validateDeferredGlobalIntent(intent);
  return {
    intent: structuredClone(intent),
    firstLsn: value.firstLsn as number,
  };
}

function mutationReferences(
  mutation: DeferredGlobalIntent["mutation"],
): readonly ArtifactRef[] {
  return mutation.kind === "rubric-save-own" || mutation.kind === "rubric-update-own"
    ? [mutation.rubric.content]
    : [];
}

function intentIdFor(input: {
  readonly localDomainId: string;
  readonly conversationId: string;
  readonly requestId: string;
}): string {
  const digest = createHash("sha256")
    .update("zhixing:DeferredGlobalIntentIdentity:v1\0", "utf8")
    .update(JSON.stringify(input), "utf8")
    .digest()
    .subarray(0, 16);
  digest[0] = digest[0]! & 0x7f;
  let value = BigInt(`0x${digest.toString("hex")}`);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `int-${encoded}`;
}

function intentKey(intentId: string): string {
  return `${INTENT_PREFIX}${intentId}`;
}

function requestKey(intentId: string): string {
  return `${REQUEST_PREFIX}${intentId}`;
}

function orderPrefix(conversationId: string): string {
  return `${ORDER_PREFIX}${Buffer.from(conversationId, "utf8").toString("base64url")}:`;
}

function orderKey(conversationId: string, lsn: number, intentId: string): string {
  return `${orderPrefix(conversationId)}${String(lsn).padStart(16, "0")}:${intentId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface DeferredIntentConversationState {
  readonly intents: ReadonlyMap<string, DeferredGlobalIntent>;
}

export function emptyDeferredIntentConversationState(): DeferredIntentConversationState {
  return { intents: new Map() };
}

export function reduceDeferredIntentConversationState(
  state: DeferredIntentConversationState,
  logical: { readonly stream: string; readonly body: unknown },
): DeferredIntentConversationState {
  if (!logical.stream.startsWith("intent:")) return state;
  const body = logical.body;
  validateIntentStreamRecord(body, logical.stream);
  const next = new Map(state.intents);
  next.set(
    body.intent.intentId,
    reduceDeferredGlobalIntent(
      next.get(body.intent.intentId),
      body,
      logical.stream,
    ),
  );
  return { intents: next };
}

export function confirmedIntentRecord(
  intent: DeferredGlobalIntent,
  context: ProjectionTransactionContext,
): IntentStreamRecord {
  if (intent.status !== "pending") {
    throw new TypeError("Only a pending deferred intent can be confirmed");
  }
  return {
    t: "intent",
    intent: {
      ...structuredClone(intent),
      status: "confirmed",
      reviewedAt: context.at,
    },
  };
}
