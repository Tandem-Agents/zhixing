import type { ArtifactStore } from "@zhixing-ai/core/authority";
import type { SkillMode } from "@zhixing-ai/core/skills/catalog";
import type {
  KernelToolImplementationPort,
  KernelToolPermissionRuleSet,
} from "@zhixing-ai/orchestrator/runtime";
import {
  BUILTIN_TOOL_FACTORIES,
  WEB_FETCH_DEFAULT_RULES,
} from "@zhixing-ai/tools-builtin";
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

/**
 * 内置工具随工具集合贡献的权限规则（纯规则，不构造工具）。运行时装配与没有 owner 侧
 * 运行时的派发（job 冻结快照）都从这里取，保证两处是同一份贡献。
 */
export function hostToolPermissionRuleSets(
  toolNames: readonly string[],
): readonly KernelToolPermissionRuleSet[] {
  return Object.freeze(toolNames.includes("web_fetch")
    ? [Object.freeze({ namespace: "web_fetch", rules: Object.freeze([...WEB_FETCH_DEFAULT_RULES]) })]
    : []);
}

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
        permissionRuleSets: hostToolPermissionRuleSets(request.requestedToolNames),
      });
    }) satisfies KernelToolImplementationPort["create"],
  });
}
