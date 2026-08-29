import { randomUUID } from "node:crypto";
import type {
  ArtifactRef,
  Digest,
  GlobalControlCallContext,
  GlobalStatePort,
  SkillStatePatch,
} from "../contracts/index.js";
import { stringifyFrontmatter } from "../frontmatter.js";
import { scrubSecrets } from "../security/secret-scrubber.js";
import { SkillMutationConflictError } from "./global-state-adapter.js";
import { skillNameToId } from "./id.js";
import type { SkillCatalogEntry, SkillMode } from "./types.js";

/** Skill-owned management query. Runtime and tool catalog reads use GlobalStatePort directly. */
export type SkillCatalogQuery = { readonly kind: "list" };

export type SkillCatalogStatePatch = Readonly<{
  mode?: SkillMode;
  pinned?: boolean;
  disabled?: boolean;
}>;

/** Skill-owned management commands. Expected revisions remain an application concern. */
export type SkillCatalogCommand =
  | {
      readonly kind: "set-state";
      readonly skillId: string;
      readonly patch: SkillCatalogStatePatch;
    }
  | { readonly kind: "archive"; readonly skillId: string };

/** Stable management projection; it deliberately contains no storage or authority types. */
export interface SkillCatalogView {
  readonly entries: readonly SkillCatalogEntry[];
  readonly catalogRevision: number;
}

/** A committed Skill fact. Bindings may project it to their own transport vocabulary. */
export interface SkillCatalogChangedFact {
  readonly kind: "skill-catalog-changed";
  readonly catalogRevision: number;
}

export interface SkillCatalogCommandResult {
  readonly fact: SkillCatalogChangedFact;
}

export interface SkillCatalogApplication {
  query(query: SkillCatalogQuery): Promise<SkillCatalogView>;
  execute(command: SkillCatalogCommand): Promise<SkillCatalogCommandResult>;
}

/** Skill-owned input for the save_skill create/update use case. */
export interface SkillCatalogSaveDraft {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly mode: SkillMode;
}

export interface SkillCatalogSaveOutcome {
  readonly id: string;
  readonly name: string;
  readonly outcome: "created" | "updated";
  readonly scrubbedCount: number;
}

/** The only application entry for save_skill. Bindings retain product copy only. */
export interface SkillCatalogSaveApplication {
  save(
    draft: SkillCatalogSaveDraft,
    operationId?: string,
  ): Promise<SkillCatalogSaveOutcome>;
}

export interface SkillCatalogSaveRecord {
  readonly name: string;
  readonly description: string;
  readonly content: ArtifactRef;
}

export type SkillCatalogSaveOverlayMutation =
  | {
      readonly kind: "skill-create";
      readonly record: SkillCatalogSaveRecord;
      readonly mode: SkillMode;
    }
  | {
      readonly kind: "skill-admit";
      readonly record: SkillCatalogSaveRecord;
      readonly mode: SkillMode;
    }
  | {
      readonly kind: "skill-update";
      readonly skillId: string;
      readonly record: SkillCatalogSaveRecord;
      readonly mode: SkillMode;
      readonly expectedRevision: number;
    };

export interface SkillCatalogSaveOverlayRecord {
  readonly recordSeq: number;
  readonly requestIdentity: string;
  readonly mutation: SkillCatalogSaveOverlayMutation;
  readonly mutationDigest: Digest;
}

export type SkillCatalogSaveMutation = Exclude<
  SkillCatalogSaveOverlayMutation,
  { readonly kind: "skill-admit" }
>;

/**
 * Path-free Correctness adapter required by the Skill-owned save use case.
 * Runtime composition supplies artifact, global-read and assignment-stage mechanics;
 * it does not decide upsert, overlay, format or operation identity semantics.
 */
export interface SkillCatalogSaveCorrectnessPort {
  readCatalogEntry(skillId: string): Promise<SkillCatalogEntry | null>;
  readOverlay(): Promise<readonly SkillCatalogSaveOverlayRecord[]>;
  requestIdentityFor(operationId: string): string;
  putContent(document: string): Promise<ArtifactRef>;
  stage(operationId: string, mutation: SkillCatalogSaveMutation): Promise<void>;
  assignmentIssuedAt(): string;
}

/** Skill-owned save use case over the assignment-scoped Correctness adapter. */
export class SkillCatalogSaveApplicationService
  implements SkillCatalogSaveApplication
{
  constructor(private readonly correctness: SkillCatalogSaveCorrectnessPort) {}

  async save(
    draft: SkillCatalogSaveDraft,
    operationId?: string,
  ): Promise<SkillCatalogSaveOutcome> {
    if (
      typeof draft?.name !== "string" ||
      typeof draft.description !== "string" ||
      typeof draft.body !== "string" ||
      (draft.mode !== "main" && draft.mode !== "work")
    ) {
      throw new Error("Skill save draft is invalid");
    }
    const name = scrubSecrets(draft.name);
    const description = scrubSecrets(draft.description);
    const body = scrubSecrets(draft.body);
    const normalized = {
      name: name.scrubbed.trim(),
      description: description.scrubbed.trim(),
      body: body.scrubbed.trim(),
      mode: draft.mode,
    } satisfies SkillCatalogSaveDraft;
    const id = skillNameToId(normalized.name);
    if (!id || !normalized.description || !normalized.body) {
      throw new Error("Skill name, description and body must remain non-empty");
    }

    const stagedOperationId = operationId
      ? `${operationId}:save`
      : undefined;
    const currentState = await this.#readCurrent(
      id,
      stagedOperationId === undefined
        ? undefined
        : this.correctness.requestIdentityFor(stagedOperationId),
    );
    const content = await this.correctness.putContent(
      stringifyFrontmatter(
        { name: normalized.name, description: normalized.description },
        normalized.body,
      ),
    );
    if (!operationId) {
      throw new Error("Skill mutation requires a durable tool operation id");
    }
    const candidate: SkillCatalogSaveMutation = currentState.entry
      ? {
          kind: "skill-update",
          skillId: currentState.entry.id,
          record: {
            name: normalized.name,
            description: normalized.description,
            content,
          },
          mode: normalized.mode,
          expectedRevision: currentState.entry.revision,
        }
      : {
          kind: "skill-create",
          record: {
            name: normalized.name,
            description: normalized.description,
            content,
          },
          mode: normalized.mode,
        };
    const replayMutation = currentState.replayRecord?.mutation;
    const exactReplay = replayMutation !== undefined &&
      isSkillCatalogSaveMutation(replayMutation) &&
      sameSkillSaveDraft(replayMutation, candidate);
    const mutation = exactReplay
      ? replayMutation
      : candidate;
    await this.correctness.stage(
      stagedOperationId!,
      mutation,
    );
    return {
      id,
      name: normalized.name,
      outcome: mutation.kind === "skill-update" ? "updated" : "created",
      scrubbedCount:
        name.redactions.length +
        description.redactions.length +
        body.redactions.length,
    };
  }

  async #readCurrent(
    skillId: string,
    currentRequestIdentity?: string,
  ): Promise<{
    readonly entry: SkillCatalogEntry | null;
    readonly replayRecord?: SkillCatalogSaveOverlayRecord;
  }> {
    let entry = await this.correctness.readCatalogEntry(skillId);
    const overlay = await this.correctness.readOverlay();
    const replayRecords = currentRequestIdentity === undefined
      ? []
      : overlay.filter(
          (record) => record.requestIdentity === currentRequestIdentity,
        );
    if (replayRecords.length > 1) {
      throw new Error("Skill save overlay contains a duplicate operation identity");
    }
    const replayRecordSeq = replayRecords[0]?.recordSeq;
    for (const record of overlay) {
      if (replayRecordSeq !== undefined && record.recordSeq >= replayRecordSeq) {
        continue;
      }
      const mutation = record.mutation;
      const mutationId = skillNameToId(mutation.record.name);
      if (mutationId !== skillId) continue;
      entry = {
        id: mutationId,
        name: mutation.record.name,
        description: mutation.record.description,
        source: mutation.kind === "skill-admit" ? "linked" : "own",
        mode: mutation.mode,
        pinned: entry?.pinned ?? false,
        disabled: false,
        createdAt: entry?.createdAt ?? this.correctness.assignmentIssuedAt(),
        usage: entry?.usage ?? null,
        contentRef: mutation.record.content,
        revision: entry ? entry.revision + 1 : 1,
        digest: record.mutationDigest,
      };
    }
    return {
      entry,
      ...(replayRecords[0] === undefined
        ? {}
        : { replayRecord: replayRecords[0] }),
    };
  }
}

function isSkillCatalogSaveMutation(
  mutation: SkillCatalogSaveOverlayMutation,
): mutation is SkillCatalogSaveMutation {
  return mutation.kind === "skill-create" || mutation.kind === "skill-update";
}

function sameSkillSaveDraft(
  replay: SkillCatalogSaveMutation,
  candidate: SkillCatalogSaveMutation,
): boolean {
  return replay.record.name === candidate.record.name &&
    replay.record.description === candidate.record.description &&
    replay.record.content.digest === candidate.record.content.digest &&
    replay.record.content.bytes === candidate.record.content.bytes &&
    replay.mode === candidate.mode;
}

export type SkillCatalogApplicationErrorCode =
  | "invalid-command"
  | "not-found"
  | "conflict";

export class SkillCatalogApplicationError extends Error {
  constructor(
    readonly code: SkillCatalogApplicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillCatalogApplicationError";
  }
}

export interface SkillCatalogApplicationServiceOptions {
  readonly globalState: GlobalStatePort | (() => GlobalStatePort);
  readonly anchorEpoch: number | (() => number);
  readonly requestId?: () => string;
  readonly now?: () => Date;
}

/**
 * The single application entry for Skill Catalog management.
 *
 * It translates product commands to the existing global correctness port and only
 * creates a fact only after the authoritative mutation returns its exact committed
 * catalog revision.
 */
export class SkillCatalogApplicationService implements SkillCatalogApplication {
  readonly #options: SkillCatalogApplicationServiceOptions;

  constructor(options: SkillCatalogApplicationServiceOptions) {
    this.#options = options;
  }

  async query(query: SkillCatalogQuery): Promise<SkillCatalogView> {
    if (query.kind !== "list") {
      throw new SkillCatalogApplicationError(
        "invalid-command",
        "Unsupported Skill Catalog query",
      );
    }
    return await this.#readCatalog("skill-list");
  }

  async execute(command: SkillCatalogCommand): Promise<SkillCatalogCommandResult> {
    const skillId = requireSkillId(command.skillId);
    const statePatch = command.kind === "set-state"
      ? requireStatePatch(command.patch)
      : command.kind === "archive"
        ? undefined
        : unsupportedCommand(command);
    const current = await this.#readEntry(skillId);
    if (!current) {
      throw new SkillCatalogApplicationError(
        "not-found",
        `Skill not found: ${skillId}`,
      );
    }

    const mutation = command.kind === "set-state"
      ? {
          kind: "skill-set-state" as const,
          skillId,
          patch: statePatch!,
          expectedRevision: current.revision,
        }
      : command.kind === "archive"
        ? {
            kind: "skill-archive" as const,
            skillId,
            expectedRevision: current.revision,
          }
        : unsupportedCommand(command);

    try {
      const committed = await this.#state().mutate(
        mutation,
        this.#context(`skill-${command.kind}`),
      );
      return {
        fact: {
          kind: "skill-catalog-changed",
          catalogRevision: committed.catalogRevision,
        },
      };
    } catch (error) {
      if (error instanceof SkillMutationConflictError) {
        throw new SkillCatalogApplicationError(
          "conflict",
          error.authorityError.message,
        );
      }
      throw error;
    }

  }

  async #readCatalog(prefix: string): Promise<SkillCatalogView> {
    const result = await this.#state().read(
      { kind: "skill-catalog", includeDisabled: true },
      this.#context(prefix),
    );
    if (result.kind !== "skill-catalog") {
      throw new TypeError("Skill catalog returned another result type");
    }
    return {
      entries: result.entries,
      catalogRevision: result.catalogRevision,
    };
  }

  async #readEntry(skillId: string): Promise<SkillCatalogEntry | null> {
    const result = await this.#state().read(
      { kind: "skill-get", skillId },
      this.#context("skill-get"),
    );
    if (result.kind !== "skill-get") {
      throw new TypeError("Skill lookup returned another result type");
    }
    return result.entry;
  }

  #state(): GlobalStatePort {
    return typeof this.#options.globalState === "function"
      ? this.#options.globalState()
      : this.#options.globalState;
  }

  #context(prefix: string): GlobalControlCallContext {
    const anchorEpoch = typeof this.#options.anchorEpoch === "function"
      ? this.#options.anchorEpoch()
      : this.#options.anchorEpoch;
    return {
      principal: { kind: "host", component: "skill-catalog-application" },
      requestId: `${prefix}:${this.#options.requestId?.() ?? randomUUID()}`,
      deadlineAt: new Date((this.#options.now?.() ?? new Date()).getTime() + 30_000)
        .toISOString(),
      authority: { domain: "global", anchorEpoch },
    };
  }
}

function requireSkillId(skillId: string): string {
  if (typeof skillId !== "string" || skillId.length === 0) {
    throw new SkillCatalogApplicationError(
      "invalid-command",
      "Skill command requires a non-empty skillId",
    );
  }
  return skillId;
}

function requireStatePatch(patch: SkillCatalogStatePatch): SkillStatePatch {
  if (!patch || typeof patch !== "object") {
    throw new SkillCatalogApplicationError(
      "invalid-command",
      "Skill state patch must be an object",
    );
  }
  const keys = Object.keys(patch);
  if (
    keys.length === 0 ||
    keys.some((key) => !["mode", "pinned", "disabled"].includes(key))
  ) {
    throw new SkillCatalogApplicationError(
      "invalid-command",
      "Skill state patch requires only mode, pinned, or disabled",
    );
  }
  if (patch.mode !== undefined && patch.mode !== "main" && patch.mode !== "work") {
    throw new SkillCatalogApplicationError(
      "invalid-command",
      "Skill mode must be main or work",
    );
  }
  if (patch.pinned !== undefined && typeof patch.pinned !== "boolean") {
    throw new SkillCatalogApplicationError(
      "invalid-command",
      "Skill pinned state must be boolean",
    );
  }
  if (patch.disabled !== undefined && typeof patch.disabled !== "boolean") {
    throw new SkillCatalogApplicationError(
      "invalid-command",
      "Skill disabled state must be boolean",
    );
  }
  return patch.mode !== undefined
    ? {
        mode: patch.mode,
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
      }
    : patch.pinned !== undefined
      ? {
          pinned: patch.pinned,
          ...(patch.disabled !== undefined ? { disabled: patch.disabled } : {}),
        }
      : { disabled: patch.disabled! };
}

function unsupportedCommand(command: never): never {
  throw new SkillCatalogApplicationError(
    "invalid-command",
    `Unsupported Skill Catalog command: ${String(command)}`,
  );
}
