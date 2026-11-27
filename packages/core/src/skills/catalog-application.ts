import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiFactEvent,
  defineProductApiQuery,
  type ProductApiContribution,
} from "../product-api/catalog.js";
import { builtinIndexEntries, getBuiltinSkill, listBuiltinSkills } from "./builtin.js";
import { formatQualifiedSkillId } from "./id.js";
import { normalizeEntryToV2 } from "./package-pagination.js";
import { renderSkillIndex, renderSkillIndexV2 } from "./render.js";
import {
  DEFAULT_SKILL_VISIBILITY,
  computeSkillEntryV2Digest,
  projectSkillEntryToV1,
  projectV1SkillEntryToV2,
  type SkillCatalogChangedFact,
  type SkillCatalogEntry,
  type SkillCatalogEntryV2,
  type SkillMode,
  type SkillVisibility,
} from "./types.js";

export {
  DEFAULT_SKILL_VISIBILITY,
  computeSkillEntryV2Digest,
  projectSkillEntryToV1,
  projectV1SkillEntryToV2,
};
export type {
  SkillCatalogChangedFact,
  SkillCatalogEntry,
  SkillCatalogEntryV2,
  SkillMode,
  SkillV1ProjectionSurface,
  SkillVisibility,
} from "./types.js";
export {
  SKILL_READ_MAX_RESPONSE_BYTES,
  SkillPackageReadError,
  applyOverlayMutation,
  computeHeaderDiff,
  decodeSkillReadCursor,
  encodeSkillReadCursor,
  foldSkillCatalogEntry,
  normalizeEntryToV2,
  normalizeResourceOrThrow,
  packSkillReadPage,
} from "./package-pagination.js";
export type {
  ParsedSkillReadCursor,
  SkillPackageChangedResource,
  SkillPackageNavigationItem,
  SkillPackageReadErrorCode,
  SkillPackageReadSuccessOutcome,
  SkillPackageVersionMismatchOutcome,
} from "./package-pagination.js";
export {
  SkillCatalogSaveApplicationService,
  SkillCatalogSaveError,
  isSkillCatalogSaveMutation,
  isV2SkillSaveMutation,
  sameSkillSaveDraft,
} from "./catalog-save-service.js";
export type {
  SkillCatalogSaveApplication,
  SkillCatalogSaveBaselinePreview,
  SkillCatalogSaveCorrectnessPort,
  SkillCatalogSaveDraft,
  SkillCatalogSaveErrorCode,
  SkillCatalogSaveMutation,
  SkillCatalogSaveOutcome,
  SkillCatalogSaveOverlayMutation,
  SkillCatalogSaveOverlayRecord,
  SkillCatalogSaveRecord,
  SkillCatalogSaveRecordV2,
  SkillCatalogSaveResourceDraft,
} from "./catalog-save-service.js";
export { SkillCatalogLoadApplicationService } from "./catalog-load-service.js";
export type {
  SkillCatalogLoadApplication,
  SkillCatalogLoadCorrectnessPort,
  SkillCatalogLoadOutcome,
  SkillCatalogLoadRequest,
  SkillCatalogLoadScope,
  SkillCatalogUsageMutation,
  SkillMaterializeReadOutcome,
  SkillMaterializeReadRequest,
  SkillMaterializeReadSuccessOutcome,
  SkillPackageReadOutcome,
  SkillPackageReadRequest,
} from "./catalog-load-service.js";
export {
  SkillCatalogAdmissionApplicationService,
  resolveAndValidateCandidateMembers,
} from "./catalog-admission-service.js";
export type {
  SkillAdmissionAuthorizationDecision,
  SkillAdmissionReviewReport,
  SkillCatalogAdmissionApplication,
  SkillCatalogAdmissionCandidate,
  SkillCatalogAdmissionCorrectnessPort,
  SkillCatalogAdmissionMutation,
  SkillCatalogAdmissionMutationV2,
  SkillCatalogAdmissionOutcome,
  SkillCatalogAdmissionRequest,
} from "./catalog-admission-service.js";
export { getBuiltinSkill, listBuiltinSkills, renderSkillIndexV2 };

/** Skill-owned management query. */
export type SkillCatalogQuery =
  | { readonly kind: "list" }
  | { readonly kind: "list-v2" };

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
  | {
      readonly kind: "set-visibility";
      readonly skillId: string;
      readonly visibility: SkillVisibility;
      readonly expectedRevision?: number;
    }
  | { readonly kind: "archive"; readonly skillId: string };

/** Stable management projection; it deliberately contains no storage or authority types. */
export interface SkillCatalogView {
  readonly entries: readonly SkillCatalogEntry[];
  readonly catalogRevision: number;
}

export interface SkillCatalogViewV2 {
  readonly entries: readonly SkillCatalogEntryV2[];
  readonly catalogRevision: number;
}

export interface SkillCatalogCommandResult {
  readonly fact: SkillCatalogChangedFact;
}

export interface SkillCatalogApplication {
  query(query: { readonly kind: "list-v2" }): Promise<SkillCatalogViewV2>;
  query(query: SkillCatalogQuery): Promise<SkillCatalogView | SkillCatalogViewV2>;
  execute(command: SkillCatalogCommand): Promise<SkillCatalogCommandResult>;
}

export type SkillCatalogManagementStatePatch =
  | Readonly<{ mode: SkillMode; pinned?: boolean; disabled?: boolean }>
  | Readonly<{ pinned: boolean; mode?: SkillMode; disabled?: boolean }>
  | Readonly<{ disabled: boolean; mode?: SkillMode; pinned?: boolean }>;

export type SkillCatalogManagementMutation =
  | Readonly<{
      kind: "set-state";
      skillId: string;
      patch: SkillCatalogManagementStatePatch;
      expectedRevision: number;
    }>
  | Readonly<{
      kind: "set-visibility";
      skillId: string;
      visibility: SkillVisibility;
      expectedRevision: number;
    }>
  | Readonly<{
      kind: "archive";
      skillId: string;
      expectedRevision: number;
    }>;

export type SkillCatalogManagementCommitResult =
  | Readonly<{ kind: "committed"; catalogRevision: number }>
  | Readonly<{ kind: "conflict"; message: string }>;

/**
 * Skill-owned, topology-neutral Correctness port for management reads and commits.
 * The implementation owns authority generation selection and call fencing.
 */
export interface SkillCatalogManagementCorrectnessPort {
  readCatalog(input: Readonly<{ includeDisabled: boolean }>): Promise<SkillCatalogView>;
  readCatalogV2?(input: Readonly<{ includeDisabled: boolean }>): Promise<SkillCatalogViewV2>;
  readEntry(skillId: string): Promise<SkillCatalogEntry | null>;
  commit(
    mutation: SkillCatalogManagementMutation,
  ): Promise<SkillCatalogManagementCommitResult>;
}

/**
 * Transport-independent Skill management client consumed by product Surfaces.
 *
 * A binding owns connection and wire details. Surfaces can only query the
 * authoritative projection, submit a domain command, and observe committed
 * facts; they cannot infer catalog state from notifications.
 */
export interface SkillCatalogClient {
  query(query: { readonly kind: "list-v2" }): Promise<SkillCatalogViewV2>;
  query(query: SkillCatalogQuery): Promise<SkillCatalogView | SkillCatalogViewV2>;
  command(command: SkillCatalogCommand): Promise<void>;
  onFact(handler: (fact: SkillCatalogChangedFact) => void): () => void;
}

export const SKILL_CATALOG_CHANGED_FACT_EVENT = defineProductApiFactEvent<
  "skill-catalog-changed",
  SkillCatalogChangedFact
>("skill-catalog-changed");

export const SKILL_CATALOG_LIST_QUERY = defineProductApiQuery<
  "skill-catalog.query.list",
  { readonly kind: "list" },
  SkillCatalogView
>("skill-catalog.query.list");

export const SKILL_CATALOG_LIST_V2_QUERY = defineProductApiQuery<
  "skill-catalog.query.list-v2",
  { readonly kind: "list-v2" },
  SkillCatalogViewV2
>("skill-catalog.query.list-v2");

export const SKILL_CATALOG_SET_STATE_COMMAND = defineProductApiCommand<
  "skill-catalog.command.set-state",
  Extract<SkillCatalogCommand, { readonly kind: "set-state" }>,
  SkillCatalogCommandResult,
  SkillCatalogChangedFact
>("skill-catalog.command.set-state", [SKILL_CATALOG_CHANGED_FACT_EVENT]);

export const SKILL_CATALOG_SET_VISIBILITY_COMMAND = defineProductApiCommand<
  "skill-catalog.command.set-visibility",
  Extract<SkillCatalogCommand, { readonly kind: "set-visibility" }>,
  SkillCatalogCommandResult,
  SkillCatalogChangedFact
>("skill-catalog.command.set-visibility", [SKILL_CATALOG_CHANGED_FACT_EVENT]);

export const SKILL_CATALOG_ARCHIVE_COMMAND = defineProductApiCommand<
  "skill-catalog.command.archive",
  Extract<SkillCatalogCommand, { readonly kind: "archive" }>,
  SkillCatalogCommandResult,
  SkillCatalogChangedFact
>("skill-catalog.command.archive", [SKILL_CATALOG_CHANGED_FACT_EVENT]);

export const SKILL_CATALOG_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [
    SKILL_CATALOG_LIST_QUERY,
    SKILL_CATALOG_LIST_V2_QUERY,
    SKILL_CATALOG_SET_STATE_COMMAND,
    SKILL_CATALOG_SET_VISIBILITY_COMMAND,
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
        result: (await application.query(query)) as SkillCatalogView,
        facts: [],
      })),
      bindProductApiOperation(SKILL_CATALOG_LIST_V2_QUERY, async (query) => ({
        result: await application.query(query),
        facts: [],
      })),
      bindProductApiOperation(SKILL_CATALOG_SET_STATE_COMMAND, async (command) => {
        const result = await application.execute(command);
        return { result, facts: [result.fact] };
      }),
      bindProductApiOperation(SKILL_CATALOG_SET_VISIBILITY_COMMAND, async (command) => {
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
  readCatalogV2?(): Promise<{
    readonly catalogRevision: number;
    readonly entries: readonly SkillCatalogEntryV2[];
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
  projectV2?(mode: SkillMode): Promise<SkillCatalogKernelProjection>;
}

/**
 * Skill-owned projection policy for Kernel prompt capabilities.
 *
 * With no source, the same policy produces the builtin-only startup projection.
 * With a source, it owns mode filtering, visibility/disabled filtering, the user top-N pool,
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

  /** V2 限定命名空间索引投影：`user:<id>` 前 20 条（`!disabled && modelAutoIndex`）+ 全量 `system:<id>`，零同名遮蔽。 */
  async projectV2(mode: SkillMode): Promise<SkillCatalogKernelProjection> {
    if (mode !== "main" && mode !== "work") {
      throw new TypeError("Skill capability projection mode is invalid");
    }
    const snapshot = this.source?.readCatalogV2
      ? await this.source.readCatalogV2()
      : this.source
        ? await this.source.readCatalog()
        : { catalogRevision: -1, entries: [] as const };
    const visibleUsers = snapshot.entries
      .filter((entry) => {
        const v2 = entry as Partial<SkillCatalogEntryV2>;
        const autoIndex = v2.visibility ? v2.visibility.modelAutoIndex : true;
        return entry.mode === mode && !entry.disabled && autoIndex;
      })
      .slice(0, SKILL_CATALOG_KERNEL_TOP_N)
      .map((entry) => ({
        id: formatQualifiedSkillId("user", entry.id),
        description: entry.description,
        pinned: entry.pinned,
      }));
    const systems = listBuiltinSkills(mode).map((entry) => ({
      id: formatQualifiedSkillId("system", entry.id),
      description: entry.description,
      pinned: false as const,
    }));
    return Object.freeze({
      catalogRevision: snapshot.catalogRevision,
      content: renderSkillIndexV2([...visibleUsers, ...systems]),
    });
  }
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

/**
 * The single application entry for Skill Catalog management.
 *
 * It owns management rules and only creates a fact after the topology-neutral
 * Correctness port returns the exact committed catalog revision.
 */
export class SkillCatalogApplicationService implements SkillCatalogApplication {
  readonly #correctness: SkillCatalogManagementCorrectnessPort;

  constructor(correctness: SkillCatalogManagementCorrectnessPort) {
    this.#correctness = correctness;
  }

  query(query: { readonly kind: "list-v2" }): Promise<SkillCatalogViewV2>;
  query(query: SkillCatalogQuery): Promise<SkillCatalogView | SkillCatalogViewV2>;
  async query(query: SkillCatalogQuery): Promise<SkillCatalogView | SkillCatalogViewV2> {
    if (query.kind === "list") {
      if (this.#correctness.readCatalogV2) {
        const v2 = await this.#correctness.readCatalogV2({ includeDisabled: true });
        return {
          catalogRevision: v2.catalogRevision,
          entries: v2.entries.map((entry) => projectSkillEntryToV1(entry, "skill-list")),
        };
      }
      return await this.#correctness.readCatalog({ includeDisabled: true });
    }
    if (query.kind === "list-v2") {
      if (this.#correctness.readCatalogV2) {
        return await this.#correctness.readCatalogV2({ includeDisabled: true });
      }
      const fallback = await this.#correctness.readCatalog({ includeDisabled: true });
      return {
        catalogRevision: fallback.catalogRevision,
        entries: fallback.entries.map((entry) => normalizeEntryToV2(entry)),
      };
    }
    throw new SkillCatalogApplicationError(
      "invalid-command",
      "Unsupported Skill Catalog query",
    );
  }

  async execute(command: SkillCatalogCommand): Promise<SkillCatalogCommandResult> {
    const skillId = requireSkillId(command.skillId);
    const statePatch = command.kind === "set-state"
      ? requireStatePatch(command.patch)
      : undefined;
    const visibility = command.kind === "set-visibility"
      ? requireVisibility(command.visibility)
      : undefined;
    if (
      command.kind !== "set-state" &&
      command.kind !== "set-visibility" &&
      command.kind !== "archive"
    ) {
      unsupportedCommand(command);
    }

    const current = await this.#correctness.readEntry(skillId);
    if (!current) {
      throw new SkillCatalogApplicationError(
        "not-found",
        `Skill not found: ${skillId}`,
      );
    }
    if (
      command.kind === "set-visibility" &&
      command.expectedRevision !== undefined &&
      current.revision !== command.expectedRevision
    ) {
      throw new SkillCatalogApplicationError(
        "conflict",
        `Skill revision mismatch: expected ${command.expectedRevision}, actual ${current.revision}`,
      );
    }

    const mutation: SkillCatalogManagementMutation =
      command.kind === "set-state"
        ? {
            kind: "set-state" as const,
            skillId,
            patch: statePatch!,
            expectedRevision: current.revision,
          }
        : command.kind === "set-visibility"
          ? {
              kind: "set-visibility" as const,
              skillId,
              visibility: visibility!,
              expectedRevision: current.revision,
            }
          : {
              kind: "archive" as const,
              skillId,
              expectedRevision: current.revision,
            };

    const committed = await this.#correctness.commit(mutation);
    if (committed.kind === "conflict") {
      throw new SkillCatalogApplicationError("conflict", committed.message);
    }
    if (committed.kind !== "committed") {
      throw new TypeError("Skill catalog commit returned another result type");
    }
    return {
      fact: {
        kind: "skill-catalog-changed",
        catalogRevision: committed.catalogRevision,
      },
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

function requireVisibility(visibility: SkillVisibility): SkillVisibility {
  if (
    !visibility ||
    typeof visibility !== "object" ||
    typeof visibility.modelAutoIndex !== "boolean" ||
    typeof visibility.userSlashCommand !== "boolean"
  ) {
    throw new SkillCatalogApplicationError(
      "invalid-command",
      "Skill visibility requires boolean modelAutoIndex and userSlashCommand",
    );
  }
  return {
    modelAutoIndex: visibility.modelAutoIndex,
    userSlashCommand: visibility.userSlashCommand,
  };
}

function requireStatePatch(
  patch: SkillCatalogStatePatch,
): SkillCatalogManagementStatePatch {
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
