import { type SchedulerFacade } from "@zhixing/core/scheduler";
import { type ToolDefinition } from "@zhixing/core";
import type { ArtifactStore } from "@zhixing/core/authority";
import type { SkillMode } from "@zhixing/core/skills/catalog";
import type {
  JobExecutionInstruction,
} from "@zhixing/core/contracts";
import {
  WorksceneApplicationError,
  isWorksceneSupportConversation,
  type WorksceneConversationRuntimeProjection,
  type WorksceneConversationRuntimeQuery,
  type WorksceneAssignmentToolApplication,
  type WorksceneWorkspaceReference,
} from "@zhixing/core/workscene/application";
import { zhixingProfile } from "./zhixing-agent-profile.js";
import { powerProfile } from "./workscene-agent-guidance.js";
import {
  createKernelWindowPromptProjection,
  type AgentRuntimeLifecycle,
  type AgentRuntime,
} from "@zhixing/orchestrator/runtime";
import type { BuiltinExtraToolsAssembly } from "./builtin-extra-tools.js";
import {
  createConversationRuntimeProjection,
  createRuntimeProductProjection,
  createRuntimeToolProjection,
  type ConversationRuntimeProjection,
  type RuntimeProductProjection,
  type RuntimeToolProjection,
} from "@zhixing/runtime-host/conversation-runtime-projection";
import { selectJobRuntimeTools, type JobRuntimeCapabilities } from "./job-runtime-tool-selection.js";
import {
  createWorkmodeEnterTool,
  createWorksceneTaskTools,
  createWorkmodeExitTool,
  createWorksceneChangeApproveTool,
  createWorksceneClearWorkdirCurrentTool,
  createWorksceneListTool,
  createWorksceneRenameCurrentTool,
  createWorksceneSetWorkdirCurrentTool,
  WORKSCENE_PRODUCT_TOOL_IDS,
  type WorksceneToolDirectory,
} from "./workmode-tools.js";
import { ExecutionSchedulerFacade } from "./execution-scheduler-facade.js";
import type { McpRuntimeToolProjectionPort } from "../runtime/mcp-runtime-ports.js";
import type { HostKernelToolImplementationFactory } from "../runtime/kernel-tool-implementation.js";
import { createSkillCatalogWindowPromptProjection } from "../runtime/skill-catalog-window-projection.js";
import type { RuntimeSecurityExecutionInfrastructure } from "./permission-storage-infrastructure.js";
import type { RuntimeExecutionProfile } from "@zhixing/core/types";

/** Conversation inventories are device-local, not a task's declared tool requirements.
 * Keep portable tools mandatory; MCP and owner-only management are projected by location.
 * Job manifests retain their separate, explicit capability requirements. */
export function projectConversationCapabilitiesForDevice(input: {
  readonly profile: RuntimeExecutionProfile;
  readonly ownerDeviceId: string;
  readonly executorDeviceId: string;
  readonly capabilities: { readonly tools: readonly string[]; readonly mcpServers: readonly string[] };
}): RuntimeExecutionProfile {
  if (input.ownerDeviceId === input.executorDeviceId) return input.profile;
  const ownerTools = new Set([
    "mcp_connect", "schedule", "task_list", "workscene_change_approve",
    "workscene_rename_current", "workscene_set_workdir_current", "workscene_clear_workdir_current",
  ]);
  return {
    tools: [...new Set([
      ...input.profile.tools.filter(name => !ownerTools.has(name) && !name.startsWith("mcp__")),
      ...input.capabilities.tools.filter(name => name.startsWith("mcp__")),
      ...(input.profile.tools.includes("mcp_connect") && input.capabilities.tools.includes("mcp_delegate") ? ["mcp_delegate"] : []),
    ])].sort(),
    mcpServers: [...input.capabilities.mcpServers],
    providerIds: [...input.profile.providerIds],
  };
}

type WorksceneRuntimeSceneIdentity = Extract<
  WorksceneConversationRuntimeProjection,
  { readonly kind: "scene" }
>["scene"];

export interface AnchorRuntimeProjectionAssembly {
  main(workspace?: string | null, isolated?: boolean): ConversationRuntimeProjection;
  scene(input: {
    readonly scene: WorksceneRuntimeSceneIdentity;
    readonly absolutePath: string | null;
  }): ConversationRuntimeProjection;
  ephemeral(): RuntimeProductProjection;
  jobCapabilities(): JobRuntimeCapabilities;
  job(instruction: JobExecutionInstruction, capabilities: JobRuntimeCapabilities): {
    readonly profile: ConversationRuntimeProjection["profile"];
    readonly runtimeTools: RuntimeToolProjection;
    readonly windowPrompt: RuntimeProductProjection["windowPrompt"];
    readonly securityExecution: RuntimeProductProjection["securityExecution"];
    readonly modelOverride?: string;
  };
  capabilityCatalog(): {
    readonly tools: readonly string[];
    readonly mcpServers: readonly string[];
  };
}

export interface AnchorRuntimeCapabilityCatalog {
  capabilityCatalog(): {
    readonly tools: readonly string[];
    readonly mcpServers: readonly string[];
  };
}

/**
 * Static product capability view needed while the Authority generation starts.
 * Tool identities come from the same canonical definitions used by the live
 * runtime projection, without manufacturing an unbound Workscene directory.
 */
export function createAnchorRuntimeCapabilityCatalog(input: {
  readonly mcpProductTools?: readonly ToolDefinition[];
  readonly extraTools: BuiltinExtraToolsAssembly;
  readonly mcpTools: McpRuntimeToolProjectionPort;
  readonly scheduler: SchedulerFacade;
}): AnchorRuntimeCapabilityCatalog {
  const executionScheduler = new ExecutionSchedulerFacade(input.scheduler);
  return Object.freeze({
    capabilityCatalog() {
      const mcp = input.mcpTools.snapshot();
      const tools = new Set<string>([
        ...(input.mcpProductTools ?? []).map((tool) => tool.name),
        ...zhixingProfile().enabledTools,
        ...powerProfile({
          id: "capability-catalog",
          name: "capability-catalog",
          hasWorkspace: false,
          hasSceneControlTools: false,
        }).enabledTools,
        ...input.extraTools
          .assembleTools({ scheduler: () => executionScheduler })
          .map((tool) => tool.name),
        ...mcp.tools.map((tool) => tool.name),
        ...Object.values(WORKSCENE_PRODUCT_TOOL_IDS),
      ]);
      return Object.freeze({
        tools: Object.freeze([...tools].sort()),
        mcpServers: mcp.serverIds,
      });
    },
  });
}

function mainProductTools(
  application: WorksceneAssignmentToolApplication,
  workscenes: WorksceneToolDirectory,
): ToolDefinition[] {
  return [
    createWorkmodeEnterTool(application),
    ...createWorksceneTaskTools(),
    createWorksceneChangeApproveTool(application, workscenes),
    createWorksceneListTool(application, workscenes),
  ];
}

function sceneProductTools(
  application: WorksceneAssignmentToolApplication,
  workscenes: WorksceneToolDirectory,
  scene: WorksceneRuntimeSceneIdentity,
): ToolDefinition[] {
  const identity = { sceneId: scene.sceneId, sceneName: scene.name };
  return [
    createWorkmodeExitTool(),
    ...createWorksceneTaskTools(),
    createWorksceneRenameCurrentTool(identity, application),
    createWorksceneSetWorkdirCurrentTool(identity, application, workscenes),
    createWorksceneClearWorkdirCurrentTool(identity, application),
  ];
}

/** Anchor product composition; RuntimeHost only sees the frozen output. */
export function createAnchorRuntimeProjectionAssembly(input: {
  readonly mcpProductTools?: readonly ToolDefinition[];
  readonly agentIdentity: import("@zhixing/core/identity").AgentIdentity;
  readonly capabilities: AnchorRuntimeCapabilityCatalog;
  readonly workscenes: WorksceneToolDirectory;
  readonly worksceneAssignmentTools: WorksceneAssignmentToolApplication;
  readonly extraTools: BuiltinExtraToolsAssembly;
  readonly mcpTools: McpRuntimeToolProjectionPort;
  readonly scheduler: SchedulerFacade;
  readonly skillArtifacts: ArtifactStore;
  readonly createToolImplementation: HostKernelToolImplementationFactory;
  readonly securityExecution: RuntimeSecurityExecutionInfrastructure;
  readonly createGuidanceLifecycle: (
    sceneId?: string,
  ) => AgentRuntimeLifecycle;
}): AnchorRuntimeProjectionAssembly {
  const executionScheduler = new ExecutionSchedulerFacade(input.scheduler);
  const runtimeProduct = (
    mode: SkillMode,
    productTools: readonly ToolDefinition[] = [],
    sceneId?: string,
  ): RuntimeProductProjection => {
    const mcp = input.mcpTools.snapshot();
    return createRuntimeProductProjection({
      runtimeTools: createRuntimeToolProjection({
        extraTools: [
          ...(input.mcpProductTools ?? []).filter((tool) => tool.name !== "mcp_connect" || productTools.length > 0),
          ...input.extraTools.assembleTools({ scheduler: () => executionScheduler }),
          ...mcp.tools,
          ...productTools,
        ],
        executionMcpServers: mcp.serverIds,
        implementation: input.createToolImplementation(Object.freeze({
          kind: "assignment",
          mode,
          artifacts: input.skillArtifacts,
        })),
      }),
      windowPrompt: createSkillCatalogWindowPromptProjection(mode),
      securityExecution: input.securityExecution.bind(
        sceneId === undefined
          ? Object.freeze({ kind: "default" })
          : Object.freeze({ kind: "scene", sceneId }),
      ),
    });
  };
  const main = (workspace?: string | null, isolated = false): ConversationRuntimeProjection => {
    const product = runtimeProduct(
      "main",
      mainProductTools(input.worksceneAssignmentTools, input.workscenes),
    );
    return createConversationRuntimeProjection({
      ...(workspace === undefined ? {} : { workspace }),
      primaryRole: "main",
      profile: zhixingProfile({ agentIdentity: input.agentIdentity, hasWorkspace: workspace !== null }),
      lifecycle: isolated ? [] : [input.createGuidanceLifecycle()],
      ...product,
      ...(isolated ? { windowPrompt: Object.freeze({ project: async () => createKernelWindowPromptProjection({ revision: 0, segment: "skill-index", content: "" }) }) } : {}),
    });
  };
  const scene = (options: {
    readonly scene: WorksceneRuntimeSceneIdentity;
    readonly absolutePath: string | null;
  }): ConversationRuntimeProjection => {
    const product = runtimeProduct(
      "work",
      sceneProductTools(
        input.worksceneAssignmentTools,
        input.workscenes,
        options.scene,
      ),
      options.scene.sceneId,
    );
    return createConversationRuntimeProjection({
      workspace: options.absolutePath,
      primaryRole: "power",
      profile: powerProfile({
        id: options.scene.sceneId,
        name: options.scene.name,
        hasWorkspace: options.absolutePath !== null,
        hasSceneControlTools: true,
      }, { agentIdentity: input.agentIdentity }),
      lifecycle: [input.createGuidanceLifecycle(options.scene.sceneId)],
      ...product,
    });
  };
  const ephemeral = (): RuntimeProductProjection => runtimeProduct("main");
  const jobCapabilities = (): JobRuntimeCapabilities => {
    const available = runtimeProduct("main");
    return {
      tools: [...new Set([
        ...zhixingProfile().enabledTools,
        ...available.runtimeTools.extraTools.map((tool) => tool.name),
      ])].sort(),
      mcpServers: [...available.runtimeTools.executionMcpServers],
    };
  };
  const job = (instruction: JobExecutionInstruction, capabilities: JobRuntimeCapabilities) => {
    const baseProfile = zhixingProfile({ agentIdentity: input.agentIdentity });
    const available = runtimeProduct("main");
    const selection = selectJobRuntimeTools({
      instruction,
      capabilities,
      baseProfile,
      extraTools: available.runtimeTools.extraTools,
      executionMcpServers: available.runtimeTools.executionMcpServers,
      implementation: available.runtimeTools.implementation,
    });
    return Object.freeze({
      ...selection,
      windowPrompt: available.windowPrompt,
      securityExecution: available.securityExecution,
    });
  };

  return Object.freeze({
    main,
    scene,
    ephemeral,
    job,
    jobCapabilities,
    capabilityCatalog: () => input.capabilities.capabilityCatalog(),
  });
}

/** The sole Anchor conversation routing path for main and Workscene runtimes. */
export function createWorksceneConversationRuntimeFactory(input: {
  readonly issue: (projection: ConversationRuntimeProjection) => Promise<AgentRuntime>;
  readonly projections: AnchorRuntimeProjectionAssembly;
  readonly projectConversationRuntime: (
    query: WorksceneConversationRuntimeQuery,
  ) => Promise<WorksceneConversationRuntimeProjection>;
  readonly resolveWorkspaceRoot: (
    sceneId: string,
    workspace: WorksceneWorkspaceReference,
  ) => Promise<string | null>;
  readonly prepareWorkspaceRoot: (
    sceneId: string,
    absolutePath: string,
  ) => Promise<void>;
}): (
  sessionId: string,
  environment?: { readonly workspaceRoot: string | null; readonly executionProfile?: import("@zhixing/core/types").RuntimeExecutionProfile },
) => Promise<AgentRuntime> {
  return async (sessionId, environment) => {
    const issue = (projection: ConversationRuntimeProjection) => input.issue(selectFrozenRuntimeCapabilities(projection, environment?.executionProfile));
    const current = await input.projectConversationRuntime({
      conversationId: sessionId,
    });
    if (current.kind === "main") {
      if (isWorksceneSupportConversation(sessionId)) return issue(input.projections.main(null, true));
      return issue(input.projections.main(environment?.workspaceRoot));
    }
    if (environment) {
      return issue(
        input.projections.scene({
          scene: current.scene,
          absolutePath: environment.workspaceRoot,
        }),
      );
    }
    if (!current.workspace) {
      return issue(
        input.projections.scene({ scene: current.scene, absolutePath: null }),
      );
    }
    let refreshed: WorksceneConversationRuntimeProjection;
    try {
      refreshed = await input.projectConversationRuntime({ conversationId: sessionId });
    } catch (error) {
      if (error instanceof WorksceneApplicationError && error.kind === "not-found") {
        throw new Error(
          `工作场景 "${current.scene.sceneId}" 的工作区无法在当前 executor 解析`,
          { cause: error },
        );
      }
      throw error;
    }
    const absolutePath = refreshed.kind === "scene" && refreshed.workspace
      ? await input.resolveWorkspaceRoot(
          current.scene.sceneId,
          refreshed.workspace,
        )
      : null;
    if (!absolutePath) {
      throw new Error(
        `工作场景 "${current.scene.sceneId}" 的工作区无法在当前 executor 解析`,
      );
    }
    await input.prepareWorkspaceRoot(current.scene.sceneId, absolutePath);
    return issue(
      input.projections.scene({ scene: current.scene, absolutePath }),
    );
  };
}

/** Additive lifecycle changes must not widen an assignment that was already issued. */
export function selectFrozenRuntimeCapabilities(projection: ConversationRuntimeProjection, expected?: import("@zhixing/core/types").RuntimeExecutionProfile): ConversationRuntimeProjection {
  if (!expected) return projection;
  return createConversationRuntimeProjection({ ...projection, runtimeTools: createRuntimeToolProjection({
    extraTools: projection.runtimeTools.extraTools.filter((tool) => expected.tools.includes(tool.name)),
    executionMcpServers: projection.runtimeTools.executionMcpServers.filter((id) => expected.mcpServers.includes(id)),
    implementation: projection.runtimeTools.implementation,
  }) });
}
