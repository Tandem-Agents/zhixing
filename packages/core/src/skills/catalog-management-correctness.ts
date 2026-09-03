import { randomUUID } from "node:crypto";
import type {
  GlobalControlCallContext,
  GlobalControlMutation,
  GlobalStatePort,
} from "../contracts/index.js";
import type {
  SkillCatalogManagementCorrectnessPort,
  SkillCatalogManagementMutation,
} from "./catalog-application.js";
import { SkillMutationConflictError } from "./global-state-adapter.js";

type SkillCatalogAuthorityMutation = Extract<
  GlobalControlMutation,
  { kind: "skill-set-state" | "skill-archive" }
>;

export interface AnchorSkillCatalogManagementCorrectnessOptions {
  readonly globalState: GlobalStatePort | (() => GlobalStatePort);
  readonly anchorEpoch: number | (() => number);
  readonly requestId?: () => string;
  readonly now?: () => Date;
}

/**
 * Anchor Correctness adapter for Skill Catalog management.
 *
 * It resolves the current Authority generation for every call and is the sole
 * owner of GlobalState call contexts. Skill management rules remain in the
 * domain application behind the topology-neutral port.
 */
export function createAnchorSkillCatalogManagementCorrectnessPort(
  options: AnchorSkillCatalogManagementCorrectnessOptions,
): SkillCatalogManagementCorrectnessPort {
  const state = (): GlobalStatePort => typeof options.globalState === "function"
    ? options.globalState()
    : options.globalState;
  const context = (prefix: string): GlobalControlCallContext => ({
    principal: { kind: "host", component: "skill-catalog-application" },
    requestId: `${prefix}:${options.requestId?.() ?? randomUUID()}`,
    deadlineAt: new Date((options.now?.() ?? new Date()).getTime() + 30_000)
      .toISOString(),
    authority: {
      domain: "global",
      anchorEpoch: typeof options.anchorEpoch === "function"
        ? options.anchorEpoch()
        : options.anchorEpoch,
    },
  });

  return Object.freeze({
    async readCatalog(input: Readonly<{ includeDisabled: boolean }>) {
      const result = await state().read(
        { kind: "skill-catalog", includeDisabled: input.includeDisabled },
        context("skill-list"),
      );
      if (result.kind !== "skill-catalog") {
        throw new TypeError("Skill catalog returned another result type");
      }
      return {
        entries: result.entries,
        catalogRevision: result.catalogRevision,
      };
    },

    async readEntry(skillId: string) {
      const result = await state().read(
        { kind: "skill-get", skillId },
        context("skill-get"),
      );
      if (result.kind !== "skill-get") {
        throw new TypeError("Skill lookup returned another result type");
      }
      return result.entry;
    },

    async commit(mutation: SkillCatalogManagementMutation) {
      try {
        const committed = await state().mutate(
          toAuthorityMutation(mutation),
          context(`skill-${mutation.kind}`),
        );
        return {
          kind: "committed" as const,
          catalogRevision: committed.catalogRevision,
        };
      } catch (error) {
        if (error instanceof SkillMutationConflictError) {
          return {
            kind: "conflict" as const,
            message: error.authorityError.message,
          };
        }
        throw error;
      }
    },
  });
}

function toAuthorityMutation(
  mutation: SkillCatalogManagementMutation,
): SkillCatalogAuthorityMutation {
  return mutation.kind === "set-state"
    ? {
        kind: "skill-set-state",
        skillId: mutation.skillId,
        patch: { ...mutation.patch },
        expectedRevision: mutation.expectedRevision,
      }
    : {
        kind: "skill-archive",
        skillId: mutation.skillId,
        expectedRevision: mutation.expectedRevision,
      };
}
