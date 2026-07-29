import { getZhixingHome, type ToolDefinition } from "@zhixing/core";
import { createMcpHub, mapServerTools, type McpHub } from "@zhixing/mcp";
import {
  createAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeCapacityBinding,
} from "@zhixing/orchestrator/runtime";
import { mainProfile } from "@zhixing/orchestrator/profile";
import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";
import { parseServerSpecs } from "../runtime/mcp-config.js";
import { createStdoutWriter } from "../screen/index.js";
import { resolveSystemProtectedSecretPaths } from "../security/secret-boundary.js";
import {
  type AuthorityRuntimeStack,
  setupAuthorityRuntime,
} from "../setup-delivery.js";
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
import { ExecutorDataPlaneRuntime } from "./executor-data-plane-runtime.js";
import { createAgentJobRuntimePort } from "./agent-job-runtime.js";
import { JobAssignmentWorker } from "./job-assignment-worker.js";

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
  const zhixingHome = getZhixingHome();
  const deviceCapacity = bootstrap.deviceCapacity;
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
  let jobWorker: JobAssignmentWorker | undefined;
  let authority: AuthorityRuntimeStack | undefined;
  let dataPlane: ExecutorDataPlaneRuntime | undefined;
  try {
    const interactions = new DurableConversationInteractionObserver();
    const runtime = new ExecutorRuntimeSubstrate({
      config: startup.config,
      credentials: providerCredentials,
      mcpHub,
      systemProtectedPaths: resolveSystemProtectedSecretPaths(),
      interactions,
      deviceCapacity: {
        interactive: deviceCapacity.workload("workload-interactive"),
        scheduler: deviceCapacity.workload("workload-scheduler"),
      },
    });
    authority = await setupAuthorityRuntime({
      zhixingHome,
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
      storageMaintenance: deviceCapacity.storage,
    });
    dataPlane = new ExecutorDataPlaneRuntime({
      zhixingHome,
      authority,
      module: executor,
      storageMaintenance: deviceCapacity.storage,
      onError: (error) => writer.notify(`[data-plane] ${error.message}`),
    });
    const ledger = createConversationExecutorLedger({
      Constructor: executor.ConversationAssignmentLedger,
      authority,
      dataPlaneTickets: dataPlane.tickets,
      usageFinal: (assignmentId) => {
        if (!mesh) throw new Error("Executor mesh runtime is not ready");
        return mesh.finalizeExecutorUsage(assignmentId);
      },
    });
    dataPlane.bindLedger(ledger);
    await dataPlane.start();
    const role = executor.createExecutorRole({
      createAgentRuntime: () => runtime.createConversationRuntime(),
    });
    const runtimeFactory = executor.createInProcessRuntimeFactory(role);
    jobWorker = new JobAssignmentWorker({
      ledger,
      runtime: createAgentJobRuntimePort({
        create: (instruction, confirmationBroker) =>
          runtime.createJobRuntime(instruction, confirmationBroker),
      }),
      submissionFor: () => {
        if (!mesh) throw new Error("Executor submission transport is not ready");
        return mesh.submissionForAnchor();
      },
      finalizeUsage: ({ assignmentId }) => {
        if (!mesh) throw new Error("Executor usage transport is not ready");
        return mesh.finalizeExecutorUsage(assignmentId);
      },
      InProcessAssignmentSubmission: executor.InProcessAssignmentSubmission,
      createStream: (input) => dataPlane!.createStream(input),
      onError: (_assignmentId, error) =>
        writer.notify(`[job-worker] ${error.message}`),
    });
    mesh = new MeshRuntimeAssembly({
      zhixingHome,
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
        dataPlane,
        InProcessAssignmentSubmission: executor.InProcessAssignmentSubmission,
        job: {
          worker: jobWorker,
        },
      },
      secretStore: bootstrap.secretStore,
      onError: (error) => writer.notify(`[mesh] ${error.message}`),
    });
    await mesh.start();
    await jobWorker.recover();
    await waitForRoleShutdown();
  } finally {
    jobWorker?.stopAccepting();
    await jobWorker?.close();
    await mesh?.stop();
    await dataPlane?.close();
    authority?.stopStorageMaintenance();
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
    readonly deviceCapacity: {
      readonly interactive: AgentRuntimeCapacityBinding;
      readonly scheduler: AgentRuntimeCapacityBinding;
    };
  }) {}

  createConversationRuntime(): Promise<AgentRuntime> {
    const catalog = this.options.mcpHub.catalog();
    return createAgentRuntime({
      deviceCapacity: this.options.deviceCapacity.interactive,
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

  createJobRuntime(
    instruction: import("@zhixing/core/contracts").JobExecutionInstruction,
    confirmationBroker: import("@zhixing/core").IConfirmationBroker,
  ): Promise<AgentRuntime> {
    const catalog = this.options.mcpHub.catalog();
    let extraTools = mapMcpTools(this.options.mcpHub);
    const baseProfile = mainProfile();
    const requested = instruction.tools
      ? new Set(instruction.tools)
      : undefined;
    if (requested) {
      const available = new Set([
        ...baseProfile.enabledTools,
        ...extraTools.map((tool) => tool.name),
      ]);
      const unknown = [...requested].filter((tool) => !available.has(tool));
      if (unknown.length > 0) {
        throw new TypeError(
          `Job requested unavailable tools: ${unknown.sort().join(", ")}`,
        );
      }
      extraTools = extraTools.filter((tool) => requested.has(tool.name));
    }
    const config =
      instruction.model && this.options.config.llm
        ? {
            ...this.options.config,
            llm: {
              ...this.options.config.llm,
              main: {
                ...this.options.config.llm.main,
                model: instruction.model,
              },
            },
          }
        : this.options.config;
    return createAgentRuntime({
      deviceCapacity: this.options.deviceCapacity.scheduler,
      providerConfiguration: {
        config,
        credentials: this.options.credentials,
      },
      profile: {
        ...baseProfile,
        enabledTools: requested
          ? baseProfile.enabledTools.filter((tool) => requested.has(tool))
          : baseProfile.enabledTools,
      },
      extraTools,
      executionMcpServers: catalog.map(({ server }) => server.serverId).sort(),
      confirmationBroker,
      systemProtectedPaths: this.options.systemProtectedPaths,
      runtimeKind: "ephemeral",
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
