import {
  SkillCatalogKernelProjectionApplicationService,
  type SkillCatalogKernelProjectionSource,
  type SkillMode,
} from "@zhixing-ai/core/skills/catalog";

const DEFAULT_VISIBILITY = Object.freeze({
  modelAutoIndex: true,
  userSlashCommand: true,
});
import type { AssignmentGlobalQueryPort } from "@zhixing-ai/core/contracts";
import {
  createKernelWindowPromptProjection,
  type KernelWindowPromptProjectionPort,
} from "@zhixing-ai/orchestrator/runtime";

export interface SkillCatalogWindowPromptOptions {
  readonly legacyV1Only?: boolean;
  readonly builtinOnly?: boolean;
}

/**
 * Anchor/Executor product-edge binding from the Skill domain projection to the
 * generic Kernel attention-window prompt contract.
 */
export function createSkillCatalogWindowPromptProjection(
  mode: SkillMode,
  options: SkillCatalogWindowPromptOptions = {},
): KernelWindowPromptProjectionPort {
  if (mode !== "main" && mode !== "work") {
    throw new TypeError("Skill capability projection mode is invalid");
  }
  return Object.freeze({
    async project(query?: AssignmentGlobalQueryPort) {
      if (options.builtinOnly || !query) {
        const application = new SkillCatalogKernelProjectionApplicationService(undefined);
        const projection = options.legacyV1Only
          ? await application.project(mode)
          : await application.projectV2(mode);
        return createKernelWindowPromptProjection({
          revision: projection.catalogRevision,
          segment: "skill-index",
          content: projection.content,
        });
      }
      const application = new SkillCatalogKernelProjectionApplicationService(
        createCatalogSource(query),
      );
      const projection = options.legacyV1Only
        ? await application.project(mode)
        : await application.projectV2(mode);
      return createKernelWindowPromptProjection({
        revision: projection.catalogRevision,
        segment: "skill-index",
        content: projection.content,
      });
    },
  });
}

function createCatalogSource(
  query: AssignmentGlobalQueryPort,
): SkillCatalogKernelProjectionSource {
  return Object.freeze({
    async readCatalog() {
      const result = await query.read({
        kind: "skill-catalog",
        includeDisabled: true,
      });
      if (result.kind !== "skill-catalog") {
        throw new Error("Skill catalog query returned another result type");
      }
      return Object.freeze({
        catalogRevision: result.catalogRevision,
        entries: result.entries,
      });
    },
    async readCatalogV2() {
      try {
        const result = await query.read({
          kind: "skill-catalog-v2",
          includeDisabled: true,
        });
        if (result.kind === "skill-catalog-v2") {
          return Object.freeze({
            catalogRevision: result.catalogRevision,
            entries: result.entries,
          });
        }
      } catch {
        // Older v1 anchors only support "skill-catalog"; fall back cleanly.
      }
      const fallback = await query.read({
        kind: "skill-catalog",
        includeDisabled: true,
      });
      if (fallback.kind !== "skill-catalog") {
        throw new Error("Skill catalog query returned another result type");
      }
      return Object.freeze({
        catalogRevision: fallback.catalogRevision,
        entries: fallback.entries.map((entry) => ({
          ...entry,
          visibility: DEFAULT_VISIBILITY,
        })),
      });
    },
  });
}
