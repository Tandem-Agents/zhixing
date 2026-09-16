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

export type JobRuntimeCapabilities = Pick<
  import("@zhixing/core/types").RuntimeExecutionProfile,
  "tools" | "mcpServers"
>;

/**
 * 装配已签发 Job 的冻结能力；实时目录只能提供实现，不能扩张签发范围。
 */
export function selectJobRuntimeTools(
  input: Readonly<{
    instruction: JobExecutionInstruction;
    capabilities: JobRuntimeCapabilities;
    baseProfile: AgentRoleProfile;
    extraTools: readonly ToolDefinition[];
    executionMcpServers: readonly string[];
    implementation: RuntimeToolProjection["implementation"];
  }>,
): JobRuntimeToolSelection {
  const requested = new Set(input.capabilities.tools);
  if (
    input.instruction.tools &&
    (input.instruction.tools.some((tool) => !requested.has(tool)) ||
      requested.size !== new Set(input.instruction.tools).size)
  )
    throw new TypeError(
      "Job instruction tools differ from its frozen manifest",
    );
  {
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
  const unavailableServers = input.capabilities.mcpServers.filter(
    (server) => !input.executionMcpServers.includes(server),
  );
  if (unavailableServers.length) {
    throw new TypeError(
      `Job requested unavailable MCP servers: ${unavailableServers.join(", ")}`,
    );
  }
  const profile = Object.freeze({
    ...input.baseProfile,
    constraints: Object.freeze([...input.baseProfile.constraints]),
    enabledTools: Object.freeze(
      input.baseProfile.enabledTools.filter((tool) => requested.has(tool)),
    ),
    ...(input.baseProfile.capabilities
      ? { capabilities: Object.freeze({ ...input.baseProfile.capabilities }) }
      : {}),
  });
  return Object.freeze({
    profile,
    runtimeTools: createRuntimeToolProjection({
      extraTools: input.extraTools.filter((tool) => requested.has(tool.name)),
      executionMcpServers: [...input.capabilities.mcpServers],
      implementation: input.implementation,
    }),
    ...(input.instruction.model
      ? { modelOverride: input.instruction.model }
      : {}),
  });
}
