import {
  MemoryFlusher,
  MemoryMutationConflictError,
  type FlushExtraction,
  type MemoryLogicalEntry,
} from "@zhixing/core";
import type { AuthorityCommitLog } from "@zhixing/core/authority";
import type {
  ConversationTransferManifest,
  GlobalControlMutation,
  GlobalStatePort,
  JsonValue,
  LogicalRecord,
} from "@zhixing/core/contracts";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import {
  assertConversationRunInternalRecord,
  postAdoptionMemoryInputDigest,
  postAdoptionMemoryOperationId,
  type ConversationSegmentMemoryFlush,
  type PostAdoptionMemoryExtraction,
  type PostAdoptionMemoryRecord,
} from "@zhixing/owner-kernel";
import type { GovernedTextCall } from "./governed-control-llm.js";

type MemoryAppendMutation = Extract<GlobalControlMutation, { kind: "memory-append" }>;
type MemoryEffectRecord = Extract<
  PostAdoptionMemoryRecord,
  { kind: "post-adoption-memory-effect" }
>;
type MemoryPlanRecord = Extract<
  PostAdoptionMemoryRecord,
  { kind: "post-adoption-memory-plan" }
>;

export interface PostAdoptionMemoryPort {
  flush(input: {
    readonly manifest: ConversationTransferManifest;
    readonly candidates?: readonly ConversationSegmentMemoryFlush[];
    readonly loadCandidates?: () => Promise<readonly ConversationSegmentMemoryFlush[]>;
  }): Promise<void>;
}

export interface PostAdoptionMemoryOptions {
  readonly globalState: GlobalStatePort;
  readonly authorityLog: AuthorityCommitLog;
  readonly anchorEpoch: number;
  readonly callText: GovernedTextCall;
  readonly clock?: () => Date;
}

interface MemoryOperationProjection {
  attempt?: Extract<PostAdoptionMemoryRecord, { kind: "post-adoption-memory-attempt" }>;
  plan?: MemoryPlanRecord;
  readonly effects: Map<string, MemoryEffectRecord[]>;
  completed?: Extract<PostAdoptionMemoryRecord, { kind: "post-adoption-memory-completed" }>;
}

interface MemoryProjection {
  readonly discoveries: Map<
    string,
    Extract<PostAdoptionMemoryRecord, { kind: "post-adoption-memory-discovery" }>
  >;
  readonly operations: Map<string, MemoryOperationProjection>;
}

/**
 * Replays adopted segments through one durable extraction plan. The conversation
 * run stream owns discovery, effect attempts and completion; GlobalState only
 * applies the already-frozen effects under stable request identities.
 */
export function createPostAdoptionMemoryPort(
  options: PostAdoptionMemoryOptions,
): PostAdoptionMemoryPort {
  if (!Number.isSafeInteger(options.anchorEpoch) || options.anchorEpoch <= 0) {
    throw new TypeError("Post-adoption memory requires a positive anchor epoch");
  }
  const inFlight = new Map<string, Promise<void>>();

  return {
    async flush(input) {
      const conversationId = input.manifest.conversationId;
      const checkpointDigest = protocolDigest(
        "PostAdoptionMemoryCheckpoint",
        1,
        input.manifest.authorityBase.checkpoint,
      );
      const discoveryKey = `${input.manifest.transferId}:${checkpointDigest}`;
      const beforeLoad = await readProjection(options.authorityLog, conversationId);
      let projection = beforeLoad;
      let durableDiscovery = projection.discoveries.get(discoveryKey);
      if (
        durableDiscovery &&
        durableDiscovery.operationIds.every((operationId) =>
          projection.operations.get(operationId)?.completed !== undefined)
      ) {
        return;
      }
      if (!durableDiscovery) {
        const loaded = input.candidates ?? await input.loadCandidates?.();
        if (!loaded) {
          throw new TypeError("Post-adoption memory requires a candidate source");
        }
        const candidates = [...loaded]
          .sort((left, right) =>
            postAdoptionMemoryOperationId(left).localeCompare(
              postAdoptionMemoryOperationId(right),
              "en-US",
            ));
        const operationIds = candidates.map(postAdoptionMemoryOperationId);
        await appendDiscoveryWithAttempts(
          options.authorityLog,
          conversationId,
          {
            kind: "post-adoption-memory-discovery",
            conversationId,
            transferId: input.manifest.transferId,
            checkpointDigest,
            operationIds,
            operationsDigest: protocolDigest(
              "PostAdoptionMemoryOperations",
              1,
              operationIds,
            ),
          },
          candidates,
        );
        projection = await readProjection(options.authorityLog, conversationId);
        durableDiscovery = projection.discoveries.get(discoveryKey);
      }
      if (!durableDiscovery) {
        throw new Error("Post-adoption memory discovery was not durably recorded");
      }

      for (const operationId of durableDiscovery.operationIds) {
        const operation = projection.operations.get(operationId);
        if (operation?.completed) continue;
        const candidate = operation?.attempt?.input;
        if (!candidate) {
          throw new Error(`Post-adoption memory operation has no durable input: ${operationId}`);
        }
        const existing = inFlight.get(operationId);
        if (existing) {
          await existing;
          continue;
        }
        const run = settleOperation(options, candidate, operationId);
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

async function settleOperation(
  options: PostAdoptionMemoryOptions,
  candidate: ConversationSegmentMemoryFlush,
  operationId: string,
): Promise<void> {
  const projection = await readProjection(options.authorityLog, candidate.conversationId);
  const operation = projection.operations.get(operationId);
  if (operation?.completed) return;
  if (
    !operation?.attempt ||
    operation.attempt.inputDigest !== postAdoptionMemoryInputDigest(candidate) ||
    canonicalize(operation.attempt.input) !== canonicalize(candidate)
  ) {
    throw new Error("Post-adoption memory durable input does not match the operation");
  }
  let plan = operation?.plan;
  if (!plan) {
    const extractions = await extractPlan(options, candidate, operationId);
    const proposed: MemoryPlanRecord = {
      kind: "post-adoption-memory-plan",
      operationId,
      attemptOrdinal: 1,
      resultDigest: protocolDigest("PostAdoptionMemoryPlan", 1, extractions),
      extractions,
    };
    await appendIfAbsent(options.authorityLog, candidate.conversationId, proposed);
    plan = (await readProjection(options.authorityLog, candidate.conversationId))
      .operations.get(operationId)?.plan;
    if (!plan) throw new Error("Post-adoption memory plan was not durably recorded");
  }

  for (const [effectIndex, extraction] of plan.extractions.entries()) {
    await settleEffect(
      options,
      candidate.conversationId,
      operationId,
      extraction,
      effectIndex,
    );
  }

  await appendIfAbsent(options.authorityLog, candidate.conversationId, {
    kind: "post-adoption-memory-completed",
    operationId,
    resultDigest: plan.resultDigest,
  });
}

async function extractPlan(
  options: PostAdoptionMemoryOptions,
  candidate: ConversationSegmentMemoryFlush,
  operationId: string,
): Promise<readonly PostAdoptionMemoryExtraction[]> {
  const collected: FlushExtraction[] = [];
  const flusher = new MemoryFlusher({
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
    write: async (extraction) => {
      collected.push(structuredClone(extraction));
    },
  });
  const result = await flusher.flush(candidate.messages, { operationId });
  if (result.errors.length > 0 || result.saved !== result.extracted) {
    throw new Error(`Memory extraction plan did not settle: ${result.errors.join("; ")}`);
  }
  const byCanonical = new Map<string, PostAdoptionMemoryExtraction>();
  for (const extraction of collected) {
    const normalized: PostAdoptionMemoryExtraction = {
      category: extraction.category,
      id: extraction.id,
      meta: toJsonObject(extraction.meta),
      content: extraction.content,
    };
    byCanonical.set(canonicalize(normalized), normalized);
  }
  return [...byCanonical.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([, extraction]) => extraction);
}

async function settleEffect(
  options: PostAdoptionMemoryOptions,
  conversationId: string,
  operationId: string,
  extraction: PostAdoptionMemoryExtraction,
  effectIndex: number,
): Promise<void> {
  const effectId = `post-adoption-effect:${protocolDigest("PostAdoptionMemoryEffect", 1, {
    operationId,
    extraction,
  })}`;
  for (let guard = 0; guard < 32; guard += 1) {
    const projection = await readProjection(options.authorityLog, conversationId);
    const attempts = projection.operations.get(operationId)?.effects.get(effectId) ?? [];
    const latest = attempts.at(-1);
    if (latest?.status === "granted") return;

    let prepared = latest?.status === "prepared" ? latest : undefined;
    if (!prepared) {
      const attemptOrdinal = (latest?.attemptOrdinal ?? 0) + 1;
      const current = extraction.category === "journal"
        ? undefined
        : await readCurrent(options, extraction.category, extraction.id, effectId, attemptOrdinal);
      const mutation = memoryMutation(extraction, current);
      const expectedDigest = mutation.payload.domain === "journal"
        ? null
        : mutation.payload.expectedDigest ?? null;
      const proposed: MemoryEffectRecord = {
        kind: "post-adoption-memory-effect",
        operationId,
        effectId,
        effectIndex,
        attemptOrdinal,
        requestId: `${effectId}:attempt:${attemptOrdinal}`,
        expectedDigest,
        status: "prepared",
        mutation,
      };
      await appendIfAbsent(options.authorityLog, conversationId, proposed);
      prepared = (await readProjection(options.authorityLog, conversationId))
        .operations.get(operationId)?.effects.get(effectId)?.at(-1);
      if (!prepared || prepared.status !== "prepared") continue;
    }

    try {
      await options.globalState.mutate(
        prepared.mutation,
        context(prepared.requestId, options),
      );
      await appendIfAbsent(options.authorityLog, conversationId, {
        ...prepared,
        status: "granted",
      });
      return;
    } catch (error) {
      if (
        extraction.category !== "journal" &&
        error instanceof MemoryMutationConflictError &&
        error.authorityError.code === "revision-conflict"
      ) {
        await appendIfAbsent(options.authorityLog, conversationId, {
          ...prepared,
          status: "revision-conflict",
        });
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Post-adoption memory effect did not converge: ${effectId}`);
}

async function readCurrent(
  options: PostAdoptionMemoryOptions,
  category: "profile" | "person",
  id: string,
  effectId: string,
  attemptOrdinal: number,
): Promise<MemoryLogicalEntry | undefined> {
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
    context(`${effectId}:read:${attemptOrdinal}`, options),
  );
  if (result.kind !== "memory-list") {
    throw new TypeError("Memory authority returned another result type");
  }
  const matches = result.entries.filter((entry) => entry.id === id);
  if (matches.length > 1) {
    throw new TypeError(`Memory authority returned duplicate ${category} entries`);
  }
  return matches[0];
}

function memoryMutation(
  extraction: PostAdoptionMemoryExtraction,
  current: MemoryLogicalEntry | undefined,
): MemoryAppendMutation {
  const common = {
    scope: { kind: "personal" as const },
    content: extraction.content,
  };
  return {
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
            meta: extraction.meta,
            ...(current ? { expectedDigest: current.digest } : {}),
          },
  };
}

async function appendIfAbsent(
  log: AuthorityCommitLog,
  conversationId: string,
  record: PostAdoptionMemoryRecord,
): Promise<void> {
  await log.transactProjection<MemoryProjection, unknown, void>(
    emptyProjection(),
    reduceProjection,
    (state) => {
      const existing = findEquivalentRecord(state, record);
      if (existing) {
        if (
          record.kind !== "post-adoption-memory-plan" &&
          canonicalize(existing) !== canonicalize(record)
        ) {
          throw new Error(`${record.kind} identity was reused with another payload`);
        }
        return { kind: "return", value: undefined };
      }
      return {
        kind: "append",
        entries: [memoryRecord(conversationId, record)],
        value: undefined,
      };
    },
    { stream: memoryStream(conversationId) },
  );
}

async function appendDiscoveryWithAttempts(
  log: AuthorityCommitLog,
  conversationId: string,
  discovery: Extract<
    PostAdoptionMemoryRecord,
    { kind: "post-adoption-memory-discovery" }
  >,
  candidates: readonly ConversationSegmentMemoryFlush[],
): Promise<void> {
  const attempts = candidates.map((candidate) => {
    if (candidate.conversationId !== conversationId) {
      throw new TypeError("Post-adoption memory candidate belongs to another conversation");
    }
    const operationId = postAdoptionMemoryOperationId(candidate);
    return {
      kind: "post-adoption-memory-attempt" as const,
      operationId,
      attemptOrdinal: 1,
      inputDigest: postAdoptionMemoryInputDigest(candidate),
      input: structuredClone(candidate),
    };
  });
  if (
    attempts.length !== discovery.operationIds.length ||
    attempts.some((attempt, index) =>
      attempt.operationId !== discovery.operationIds[index])
  ) {
    throw new TypeError("Post-adoption memory discovery does not bind its inputs");
  }
  if (new Set(discovery.operationIds).size !== discovery.operationIds.length) {
    throw new TypeError("Post-adoption memory discovery contains duplicate operations");
  }

  await log.transactProjection<MemoryProjection, unknown, void>(
    emptyProjection(),
    reduceProjection,
    (state) => {
      const entries: LogicalRecord<PostAdoptionMemoryRecord>[] = [];
      const existingDiscovery = findEquivalentRecord(state, discovery);
      if (existingDiscovery) {
        if (canonicalize(existingDiscovery) !== canonicalize(discovery)) {
          throw new Error("Post-adoption memory discovery identity was reused");
        }
      } else {
        entries.push(memoryRecord(conversationId, discovery));
      }
      for (const attempt of attempts) {
        const existingAttempt = findEquivalentRecord(state, attempt);
        if (existingAttempt) {
          if (canonicalize(existingAttempt) !== canonicalize(attempt)) {
            throw new Error("Post-adoption memory attempt identity was reused");
          }
        } else {
          entries.push(memoryRecord(conversationId, attempt));
        }
      }
      return entries.length === 0
        ? { kind: "return", value: undefined }
        : { kind: "append", entries, value: undefined };
    },
    { stream: memoryStream(conversationId) },
  );
}

async function readProjection(
  log: AuthorityCommitLog,
  conversationId: string,
): Promise<MemoryProjection> {
  return (await log.transactProjection<MemoryProjection, unknown, void>(
    emptyProjection(),
    reduceProjection,
    () => ({ kind: "return", value: undefined }),
    { stream: memoryStream(conversationId) },
  )).state;
}

function reduceProjection(
  state: MemoryProjection,
  logical: LogicalRecord<unknown>,
): MemoryProjection {
  if (!logical.stream.startsWith("run:")) return state;
  const body = logical.body;
  if (
    !body ||
    typeof body !== "object" ||
    !("kind" in body) ||
    typeof body.kind !== "string" ||
    !body.kind.startsWith("post-adoption-memory-")
  ) {
    return state;
  }
  assertConversationRunInternalRecord(body);
  const record = body as PostAdoptionMemoryRecord;
  switch (record.kind) {
    case "post-adoption-memory-discovery": {
      const key = `${record.transferId}:${record.checkpointDigest}`;
      const existing = state.discoveries.get(key);
      if (existing && canonicalize(existing) !== canonicalize(record)) {
        throw new Error("Post-adoption memory discovery identity was reused");
      }
      state.discoveries.set(key, record);
      return state;
    }
    case "post-adoption-memory-attempt": {
      const operation = operationState(state, record.operationId);
      if (operation.attempt && canonicalize(operation.attempt) !== canonicalize(record)) {
        throw new Error("Post-adoption memory attempt identity was reused");
      }
      operation.attempt = record;
      return state;
    }
    case "post-adoption-memory-plan": {
      const operation = operationState(state, record.operationId);
      if (!operation.attempt || operation.attempt.attemptOrdinal !== record.attemptOrdinal) {
        throw new Error("Post-adoption memory plan has no matching attempt");
      }
      if (operation.plan && canonicalize(operation.plan) !== canonicalize(record)) {
        throw new Error("Post-adoption memory operation has multiple plans");
      }
      operation.plan = record;
      return state;
    }
    case "post-adoption-memory-effect": {
      const operation = operationState(state, record.operationId);
      if (!operation.plan || operation.plan.extractions[record.effectIndex] === undefined) {
        throw new Error("Post-adoption memory effect has no matching plan item");
      }
      const expectedEffectId = `post-adoption-effect:${protocolDigest(
        "PostAdoptionMemoryEffect",
        1,
        { operationId: record.operationId, extraction: operation.plan.extractions[record.effectIndex] },
      )}`;
      if (record.effectId !== expectedEffectId) {
        throw new Error("Post-adoption memory effect identity does not bind its plan item");
      }
      const attempts = operation.effects.get(record.effectId) ?? [];
      const sameAttempt = attempts.filter((item) => item.attemptOrdinal === record.attemptOrdinal);
      const sameStatus = sameAttempt.find((item) => item.status === record.status);
      if (sameStatus) {
        if (canonicalize(sameStatus) !== canonicalize(record)) {
          throw new Error("Post-adoption memory effect attempt identity was reused");
        }
        return state;
      }
      if (record.status === "prepared") {
        const previous = attempts.at(-1);
        if (
          record.attemptOrdinal !== (previous?.attemptOrdinal ?? 0) + 1 ||
          (previous && previous.status !== "revision-conflict")
        ) {
          throw new Error("Post-adoption memory effect attempt is not the unique next attempt");
        }
      } else {
        const prepared = sameAttempt.find((item) => item.status === "prepared");
        if (!prepared || !sameEffectAttempt(prepared, record)) {
          throw new Error("Post-adoption memory effect terminal does not bind its prepared attempt");
        }
      }
      attempts.push(record);
      operation.effects.set(record.effectId, attempts);
      return state;
    }
    case "post-adoption-memory-completed": {
      const operation = operationState(state, record.operationId);
      if (!operation.plan || operation.plan.resultDigest !== record.resultDigest) {
        throw new Error("Post-adoption memory completion does not bind its plan");
      }
      for (const [index, extraction] of operation.plan.extractions.entries()) {
        const effectId = `post-adoption-effect:${protocolDigest(
          "PostAdoptionMemoryEffect",
          1,
          { operationId: record.operationId, extraction },
        )}`;
        if (!operation.effects.get(effectId)?.some((effect) =>
          effect.effectIndex === index && effect.status === "granted")) {
          throw new Error("Post-adoption memory completed before every effect was granted");
        }
      }
      if (operation.completed && canonicalize(operation.completed) !== canonicalize(record)) {
        throw new Error("Post-adoption memory completion identity was reused");
      }
      operation.completed = record;
      return state;
    }
  }
}

function findEquivalentRecord(
  state: MemoryProjection,
  record: PostAdoptionMemoryRecord,
): PostAdoptionMemoryRecord | undefined {
  switch (record.kind) {
    case "post-adoption-memory-discovery":
      return state.discoveries.get(`${record.transferId}:${record.checkpointDigest}`);
    case "post-adoption-memory-attempt":
      return state.operations.get(record.operationId)?.attempt;
    case "post-adoption-memory-plan":
      return state.operations.get(record.operationId)?.plan;
    case "post-adoption-memory-effect":
      return state.operations.get(record.operationId)?.effects.get(record.effectId)
        ?.find((item) =>
          item.attemptOrdinal === record.attemptOrdinal && item.status === record.status);
    case "post-adoption-memory-completed":
      return state.operations.get(record.operationId)?.completed;
  }
}

function sameEffectAttempt(left: MemoryEffectRecord, right: MemoryEffectRecord): boolean {
  return canonicalize({ ...left, status: "prepared" }) ===
    canonicalize({ ...right, status: "prepared" });
}

function operationState(state: MemoryProjection, operationId: string): MemoryOperationProjection {
  const existing = state.operations.get(operationId);
  if (existing) return existing;
  const created: MemoryOperationProjection = { effects: new Map() };
  state.operations.set(operationId, created);
  return created;
}

function emptyProjection(): MemoryProjection {
  return { discoveries: new Map(), operations: new Map() };
}

function memoryRecord(
  conversationId: string,
  body: PostAdoptionMemoryRecord,
): LogicalRecord<PostAdoptionMemoryRecord> {
  return { stream: memoryStream(conversationId), body };
}

function memoryStream(conversationId: string): string {
  return `run:${conversationId}`;
}

function context(requestId: string, options: PostAdoptionMemoryOptions) {
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
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.map(toJsonValue).filter((item): item is JsonValue => item !== undefined);
  }
  if (value && typeof value === "object") return toJsonObject(value as Record<string, unknown>);
  return undefined;
}
