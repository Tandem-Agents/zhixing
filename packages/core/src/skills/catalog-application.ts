import { randomUUID } from "node:crypto";
import type {
  GlobalControlCallContext,
  GlobalStatePort,
  SkillStatePatch,
} from "../contracts/index.js";
import { SkillMutationConflictError } from "./global-state-adapter.js";
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
