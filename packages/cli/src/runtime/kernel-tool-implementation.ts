import type { ArtifactStore } from "@zhixing/core/authority";
import type { SkillMode } from "@zhixing/core/skills/catalog";
import type { KernelToolImplementationPort } from "@zhixing/orchestrator/runtime";
import {
  BUILTIN_TOOL_FACTORIES,
  WEB_FETCH_DEFAULT_RULES,
} from "@zhixing/tools-builtin";
import {
  createAssignmentSkillPorts,
  createBuiltinOnlyAssignmentSkillPorts,
} from "./assignment-skill-adapter.js";

export type HostSkillToolBinding =
  | Readonly<{
      kind: "assignment";
      mode: SkillMode;
      artifacts: ArtifactStore;
    }>
  | Readonly<{
      kind: "builtin-only";
      mode: SkillMode;
    }>;

export type HostKernelToolImplementationFactory = (
  binding: HostSkillToolBinding,
) => KernelToolImplementationPort;

/** The Host edge is the only production selector for concrete built-in tools. */
export function createHostKernelToolImplementation(
  binding: HostSkillToolBinding,
): KernelToolImplementationPort {
  if (!Object.isFrozen(binding)) {
    throw new TypeError("Host Skill tool binding must be frozen");
  }
  return Object.freeze({
    create: ((request) => {
      const skillPorts = binding.kind === "assignment"
        ? createAssignmentSkillPorts(binding.artifacts, {
            admissionLlm: request.callText,
          })
        : createBuiltinOnlyAssignmentSkillPorts();
      const tools = request.requestedToolNames.map((name) => {
        const factory = Object.hasOwn(BUILTIN_TOOL_FACTORIES, name)
          ? BUILTIN_TOOL_FACTORIES[name]
          : undefined;
        if (!factory) {
          throw new Error(`Kernel Tool implementation does not provide "${name}"`);
        }
        const tool = factory({
          proxy: request.networkProxy,
          skillCatalogLoad: skillPorts.loadApplication,
          skillCatalogSave: skillPorts.saveApplication,
          skillCatalogAdmission: skillPorts.admissionApplication,
          skillMode: binding.mode,
        });
        if (tool.name !== name) {
          throw new TypeError(
            `Kernel Tool implementation returned "${tool.name}" for "${name}"`,
          );
        }
        return tool;
      });
      return Object.freeze({
        tools: Object.freeze(tools),
        permissionRuleSets: Object.freeze([
          Object.freeze({
            namespace: "web_fetch",
            rules: Object.freeze([...WEB_FETCH_DEFAULT_RULES]),
          }),
        ]),
      });
    }) satisfies KernelToolImplementationPort["create"],
  });
}
