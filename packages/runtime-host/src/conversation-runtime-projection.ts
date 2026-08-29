import type { ToolDefinition } from "@zhixing/core";
import {
  assertKernelRuntimeIdentityContribution,
  type CreateAgentRuntimeOptions,
} from "@zhixing/orchestrator/runtime";

type RuntimeProfile = NonNullable<CreateAgentRuntimeOptions["profile"]>;
type RuntimeIdentity = NonNullable<CreateAgentRuntimeOptions["runtimeIdentity"]>;
type RuntimePrimaryRole = NonNullable<CreateAgentRuntimeOptions["primaryRole"]>;

/**
 * Product-owned, immutable input for issuing one conversation runtime.
 *
 * RuntimeHost treats this as an already-decided projection: it does not select a
 * product profile, workspace, identity, or product-specific tools.
 */
export interface ConversationRuntimeProjection {
  readonly workspace?: string | null;
  readonly primaryRole: RuntimePrimaryRole;
  readonly profile: Readonly<RuntimeProfile>;
  readonly runtimeIdentity?: Readonly<RuntimeIdentity>;
  readonly productTools: readonly Readonly<ToolDefinition>[];
}

export function createConversationRuntimeProjection(input: {
  readonly workspace?: string | null;
  readonly primaryRole: RuntimePrimaryRole;
  readonly profile: RuntimeProfile;
  readonly runtimeIdentity?: RuntimeIdentity;
  readonly productTools: readonly ToolDefinition[];
}): ConversationRuntimeProjection {
  const profile = Object.freeze({
    ...input.profile,
    constraints: Object.freeze([...input.profile.constraints]),
    enabledTools: Object.freeze([...input.profile.enabledTools]),
    ...(input.profile.capabilities
      ? { capabilities: Object.freeze({ ...input.profile.capabilities }) }
      : {}),
  });
  const runtimeIdentity = input.runtimeIdentity;
  if (runtimeIdentity !== undefined) {
    assertKernelRuntimeIdentityContribution(runtimeIdentity);
  }
  const productTools = Object.freeze(
    input.productTools.map((tool) => Object.freeze(tool)),
  );
  return Object.freeze({
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    primaryRole: input.primaryRole,
    profile,
    ...(runtimeIdentity ? { runtimeIdentity } : {}),
    productTools,
  });
}

export function assertConversationRuntimeProjection(
  projection: ConversationRuntimeProjection,
): void {
  if (
    !projection ||
    (projection.primaryRole !== "main" && projection.primaryRole !== "power") ||
    (projection.workspace !== undefined &&
      projection.workspace !== null &&
      typeof projection.workspace !== "string") ||
    !projection.profile ||
    !Array.isArray(projection.profile.constraints) ||
    !Array.isArray(projection.profile.enabledTools) ||
    !Array.isArray(projection.productTools) ||
    projection.productTools.some(
      (tool) => !tool || typeof tool.name !== "string" || !tool.name,
    ) ||
    !Object.isFrozen(projection) ||
    !Object.isFrozen(projection.profile) ||
    !Object.isFrozen(projection.profile.constraints) ||
    !Object.isFrozen(projection.profile.enabledTools) ||
    !Object.isFrozen(projection.productTools) ||
    projection.productTools.some((tool) => !Object.isFrozen(tool))
  ) {
    throw new TypeError("Conversation runtime projection must be immutable");
  }
  if (projection.runtimeIdentity !== undefined) {
    assertKernelRuntimeIdentityContribution(projection.runtimeIdentity);
  }
}
