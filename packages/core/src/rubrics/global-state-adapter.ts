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
  ProjectionCursor,
} from "../authority/index.js";
import {
  assertPrincipalAllowsAuthorityMethod,
  protocolDigest,
} from "../protocol/index.js";
import { parseRubricDocument, rubricDocumentId } from "./document.js";

const RUBRIC_STREAM = "intent:rubric-registry";

type RubricAuthorityRecord =
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
          entries: [{ stream: RUBRIC_STREAM, body: record }],
          value: revision,
        };
      },
      {
        stream: RUBRIC_STREAM,
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
        stream: RUBRIC_STREAM,
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
  if (logical.stream !== RUBRIC_STREAM) return state;
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
