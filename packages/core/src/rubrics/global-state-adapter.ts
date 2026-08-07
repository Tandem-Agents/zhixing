import type {
  GlobalControlCallContext,
  GlobalControlMutation,
  GlobalControlMutationResult,
  GlobalQuery,
  GlobalReadCallContext,
  GlobalReadResult,
  GlobalStagedCallContext,
  GlobalStagedMutation,
  GlobalStagedMutationResult,
  GlobalStatePort,
  RubricWriteMutation,
} from "../contracts/index.js";
import type { ArtifactRef, Digest, IsoTime } from "../contracts/foundation.js";
import type {
  ArtifactStore,
  AuthorityCommitLog,
  DurableProjectionMutation,
  DurableProjectionReadContext,
  ProjectionCursor,
} from "../authority/index.js";
import type { JsonValue, LogicalRecord } from "../contracts/index.js";
import {
  assertPrincipalAllowsAuthorityMethod,
  protocolDigest,
} from "../protocol/index.js";
import { parseRubricDocument, rubricDocumentId } from "./document.js";

export const RUBRIC_AUTHORITY_STREAM = "intent:rubric-registry";
export const RUBRIC_AUTHORITY_PROJECTION_ID = "global-rubric-authority-v1";
const RUBRIC_ENTRY_PREFIX = "entry:";
const RUBRIC_REQUEST_PREFIX = "request:";
const RUBRIC_REVISION_KEY = "revision";

export type RubricAuthorityRecord =
  | {
      readonly t: "rubric-upserted";
      readonly requestId: string;
      readonly mutationDigest: Digest;
      readonly id: string;
      readonly revision: number;
      readonly content: ArtifactRef;
      readonly at: IsoTime;
    }
  | {
      readonly t: "rubric-archived";
      readonly requestId: string;
      readonly mutationDigest: Digest;
      readonly id: string;
      readonly revision: number;
      readonly at: IsoTime;
    };

interface RubricAuthorityState {
  readonly entries: Map<string, { revision: number; content: ArtifactRef; archived: boolean }>;
  readonly requests: Map<string, { mutationDigest: Digest; revision: number }>;
  revision: number;
}

export interface AnchorRubricGlobalStateAdapterOptions {
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly anchorEpoch: number;
  readonly clock?: () => IsoTime;
}

/** Durable global Rubric index; immutable content lives in ArtifactStore. */
export class AnchorRubricGlobalStateAdapter implements GlobalStatePort {
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #anchorEpoch: number;
  readonly #clock: () => IsoTime;
  #state: RubricAuthorityState = emptyState();
  #cursor: ProjectionCursor | undefined;

  constructor(options: AnchorRubricGlobalStateAdapterOptions) {
    if (!Number.isSafeInteger(options.anchorEpoch) || options.anchorEpoch < 1) {
      throw new TypeError("Rubric anchor epoch must be a positive safe integer");
    }
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#anchorEpoch = options.anchorEpoch;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    options.log.durableProjection<RubricAuthorityRecord>({
      projectionId: RUBRIC_AUTHORITY_PROJECTION_ID,
      reducerVersion: 1,
      reduce: reduceRubricDurableProjection,
    });
  }

  get deferredIntentProjectionId(): string {
    return RUBRIC_AUTHORITY_PROJECTION_ID;
  }

  async prepareDeferredIntentMutation(input: {
    readonly mutation: Extract<
      RubricWriteMutation,
      { kind: "rubric-save-own" | "rubric-update-own" }
    >;
    readonly requestId: string;
    readonly at: IsoTime;
    readonly projection: DurableProjectionReadContext;
  }): Promise<{
    readonly records: readonly LogicalRecord<RubricAuthorityRecord>[];
    readonly revision: number;
    readonly candidateReferences: readonly ArtifactRef[];
  }> {
    const mutationDigest = protocolDigest("RubricWriteMutation", 1, input.mutation);
    const replay = readRubricRequest(
      await input.projection.get(rubricRequestKey(input.requestId)),
    );
    if (replay) {
      if (replay.mutationDigest !== mutationDigest) {
        throw new TypeError("Rubric request id was reused with another mutation");
      }
      return { records: [], revision: replay.revision, candidateReferences: [] };
    }
    const bytes = await this.#artifacts.get(input.mutation.rubric.content);
    const document = parseRubricDocument(Buffer.from(bytes).toString("utf8"));
    if (
      document.title !== input.mutation.rubric.title ||
      document.description !== input.mutation.rubric.description
    ) {
      throw new TypeError("Rubric metadata does not match its content artifact");
    }
    const derivedId = rubricDocumentId(document);
    const targetId = input.mutation.kind === "rubric-update-own"
      ? input.mutation.rubricId
      : derivedId;
    if (derivedId !== targetId) {
      throw new TypeError("Rubric content id does not match the update target");
    }
    const existing = readRubricEntry(
      await input.projection.get(rubricEntryKey(targetId)),
    );
    if (input.mutation.kind === "rubric-save-own") {
      if (existing && !existing.archived) throw new TypeError("Rubric already exists");
    } else if (
      !existing || existing.archived ||
      existing.revision !== input.mutation.expectedRevision
    ) {
      throw new TypeError("Rubric revision is stale or unavailable");
    }
    const currentRevision = readRubricRevision(
      await input.projection.get(RUBRIC_REVISION_KEY),
    );
    const revision = currentRevision + 1;
    const record: RubricAuthorityRecord = {
      t: "rubric-upserted",
      requestId: input.requestId,
      mutationDigest,
      id: targetId,
      revision,
      content: input.mutation.rubric.content,
      at: input.at,
    };
    return {
      records: [{ stream: RUBRIC_AUTHORITY_STREAM, body: record }],
      revision,
      candidateReferences: [input.mutation.rubric.content],
    };
  }

  async read(
    query: GlobalQuery,
    context: GlobalReadCallContext,
  ): Promise<GlobalReadResult> {
    this.#admit(context, "global.read");
    if (query.kind !== "asset-index" || query.asset !== "rubrics") {
      throw new TypeError("This global state adapter only owns Rubric assets");
    }
    const state = await this.#load();
    return {
      kind: "asset-index",
      entries: [...state.entries]
        .filter(([, entry]) => !entry.archived)
        .map(([id, entry]) => ({
          id,
          kind: "rubrics" as const,
          revision: entry.revision,
          digest: entry.content.digest,
        }))
        .sort((left, right) => left.id.localeCompare(right.id, "en-US")),
    };
  }

  mutate<M extends GlobalControlMutation>(
    mutation: M,
    context: GlobalControlCallContext,
  ): Promise<GlobalControlMutationResult<M>>;
  mutate<M extends GlobalStagedMutation>(
    mutation: M,
    context: GlobalStagedCallContext,
  ): Promise<GlobalStagedMutationResult<M>>;
  async mutate(
    mutation: GlobalControlMutation | GlobalStagedMutation,
    context: GlobalControlCallContext | GlobalStagedCallContext,
  ): Promise<
    | GlobalControlMutationResult<GlobalControlMutation>
    | GlobalStagedMutationResult<GlobalStagedMutation>
  > {
    this.#admit(context, "global.mutate");
    if (context.principal.kind === "assignment" || !isRubricMutation(mutation)) {
      throw new TypeError("Only the global control owner may mutate Rubric assets");
    }
    const controlContext = context as GlobalControlCallContext;
    const mutationDigest = protocolDigest("RubricWriteMutation", 1, mutation);
    const state = await this.#load();
    const replay = state.requests.get(context.requestId);
    if (replay) {
      if (replay.mutationDigest !== mutationDigest) {
        throw new TypeError("Rubric request id was reused with another mutation");
      }
      return { revision: replay.revision };
    }

    const prepared = await this.#prepare(mutation, controlContext);
    const transaction = await this.#log.transactProjection<
      RubricAuthorityState,
      RubricAuthorityRecord,
      number
    >(
      state,
      reduceRubricAuthority,
      (current) => {
        const duplicate = current.requests.get(context.requestId);
        if (duplicate) {
          if (duplicate.mutationDigest !== mutationDigest) {
            throw new TypeError("Rubric request id was reused with another mutation");
          }
          return { kind: "return", value: duplicate.revision };
        }
        const revision = current.revision + 1;
        const record: RubricAuthorityRecord = prepared.kind === "archive"
          ? {
              t: "rubric-archived",
              requestId: context.requestId,
              mutationDigest,
              id: prepared.id,
              revision,
              at: this.#clock(),
            }
          : {
              t: "rubric-upserted",
              requestId: context.requestId,
              mutationDigest,
              id: prepared.id,
              revision,
              content: prepared.content,
              at: this.#clock(),
            };
        return {
          kind: "append",
          entries: [{ stream: RUBRIC_AUTHORITY_STREAM, body: record }],
          value: revision,
        };
      },
      {
        stream: RUBRIC_AUTHORITY_STREAM,
        ...(this.#cursor ? { cursor: this.#cursor } : {}),
        ...(prepared.kind === "upsert"
          ? { candidateReferences: [prepared.content] }
          : {}),
      },
    );
    this.#state = transaction.state;
    this.#cursor = transaction.cursor;
    return { revision: transaction.value };
  }

  async #prepare(
    mutation: RubricWriteMutation,
    context: GlobalControlCallContext,
  ): Promise<
    | { kind: "upsert"; id: string; content: ArtifactRef }
    | { kind: "archive"; id: string }
  > {
    const state = await this.#load();
    if (mutation.kind === "rubric-archive") {
      const existing = state.entries.get(mutation.rubricId);
      if (!existing || existing.archived) throw new TypeError("Rubric does not exist");
      assertExpectedRevision(mutation.expectedRevision, context, existing.revision);
      return { kind: "archive", id: mutation.rubricId };
    }
    const bytes = await this.#artifacts.get(mutation.rubric.content);
    const document = parseRubricDocument(Buffer.from(bytes).toString("utf8"));
    if (
      document.title !== mutation.rubric.title ||
      document.description !== mutation.rubric.description
    ) {
      throw new TypeError("Rubric metadata does not match its content artifact");
    }
    const derivedId = rubricDocumentId(document);
    if (mutation.kind === "rubric-save-own") {
      const existing = state.entries.get(derivedId);
      if (existing && !existing.archived) throw new TypeError("Rubric already exists");
      return { kind: "upsert", id: derivedId, content: mutation.rubric.content };
    }
    if (derivedId !== mutation.rubricId) {
      throw new TypeError("Rubric content id does not match the update target");
    }
    const existing = state.entries.get(mutation.rubricId);
    if (!existing || existing.archived) throw new TypeError("Rubric does not exist");
    assertExpectedRevision(mutation.expectedRevision, context, existing.revision);
    return { kind: "upsert", id: mutation.rubricId, content: mutation.rubric.content };
  }

  async #load(): Promise<RubricAuthorityState> {
    const transaction = await this.#log.transactProjection<
      RubricAuthorityState,
      RubricAuthorityRecord,
      undefined
    >(
      this.#state,
      reduceRubricAuthority,
      () => ({ kind: "return", value: undefined }),
      {
        stream: RUBRIC_AUTHORITY_STREAM,
        ...(this.#cursor ? { cursor: this.#cursor } : {}),
      },
    );
    this.#state = transaction.state;
    this.#cursor = transaction.cursor;
    return this.#state;
  }

  #admit(
    context: GlobalReadCallContext | GlobalControlCallContext | GlobalStagedCallContext,
    method: "global.read" | "global.mutate",
  ): void {
    assertPrincipalAllowsAuthorityMethod(context.principal.kind, method);
    if (
      context.authority.domain !== "global" ||
      context.authority.anchorEpoch !== this.#anchorEpoch
    ) {
      throw new TypeError("Global Rubric authority fence is stale or invalid");
    }
    if (!context.requestId || Date.parse(context.deadlineAt) < Date.parse(this.#clock())) {
      throw new TypeError("Global Rubric request is invalid or expired");
    }
  }
}

function emptyState(): RubricAuthorityState {
  return { entries: new Map(), requests: new Map(), revision: 0 };
}

function reduceRubricAuthority(
  state: RubricAuthorityState,
  logical: { readonly stream: string; readonly body: RubricAuthorityRecord },
): RubricAuthorityState {
  if (logical.stream !== RUBRIC_AUTHORITY_STREAM) return state;
  const next: RubricAuthorityState = {
    entries: new Map(state.entries),
    requests: new Map(state.requests),
    revision: state.revision,
  };
  const record = logical.body;
  if (record.revision !== state.revision + 1) {
    throw new TypeError("Rubric authority revision is not contiguous");
  }
  if (next.requests.has(record.requestId)) {
    throw new TypeError("Rubric authority log contains a duplicate request id");
  }
  if (record.t === "rubric-upserted") {
    next.entries.set(record.id, {
      revision: record.revision,
      content: record.content,
      archived: false,
    });
  } else {
    const existing = next.entries.get(record.id);
    if (!existing || existing.archived) {
      throw new TypeError("Rubric authority log archives an unknown Rubric");
    }
    next.entries.set(record.id, { ...existing, revision: record.revision, archived: true });
  }
  next.requests.set(record.requestId, {
    mutationDigest: record.mutationDigest,
    revision: record.revision,
  });
  next.revision = record.revision;
  return next;
}

async function reduceRubricDurableProjection(
  envelope: import("../contracts/index.js").CommitEnvelope<RubricAuthorityRecord>,
  current: DurableProjectionReadContext,
): Promise<readonly DurableProjectionMutation[]> {
  const mutations: DurableProjectionMutation[] = [];
  const overlay = new Map<string, JsonValue | undefined>();
  const read = (key: string): Promise<JsonValue | undefined> =>
    overlay.has(key) ? Promise.resolve(overlay.get(key)) : current.get(key);
  const put = (key: string, value: JsonValue): void => {
    overlay.set(key, value);
    mutations.push({ kind: "put", key, value });
  };
  for (const logical of envelope.entries) {
    if (logical.stream !== RUBRIC_AUTHORITY_STREAM) continue;
    const record = logical.body;
    const revision = readRubricRevision(await read(RUBRIC_REVISION_KEY));
    if (record.revision !== revision + 1) {
      throw new TypeError("Rubric authority revision is not contiguous");
    }
    if (await read(rubricRequestKey(record.requestId)) !== undefined) {
      throw new TypeError("Rubric authority log contains a duplicate request id");
    }
    const request = {
      mutationDigest: record.mutationDigest,
      revision: record.revision,
    };
    if (record.t === "rubric-upserted") {
      put(rubricEntryKey(record.id), {
        archived: false,
        content: record.content as unknown as JsonValue,
        revision: record.revision,
      });
    } else {
      const existing = readRubricEntry(await read(rubricEntryKey(record.id)));
      if (!existing || existing.archived) {
        throw new TypeError("Rubric authority log archives an unknown Rubric");
      }
      put(rubricEntryKey(record.id), {
        archived: true,
        content: existing.content as unknown as JsonValue,
        revision: record.revision,
      });
    }
    put(rubricRequestKey(record.requestId), request);
    put(RUBRIC_REVISION_KEY, record.revision);
  }
  return mutations;
}

function rubricEntryKey(id: string): string {
  return `${RUBRIC_ENTRY_PREFIX}${id}`;
}

function rubricRequestKey(requestId: string): string {
  return `${RUBRIC_REQUEST_PREFIX}${requestId}`;
}

function readRubricRevision(value: JsonValue | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError("Rubric authority projection revision is invalid");
  }
  return Number(value);
}

function readRubricEntry(value: JsonValue | undefined):
  | { readonly revision: number; readonly content: ArtifactRef; readonly archived: boolean }
  | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    typeof (value as { archived?: unknown }).archived !== "boolean" ||
    !Number.isSafeInteger((value as { revision?: unknown }).revision)
  ) {
    throw new TypeError("Rubric authority projection entry is invalid");
  }
  const entry = value as unknown as {
    readonly revision: number;
    readonly content: ArtifactRef;
    readonly archived: boolean;
  };
  if (!entry.content || typeof entry.content.digest !== "string") {
    throw new TypeError("Rubric authority projection content is invalid");
  }
  return entry;
}

function readRubricRequest(value: JsonValue | undefined):
  | { readonly mutationDigest: Digest; readonly revision: number }
  | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    typeof (value as { mutationDigest?: unknown }).mutationDigest !== "string" ||
    !Number.isSafeInteger((value as { revision?: unknown }).revision)
  ) {
    throw new TypeError("Rubric authority projection request is invalid");
  }
  return value as unknown as { readonly mutationDigest: Digest; readonly revision: number };
}

function isRubricMutation(
  mutation: GlobalControlMutation | GlobalStagedMutation,
): mutation is RubricWriteMutation {
  return mutation.kind === "rubric-save-own" ||
    mutation.kind === "rubric-update-own" ||
    mutation.kind === "rubric-archive";
}

function assertExpectedRevision(
  mutationRevision: number,
  context: GlobalControlCallContext,
  actual: number,
): void {
  if (
    mutationRevision !== actual ||
    (context.expectedRevision !== undefined && context.expectedRevision !== actual)
  ) {
    throw new TypeError("Rubric revision is stale");
  }
}
