import type { BoundaryCrossing } from "../security/types.js";
import type { ConfirmationDisplayContext } from "../types/tools.js";
import { normalizeSceneName, normalizeWorkdir } from "./validation.js";

export type WorksceneManagementToolName =
  | "workscene_change_approve"
  | "workscene_list"
  | "workmode_enter"
  | "workmode_exit"
  | "workscene_rename_current"
  | "workscene_set_workdir_current"
  | "workscene_clear_workdir_current";

export type WorksceneManagementAction =
  | "add"
  | "remove"
  | "rename"
  | "set_workdir"
  | "clear_workdir"
  | "enter"
  | "exit"
  | "list"
  | "rename_current"
  | "set_workdir_current"
  | "clear_workdir_current";

export type WorkscenePostTurnControlKind = "enter" | "exit" | "set_workdir";

export type WorksceneConfirmationDisplay = "generic" | "workscene";

interface WorksceneManagementActionSpec {
  readonly label: string;
  readonly enabled?: boolean;
}

interface WorksceneManagementToolSpec {
  readonly surface: "main" | "workscene";
  readonly actions: Partial<
    Record<WorksceneManagementAction, WorksceneManagementActionSpec>
  >;
  readonly boundaries: readonly BoundaryCrossing[];
  readonly requiresExplicitConfirmation: boolean;
  readonly confirmationDisplay: WorksceneConfirmationDisplay;
  readonly postTurnControlKind?: WorkscenePostTurnControlKind;
}

const AGENT_CONTEXT_SWITCH_BOUNDARIES = [
  { boundaryType: "agent-context", access: "switch", dynamic: false },
] as const satisfies readonly BoundaryCrossing[];

const FILESYSTEM_WRITE_BOUNDARIES = [
  { boundaryType: "filesystem", access: "write", dynamic: false },
] as const satisfies readonly BoundaryCrossing[];

const FILESYSTEM_READ_BOUNDARIES = [
  { boundaryType: "filesystem", access: "read", dynamic: false },
] as const satisfies readonly BoundaryCrossing[];

const AGENT_CONTEXT_AND_FILESYSTEM_WRITE_BOUNDARIES = [
  ...AGENT_CONTEXT_SWITCH_BOUNDARIES,
  ...FILESYSTEM_WRITE_BOUNDARIES,
] as const satisfies readonly BoundaryCrossing[];

export const WORKSCENE_MANAGEMENT_TOOLS = {
  workscene_change_approve: {
    surface: "main",
    actions: {
      add: { label: "创建工作场景" },
      remove: { label: "删除工作场景" },
      rename: { label: "重命名工作场景" },
      set_workdir: { label: "绑定或更换设备工作区" },
      clear_workdir: { label: "解除工作区绑定" },
    },
    boundaries: FILESYSTEM_WRITE_BOUNDARIES,
    requiresExplicitConfirmation: true,
    confirmationDisplay: "workscene",
  },
  workscene_list: {
    surface: "main",
    actions: {
      list: { label: "查看工作场景列表" },
    },
    boundaries: FILESYSTEM_READ_BOUNDARIES,
    requiresExplicitConfirmation: false,
    confirmationDisplay: "generic",
  },
  workmode_enter: {
    surface: "main",
    actions: {
      enter: { label: "进入工作场景" },
    },
    boundaries: AGENT_CONTEXT_SWITCH_BOUNDARIES,
    requiresExplicitConfirmation: true,
    confirmationDisplay: "generic",
    postTurnControlKind: "enter",
  },
  workmode_exit: {
    surface: "workscene",
    actions: {
      exit: { label: "退出工作场景" },
    },
    boundaries: AGENT_CONTEXT_SWITCH_BOUNDARIES,
    requiresExplicitConfirmation: true,
    confirmationDisplay: "generic",
    postTurnControlKind: "exit",
  },
  workscene_rename_current: {
    surface: "workscene",
    actions: {
      rename_current: { label: "重命名当前工作场景" },
    },
    boundaries: FILESYSTEM_WRITE_BOUNDARIES,
    requiresExplicitConfirmation: true,
    confirmationDisplay: "workscene",
  },
  workscene_set_workdir_current: {
    surface: "workscene",
    actions: {
      set_workdir_current: { label: "更换当前工作场景工作区" },
    },
    boundaries: AGENT_CONTEXT_AND_FILESYSTEM_WRITE_BOUNDARIES,
    requiresExplicitConfirmation: true,
    confirmationDisplay: "workscene",
  },
  workscene_clear_workdir_current: {
    surface: "workscene",
    actions: {
      clear_workdir_current: { label: "解除当前工作场景工作区绑定" },
    },
    boundaries: AGENT_CONTEXT_AND_FILESYSTEM_WRITE_BOUNDARIES,
    requiresExplicitConfirmation: true,
    confirmationDisplay: "workscene",
  },
} as const satisfies Record<
  WorksceneManagementToolName,
  WorksceneManagementToolSpec
>;

export function isWorksceneManagementToolName(
  toolName: string,
): toolName is WorksceneManagementToolName {
  return Object.prototype.hasOwnProperty.call(
    WORKSCENE_MANAGEMENT_TOOLS,
    toolName,
  );
}

export function getWorksceneToolBoundaries(
  toolName: WorksceneManagementToolName,
): BoundaryCrossing[] {
  return WORKSCENE_MANAGEMENT_TOOLS[toolName].boundaries.map((b) => ({ ...b }));
}

export function getEnabledWorksceneToolActions(
  toolName: WorksceneManagementToolName,
): WorksceneManagementAction[] {
  return Object.entries(WORKSCENE_MANAGEMENT_TOOLS[toolName].actions)
    .filter(([, spec]) => spec.enabled !== false)
    .map(([action]) => action as WorksceneManagementAction);
}

export function worksceneToolRequiresExplicitConfirmation(
  toolName: WorksceneManagementToolName,
): boolean {
  return WORKSCENE_MANAGEMENT_TOOLS[toolName].requiresExplicitConfirmation;
}

export function isWorksceneConfirmationDisplayTool(
  toolName: string,
): toolName is WorksceneManagementToolName {
  return (
    isWorksceneManagementToolName(toolName) &&
    WORKSCENE_MANAGEMENT_TOOLS[toolName].confirmationDisplay === "workscene"
  );
}

export function getWorksceneToolsRequiringExplicitConfirmation(): WorksceneManagementToolName[] {
  return (Object.keys(WORKSCENE_MANAGEMENT_TOOLS) as WorksceneManagementToolName[])
    .filter((name) => WORKSCENE_MANAGEMENT_TOOLS[name].requiresExplicitConfirmation);
}

export function getWorksceneToolPostTurnControlKind(
  toolName: WorksceneManagementToolName,
): WorkscenePostTurnControlKind | undefined {
  return asToolSpec(toolName).postTurnControlKind;
}

export interface WorksceneChangeSummaryInput {
  readonly action: string;
  readonly name?: unknown;
  readonly sceneId?: unknown;
  /** 仅供当前设备本地受信确认面展示，不得进入普通控制 wire。 */
  readonly workdir?: unknown;
  readonly deviceName?: unknown;
  readonly workspaceName?: unknown;
}

export interface WorksceneChangeSummaryOptions {
  readonly displayContext?: ConfirmationDisplayContext;
  readonly workdirNotice?: string;
}

export function buildWorksceneToolConfirmationSummary(
  toolName: WorksceneManagementToolName,
  input: Record<string, unknown>,
  opts: WorksceneChangeSummaryOptions = {},
): string {
  switch (toolName) {
    case "workscene_change_approve":
      return buildWorksceneChangeSummary(
        {
          action: String(input.action ?? ""),
          name: input.name,
          sceneId: input.sceneId,
          workdir: input.workdir,
          deviceName: input.deviceName,
          workspaceName: input.workspaceName,
        },
        opts,
      );
    case "workscene_rename_current":
      return buildWorksceneChangeSummary(
        { action: "rename_current", name: input.name },
        opts,
      );
    case "workscene_set_workdir_current":
      return buildWorksceneChangeSummary(
        {
          action: "set_workdir_current",
          deviceName: input.deviceName,
          workspaceName: input.workspaceName,
        },
        opts,
      );
    case "workscene_clear_workdir_current":
      return buildWorksceneChangeSummary(
        { action: "clear_workdir_current" },
        opts,
      );
    default:
      if (isWorksceneConfirmationDisplayTool(toolName)) {
        throw new Error(`缺少工作场景确认摘要构造: ${toolName}`);
      }
      return `${toolName} ${JSON.stringify(input)}`;
  }
}

export function buildWorksceneChangeSummary(
  change: WorksceneChangeSummaryInput,
  opts: WorksceneChangeSummaryOptions = {},
): string {
  const action = change.action as WorksceneManagementAction;
  const label = findActionLabel(action) ?? "工作场景变更";
  const lines = [`动作：${label}`];

  const currentScene = opts.displayContext?.workscene;
  switch (action) {
    case "add":
      lines.push(`新场景：${formatSceneName(change.name)}`);
      addWorkspaceLine(lines, change);
      break;
    case "remove":
      lines.push(`目标场景：${formatSceneId(change.sceneId)}`);
      break;
    case "rename":
      lines.push(`目标场景：${formatSceneId(change.sceneId)}`);
      lines.push(`新名称：${formatSceneName(change.name)}`);
      break;
    case "set_workdir":
      lines.push(`目标场景：${formatSceneId(change.sceneId)}`);
      addWorkspaceLine(lines, change);
      break;
    case "clear_workdir":
      lines.push(`目标场景：${formatSceneId(change.sceneId)}`);
      lines.push("设备工作区：解除绑定");
      break;
    case "rename_current":
      lines.push(`当前场景：${formatCurrentScene(currentScene)}`);
      lines.push(`新名称：${formatSceneName(change.name)}`);
      break;
    case "set_workdir_current":
      lines.push(`当前场景：${formatCurrentScene(currentScene)}`);
      addWorkspaceLine(lines, change);
      break;
    case "clear_workdir_current":
      lines.push(`当前场景：${formatCurrentScene(currentScene)}`);
      lines.push("设备工作区：解除绑定");
      break;
    case "enter":
    case "exit":
      break;
    default:
      lines.push(`动作参数：${String(change.action || "未知")}`);
  }

  if (opts.workdirNotice) lines.push(`提示：${opts.workdirNotice}`);
  return lines.join("\n");
}

function findActionLabel(action: WorksceneManagementAction): string | undefined {
  for (const spec of Object.values(WORKSCENE_MANAGEMENT_TOOLS) as WorksceneManagementToolSpec[]) {
    const actionSpec = spec.actions[action];
    if (actionSpec) return actionSpec.label;
  }
  return undefined;
}

function asToolSpec(toolName: WorksceneManagementToolName): WorksceneManagementToolSpec {
  return WORKSCENE_MANAGEMENT_TOOLS[toolName] as WorksceneManagementToolSpec;
}

function formatSceneName(value: unknown): string {
  if (typeof value !== "string") return "（未提供）";
  try {
    return normalizeSceneName(value);
  } catch {
    const raw = value.trim();
    return raw || "（空）";
  }
}

function formatSceneId(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "（未提供）";
}

function formatWorkdir(value: unknown): string {
  if (typeof value !== "string") return "（未提供）";
  try {
    return normalizeWorkdir(value);
  } catch {
    const raw = value.trim();
    return raw || "（空）";
  }
}

function addWorkdirLine(lines: string[], value: unknown): void {
  if (value === undefined || value === null) return;
  lines.push(`本机工作目录：${formatWorkdir(value)}`);
}

function addWorkspaceLine(
  lines: string[],
  change: WorksceneChangeSummaryInput,
): void {
  const deviceName = optionalName(change.deviceName);
  const workspaceName = optionalName(change.workspaceName);
  if (deviceName || workspaceName) {
    lines.push(
      `设备工作区：${deviceName ?? "（未提供设备）"} / ${
        workspaceName ?? "（未提供工作区）"
      }`,
    );
    return;
  }
  addWorkdirLine(lines, change.workdir);
}

function optionalName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function formatCurrentScene(
  scene: ConfirmationDisplayContext["workscene"] | undefined,
): string {
  if (!scene) return "（当前场景）";
  return `${scene.sceneName} (${scene.sceneId})`;
}
