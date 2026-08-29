import {
  parseConversationId,
  type SchedulerFacade,
  type ToolDefinition,
} from "@zhixing/core";
import type {
  JobExecutionInstruction,
  WorksceneDto,
} from "@zhixing/core/contracts";
import { mainProfile, powerProfile } from "@zhixing/orchestrator/profile";
import {
  createKernelRuntimeIdentityContribution,
  type AgentRuntime,
} from "@zhixing/orchestrator/runtime";
import type { BuiltinExtraToolsAssembly } from "@zhixing/runtime-host/builtin-extra-tools";
import {
  createConversationRuntimeProjection,
  createRuntimeToolProjection,
  type ConversationRuntimeProjection,
  type RuntimeToolProjection,
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
import { ExecutionSchedulerFacade } from "./execution-scheduler-facade.js";

export interface AnchorRuntimeProjectionAssembly {
  main(workspace?: string | null): ConversationRuntimeProjection;
  scene(input: {
    readonly scene: WorksceneDto;
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

/** Anchor product composition; RuntimeHost only sees the frozen output. */
export function createAnchorRuntimeProjectionAssembly(input: {
  readonly workscenes: WorksceneToolDirectory;
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
      runtimeTools: runtimeTools(mainProductTools(input.workscenes)),
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
      runtimeTools: runtimeTools(
        sceneProductTools(input.workscenes, options.scene),
      ),
    });
  const ephemeral = (): RuntimeToolProjection => runtimeTools();
  const job = (instruction: JobExecutionInstruction) => {
    const baseProfile = mainProfile();
    const availableTools = runtimeTools();
    const requestedTools = instruction.tools
      ? new Set(instruction.tools)
      : undefined;
    if (requestedTools) {
      const available = new Set([
        ...baseProfile.enabledTools,
        ...availableTools.extraTools.map((tool) => tool.name),
      ]);
      const unknown = [...requestedTools].filter((tool) => !available.has(tool));
      if (unknown.length > 0) {
        throw new TypeError(
          `Job requested unavailable tools: ${unknown.sort().join(", ")}`,
        );
      }
    }
    const profile = Object.freeze({
      ...baseProfile,
      constraints: Object.freeze([...baseProfile.constraints]),
      enabledTools: Object.freeze(
        requestedTools
          ? baseProfile.enabledTools.filter((tool) => requestedTools.has(tool))
          : [...baseProfile.enabledTools],
      ),
      ...(baseProfile.capabilities
        ? { capabilities: Object.freeze({ ...baseProfile.capabilities }) }
        : {}),
    });
    return Object.freeze({
      profile,
      ...(instruction.model ? { modelOverride: instruction.model } : {}),
      runtimeTools: requestedTools
        ? createRuntimeToolProjection({
            extraTools: availableTools.extraTools.filter((tool) =>
              requestedTools.has(tool.name),
            ),
            executionMcpServers: availableTools.executionMcpServers,
          })
        : availableTools,
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
      const catalogScene: WorksceneDto = {
        id: "capability-catalog",
        revision: 1,
        name: "capability-catalog",
        createdAt: "1970-01-01T00:00:00.000Z",
        lastActiveAt: "1970-01-01T00:00:00.000Z",
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
