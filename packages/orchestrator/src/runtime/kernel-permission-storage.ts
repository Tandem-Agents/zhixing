import type {
  PermissionRuleExecutionSource,
  SecurityRequest,
} from "@zhixing/core";
import type {
  TrustAdministrationContext,
  TrustAdministrationExecutionRepository,
} from "@zhixing/core/trust-administration";
import type { KernelToolPermissionRuleSet } from "./kernel-tool-implementation.js";

/** Finite Host request for one runtime's permission persistence mechanism. */
export interface KernelPermissionStorageRequest {
  readonly extractArgument: (request: SecurityRequest) => string;
  readonly builtinRuleSets: readonly KernelToolPermissionRuleSet[];
}

/**
 * One runtime-scoped permission mechanism binding.
 *
 * The Kernel receives only the Trust application's repository mechanism and a
 * context-bound readonly Security source. Concrete stores, paths and storage
 * lifecycle never cross this boundary.
 */
export interface KernelPermissionStorageBinding {
  readonly trustAdministration: TrustAdministrationExecutionRepository;
  readonly rulesFor: (
    context: TrustAdministrationContext,
  ) => PermissionRuleExecutionSource;
}

/** Host-owned selector for the concrete permission persistence mechanism. */
export interface KernelPermissionStorageFactory {
  readonly create: (
    request: KernelPermissionStorageRequest,
  ) => KernelPermissionStorageBinding;
}

/** Capture one complete binding before the runtime is published. */
export function assembleKernelPermissionStorage(
  factory: KernelPermissionStorageFactory,
  request: KernelPermissionStorageRequest,
): KernelPermissionStorageBinding {
  if (
    !factory ||
    !Object.isFrozen(factory) ||
    typeof factory.create !== "function"
  ) {
    throw new TypeError("Kernel permission storage factory must be frozen");
  }
  if (
    !request ||
    !Object.isFrozen(request) ||
    typeof request.extractArgument !== "function" ||
    !Object.isFrozen(request.builtinRuleSets)
  ) {
    throw new TypeError("Kernel permission storage request must be finite and immutable");
  }
  const binding = factory.create(request);
  if (
    !binding ||
    !Object.isFrozen(binding) ||
    !binding.trustAdministration ||
    typeof binding.trustAdministration.workspaceIdentity !== "function" ||
    typeof binding.trustAdministration.listExecutionRules !== "function" ||
    typeof binding.trustAdministration.snapshotExecutionRules !== "function" ||
    typeof binding.trustAdministration.createExecutionRule !== "function" ||
    typeof binding.rulesFor !== "function"
  ) {
    throw new TypeError("Kernel permission storage binding is incomplete");
  }
  return binding;
}

/** Validate the context-bound readonly source before Security consumes it. */
export function bindKernelPermissionRuleSource(
  binding: KernelPermissionStorageBinding,
  context: TrustAdministrationContext,
): PermissionRuleExecutionSource {
  const source = binding.rulesFor(context);
  if (
    !source ||
    !Object.isFrozen(source) ||
    typeof source.match !== "function" ||
    typeof source.matchFrozen !== "function"
  ) {
    throw new TypeError("Kernel permission rule source is incomplete");
  }
  return source;
}
