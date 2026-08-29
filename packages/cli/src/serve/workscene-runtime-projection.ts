import {
  parseConversationId,
  type SchedulerFacade,
  type ToolDefinition,
} from "@zhixing/core";
import type { WorksceneDto } from "@zhixing/core/contracts";
import { mainProfile, powerProfile } from "@zhixing/orchestrator/profile";
import {
  createKernelRuntimeIdentityContribution,
  type AgentRuntime,
} from "@zhixing/orchestrator/runtime";
import type { BuiltinExtraToolsAssembly } from "@zhixing/runtime-host/builtin-extra-tools";
import {
  createConversationRuntimeProjection,
  type ConversationRuntimeProjection,
} from "@zhixing/runtime-host/conversation-runtime-projection";
import {
  createWorkmodeEnterTool,
  createWorkmodeExitTool,
  createWorksceneChangeApproveTool,
  createWorksceneClearWorkdirCurrentTool,
  createWorksceneListTool,
  createWorksceneRenameCurrentTool,
  createWorksceneSetWorkdirCurrentTool,
  type WorksceneToolDirectory,
} from "@zhixing/runtime-host/workmode-tools";

export interface WorksceneRuntimeProjectionAssembly {
  main(workspace?: string | null): ConversationRuntimeProjection;
  scene(input: {
    readonly scene: WorksceneDto;
    readonly absolutePath: string | null;
  }): ConversationRuntimeProjection;
  capabilityCatalog(): {
    readonly tools: readonly string[];
    readonly mcpServers: readonly string[];
  };
}

function mainProductTools(workscenes: WorksceneToolDirectory): ToolDefinition[] {
  return [
    createWorkmodeEnterTool(workscenes),
    createWorksceneChangeApproveTool(workscenes),
    createWorksceneListTool(workscenes),
  ];
}

function sceneProductTools(
  workscenes: WorksceneToolDirectory,
  scene: Pick<WorksceneDto, "id" | "name">,
): ToolDefinition[] {
  const identity = { sceneId: scene.id, sceneName: scene.name };
  return [
    createWorkmodeExitTool(),
    createWorksceneRenameCurrentTool(workscenes, identity),
    createWorksceneSetWorkdirCurrentTool(identity, workscenes),
    createWorksceneClearWorkdirCurrentTool(identity),
  ];
}

/** Workscene product composition; RuntimeHost only sees the frozen output. */
export function createWorksceneRuntimeProjectionAssembly(input: {
  readonly workscenes: WorksceneToolDirectory;
  readonly extraTools: BuiltinExtraToolsAssembly;
  readonly scheduler: () => SchedulerFacade;
}): WorksceneRuntimeProjectionAssembly {
  const main = (workspace?: string | null): ConversationRuntimeProjection =>
    createConversationRuntimeProjection({
      ...(workspace === undefined ? {} : { workspace }),
      primaryRole: "main",
      profile: mainProfile({ hasWorkspace: workspace !== null }),
      productTools: mainProductTools(input.workscenes),
    });
  const scene = (options: {
    readonly scene: WorksceneDto;
    readonly absolutePath: string | null;
  }): ConversationRuntimeProjection =>
    createConversationRuntimeProjection({
      workspace: options.absolutePath,
      primaryRole: "power",
      profile: powerProfile({
        id: options.scene.id,
        name: options.scene.name,
        hasWorkspace: options.absolutePath !== null,
      }),
      runtimeIdentity: createKernelRuntimeIdentityContribution(options.scene.id),
      productTools: sceneProductTools(input.workscenes, options.scene),
    });

  return Object.freeze({
    main,
    scene,
    capabilityCatalog() {
      const tools = new Set<string>();
      const addProjection = (projection: ConversationRuntimeProjection) => {
        for (const tool of projection.profile.enabledTools) tools.add(tool);
        for (const tool of projection.productTools) tools.add(tool.name);
      };
      addProjection(main());
      const catalogScene: WorksceneDto = {
        id: "capability-catalog",
        revision: 1,
        name: "capability-catalog",
        createdAt: "1970-01-01T00:00:00.000Z",
        lastActiveAt: "1970-01-01T00:00:00.000Z",
      };
      addProjection(scene({ scene: catalogScene, absolutePath: null }));
      addProjection(scene({ scene: catalogScene, absolutePath: "/capability-catalog" }));
      for (const tool of input.extraTools.assembleTools({ scheduler: input.scheduler })) {
        tools.add(tool.name);
      }
      return Object.freeze({
        tools: Object.freeze([...tools].sort()),
        mcpServers: Object.freeze(
          input.extraTools.mcpHub.catalog()
            .map(({ server }) => server.serverId)
            .sort(),
        ),
      });
    },
  });
}

/** The sole Anchor conversation routing path for main and Workscene runtimes. */
export function createWorksceneConversationRuntimeFactory(input: {
  readonly issue: (projection: ConversationRuntimeProjection) => Promise<AgentRuntime>;
  readonly projections: WorksceneRuntimeProjectionAssembly;
  readonly getScene: (sceneId: string) => Promise<WorksceneDto | null>;
  readonly resolveWorkspaceRoot: (sceneId: string) => Promise<string | null>;
  readonly prepareWorkspaceRoot: (
    sceneId: string,
    absolutePath: string,
  ) => Promise<void>;
}): (
  sessionId: string,
  environment?: { readonly workspaceRoot: string | null },
) => Promise<AgentRuntime> {
  return async (sessionId, environment) => {
    const { scope } = parseConversationId(sessionId);
    if (scope.kind !== "workscene") {
      return input.issue(input.projections.main(environment?.workspaceRoot));
    }

    const scene = await input.getScene(scope.sceneId);
    if (!scene) {
      throw new Error(`工作场景 "${scope.sceneId}" 不存在,无法装配会话`);
    }
    if (environment) {
      return input.issue(
        input.projections.scene({ scene, absolutePath: environment.workspaceRoot }),
      );
    }
    if (!scene.workspace) {
      return input.issue(input.projections.scene({ scene, absolutePath: null }));
    }
    const absolutePath = await input.resolveWorkspaceRoot(scope.sceneId);
    if (!absolutePath) {
      throw new Error(
        `工作场景 "${scope.sceneId}" 的工作区无法在当前 executor 解析`,
      );
    }
    await input.prepareWorkspaceRoot(scope.sceneId, absolutePath);
    return input.issue(input.projections.scene({ scene, absolutePath }));
  };
}
