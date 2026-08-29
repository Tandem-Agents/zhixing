import { randomUUID } from "node:crypto";
import type {
  ArtifactRef,
  Digest,
  GlobalControlCallContext,
  GlobalStatePort,
  SkillStatePatch,
} from "../contracts/index.js";
import { parseFrontmatter, stringifyFrontmatter } from "../frontmatter.js";
import { scrubSecrets } from "../security/secret-scrubber.js";
import {
  ADMISSION_TOKEN_TTL_MS,
  assessSkill,
  type AdmissionLlm,
} from "./admission.js";
import type { ContentThreat } from "./content-scan.js";
import { SkillMutationConflictError } from "./global-state-adapter.js";
import { skillNameToId } from "./id.js";
import { builtinIndexEntries, getBuiltinSkill } from "./builtin.js";
import type { SkillCatalogEntry, SkillMode } from "./types.js";
import { renderSkillIndex } from "./render.js";
import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiFactEvent,
  defineProductApiQuery,
  type ProductApiContribution,
} from "../product-api/catalog.js";

export type { SkillCatalogEntry, SkillMode } from "./types.js";

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

/**
 * Transport-independent Skill management client consumed by product Surfaces.
 *
 * A binding owns connection and wire details. Surfaces can only query the
 * authoritative projection, submit a domain command, and observe committed
 * facts; they cannot infer catalog state from notifications.
 */
export interface SkillCatalogClient {
  query(query: SkillCatalogQuery): Promise<SkillCatalogView>;
  command(command: SkillCatalogCommand): Promise<void>;
  onFact(handler: (fact: SkillCatalogChangedFact) => void): () => void;
}

export const SKILL_CATALOG_CHANGED_FACT_EVENT = defineProductApiFactEvent<
  "skill-catalog-changed",
  SkillCatalogChangedFact
>("skill-catalog-changed");

export const SKILL_CATALOG_LIST_QUERY = defineProductApiQuery<
  "skill-catalog.query.list",
  SkillCatalogQuery,
  SkillCatalogView
>("skill-catalog.query.list");

export const SKILL_CATALOG_SET_STATE_COMMAND = defineProductApiCommand<
  "skill-catalog.command.set-state",
  Extract<SkillCatalogCommand, { readonly kind: "set-state" }>,
  SkillCatalogCommandResult,
  SkillCatalogChangedFact
>("skill-catalog.command.set-state", [SKILL_CATALOG_CHANGED_FACT_EVENT]);

export const SKILL_CATALOG_ARCHIVE_COMMAND = defineProductApiCommand<
  "skill-catalog.command.archive",
  Extract<SkillCatalogCommand, { readonly kind: "archive" }>,
  SkillCatalogCommandResult,
  SkillCatalogChangedFact
>("skill-catalog.command.archive", [SKILL_CATALOG_CHANGED_FACT_EVENT]);

export const SKILL_CATALOG_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [
    SKILL_CATALOG_LIST_QUERY,
    SKILL_CATALOG_SET_STATE_COMMAND,
    SKILL_CATALOG_ARCHIVE_COMMAND,
  ],
  factEvents: [SKILL_CATALOG_CHANGED_FACT_EVENT],
});

/** Skill-owned Product API contribution; it delegates to the one catalog application. */
export function createSkillCatalogProductApiContribution(
  application: SkillCatalogApplication,
): ProductApiContribution {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(SKILL_CATALOG_LIST_QUERY, async (query) => ({
        result: await application.query(query),
        facts: [],
      })),
      bindProductApiOperation(SKILL_CATALOG_SET_STATE_COMMAND, async (command) => {
        const result = await application.execute(command);
        return { result, facts: [result.fact] };
      }),
      bindProductApiOperation(SKILL_CATALOG_ARCHIVE_COMMAND, async (command) => {
        const result = await application.execute(command);
        return { result, facts: [result.fact] };
      }),
    ],
    factEvents: [SKILL_CATALOG_CHANGED_FACT_EVENT],
  });
}

const SKILL_CATALOG_KERNEL_TOP_N = 20;

/** Raw, path-free catalog snapshot supplied by Correctness to the Skill domain. */
export interface SkillCatalogKernelProjectionSource {
  readCatalog(): Promise<{
    readonly catalogRevision: number;
    readonly entries: readonly SkillCatalogEntry[];
  }>;
}

/** Immutable Skill capability projection consumed by the Intelligence Kernel. */
export interface SkillCatalogKernelProjection {
  readonly catalogRevision: number;
  readonly content: string | null;
}

/** The Kernel asks only for its runtime mode and never interprets catalog entries. */
export interface SkillCatalogKernelProjectionApplication {
  project(mode: SkillMode): Promise<SkillCatalogKernelProjection>;
}

/**
 * Skill-owned projection policy for Kernel prompt capabilities.
 *
 * With no source, the same policy produces the builtin-only startup projection.
 * With a source, it owns mode filtering, disabled shadowing, the user top-N pool,
 * builtin append rules and the final byte representation.
 */
export class SkillCatalogKernelProjectionApplicationService
  implements SkillCatalogKernelProjectionApplication
{
  constructor(
    private readonly source?: SkillCatalogKernelProjectionSource,
  ) {}

  async project(mode: SkillMode): Promise<SkillCatalogKernelProjection> {
    if (mode !== "main" && mode !== "work") {
      throw new TypeError("Skill capability projection mode is invalid");
    }
    const snapshot = this.source
      ? await this.source.readCatalog()
      : { catalogRevision: -1, entries: [] as const };
    const userIds = new Set(snapshot.entries.map((entry) => entry.id));
    const visibleUsers = snapshot.entries
      .filter((entry) => entry.mode === mode && !entry.disabled)
      .slice(0, SKILL_CATALOG_KERNEL_TOP_N);
    return Object.freeze({
      catalogRevision: snapshot.catalogRevision,
      content: renderSkillIndex([
        ...visibleUsers,
        ...builtinIndexEntries(mode, userIds),
      ]),
    });
  }
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

/** Skill-owned request for loading executable instructions within one tool operation. */
export interface SkillCatalogLoadRequest {
  readonly id: string;
  readonly operationId?: string;
}

/** Stable projection consumed by load_skill; storage and assignment details stay private. */
export interface SkillCatalogLoadOutcome {
  readonly id: string;
  readonly name: string;
  readonly body: string;
}

/** The only application entry for load_skill and its durable usage hit. */
export interface SkillCatalogLoadApplication {
  load(request: SkillCatalogLoadRequest): Promise<SkillCatalogLoadOutcome>;
}

export interface SkillCatalogUsageMutation {
  readonly kind: "skill-usage";
  readonly record: {
    readonly skillId: string;
    readonly occurredAt: string;
    readonly hitDelta: 1;
  };
}

/** Explicit execution scope; missing assignment context remains an adapter error. */
export type SkillCatalogLoadScope =
  | {
      readonly kind: "assignment";
      readonly entry: SkillCatalogEntry | null;
      readonly overlay: readonly SkillCatalogSaveOverlayRecord[];
      readonly issuedAt: string;
    }
  | {
      /** Production runtime without ArtifactStore: immutable builtins only. */
      readonly kind: "builtin-only";
    };

/**
 * Path-free Correctness adapter for Skill loading. The Skill application owns
 * user-over-builtin selection, overlay folding, document parsing and usage identity.
 */
export interface SkillCatalogLoadCorrectnessPort {
  readScope(skillId: string): Promise<SkillCatalogLoadScope>;
  readContent(content: ArtifactRef): Promise<string>;
  stageUsage(operationId: string, mutation: SkillCatalogUsageMutation): Promise<void>;
}

/** Skill-owned load and usage application over assignment-scoped adapters. */
export class SkillCatalogLoadApplicationService
  implements SkillCatalogLoadApplication
{
  constructor(private readonly correctness: SkillCatalogLoadCorrectnessPort) {}

  async load(request: SkillCatalogLoadRequest): Promise<SkillCatalogLoadOutcome> {
    const id = typeof request?.id === "string" ? request.id.trim() : "";
    if (!id) throw new Error("Skill id must be non-empty");

    const builtin = getBuiltinSkill(id);
    const scope = await this.correctness.readScope(id);
    if (scope.kind === "builtin-only") {
      if (!builtin) {
        throw new Error("User skills require an active artifact-backed assignment");
      }
      return { id: builtin.id, name: builtin.name, body: builtin.body };
    }

    const entry = foldSkillCatalogEntry(
      id,
      scope.entry,
      scope.overlay,
      scope.issuedAt,
    );
    if (!entry) {
      if (!builtin) throw new Error(`Skill not found: ${id}`);
      return { id: builtin.id, name: builtin.name, body: builtin.body };
    }

    const document = await this.correctness.readContent(entry.contentRef);
    const parsed = parseFrontmatter(document);
    if (!request.operationId) {
      throw new Error("Skill mutation requires a durable tool operation id");
    }
    await this.correctness.stageUsage(`${request.operationId}:usage`, {
      kind: "skill-usage",
      record: {
        skillId: entry.id,
        occurredAt: scope.issuedAt,
        hitDelta: 1,
      },
    });
    return { id: entry.id, name: entry.name, body: parsed.content };
  }
}

function foldSkillCatalogEntry(
  skillId: string,
  initial: SkillCatalogEntry | null,
  overlay: readonly SkillCatalogSaveOverlayRecord[],
  issuedAt: string,
): SkillCatalogEntry | null {
  let entry = initial;
  for (const record of overlay) {
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
      createdAt: entry?.createdAt ?? issuedAt,
      usage: entry?.usage ?? null,
      contentRef: mutation.record.content,
      revision: entry ? entry.revision + 1 : 1,
      digest: record.mutationDigest,
    };
  }
  return entry;
}

/** Skill-owned request for the admit_skill two-stage lifecycle. */
export interface SkillCatalogAdmissionRequest {
  readonly source?: {
    readonly kind: "local-path";
    readonly path: string;
  };
  readonly admissionToken?: string;
  readonly mode: SkillMode;
  readonly operationId?: string;
}

export type SkillCatalogAdmissionOutcome =
  | { readonly kind: "missing-input" }
  | { readonly kind: "missing-name" }
  | {
      readonly kind: "escalated";
      readonly reason: string;
      readonly threats: readonly ContentThreat[];
    }
  | {
      readonly kind: "needs-confirm";
      readonly admissionToken: string;
      readonly reason: string;
      readonly threats: readonly ContentThreat[];
    }
  | { readonly kind: "confirmation-expired" }
  | { readonly kind: "candidate-changed" }
  | {
      readonly kind: "admitted";
      readonly id: string;
      readonly name: string;
    };

export interface SkillCatalogAdmissionApplication {
  admit(request: SkillCatalogAdmissionRequest): Promise<SkillCatalogAdmissionOutcome>;
}

/** Opaque, path-free snapshot owned by the Infrastructure adapter. */
export interface SkillCatalogAdmissionCandidate {
  readonly candidateId: string;
  readonly document: string;
  readonly digest: string;
}

export interface SkillCatalogAdmissionMutation {
  readonly kind: "skill-admit";
  readonly record: SkillCatalogSaveRecord;
  readonly mode: SkillMode;
}

/**
 * Path-free adapter for candidate storage, independent review, CAS and the
 * assignment mutation ledger. The Skill application owns every admission rule.
 */
export interface SkillCatalogAdmissionCorrectnessPort {
  acquireLocalCandidate(sourcePath: string): Promise<SkillCatalogAdmissionCandidate>;
  readCandidate(candidateId: string): Promise<SkillCatalogAdmissionCandidate>;
  discardCandidate(candidateId: string): Promise<void>;
  sweepStaleCandidates(maxAgeMs: number): Promise<number>;
  putContent(document: string): Promise<ArtifactRef>;
  stage(operationId: string, mutation: SkillCatalogAdmissionMutation): Promise<void>;
  admissionLlm: AdmissionLlm;
  now(): number;
  newToken(): string;
}

interface PendingSkillAdmission {
  readonly candidateId: string;
  readonly digest: string;
  readonly threats: readonly ContentThreat[];
  readonly reason: string;
  readonly mode: SkillMode;
  readonly expiresAt: number;
}

/** Skill-owned two-stage admission state machine over path-free adapters. */
export class SkillCatalogAdmissionApplicationService
  implements SkillCatalogAdmissionApplication
{
  readonly #pending = new Map<string, PendingSkillAdmission>();

  constructor(private readonly correctness: SkillCatalogAdmissionCorrectnessPort) {}

  async admit(
    request: SkillCatalogAdmissionRequest,
  ): Promise<SkillCatalogAdmissionOutcome> {
    await this.correctness.sweepStaleCandidates(ADMISSION_TOKEN_TTL_MS).catch(() => {});
    const now = this.correctness.now();
    for (const [token, pending] of this.#pending) {
      if (pending.expiresAt <= now) await this.#dropPending(token);
    }

    const token = request.admissionToken?.trim() ?? "";
    if (token) return this.#confirm(token, request.operationId);

    const sourcePath = request.source?.kind === "local-path"
      ? request.source.path.trim()
      : "";
    if (!sourcePath) return { kind: "missing-input" };
    if (request.mode !== "main" && request.mode !== "work") {
      throw new Error("Skill admission mode is invalid");
    }
    return this.#reviewLocal(sourcePath, request.mode, request.operationId);
  }

  async #reviewLocal(
    sourcePath: string,
    mode: SkillMode,
    operationId: string | undefined,
  ): Promise<SkillCatalogAdmissionOutcome> {
    let candidate: SkillCatalogAdmissionCandidate | undefined;
    try {
      candidate = await this.correctness.acquireLocalCandidate(sourcePath);
      const { data } = parseFrontmatter(candidate.document);
      const name = typeof data.name === "string" ? data.name.trim() : "";
      if (!name) {
        await this.correctness.discardCandidate(candidate.candidateId);
        return { kind: "missing-name" };
      }

      const assessment = await assessSkill(
        { llm: this.correctness.admissionLlm },
        { name, content: candidate.document },
      );
      if (assessment.verdict.decision === "escalate") {
        await this.correctness.discardCandidate(candidate.candidateId);
        return {
          kind: "escalated",
          reason: assessment.verdict.reason,
          threats: assessment.threats,
        };
      }
      if (assessment.verdict.decision === "safe") {
        const admitted = await this.#stageCandidate(candidate, mode, operationId);
        await this.correctness.discardCandidate(candidate.candidateId);
        return admitted;
      }

      const token = this.correctness.newToken();
      if (!token || this.#pending.has(token)) {
        throw new Error("Skill admission token generator returned a duplicate token");
      }
      this.#pending.set(token, {
        candidateId: candidate.candidateId,
        digest: candidate.digest,
        threats: assessment.threats,
        reason: assessment.verdict.reason,
        mode,
        expiresAt: this.correctness.now() + ADMISSION_TOKEN_TTL_MS,
      });
      candidate = undefined;
      return {
        kind: "needs-confirm",
        admissionToken: token,
        reason: assessment.verdict.reason,
        threats: assessment.threats,
      };
    } catch (error) {
      if (candidate) {
        await this.correctness.discardCandidate(candidate.candidateId).catch(() => {});
      }
      throw error;
    }
  }

  async #confirm(
    token: string,
    operationId: string | undefined,
  ): Promise<SkillCatalogAdmissionOutcome> {
    const pending = this.#pending.get(token);
    if (!pending || pending.expiresAt <= this.correctness.now()) {
      await this.#dropPending(token);
      return { kind: "confirmation-expired" };
    }
    try {
      const candidate = await this.correctness.readCandidate(pending.candidateId);
      if (candidate.digest !== pending.digest) {
        await this.#dropPending(token);
        return { kind: "candidate-changed" };
      }
      const admitted = await this.#stageCandidate(candidate, pending.mode, operationId);
      await this.#dropPending(token);
      return admitted;
    } catch (error) {
      await this.#dropPending(token);
      throw error;
    }
  }

  async #stageCandidate(
    candidate: SkillCatalogAdmissionCandidate,
    mode: SkillMode,
    operationId: string | undefined,
  ): Promise<Extract<SkillCatalogAdmissionOutcome, { kind: "admitted" }>> {
    const parsed = parseFrontmatter(candidate.document);
    const name = typeof parsed.data.name === "string" ? parsed.data.name.trim() : "";
    const description = typeof parsed.data.description === "string"
      ? parsed.data.description.trim()
      : "";
    const id = skillNameToId(name);
    if (!id || !description) {
      throw new Error("Skill frontmatter requires name and description");
    }
    const content = await this.correctness.putContent(candidate.document);
    if (!operationId) {
      throw new Error("Skill mutation requires a durable tool operation id");
    }
    await this.correctness.stage(`${operationId}:admit`, {
      kind: "skill-admit",
      record: { name, description, content },
      mode,
    });
    return { kind: "admitted", id, name };
  }

  async #dropPending(token: string): Promise<void> {
    const pending = this.#pending.get(token);
    this.#pending.delete(token);
    if (pending) {
      await this.correctness.discardCandidate(pending.candidateId).catch(() => {});
    }
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
