import type {
  ToolDefinition,
} from "@zhixing/core/types";
import {
  assertKernelWindowPromptProjectionPort,
  type AgentRuntimeLifecycle,
  type CreateAgentRuntimeOptions,
  type KernelSecurityExecutionFactory,
  type KernelWindowPromptProjectionPort,
  type KernelToolImplementationPort,
} from "@zhixing/orchestrator/runtime";

type RuntimeProfile = NonNullable<CreateAgentRuntimeOptions["profile"]>;
type RuntimePrimaryRole = NonNullable<CreateAgentRuntimeOptions["primaryRole"]>;

/**
 * Product-owned, immutable tool input for issuing any Anchor runtime.
 *
 * RuntimeHost only validates and forwards this projection. It does not know how
 * Schedule, Task, MCP or another product tool was selected.
 */
export interface RuntimeToolProjection {
  readonly extraTools: readonly Readonly<ToolDefinition>[];
  readonly executionMcpServers: readonly string[];
  readonly implementation: KernelToolImplementationPort;
}

/** Product-owned immutable inputs shared by every runtime issuance shape. */
export interface RuntimeProductProjection {
  readonly runtimeTools: RuntimeToolProjection;
  readonly windowPrompt: KernelWindowPromptProjectionPort;
  readonly securityExecution: KernelSecurityExecutionFactory;
}

export function createRuntimeProductProjection(input: {
  readonly runtimeTools: RuntimeToolProjection;
  readonly windowPrompt: KernelWindowPromptProjectionPort;
  readonly securityExecution: KernelSecurityExecutionFactory;
}): RuntimeProductProjection {
  assertRuntimeToolProjection(input.runtimeTools);
  assertKernelWindowPromptProjectionPort(input.windowPrompt);
  return Object.freeze({
    runtimeTools: input.runtimeTools,
    windowPrompt: input.windowPrompt,
    securityExecution: input.securityExecution,
  });
}

export function assertRuntimeProductProjection(
  projection: RuntimeProductProjection,
): void {
  const keys =
    projection && typeof projection === "object"
      ? Object.keys(projection).sort()
      : [];
  if (
    !projection ||
    !Object.isFrozen(projection) ||
    keys.length !== 3 ||
    keys[0] !== "runtimeTools" ||
    keys[1] !== "securityExecution" ||
    keys[2] !== "windowPrompt" ||
    !Object.isFrozen(projection.securityExecution) ||
    typeof projection.securityExecution.create !== "function"
  ) {
    throw new TypeError("Runtime product projection must be finite and immutable");
  }
  assertRuntimeToolProjection(projection.runtimeTools);
  assertKernelWindowPromptProjectionPort(projection.windowPrompt);
}

export function createRuntimeToolProjection(input: {
  readonly extraTools: readonly ToolDefinition[];
  readonly executionMcpServers: readonly string[];
  readonly implementation: KernelToolImplementationPort;
}): RuntimeToolProjection {
  const toolNames = new Set<string>();
  for (const tool of input.extraTools) {
    if (
      !tool ||
      typeof tool.name !== "string" ||
      !tool.name ||
      toolNames.has(tool.name)
    ) {
      throw new TypeError(
        "Runtime tool projection contains an invalid or duplicate tool",
      );
    }
    toolNames.add(tool.name);
  }
  const serverIds = new Set<string>();
  for (const serverId of input.executionMcpServers) {
    if (typeof serverId !== "string" || !serverId || serverIds.has(serverId)) {
      throw new TypeError(
        "Runtime tool projection contains an invalid or duplicate MCP server",
      );
    }
    serverIds.add(serverId);
  }
  return Object.freeze({
    extraTools: Object.freeze(
      input.extraTools.map((tool) => Object.freeze({ ...tool })),
    ),
    executionMcpServers: Object.freeze([...input.executionMcpServers]),
    implementation: input.implementation,
  });
}

export function assertRuntimeToolProjection(
  projection: RuntimeToolProjection,
): void {
  const keys =
    projection && typeof projection === "object"
      ? Object.keys(projection).sort()
      : [];
  if (
    !projection ||
    !Array.isArray(projection.extraTools) ||
    !Array.isArray(projection.executionMcpServers) ||
    !Object.isFrozen(projection) ||
    !Object.isFrozen(projection.extraTools) ||
    !Object.isFrozen(projection.executionMcpServers) ||
    keys.length !== 3 ||
    keys[0] !== "executionMcpServers" ||
    keys[1] !== "extraTools" ||
    keys[2] !== "implementation" ||
    !Object.isFrozen(projection.implementation) ||
    typeof projection.implementation.create !== "function" ||
    projection.extraTools.some(
      (tool) =>
        !tool ||
        typeof tool.name !== "string" ||
        !tool.name ||
        !Object.isFrozen(tool),
    ) ||
    projection.executionMcpServers.some(
      (serverId) => typeof serverId !== "string" || !serverId,
    ) ||
    new Set(projection.extraTools.map((tool) => tool.name)).size !==
      projection.extraTools.length ||
    new Set(projection.executionMcpServers).size !==
      projection.executionMcpServers.length
  ) {
    throw new TypeError("Runtime tool projection must be finite and immutable");
  }
}

/**
 * Product-owned, immutable input for issuing one conversation runtime.
 *
 * RuntimeHost treats this as an already-decided projection: it does not select a
 * product profile, workspace, identity, or product-specific tools.
 */
export interface ConversationRuntimeProjection extends RuntimeProductProjection {
  readonly workspace?: string | null;
  readonly primaryRole: RuntimePrimaryRole;
  readonly profile: Readonly<RuntimeProfile>;
  readonly lifecycle?: readonly AgentRuntimeLifecycle[];
}

export function createConversationRuntimeProjection(input: {
  readonly workspace?: string | null;
  readonly primaryRole: RuntimePrimaryRole;
  readonly profile: RuntimeProfile;
  readonly lifecycle?: readonly AgentRuntimeLifecycle[];
  readonly runtimeTools: RuntimeToolProjection;
  readonly windowPrompt: KernelWindowPromptProjectionPort;
  readonly securityExecution: KernelSecurityExecutionFactory;
}): ConversationRuntimeProjection {
  const profile = Object.freeze({
    ...input.profile,
    constraints: Object.freeze([...input.profile.constraints]),
    enabledTools: Object.freeze([...input.profile.enabledTools]),
    ...(input.profile.capabilities
      ? { capabilities: Object.freeze({ ...input.profile.capabilities }) }
      : {}),
  });
  const lifecycle = input.lifecycle
    ? Object.freeze([...input.lifecycle])
    : undefined;
  assertRuntimeToolProjection(input.runtimeTools);
  assertKernelWindowPromptProjectionPort(input.windowPrompt);
  return Object.freeze({
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    primaryRole: input.primaryRole,
    profile,
    ...(lifecycle ? { lifecycle } : {}),
    runtimeTools: input.runtimeTools,
    windowPrompt: input.windowPrompt,
    securityExecution: input.securityExecution,
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
    !Object.isFrozen(projection) ||
    !Object.isFrozen(projection.profile) ||
    !Object.isFrozen(projection.profile.constraints) ||
    !Object.isFrozen(projection.profile.enabledTools)
    || (projection.lifecycle !== undefined &&
      (!Object.isFrozen(projection.lifecycle) ||
        projection.lifecycle.some(
          (entry) =>
            !entry || typeof entry.id !== "string" || entry.id.length === 0,
        )))
  ) {
    throw new TypeError("Conversation runtime projection must be immutable");
  }
  assertRuntimeToolProjection(projection.runtimeTools);
  assertKernelWindowPromptProjectionPort(projection.windowPrompt);
  if (
    !Object.isFrozen(projection.securityExecution) ||
    typeof projection.securityExecution.create !== "function"
  ) {
    throw new TypeError("Conversation Security execution must be immutable");
  }
}
