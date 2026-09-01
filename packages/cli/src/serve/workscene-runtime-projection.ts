import {
  type SchedulerFacade,
  type ToolDefinition,
} from "@zhixing/core";
import type {
  JobExecutionInstruction,
} from "@zhixing/core/contracts";
import {
  WorksceneApplicationError,
  type WorksceneConversationRuntimeProjection,
  type WorksceneConversationRuntimeQuery,
  type WorksceneAssignmentToolApplication,
  type WorksceneWorkspaceReference,
} from "@zhixing/core/workscene/application";
import { mainProfile, powerProfile } from "@zhixing/orchestrator/profile";
import {
  createKernelRuntimeIdentityContribution,
  type AgentRuntime,
} from "@zhixing/orchestrator/runtime";
import type { BuiltinExtraToolsAssembly } from "./builtin-extra-tools.js";
import {
  createConversationRuntimeProjection,
  createRuntimeToolProjection,
  type ConversationRuntimeProjection,
  type RuntimeToolProjection,
} from "@zhixing/runtime-host/conversation-runtime-projection";
import { selectJobRuntimeTools } from "./job-runtime-tool-selection.js";
import {
  createWorkmodeEnterTool,
  createWorkmodeExitTool,
  createWorksceneChangeApproveTool,
  createWorksceneClearWorkdirCurrentTool,
  createWorksceneListTool,
  createWorksceneRenameCurrentTool,
  createWorksceneSetWorkdirCurrentTool,
  type WorksceneToolDirectory,
} from "./workmode-tools.js";
import { ExecutionSchedulerFacade } from "./execution-scheduler-facade.js";

type WorksceneRuntimeSceneIdentity = Extract<
  WorksceneConversationRuntimeProjection,
  { readonly kind: "scene" }
>["scene"];

export interface AnchorRuntimeProjectionAssembly {
  main(workspace?: string | null): ConversationRuntimeProjection;
  scene(input: {
    readonly scene: WorksceneRuntimeSceneIdentity;
    readonly absolutePath: string | null;
  }): ConversationRuntimeProjection;
  ephemeral(): RuntimeToolProjection;
  job(instruction: JobExecutionInstruction): {
    readonly profile: ConversationRuntimeProjection["profile"];
    readonly runtimeTools: RuntimeToolProjection;
    readonly modelOverride?: string;
  };
  capabilityCatalog(): {
    readonly tools: readonly string[];
    readonly mcpServers: readonly string[];
  };
}

function mainProductTools(
  application: WorksceneAssignmentToolApplication,
  workscenes: WorksceneToolDirectory,
): ToolDefinition[] {
  return [
    createWorkmodeEnterTool(application),
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
    createWorksceneRenameCurrentTool(identity, application),
    createWorksceneSetWorkdirCurrentTool(identity, application, workscenes),
    createWorksceneClearWorkdirCurrentTool(identity, application),
  ];
}

/** Anchor product composition; RuntimeHost only sees the frozen output. */
export function createAnchorRuntimeProjectionAssembly(input: {
  readonly workscenes: WorksceneToolDirectory;
  readonly worksceneAssignmentTools: WorksceneAssignmentToolApplication;
  readonly extraTools: BuiltinExtraToolsAssembly;
  readonly scheduler: () => SchedulerFacade;
}): AnchorRuntimeProjectionAssembly {
  const executionScheduler = new ExecutionSchedulerFacade(input.scheduler);
  const runtimeTools = (
    productTools: readonly ToolDefinition[] = [],
  ): RuntimeToolProjection =>
    createRuntimeToolProjection({
      extraTools: [
        ...input.extraTools.assembleTools({ scheduler: () => executionScheduler }),
        ...productTools,
      ],
      executionMcpServers: input.extraTools.mcpHub.catalog()
        .map(({ server }) => server.serverId)
        .sort(),
    });
  const main = (workspace?: string | null): ConversationRuntimeProjection =>
    createConversationRuntimeProjection({
      ...(workspace === undefined ? {} : { workspace }),
      primaryRole: "main",
      profile: mainProfile({ hasWorkspace: workspace !== null }),
      runtimeTools: runtimeTools(
        mainProductTools(input.worksceneAssignmentTools, input.workscenes),
      ),
    });
  const scene = (options: {
    readonly scene: WorksceneRuntimeSceneIdentity;
    readonly absolutePath: string | null;
  }): ConversationRuntimeProjection =>
    createConversationRuntimeProjection({
      workspace: options.absolutePath,
      primaryRole: "power",
      profile: powerProfile({
        id: options.scene.sceneId,
        name: options.scene.name,
        hasWorkspace: options.absolutePath !== null,
      }),
      runtimeIdentity: createKernelRuntimeIdentityContribution(options.scene.sceneId),
      runtimeTools: runtimeTools(
        sceneProductTools(
          input.worksceneAssignmentTools,
          input.workscenes,
          options.scene,
        ),
      ),
    });
  const ephemeral = (): RuntimeToolProjection => runtimeTools();
  const job = (instruction: JobExecutionInstruction) => {
    const baseProfile = mainProfile();
    const availableTools = runtimeTools();
    return selectJobRuntimeTools({
      instruction,
      baseProfile,
      extraTools: availableTools.extraTools,
      executionMcpServers: availableTools.executionMcpServers,
    });
  };

  return Object.freeze({
    main,
    scene,
    ephemeral,
    job,
    capabilityCatalog() {
      const tools = new Set<string>();
      const addProjection = (projection: ConversationRuntimeProjection) => {
        for (const tool of projection.profile.enabledTools) tools.add(tool);
        for (const tool of projection.runtimeTools.extraTools) tools.add(tool.name);
      };
      const mainProjection = main();
      addProjection(mainProjection);
      const catalogScene = {
        sceneId: "capability-catalog",
        name: "capability-catalog",
      };
      addProjection(scene({ scene: catalogScene, absolutePath: null }));
      addProjection(scene({ scene: catalogScene, absolutePath: "/capability-catalog" }));
      return Object.freeze({
        tools: Object.freeze([...tools].sort()),
        mcpServers: mainProjection.runtimeTools.executionMcpServers,
      });
    },
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
  environment?: { readonly workspaceRoot: string | null },
) => Promise<AgentRuntime> {
  return async (sessionId, environment) => {
    const current = await input.projectConversationRuntime({
      conversationId: sessionId,
    });
    if (current.kind === "main") {
      return input.issue(input.projections.main(environment?.workspaceRoot));
    }
    if (environment) {
      return input.issue(
        input.projections.scene({
          scene: current.scene,
          absolutePath: environment.workspaceRoot,
        }),
      );
    }
    if (!current.workspace) {
      return input.issue(
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
    return input.issue(
      input.projections.scene({ scene: current.scene, absolutePath }),
    );
  };
}
