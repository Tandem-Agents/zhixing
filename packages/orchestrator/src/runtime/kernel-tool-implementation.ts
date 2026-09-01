import type { PermissionRule, SkillMode, ToolDefinition } from "@zhixing/core";
import type {
  SkillCatalogAdmissionApplication,
  SkillCatalogLoadApplication,
  SkillCatalogSaveApplication,
} from "@zhixing/core/skills/catalog";

/** Host-provided finite implementation input for one Kernel runtime instance. */
export interface KernelToolImplementationRequest {
  readonly requestedToolNames: readonly string[];
  readonly networkProxy?: string;
  readonly skillCatalogLoad: SkillCatalogLoadApplication;
  readonly skillCatalogSave: SkillCatalogSaveApplication;
  readonly skillCatalogAdmission: SkillCatalogAdmissionApplication;
  readonly skillMode: SkillMode;
}

export interface KernelToolPermissionRuleSet {
  readonly namespace: string;
  readonly rules: readonly PermissionRule[];
}

export interface KernelToolImplementationAssembly {
  readonly tools: readonly ToolDefinition[];
  readonly permissionRuleSets: readonly KernelToolPermissionRuleSet[];
}

/**
 * Demand-owned port. Profiles name required tools; the Host selects their implementation.
 * Implementations must return a frozen, order-preserving exact projection.
 */
export interface KernelToolImplementationPort {
  readonly create: (
    request: KernelToolImplementationRequest,
  ) => KernelToolImplementationAssembly;
}

export function assembleKernelToolImplementation(
  implementation: KernelToolImplementationPort,
  request: KernelToolImplementationRequest,
): KernelToolImplementationAssembly {
  if (!Object.isFrozen(implementation) || typeof implementation.create !== "function") {
    throw new TypeError("Kernel Tool implementation port must be frozen");
  }
  if (
    !Object.isFrozen(request.requestedToolNames) ||
    new Set(request.requestedToolNames).size !== request.requestedToolNames.length
  ) {
    throw new TypeError("Kernel Tool request names must be a frozen unique sequence");
  }
  const assembly = implementation.create(Object.freeze({ ...request }));
  if (
    !assembly ||
    !Object.isFrozen(assembly) ||
    !Object.isFrozen(assembly.tools) ||
    !Object.isFrozen(assembly.permissionRuleSets)
  ) {
    throw new TypeError("Kernel Tool implementation assembly must be frozen");
  }
  if (
    assembly.tools.length !== request.requestedToolNames.length ||
    assembly.tools.some((tool, index) =>
      !tool || tool.name !== request.requestedToolNames[index])
  ) {
    throw new TypeError("Kernel Tool implementation must satisfy the exact requested sequence");
  }
  const namespaces = new Set<string>();
  for (const contribution of assembly.permissionRuleSets) {
    if (
      !Object.isFrozen(contribution) ||
      !Object.isFrozen(contribution.rules) ||
      !contribution.namespace ||
      namespaces.has(contribution.namespace)
    ) {
      throw new TypeError("Kernel Tool permission rule contributions must be frozen and unique");
    }
    namespaces.add(contribution.namespace);
  }
  return assembly;
}
