import { createWorksceneRunToolApplication } from "./workscene-application-adapter.js";
import { type SchedulerFacade } from "@zhixing/core/scheduler";
import { type ToolDefinition } from "@zhixing/core";
import type { ArtifactStore } from "@zhixing/core/authority";
import type { SkillMode } from "@zhixing/core/skills/catalog";
import type {
  JobExecutionInstruction,
} from "@zhixing/core/contracts";
import { jobRunTrustScopeInput, type ExecutionTrustScopeInput } from "@zhixing/core/trust-administration";
import {
  WorksceneApplicationError,
  isWorksceneSupportConversation,
  type WorksceneConversationRuntimeProjection,
  type WorksceneConversationRuntimeQuery,
  type WorksceneAssignmentToolApplication,
  type WorksceneWorkspaceReference,
} from "@zhixing/core/workscene/application";
import { zhixingProfile } from "./zhixing-agent-profile.js";
import { createAdvancementProposalTool } from "./advancement-proposal-tool.js";
import { ADVANCEMENT_PROPOSAL_TOOL } from "@zhixing/core/advancement/proposal-identity";
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
import type {
  RuntimeSecurityExecutionBindOptions,
  RuntimeSecurityExecutionInfrastructure,
} from "./permission-storage-infrastructure.js";
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

type RuntimeWorkspaceBinding = NonNullable<
  NonNullable<Parameters<import("@zhixing/owner-kernel/types").RuntimeFactory["create"]>[1]>["workspaceBinding"]
>;

export interface AnchorRuntimeProjectionAssembly {
  /** workspaceBinding 为本次运行清单里的工作区绑定，主对话的授权范围由它决定。 */
  main(
    workspace?: string | null,
    isolated?: boolean,
    workspaceBinding?: RuntimeWorkspaceBinding | null,
  ): ConversationRuntimeProjection;
  scene(input: {
    readonly scene: WorksceneRuntimeSceneIdentity;
    readonly absolutePath: string | null;
  }): ConversationRuntimeProjection;
  ephemeral(): RuntimeProductProjection;
  jobCapabilities(): JobRuntimeCapabilities;
  /** workspaceBinding 为 job 清单里的工作区绑定，授权范围由它决定（没有则主范围）。 */
  job(
    instruction: JobExecutionInstruction,
    capabilities: JobRuntimeCapabilities,
    workspaceBinding?: RuntimeWorkspaceBinding | null,
  ): {
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
  readonly logTools?: readonly ToolDefinition[];
  readonly extensionTools?: readonly ToolDefinition[];
  readonly communicationTools?: readonly ToolDefinition[];
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
        ...(input.logTools ?? []).map(tool => tool.name),
        ...(input.extensionTools ?? []).map(tool => tool.name),
        ...(input.communicationTools ?? []).map(tool => tool.name),
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
        // 推进提议常驻会话运行时；冻结的执行画像按本目录过滤工具
        ADVANCEMENT_PROPOSAL_TOOL,
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
    createWorkmodeEnterTool(application, createWorksceneRunToolApplication()),
    ...createWorksceneTaskTools(createWorksceneRunToolApplication()),
    createWorksceneChangeApproveTool(application, workscenes),
    createWorksceneListTool(application, workscenes),
    // 推进提议常驻会话运行时；只有宿主发送路径判定为新任务作用域的运行才启用
    createAdvancementProposalTool(),
  ];
}

function sceneProductTools(
  application: WorksceneAssignmentToolApplication,
  workscenes: WorksceneToolDirectory,
  scene: WorksceneRuntimeSceneIdentity,
): ToolDefinition[] {
  const identity = { sceneId: scene.sceneId, sceneName: scene.name };
  return [
    createWorkmodeExitTool(createWorksceneRunToolApplication()),
    ...createWorksceneTaskTools(createWorksceneRunToolApplication()),
    createWorksceneRenameCurrentTool(identity, application),
    createWorksceneSetWorkdirCurrentTool(identity, application, workscenes, createWorksceneRunToolApplication()),
    createWorksceneClearWorkdirCurrentTool(identity, application, createWorksceneRunToolApplication()),
    createAdvancementProposalTool(),
  ];
}

/** Anchor product composition; RuntimeHost only sees the frozen output. */
export function createAnchorRuntimeProjectionAssembly(input: {
  readonly logTools?: readonly ToolDefinition[];
  readonly extensionTools?: readonly ToolDefinition[];
  readonly communicationTools?: readonly ToolDefinition[];
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
    trustScope: ExecutionTrustScopeInput = {},
    securityOptions: RuntimeSecurityExecutionBindOptions = {},
  ): RuntimeProductProjection => {
    const mcp = input.mcpTools.snapshot();
    return createRuntimeProductProjection({
      runtimeTools: createRuntimeToolProjection({
        extraTools: [
          ...(input.logTools ?? []),
          ...(productTools.length > 0 ? input.extensionTools ?? [] : []),
          ...(productTools.length > 0 ? input.communicationTools ?? [] : []),
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
      securityExecution: input.securityExecution.bind(Object.freeze(trustScope), securityOptions),
    });
  };
  const main = (
    workspace?: string | null,
    isolated = false,
    workspaceBinding?: RuntimeWorkspaceBinding | null,
  ): ConversationRuntimeProjection => {
    const product = runtimeProduct(
      "main",
      mainProductTools(input.worksceneAssignmentTools, input.workscenes),
      workspaceBinding ? { workspace: workspaceBinding } : {},
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
      { sceneId: options.scene.sceneId },
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
  // 定时任务与 job 的确认只能答仅本次/拒绝，不提供"始终允许"
  const ephemeral = (): RuntimeProductProjection =>
    runtimeProduct("main", [], {}, { persistentApprovals: false });
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
  const job = (
    instruction: JobExecutionInstruction,
    capabilities: JobRuntimeCapabilities,
    workspaceBinding?: RuntimeWorkspaceBinding | null,
  ) => {
    const baseProfile = zhixingProfile({ agentIdentity: input.agentIdentity });
    const available = runtimeProduct(
      "main",
      [],
      jobRunTrustScopeInput({ workspace: workspaceBinding }),
      { persistentApprovals: false },
    );
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
  environment?: Parameters<import("@zhixing/owner-kernel/types").RuntimeFactory["create"]>[1],
) => Promise<AgentRuntime> {
  return async (sessionId, environment) => {
    const issue = (projection: ConversationRuntimeProjection) => input.issue(selectFrozenRuntimeCapabilities(projection, environment?.executionProfile));
    const current = await input.projectConversationRuntime({
      conversationId: sessionId,
    });
    if (current.kind === "main") {
      const binding = environment?.workspaceBinding ?? null;
      if (isWorksceneSupportConversation(sessionId)) return issue(input.projections.main(null, true, binding));
      // 无显式环境的主对话按执行侧同一默认：不带工作区（执行侧冻结环境 workspaceRoot=null）。
      // 授权范围只由清单的工作区绑定决定，与 owner 派发快照的范围同源，不从本机路径推导。
      return issue(input.projections.main(environment ? environment.workspaceRoot : null, false, binding));
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
