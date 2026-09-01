import type { ToolDefinition } from "@zhixing/core";
import type { JobExecutionInstruction } from "@zhixing/core/contracts";
import type { AgentRoleProfile } from "@zhixing/orchestrator/profile";
import {
  createRuntimeToolProjection,
  type RuntimeToolProjection,
} from "@zhixing/runtime-host/conversation-runtime-projection";

export interface JobRuntimeToolSelection {
  readonly profile: Readonly<AgentRoleProfile>;
  readonly runtimeTools: RuntimeToolProjection;
  readonly modelOverride?: string;
}

/**
 * The one Host-edge policy for applying a durable job's requested-tool
 * allowlist to the concrete tools available in the selected topology.
 */
export function selectJobRuntimeTools(input: Readonly<{
  instruction: JobExecutionInstruction;
  baseProfile: AgentRoleProfile;
  extraTools: readonly ToolDefinition[];
  executionMcpServers: readonly string[];
}>): JobRuntimeToolSelection {
  const requested = input.instruction.tools
    ? new Set(input.instruction.tools)
    : undefined;
  if (requested) {
    const available = new Set([
      ...input.baseProfile.enabledTools,
      ...input.extraTools.map((tool) => tool.name),
    ]);
    const unknown = [...requested].filter((tool) => !available.has(tool));
    if (unknown.length > 0) {
      throw new TypeError(
        `Job requested unavailable tools: ${unknown.sort().join(", ")}`,
      );
    }
  }
  const profile = Object.freeze({
    ...input.baseProfile,
    constraints: Object.freeze([...input.baseProfile.constraints]),
    enabledTools: Object.freeze(
      requested
        ? input.baseProfile.enabledTools.filter((tool) => requested.has(tool))
        : [...input.baseProfile.enabledTools],
    ),
    ...(input.baseProfile.capabilities
      ? { capabilities: Object.freeze({ ...input.baseProfile.capabilities }) }
      : {}),
  });
  return Object.freeze({
    profile,
    runtimeTools: createRuntimeToolProjection({
      extraTools: requested
        ? input.extraTools.filter((tool) => requested.has(tool.name))
        : [...input.extraTools],
      executionMcpServers: input.executionMcpServers,
    }),
    ...(input.instruction.model
      ? { modelOverride: input.instruction.model }
      : {}),
  });
}
