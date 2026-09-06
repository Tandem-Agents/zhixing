import {
  SkillCatalogKernelProjectionApplicationService,
  type SkillCatalogKernelProjectionSource,
  type SkillMode,
} from "@zhixing/core/skills/catalog";
import type { AssignmentGlobalQueryPort } from "@zhixing/core/contracts";
import {
  createKernelWindowPromptProjection,
  type KernelWindowPromptProjectionPort,
} from "@zhixing/orchestrator/runtime";

/**
 * Anchor/Executor product-edge binding from the Skill domain projection to the
 * generic Kernel attention-window prompt contract.
 */
export function createSkillCatalogWindowPromptProjection(
  mode: SkillMode,
): KernelWindowPromptProjectionPort {
  if (mode !== "main" && mode !== "work") {
    throw new TypeError("Skill capability projection mode is invalid");
  }
  return Object.freeze({
    async project(query?: AssignmentGlobalQueryPort) {
      const application = new SkillCatalogKernelProjectionApplicationService(
        query ? createCatalogSource(query) : undefined,
      );
      const projection = await application.project(mode);
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
  });
}
