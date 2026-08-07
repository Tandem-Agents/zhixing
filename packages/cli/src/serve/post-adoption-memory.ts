import {
  MemoryFlusher,
  createMemoryFlushHook,
  type MemoryLogicalEntry,
  type Message,
} from "@zhixing/core";
import type {
  GlobalStatePort,
  JsonValue,
} from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import type { ConversationSegmentMemoryFlush } from "@zhixing/owner-kernel";
import type { GovernedTextCall } from "./governed-control-llm.js";

export interface PostAdoptionMemoryPort {
  flush(candidates: readonly ConversationSegmentMemoryFlush[]): Promise<void>;
}

export interface PostAdoptionMemoryOptions {
  readonly globalState: GlobalStatePort;
  readonly anchorEpoch: number;
  readonly callText: GovernedTextCall;
  readonly clock?: () => Date;
}

/**
 * Replays adopted segment boundaries through the existing memory extraction
 * pipeline. Durable memory request ids are derived from conversation facts, so
 * a transfer retry or later forward transfer cannot create a second revision.
 */
export function createPostAdoptionMemoryPort(
  options: PostAdoptionMemoryOptions,
): PostAdoptionMemoryPort {
  if (!Number.isSafeInteger(options.anchorEpoch) || options.anchorEpoch <= 0) {
    throw new TypeError("Post-adoption memory requires a positive anchor epoch");
  }
  const completed = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();

  const readCurrent = async (
    category: "profile" | "person",
    id: string,
    operationId: string,
  ): Promise<MemoryLogicalEntry | undefined> => {
    const result = await options.globalState.read(
      category === "profile"
        ? {
            kind: "memory-list",
            scope: { kind: "personal" },
            domain: "memory",
            category: "profile",
          }
        : {
            kind: "memory-list",
            scope: { kind: "personal" },
            domain: "people",
          },
      context(`${operationId}:read:${category}:${id}`, options),
    );
    if (result.kind !== "memory-list") {
      throw new TypeError("Memory authority returned another result type");
    }
    const matches = result.entries.filter((entry) => entry.id === id);
    if (matches.length > 1) {
      throw new TypeError(`Memory authority returned duplicate ${category} entries`);
    }
    return matches[0];
  };

  const hook = createMemoryFlushHook({
    minMessages: 1,
    requireAllSaved: true,
    operationIdFor: (ctx, summary) => segmentOperationId({
      conversationId: ctx.conversationId,
      segmentId: ctx.segmentId,
      messages: ctx.messages,
      summary,
    }),
    flusher: new MemoryFlusher({
      callLLM: (messages, callOptions) =>
        options.callText(
          [
            "The following canonical JSON array contains the conversation messages for memory extraction.",
            "Preserve role and content semantics exactly and follow the extraction instruction in the final message.",
            canonicalize(messages),
          ].join("\n\n"),
          "light",
          { abortSignal: callOptions?.abortSignal },
        ),
      write: async (extraction, operationId) => {
        const current = extraction.category === "journal"
          ? undefined
          : await readCurrent(extraction.category, extraction.id, operationId);
        const common = {
          scope: { kind: "personal" as const },
          content: extraction.content,
        };
        await options.globalState.mutate(
          {
            kind: "memory-append",
            payload: extraction.category === "journal"
              ? {
                  domain: "journal",
                  ...common,
                  date: extraction.id,
                }
              : extraction.category === "person"
                ? {
                    domain: "people",
                    ...common,
                    id: extraction.id,
                    meta: {
                      name: String(extraction.meta.name ?? extraction.id),
                      relation: String(extraction.meta.relation ?? "unknown"),
                      ...(typeof extraction.meta.birthday === "string"
                        ? { birthday: extraction.meta.birthday }
                        : {}),
                      ...(Array.isArray(extraction.meta.tags)
                        ? { tags: extraction.meta.tags.map(String) }
                        : {}),
                    },
                    ...(current ? { expectedDigest: current.digest } : {}),
                  }
                : {
                    domain: "memory",
                    ...common,
                    category: "profile",
                    id: "profile",
                    meta: toJsonObject(extraction.meta),
                    ...(current ? { expectedDigest: current.digest } : {}),
                  },
          },
          context(operationId, options),
        );
      },
    }),
  });

  return {
    async flush(candidates) {
      for (const candidate of candidates) {
        const operationId = segmentOperationId(candidate);
        if (completed.has(operationId)) continue;
        const existing = inFlight.get(operationId);
        if (existing) {
          await existing;
          continue;
        }
        const run = (async () => {
          await hook.afterSummarize?.(
            {
              conversationId: candidate.conversationId,
              segmentId: candidate.segmentId,
              tokensBefore: candidate.tokensBefore,
              messages: candidate.messages,
            },
            candidate.summary,
          );
          completed.add(operationId);
        })();
        inFlight.set(operationId, run);
        try {
          await run;
        } finally {
          inFlight.delete(operationId);
        }
      }
    },
  };
}

function segmentOperationId(input: {
  readonly conversationId?: string;
  readonly segmentId: string;
  readonly messages: readonly Message[];
  readonly summary: { readonly facts: string; readonly state: string; readonly active: string };
}): string {
  if (!input.conversationId) {
    throw new TypeError("Post-adoption memory requires a conversation identity");
  }
  return `post-adoption-memory:${protocolDigest("PostAdoptionSegmentMemory", 1, {
    conversationId: input.conversationId,
    segmentId: input.segmentId,
    sourceDigest: protocolDigest("PostAdoptionSegmentSource", 1, input.messages),
    summaryDigest: protocolDigest("PostAdoptionSegmentSummary", 1, input.summary),
  })}`;
}

function context(
  requestId: string,
  options: PostAdoptionMemoryOptions,
) {
  const now = options.clock?.() ?? new Date();
  return {
    principal: { kind: "host" as const, component: "post-adoption-memory" },
    requestId,
    deadlineAt: new Date(now.getTime() + 120_000).toISOString(),
    authority: { domain: "global" as const, anchorEpoch: options.anchorEpoch },
  };
}

function toJsonObject(input: Record<string, unknown>): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = toJsonValue(value);
    if (normalized !== undefined) output[key] = normalized;
  }
  return output;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const normalized = toJsonValue(item);
      if (normalized !== undefined) items.push(normalized);
    }
    return items;
  }
  if (value && typeof value === "object") {
    return toJsonObject(value as Record<string, unknown>);
  }
  return undefined;
}
