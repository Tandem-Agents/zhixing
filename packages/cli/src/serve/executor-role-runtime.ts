import { getZhixingHome, type ToolDefinition } from "@zhixing/core";
import { createMcpHub, mapServerTools, type McpHub } from "@zhixing/mcp";
import {
  createAgentRuntime,
  type AgentRuntime,
} from "@zhixing/orchestrator/runtime";
import { mainProfile } from "@zhixing/orchestrator/profile";
import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";
import { parseServerSpecs } from "../runtime/mcp-config.js";
import { createStdoutWriter } from "../screen/index.js";
import { resolveSystemProtectedSecretPaths } from "../security/secret-boundary.js";
import { setupAuthorityRuntime } from "../setup-delivery.js";
import { ZHIXING_CLI_VERSION } from "../version.js";
import { createConversationExecutorLedger } from "./conversation-executor-ledger.js";
import { DurableConversationInteractionObserver } from "./durable-conversation-interactions.js";
import { createExecutorReadinessSource } from "./executor-readiness.js";
import {
  executorIdForDevice,
  MeshRuntimeAssembly,
} from "./mesh-runtime-assembly.js";
import type { ServeOptions } from "./command.js";
import type {
  ExecutorRoleModule,
  ServeBootstrapContext,
} from "./role-topology.js";

export async function runExecutorRole(
  _options: ServeOptions,
  bootstrap: ServeBootstrapContext,
  executor?: ExecutorRoleModule,
): Promise<void> {
  if (!executor) throw new Error("Executor role module is unavailable");
  if (bootstrap.mesh.mode !== "trusted-home") {
    throw new Error("A standalone executor requires an established home trust chain");
  }
  if (
    !bootstrap.mesh.roles.includes("executor") ||
    bootstrap.mesh.roles.includes("anchor")
  ) {
    throw new Error("Executor-only host received an incompatible role projection");
  }

  const startup = bootstrap.startup;
  const providerCredentials = startup.credentials.providers
    ? { providers: startup.credentials.providers }
    : {};
  const mcpHub = createMcpHub(
    parseServerSpecs(startup.config.mcp, startup.credentials.mcp),
    { networkProxy: startup.config.network?.proxy },
  );
  await mcpHub.connectAll();
  const writer = createStdoutWriter();

  let mesh: MeshRuntimeAssembly | undefined;
  try {
    const interactions = new DurableConversationInteractionObserver();
    const runtime = new ExecutorRuntimeSubstrate({
      config: startup.config,
      credentials: providerCredentials,
      mcpHub,
      systemProtectedPaths: resolveSystemProtectedSecretPaths(),
      interactions,
    });
    const authority = await setupAuthorityRuntime({
      zhixingHome: getZhixingHome(),
      secretStore: bootstrap.secretStore,
      deviceKey: bootstrap.mesh.deviceKey,
      trustedIdentities: bootstrap.mesh.trustedIdentities,
      authorizedDeviceIds: bootstrap.mesh.authorizedDeviceIds,
      executorId: executorIdForDevice(bootstrap.mesh.deviceKey.deviceId),
      configurationSnapshot: {
        config: startup.config,
        executableVersion: ZHIXING_CLI_VERSION,
      },
      executorReadiness: createExecutorReadinessSource({
        runtime,
        credentials: startup.credentials,
        credentialGeneration: startup.credentialGeneration,
      }),
      enableAnchor: false,
      enableLocalExecutor: true,
    });
    const ledger = createConversationExecutorLedger({
      Constructor: executor.ConversationAssignmentLedger,
      authority,
      usageFinal: (assignmentId) => {
        if (!mesh) throw new Error("Executor mesh runtime is not ready");
        return mesh.finalizeExecutorUsage(assignmentId);
      },
    });
    const role = executor.createExecutorRole({
      createAgentRuntime: () => runtime.createConversationRuntime(),
    });
    const runtimeFactory = executor.createInProcessRuntimeFactory(role);
    mesh = new MeshRuntimeAssembly({
      zhixingHome: getZhixingHome(),
      trust: bootstrap.mesh.trust,
      configuration: bootstrap.mesh.configuration,
      endpoints: bootstrap.mesh.endpoints,
      transportPeers: bootstrap.mesh.transportPeers,
      bootstrapStore: bootstrap.mesh.bootstrapStore,
      authority,
      executor: {
        ledger,
        runtimeFactory,
        interactions,
        InProcessAssignmentSubmission: executor.InProcessAssignmentSubmission,
      },
      secretStore: bootstrap.secretStore,
      onError: (error) => writer.notify(`[mesh] ${error.message}`),
    });
    await mesh.start();
    await waitForRoleShutdown();
  } finally {
    await mesh?.stop();
    await mcpHub.dispose();
  }
}

class ExecutorRuntimeSubstrate {
  constructor(private readonly options: {
    readonly config: ZhixingConfig;
    readonly credentials: Pick<ZhixingCredentials, "providers">;
    readonly mcpHub: McpHub;
    readonly systemProtectedPaths: readonly string[];
    readonly interactions: DurableConversationInteractionObserver;
  }) {}

  createConversationRuntime(): Promise<AgentRuntime> {
    const catalog = this.options.mcpHub.catalog();
    return createAgentRuntime({
      providerConfiguration: {
        config: this.options.config,
        credentials: this.options.credentials,
      },
      profile: mainProfile(),
      extraTools: mapMcpTools(this.options.mcpHub),
      executionMcpServers: catalog.map(({ server }) => server.serverId).sort(),
      confirmationLifecycleObserver: this.options.interactions,
      systemProtectedPaths: this.options.systemProtectedPaths,
      runtimeKind: "conversation",
    });
  }

  capabilityCatalog(): {
    readonly tools: readonly string[];
    readonly mcpServers: readonly string[];
  } {
    return {
      tools: [
        ...new Set([
          ...mainProfile().enabledTools,
          ...mapMcpTools(this.options.mcpHub).map((tool) => tool.name),
        ]),
      ].sort(),
      mcpServers: this.options.mcpHub.catalog()
        .map(({ server }) => server.serverId)
        .sort(),
    };
  }
}

function mapMcpTools(hub: McpHub): ToolDefinition[] {
  return hub.catalog().flatMap(({ server, tools }) =>
    mapServerTools(server, tools, hub.callTool));
}

function waitForRoleShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}
