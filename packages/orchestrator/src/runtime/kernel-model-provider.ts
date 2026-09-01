import type {
  LLMRoles,
  ModelBudgetInfo,
  ModelInputCapabilities,
  ResolvedRoleThinking,
} from "@zhixing/core";

export type KernelPrimaryModelRole = "main" | "power";

export interface KernelModelAttentionCapability {
  readonly optimalMaxTokens: number;
  readonly riskMaxTokens: number;
}

/**
 * Host-resolved model adapter input consumed by one Kernel instance.
 *
 * Provider configuration, credentials, protocol quirks and SDK construction are
 * deliberately absent. The Kernel receives only the model/runtime facts it
 * needs after the concrete edge adapter has made those decisions.
 */
export interface KernelModelProviderBinding {
  readonly primaryRole: KernelPrimaryModelRole;
  readonly roles: Readonly<LLMRoles>;
  readonly roleThinking: Readonly<ResolvedRoleThinking>;
  readonly defaultMaxOutputTokens: Readonly<Record<keyof LLMRoles, number>>;
  readonly primary: {
    readonly budget: Readonly<ModelBudgetInfo>;
    readonly inputCapabilities: Readonly<ModelInputCapabilities>;
    readonly attention: KernelModelAttentionCapability;
  };
}

export interface KernelModelProviderFactory {
  create(input: {
    readonly primaryRole: KernelPrimaryModelRole;
    readonly mainModelOverride?: string;
  }): KernelModelProviderBinding;
}

export function createKernelModelProviderBinding(
  input: KernelModelProviderBinding,
): KernelModelProviderBinding {
  const captureRole = (role: LLMRoles[keyof LLMRoles]) =>
    Object.freeze({
      provider: role.provider,
      model: role.model,
      chat: role.chat,
      ...(role.countTokens === undefined
        ? {}
        : { countTokens: role.countTokens }),
    });
  const captureThinking = (
    thinking: ResolvedRoleThinking[keyof ResolvedRoleThinking],
  ) => {
    if (thinking === undefined) return undefined;
    switch (thinking.mode) {
      case "off":
      case "on":
        return Object.freeze({ mode: thinking.mode });
      case "effort":
        return Object.freeze({ mode: thinking.mode, effort: thinking.effort });
      case "budget":
        return Object.freeze({ mode: thinking.mode, budget: thinking.budget });
    }
  };
  const roles = Object.freeze({
    main: captureRole(input.roles.main),
    light: captureRole(input.roles.light),
    power: captureRole(input.roles.power),
  });
  const roleThinking = Object.freeze({
    main: captureThinking(input.roleThinking.main),
    light: captureThinking(input.roleThinking.light),
    power: captureThinking(input.roleThinking.power),
  });
  const binding: KernelModelProviderBinding = Object.freeze({
    primaryRole: input.primaryRole,
    roles,
    roleThinking,
    defaultMaxOutputTokens: Object.freeze({ ...input.defaultMaxOutputTokens }),
    primary: Object.freeze({
      budget: Object.freeze({ ...input.primary.budget }),
      inputCapabilities: Object.freeze({ ...input.primary.inputCapabilities }),
      attention: Object.freeze({ ...input.primary.attention }),
    }),
  });
  assertKernelModelProviderBinding(binding);
  return binding;
}

export function assertKernelModelProviderBinding(
  binding: KernelModelProviderBinding,
  expectedPrimaryRole?: KernelPrimaryModelRole,
): void {
  const roleIds = ["main", "light", "power"] as const;
  const exactKeys = (value: object, expected: readonly string[]): boolean => {
    const actual = Object.keys(value).sort();
    return actual.length === expected.length &&
      actual.every((key, index) => key === [...expected].sort()[index]);
  };
  const validThinking = (
    thinking: ResolvedRoleThinking[keyof ResolvedRoleThinking],
  ): boolean => {
    if (thinking === undefined) return true;
    switch (thinking.mode) {
      case "off":
      case "on":
        return exactKeys(thinking, ["mode"]);
      case "effort":
        return (
          exactKeys(thinking, ["effort", "mode"]) &&
          typeof thinking.effort === "string"
        );
      case "budget":
        return (
          exactKeys(thinking, ["budget", "mode"]) &&
          Number.isFinite(thinking.budget) &&
          thinking.budget >= 0
        );
      default:
        return false;
    }
  };
  if (
    !binding ||
    (binding.primaryRole !== "main" && binding.primaryRole !== "power") ||
    (expectedPrimaryRole !== undefined && binding.primaryRole !== expectedPrimaryRole) ||
    !Object.isFrozen(binding) ||
    !Object.isFrozen(binding.roles) ||
    roleIds.some((roleId) => !Object.isFrozen(binding.roles[roleId])) ||
    !Object.isFrozen(binding.roleThinking) ||
    roleIds.some(
      (roleId) =>
        binding.roleThinking[roleId] !== undefined &&
        !Object.isFrozen(binding.roleThinking[roleId]),
    ) ||
    !Object.isFrozen(binding.defaultMaxOutputTokens) ||
    !Object.isFrozen(binding.primary) ||
    !Object.isFrozen(binding.primary.budget) ||
    !Object.isFrozen(binding.primary.inputCapabilities) ||
    !Object.isFrozen(binding.primary.attention) ||
    !exactKeys(binding, [
      "defaultMaxOutputTokens",
      "primary",
      "primaryRole",
      "roleThinking",
      "roles",
    ]) ||
    !exactKeys(binding.roles, roleIds) ||
    !exactKeys(binding.roleThinking, roleIds) ||
    !exactKeys(binding.defaultMaxOutputTokens, roleIds) ||
    !exactKeys(binding.primary, ["attention", "budget", "inputCapabilities"]) ||
    !exactKeys(binding.primary.budget, ["contextWindow", "maxOutputTokens"]) ||
    !exactKeys(binding.primary.inputCapabilities, ["images"]) ||
    !exactKeys(binding.primary.attention, [
      "optimalMaxTokens",
      "riskMaxTokens",
    ]) ||
    roleIds.some((roleId) => !validThinking(binding.roleThinking[roleId])) ||
    roleIds.some((roleId) => {
      const role = binding.roles[roleId];
      return !role ||
        !role.provider ||
        typeof role.model !== "string" ||
        role.model.length === 0 ||
        !exactKeys(
          role,
          role.countTokens === undefined
            ? ["chat", "model", "provider"]
            : ["chat", "countTokens", "model", "provider"],
        ) ||
        !Number.isFinite(binding.defaultMaxOutputTokens[roleId]) ||
        binding.defaultMaxOutputTokens[roleId] <= 0;
    }) ||
    !Number.isFinite(binding.primary.budget.contextWindow) ||
    binding.primary.budget.contextWindow <= 0 ||
    !Number.isFinite(binding.primary.budget.maxOutputTokens) ||
    binding.primary.budget.maxOutputTokens <= 0 ||
    typeof binding.primary.inputCapabilities.images !== "boolean" ||
    !Number.isFinite(binding.primary.attention.optimalMaxTokens) ||
    binding.primary.attention.optimalMaxTokens <= 0 ||
    !Number.isFinite(binding.primary.attention.riskMaxTokens) ||
    binding.primary.attention.riskMaxTokens <
      binding.primary.attention.optimalMaxTokens
  ) {
    throw new TypeError("Kernel model provider binding must be finite and immutable");
  }
}
