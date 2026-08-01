import {
  type AuthorityCommitLog,
  type DurableProjectionIndex,
  type DurableProjectionMutation,
} from "../authority/index.js";
import { parseConversationId } from "../conversation/index.js";
import { defineDurableRuntimeContract } from "../contracts/durable-contract.js";
import type {
  JsonValue,
  SessionInternalRecord,
} from "../contracts/index.js";
import { protocolDigest } from "../protocol/index.js";

const ACTIVITY_PAGE_SIZE = 128;
const CONTRIBUTION_KEY_PREFIX = "contribution:";
const SESSION_ACTIVITY_STREAM_PREFIX = "session-activity:";

export interface IncrementalWorksceneActivityProjectionOptions {
  readonly log: AuthorityCommitLog;
}

/**
 * Owner-written, incremental workscene activity read model.
 *
 * The authority log contains the only activity facts. The durable projection
 * stores one monotonic contribution per conversation plus a derived scene
 * maximum; deleting the projection never loses facts because it can be rebuilt
 * from the same log.
 */
export class IncrementalWorksceneActivityProjection {
  readonly #index: DurableProjectionIndex;
  readonly #latest = new Map<string, string>();
  readonly #refreshes = new Map<string, Promise<void>>();

  constructor(options: IncrementalWorksceneActivityProjectionOptions) {
    this.#index = options.log.durableProjection<SessionInternalRecord>({
      projectionId: "workscene-session-activity-v2",
      reducerVersion: 1,
      reduce: reduceIncrementalActivity,
    });
  }

  async get(sceneId: string): Promise<string | undefined> {
    const normalizedSceneId = requireId(sceneId);
    const value = await this.#index.get(sceneAggregateKey(normalizedSceneId));
    if (value === undefined) {
      this.#latest.delete(normalizedSceneId);
      return undefined;
    }
    const aggregate = parseAggregate(value);
    if (aggregate.sceneId !== normalizedSceneId) {
      throw new Error("Workscene activity projection scene binding is invalid");
    }
    this.#latest.set(normalizedSceneId, aggregate.lastActiveAt);
    return aggregate.lastActiveAt;
  }

  /**
   * Returns the last projection value loaded in this process and starts an
   * asynchronous refresh. Product reads never wait for projection catch-up.
   */
  peek(sceneId: string): string | undefined {
    const normalizedSceneId = requireId(sceneId);
    if (!this.#refreshes.has(normalizedSceneId)) {
      const refresh = this.get(normalizedSceneId)
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          if (this.#refreshes.get(normalizedSceneId) === refresh) {
            this.#refreshes.delete(normalizedSceneId);
          }
        });
      this.#refreshes.set(normalizedSceneId, refresh);
    }
    return this.#latest.get(normalizedSceneId);
  }

  async contributions(sceneId: string): Promise<
    readonly {
      conversationId: string;
      sceneId: string;
      sessionRevision: number;
      at: string;
      deleted: boolean;
    }[]
  > {
    const prefix = contributionScenePrefix(requireId(sceneId));
    const result: ReturnType<typeof parseContribution>[] = [];
    let continuation: string | undefined;
    do {
      const page = await this.#index.scan(
        { gte: prefix, lt: `${prefix}\uffff` },
        ACTIVITY_PAGE_SIZE,
        continuation,
      );
      for (const entry of page.entries) {
        result.push(parseContribution(entry.value));
      }
      continuation = page.continuation;
    } while (continuation);
    return result.sort((left, right) =>
      left.conversationId.localeCompare(right.conversationId, "en-US"),
    );
  }

  async rebuild(): Promise<void> {
    const rebuildable = this.#index as DurableProjectionIndex & {
      rebuild?: () => Promise<void>;
    };
    await rebuildable.rebuild?.();
  }

}

export const WORKSCENE_ACTIVITY_DURABLE_CONTRACT = defineDurableRuntimeContract({
  recordFamily: "workscene-activity-projection",
  producer: "IncrementalWorksceneActivityProjection",
  recoveryOwner: "anchor-workscene-owner",
  resourceIdentity: "workscene-session-activity-v2",
  recoveryClass: "derived-rebuild",
  cases: [
    ...["put", "tombstone"].map((key) => ({ kind: "variant" as const, key, reasonCode: `WORKSCENE_ACTIVITY_${key.toUpperCase()}` })),
    ...["stale-contribution", "wrong-scene", "wrong-conversation"].map((key) => ({ kind: "rejection" as const, key, reasonCode: `WORKSCENE_ACTIVITY_${key.replaceAll("-", "_").toUpperCase()}` })),
    ...["invalid-contribution", "invalid-aggregate", "checkpoint-mismatch"].map((key) => ({ kind: "corruption" as const, key, reasonCode: `WORKSCENE_ACTIVITY_${key.replaceAll("-", "_").toUpperCase()}` })),
  ],
} as const);

async function reduceIncrementalActivity(
  envelope: {
    readonly entries: ReadonlyArray<{
      readonly stream: string;
      readonly body: SessionInternalRecord;
    }>;
  },
  current: {
    get(key: string): Promise<JsonValue | undefined>;
    scan(
      range: { gte?: string; gt?: string; lt?: string },
      limit: number,
      continuation?: string,
    ): Promise<{
      entries: readonly { key: string; value: JsonValue }[];
      continuation?: string;
    }>;
  },
): Promise<readonly DurableProjectionMutation[]> {
  const mutations = new Map<string, DurableProjectionMutation>();
  const contributionsByScene = new Map<
    string,
    Map<string, ReturnType<typeof parseContribution>>
  >();
  const loadScene = async (
    sceneId: string,
  ): Promise<Map<string, ReturnType<typeof parseContribution>>> => {
    const loaded = contributionsByScene.get(sceneId);
    if (loaded) return loaded;
    const contributions = new Map<
      string,
      ReturnType<typeof parseContribution>
    >();
    let continuation: string | undefined;
    const prefix = contributionScenePrefix(sceneId);
    do {
      const page = await current.scan(
        { gte: prefix, lt: `${prefix}\uffff` },
        ACTIVITY_PAGE_SIZE,
        continuation,
      );
      for (const candidate of page.entries) {
        const parsed = parseContribution(candidate.value);
        contributions.set(parsed.conversationId, parsed);
      }
      continuation = page.continuation;
    } while (continuation);
    contributionsByScene.set(sceneId, contributions);
    return contributions;
  };

  for (const entry of envelope.entries) {
    if (!entry.stream.startsWith(SESSION_ACTIVITY_STREAM_PREFIX)) continue;
    if (entry.body.kind !== "session-activity") {
      throw new Error("Session activity stream contains another record kind");
    }
    const activity = validateActivityRecord(entry.body, entry.stream);
    const contributions = await loadScene(activity.sceneId);
    const key = contributionKey(activity.sceneId, activity.conversationId);
    const existing = contributions.get(activity.conversationId);
    if (
      existing &&
      existing.sessionRevision >= activity.sessionRevision
    ) {
      continue;
    }
    const nextContribution: JsonValue = {
      conversationId: activity.conversationId,
      sceneId: activity.sceneId,
      sessionRevision: activity.sessionRevision,
      at: activity.lastActiveAt,
      deleted: activity.operation === "delete",
    };
    const parsed = parseContribution(nextContribution);
    contributions.set(activity.conversationId, parsed);
    mutations.set(key, { kind: "put", key, value: nextContribution });
  }

  for (const [sceneId, contributions] of contributionsByScene) {
    let latest: string | undefined;
    for (const contribution of contributions.values()) {
      if (
        !contribution.deleted &&
        (!latest || Date.parse(contribution.at) > Date.parse(latest))
      ) {
        latest = contribution.at;
      }
    }
    const aggregateKey = sceneAggregateKey(sceneId);
    mutations.set(
      aggregateKey,
      latest
        ? {
            kind: "put",
            key: aggregateKey,
            value: { sceneId, lastActiveAt: latest },
          }
        : { kind: "tombstone", key: aggregateKey },
    );
  }
  return [...mutations.values()];
}

function contributionScenePrefix(sceneId: string): string {
  return `${CONTRIBUTION_KEY_PREFIX}${protocolDigest(
    "WorksceneActivitySceneKey",
    1,
    { sceneId },
  )}:`;
}

function contributionKey(sceneId: string, conversationId: string): string {
  return `${contributionScenePrefix(sceneId)}${protocolDigest(
    "WorksceneActivityConversationKey",
    1,
    { conversationId },
  )}`;
}

function sceneAggregateKey(sceneId: string): string {
  return `scene:${protocolDigest("WorksceneActivitySceneKey", 1, {
    sceneId,
  })}`;
}

function validateActivityRecord(
  value: Extract<SessionInternalRecord, { kind: "session-activity" }>,
  stream: string,
): Extract<SessionInternalRecord, { kind: "session-activity" }> {
  const conversationId = requireId(value.conversationId);
  const sceneId = requireId(value.sceneId);
  if (stream !== `${SESSION_ACTIVITY_STREAM_PREFIX}${conversationId}`) {
    throw new Error("Session activity stream does not bind its conversation");
  }
  const scope = parseConversationId(conversationId).scope;
  if (scope.kind !== "workscene" || scope.sceneId !== sceneId) {
    throw new Error("Session activity scene does not bind its conversation");
  }
  if (value.operation !== "upsert" && value.operation !== "delete") {
    throw new Error("Session activity operation is invalid");
  }
  if (!Number.isSafeInteger(value.sessionRevision) || value.sessionRevision < 1) {
    throw new Error("Session activity revision is invalid");
  }
  return {
    kind: "session-activity",
    operation: value.operation,
    conversationId,
    sceneId,
    sessionRevision: value.sessionRevision,
    lastActiveAt: requireTime(value.lastActiveAt),
  };
}

function parseContribution(value: JsonValue): {
  conversationId: string;
  sceneId: string;
  sessionRevision: number;
  at: string;
  deleted: boolean;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Session activity contribution is invalid");
  }
  const keys = Object.keys(value).sort().join(",");
  if (
    keys !== "at,conversationId,deleted,sceneId,sessionRevision" ||
    typeof value.deleted !== "boolean" ||
    !Number.isSafeInteger(value.sessionRevision) ||
    (value.sessionRevision as number) < 1
  ) {
    throw new Error("Session activity contribution is invalid");
  }
  return {
    conversationId: requireId(value.conversationId as string),
    sceneId: requireId(value.sceneId as string),
    sessionRevision: value.sessionRevision as number,
    at: requireTime(value.at as string),
    deleted: value.deleted,
  };
}

function parseAggregate(value: JsonValue): {
  sceneId: string;
  lastActiveAt: string;
} {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "lastActiveAt,sceneId"
  ) {
    throw new Error("Workscene activity aggregate is invalid");
  }
  return {
    sceneId: requireId(value.sceneId as string),
    lastActiveAt: requireTime(value.lastActiveAt as string),
  };
}

function requireId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("Workscene activity identity is invalid");
  }
  return value;
}

function requireTime(value: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new TypeError("Workscene activity time is invalid");
  }
  return value;
}
