/**
 * 工作模式 agent 工具 —— 由 Anchor 产品投影按运行形态注入。
 *
 * 设计要点：
 *   - 工具只捕获工作场景领域服务窄接口（不反依赖宿主具体类），故可脱离
 *     核心宿主用 mock 接口单测。
 *   - 切换类工具（enter/exit）**只 emit 意图、不执行切换**：run() 侧 accumulator
 *     收集并随成功运行提交；产品应用消费任务交接，接入面只呈现或切换视图。
 *     工具 call 体返回的文本提示 LLM「切换将在本 turn 结束后发生」，让其先把
 *     本 turn 收尾。
 *   - by-construction 隔离：注入哪组由 spec.kind 决定（见 assembleTools），
 *     power runtime 物理不持有 main-only 工具，场景内工具只能闭包触达自身 sceneId。
 *
 * 权限策略（**load-bearing 字段是 boundaries，不是 needsPermission**）：
 *   `needsPermission` 在当前实现里只是自描述文档字段（grep 全仓库无运行时消费）。
 *   真正驱动 confirm 弹窗的是 `OperationClassifier`：声明 `boundaries` 让分类器
 *   把 enter/exit/change_approve 归到 `agent-context` / `filesystem.write` 这类
 *   external 类，自然升级到 confirm；list 声明 `filesystem.read`
 *   归为 observe，自动放行。声明而非依赖 BoundaryImpactClassifier 的 fail-closed
 *   critical 兜底 —— 那条路径是"忘了声明的最后保底"，不应该作为 intended 行为。
 *
 *   - LLM 调 enter / exit / change_approve → 系统弹 confirm 让用户拍板
 *   - LLM 调 list → 自动放行
 *   - 用户命令 `/work` / `/exit` 走产品命令分发，根本不经 SecurityPipeline，
 *     天然不需要确认（用户意图即授权）
 */

import {
  getEnabledWorksceneToolActions,
  getWorksceneToolBoundaries,
  getWorksceneToolPostTurnControlKind,
  worksceneToolRequiresExplicitConfirmation,
  type WorksceneManagementToolName,
} from "@zhixing/core/workscene";
import { type JsonSchema, type ToolDefinition } from "@zhixing/core";
import type { WorksceneTaskHandoff } from "@zhixing/core/types";
import { isLocalConversationId } from "@zhixing/core/conversation";
import type { WorksceneDto } from "@zhixing/core/contracts";
import type { WorksceneAssignmentToolApplication } from "@zhixing/core/workscene/application";
import { validateWorksceneTaskHandoff } from "@zhixing/core/workscene/application";
import {
  emitPostTurnControlIntent,
  hasPostTurnControlCapability,
  runContextStorage,
} from "@zhixing/orchestrator/runtime";
import type { WorksceneToolDirectory } from "./workscene-port.js";
import { WORKING_MODE_TEXT } from "./workscene-agent-guidance.js";
export type { WorksceneToolDirectory } from "./workscene-port.js";

/** Canonical product tool identities shared by runtime assembly and readiness. */
export const WORKSCENE_PRODUCT_TOOL_IDS = Object.freeze({
  enter: "workmode_enter",
  exit: "workmode_exit",
  change: "workscene_change_approve",
  list: "workscene_list",
  renameCurrent: "workscene_rename_current",
  setWorkdirCurrent: "workscene_set_workdir_current",
  clearWorkdirCurrent: "workscene_clear_workdir_current",
  taskList: "workscene_task_list",
  taskStop: "workscene_task_stop",
} as const);

export function createWorksceneTaskTools(): ToolDefinition[] {
  return [{
    name: WORKSCENE_PRODUCT_TOOL_IDS.taskList,
    description: "查看当前对话尚未交付的场景委托及其停止引用；这里只列本轮开始时的事实快照。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: true, isParallelSafe: true,
    boundaries: [{ boundaryType: "filesystem", access: "read", dynamic: false }],
    async call() { return ok(JSON.stringify(runContextStorage.getStore()?.worksceneTasks ?? [])); },
  }, {
    name: WORKSCENE_PRODUCT_TOOL_IDS.taskStop,
    description: "用户明确撤销或替换场景委托时，按 workscene_task_list 的原委托引用请求停止。进度询问、补充约束或另开话题不等于撤销；含糊时先澄清。停止请求随本轮成功提交，不撤销已发生的动作。",
    inputSchema: { type: "object", properties: { conversationId: { type: "string" }, runId: { type: "string" } }, required: ["conversationId", "runId"], additionalProperties: false },
    isReadOnly: false, isParallelSafe: false,
    boundaries: [{ boundaryType: "agent-context", access: "switch", dynamic: false }],
    async call(input) {
      const run = runContextStorage.getStore();
      if (!run?.assignmentMutations || run.assignmentMutations.execution !== "conversation") return fail("停止委托需要当前耐久对话");
      const target = run.worksceneTasks?.find((task) => task.conversationId === input.conversationId && task.runId === input.runId);
      if (!target) return fail("停止引用不在本轮获准委托列表中，请核对任务，不要猜测引用");
      emitPostTurnControlIntent({ kind: "stop_task", conversationId: target.conversationId, runId: target.runId });
      return ok("已请求停止该委托，待本轮成功提交后生效；请结束本轮。尚未确认停止，不代表动作已回滚。");
    },
  }];
}

export interface WorksceneCurrentToolContext {
  readonly sceneId: string;
  readonly sceneName: string;
}

function ok(content: string): Promise<{ content: string }> {
  return Promise.resolve({ content });
}

function fail(content: string): Promise<{ content: string; isError: true }> {
  return Promise.resolve({ content, isError: true });
}

function postTurnControlUnsupported(): Promise<{
  content: string;
  isError: true;
}> {
  return fail("当前接入面不支持单纯切换对话；如需在场景中继续已受托任务，请明确交接内容并确认。");
}

const handoffSchema = {
  type: "object",
  description: "需要继续当前任务时提供，仅含获准交接的目标、用户限制、已完成结果和剩余事项。只切换对话时省略；不复制私人约定、无关历史或秘密。",
  properties: {
    goal: { type: "string", description: "原任务目标，不改变交付含义" },
    constraints: { type: "array", items: { type: "string" }, description: "用户已确认的限制" },
    completed: { type: "array", items: { type: "string" }, description: "已有结果及核对依据，区分确定事实和不确定状态" },
    remaining: { type: "array", items: { type: "string" }, description: "尚需完成的事项；已完成的任务用空列表" },
  },
  required: ["goal", "constraints", "completed", "remaining"],
  additionalProperties: false,
};

function readHandoff(input: Record<string, unknown>): WorksceneTaskHandoff | undefined {
  if (input.handoff === undefined) return undefined;
  validateWorksceneTaskHandoff(input.handoff);
  const run = runContextStorage.getStore();
  if (run?.assignmentMutations?.execution !== "conversation" || (run.conversationId && isLocalConversationId(run.conversationId))) throw new Error("任务交接需要 Anchor 所属的耐久对话，当前运行不能接纳场景续接。");
  return structuredClone(input.handoff);
}

function assertPostTurnControlSupported(
  toolName: WorksceneManagementToolName,
):
  | Promise<{
      content: string;
      isError: true;
    }>
  | undefined {
  if (
    getWorksceneToolPostTurnControlKind(toolName) &&
    !hasPostTurnControlCapability()
  ) {
    return postTurnControlUnsupported();
  }
  return undefined;
}

function currentDisplayContext(scene: WorksceneCurrentToolContext) {
  return {
    workscene: { sceneId: scene.sceneId, sceneName: scene.sceneName },
  };
}

function formatSceneLine(
  scene: WorksceneDto,
  label?: { deviceName: string; workspaceName: string },
): string {
  const parts = [
    `- ${scene.name} (id: ${scene.id})`,
    `  工作区：${
      scene.workspace
        ? label
          ? `${label.deviceName} / ${label.workspaceName}`
          : "已绑定"
        : "未绑定"
    }`,
  ];
  if (scene.lastActiveAt) parts.push(`  最近使用：${scene.lastActiveAt}`);
  return parts.join("\n");
}

async function selectWorkspace(
  workscenes: Pick<WorksceneToolDirectory, "selectWorkspace">,
  input: Record<string, unknown>,
): Promise<
  | { readonly workspace: { deviceId: string; bindingRef: string } }
  | { readonly error: string }
> {
  const deviceName =
    typeof input.deviceName === "string" ? input.deviceName.trim() : "";
  const workspaceName =
    typeof input.workspaceName === "string" ? input.workspaceName.trim() : "";
  if (!deviceName || !workspaceName) {
    return { error: "需要 deviceName 与 workspaceName" };
  }
  const workspace = await workscenes.selectWorkspace({
    deviceName,
    workspaceName,
  });
  return workspace
    ? { workspace }
    : { error: `未找到设备「${deviceName}」上的工作区「${workspaceName}」` };
}

/**
 * workmode_enter（main-only，needsPermission）—— 用户拍板且接入面可消费后 emit 进入意图。
 *
 * 只依赖工作场景领域服务做存在性校验;意图经 emitPostTurnControlIntent 发当前
 * run 的 bus——与 controller 解耦,宿主侧装配同样可用。
 */
export function createWorkmodeEnterTool(
  application: Pick<WorksceneAssignmentToolApplication, "get">,
): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: {
      sceneId: {
        type: "string",
        description: "要进入的工作场景 id（用 workscene_list 确认 id）",
      },
      handoff: handoffSchema,
    },
    required: ["sceneId"],
  };
  return {
    name: WORKSCENE_PRODUCT_TOOL_IDS.enter,
    systemPromptGuidance: WORKING_MODE_TEXT,
    description:
      "在工作场景的独立上下文、授权工作区与 power 模型中处理任务。" +
      "有未完成任务时用 handoff 交接，确认并成功提交本轮后自动续接，结果返回原对话；只切换视图时省略 handoff，不启动旧任务。调用后先结束本轮，不假设已经切换。",
    inputSchema,
    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    requiresExplicitConfirmation:
      worksceneToolRequiresExplicitConfirmation("workmode_enter"),
    permissionArgumentKey: "sceneId",
    boundaries: getWorksceneToolBoundaries("workmode_enter"),
    async call(input) {
      const sceneId = String(input.sceneId ?? "").trim();
      if (!sceneId) return fail("workmode_enter 需要 sceneId");
      const handoff = readHandoff(input);
      const unsupported = handoff?.remaining.length ? undefined : assertPostTurnControlSupported("workmode_enter");
      if (unsupported) return unsupported;
      const scene = await application.get(sceneId);
      if (!scene) return fail(`工作场景 "${sceneId}" 不存在，未切换`);
      emitPostTurnControlIntent({ kind: "enter", sceneId, ...(handoff ? { handoff } : {}) });
      return ok(
        `已请求进入工作场景「${scene.name}」。${handoff?.remaining.length ? "交接将在本轮成功提交后接纳并续接；当前尚未开始。" : "将在本轮结束后切换，不自动开始任务。"}请先结束本轮。`,
      );
    },
  };
}

/**
 * workmode_exit（power-only，需 confirmation）—— LLM 自判完结 emit 退出意图。
 *
 * 退出和进入对称都要用户拍板,让用户对"是否真要离开当前 workscene"显式确认。
 * 用户主动用 `/exit` 命令则不经此工具，天然无需确认（用户意图即授权）。
 *
 * 零依赖:意图经 emitPostTurnControlIntent 发当前 run 的 bus,turn 边界由
 * 调用方消费——交互直驱与宿主装配共用同一工具。
 */
export function createWorkmodeExitTool(): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: { handoff: handoffSchema },
  };
  return {
    name: WORKSCENE_PRODUCT_TOOL_IDS.exit,
    description:
      "结束当前工作场景、返回主对话。当本场景的工作已告一段落时调用。" +
      "仍有原任务需要在主对话处理时提供 handoff，沿已记录的来源交接；单纯退出则省略。成功提交后生效，调用后结束本轮。",
    inputSchema,
    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    requiresExplicitConfirmation:
      worksceneToolRequiresExplicitConfirmation("workmode_exit"),
    boundaries: getWorksceneToolBoundaries("workmode_exit"),
    async call(input) {
      const handoff = readHandoff(input);
      if (handoff && !runContextStorage.getStore()?.turnOrigin?.worksceneContinuation?.returnConversationId) return fail("当前场景没有已记录的原任务来源，未交接；请在当前场景继续处理，或明确返回的目标对话。");
      const unsupported = handoff?.remaining.length ? undefined : assertPostTurnControlSupported("workmode_exit");
      if (unsupported) return unsupported;
      emitPostTurnControlIntent({ kind: "exit", ...(handoff ? { handoff } : {}) });
      return ok("已请求退出工作场景，将在本轮结束后返回主对话。");
    },
  };
}

/**
 * workscene_change_approve（main-only，needsPermission）—— 用户拍板后改注册表。
 */
export function createWorksceneChangeApproveTool(
  application: WorksceneAssignmentToolApplication,
  workscenes: Pick<
    WorksceneToolDirectory,
    "selectWorkspace"
  >,
): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: getEnabledWorksceneToolActions("workscene_change_approve"),
        description: "对工作场景注册表的变更动作",
      },
      name: {
        type: "string",
        description: "add：新场景名；rename：新名称",
      },
      sceneId: {
        type: "string",
        description: "remove/rename/set_workdir/clear_workdir 的目标场景 id",
      },
      deviceName: {
        type: "string",
        description: "add 可选、set_workdir 必填：目标设备的显示名称",
      },
      workspaceName: {
        type: "string",
        description: "add 可选、set_workdir 必填：目标设备已授权工作区的显示名称",
      },
    },
    required: ["action"],
  };
  return {
    name: WORKSCENE_PRODUCT_TOOL_IDS.change,
    description:
      "增删改工作场景注册表（add/remove/rename/set_workdir/clear_workdir）。远程只按设备名和已授权工作区名选择，需用户确认。",
    inputSchema,
    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    requiresExplicitConfirmation:
      worksceneToolRequiresExplicitConfirmation("workscene_change_approve"),
    permissionArgumentKey: "action",
    // 写场景注册表落盘文件 → filesystem.write → external → confirm。
    boundaries: getWorksceneToolBoundaries("workscene_change_approve"),
    async call(input, context) {
      const action = String(input.action ?? "");
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const sceneId =
        typeof input.sceneId === "string" ? input.sceneId.trim() : "";
      try {
        switch (action) {
          case "add": {
            if (!name) return fail("add 需要 name");
            const hasWorkspace =
              input.deviceName !== undefined || input.workspaceName !== undefined;
            const selected = hasWorkspace
              ? await selectWorkspace(workscenes, input)
              : undefined;
            if (selected && "error" in selected) return fail(selected.error);
            await application.create({
              name,
              ...(selected ? { workspace: selected.workspace } : {}),
              toolCallId: context?.toolCallId,
            });
            return ok(`已记录创建工作场景「${name}」；本轮成功完成后生效。`);
          }
          case "remove": {
            if (!sceneId) return fail("remove 需要 sceneId");
            // 用户工作区不动——它是用户资产，删除只清理场景系统数据。
            const deleted = await application.delete({
              sceneId,
              toolCallId: context?.toolCallId,
            });
            if (!deleted) return fail(`工作场景 "${sceneId}" 不存在`);
            return ok(`已记录删除工作场景「${deleted.previous.name}」；本轮成功完成后生效。`);
          }
          case "rename": {
            if (!sceneId || !name)
              return fail("rename 需要 sceneId 与 name");
            const renamed = await application.rename({
              sceneId,
              name,
              toolCallId: context?.toolCallId,
            });
            if (!renamed) return fail(`工作场景 "${sceneId}" 不存在`);
            return ok(`已记录将工作场景重命名为「${renamed.name}」；本轮成功完成后生效。`);
          }
          case "set_workdir": {
            if (!sceneId) return fail("set_workdir 需要 sceneId");
            const selected = await selectWorkspace(workscenes, input);
            if ("error" in selected) return fail(selected.error);
            const changed = await application.setWorkspace({
              sceneId,
              workspace: selected.workspace,
              toolCallId: context?.toolCallId,
            });
            if (!changed) return fail(`工作场景 "${sceneId}" 不存在`);
            return ok(`已记录工作场景「${changed.previous.name}」的工作区变更；本轮成功完成后生效。`);
          }
          case "clear_workdir": {
            if (!sceneId) return fail("clear_workdir 需要 sceneId");
            const changed = await application.setWorkspace({
              sceneId,
              workspace: null,
              toolCallId: context?.toolCallId,
            });
            if (!changed) return fail(`工作场景 "${sceneId}" 不存在`);
            return ok(`已记录解除工作场景「${changed.previous.name}」的工作区绑定；本轮成功完成后生效。`);
          }
          default:
            return fail(`未知 action: ${action}`);
        }
      } catch (err) {
        return fail(
          `工作场景变更失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

/**
 * workscene_list（main-only，只读）—— 查看场景管理元数据。
 */
export function createWorksceneListTool(
  application: Pick<WorksceneAssignmentToolApplication, "list">,
  workscenes?: Pick<WorksceneToolDirectory, "workspaceCatalog">,
): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: {},
  };
  return {
    name: WORKSCENE_PRODUCT_TOOL_IDS.list,
    description:
      "只读列出工作场景管理元数据（id、名称、设备工作区、最近使用时间），用于选择目标场景或查看工作区绑定。",
    inputSchema,
    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: false,
    boundaries: getWorksceneToolBoundaries("workscene_list"),
    async call() {
      const scenes = await application.list();
      if (scenes.length === 0) return ok("当前没有任何工作场景");
      const catalog = workscenes ? await workscenes.workspaceCatalog() : [];
      return ok(
        scenes
          .map((scene) => {
            const binding = scene.workspace
              ? catalog.find(
                  (entry) =>
                    entry.deviceId === scene.workspace?.deviceId &&
                    entry.bindingRef === scene.workspace.bindingRef,
                )
              : undefined;
            return formatSceneLine(
              scene,
              binding
                ? {
                    deviceName: binding.deviceName,
                    workspaceName: binding.workspaceName,
                  }
                : undefined,
            );
          })
          .join("\n\n"),
      );
    },
  };
}

/**
 * workscene_rename_current（power-only）—— 确认后轻量改当前场景登记名。
 */
export function createWorksceneRenameCurrentTool(
  scene: WorksceneCurrentToolContext,
  application: Pick<
    WorksceneAssignmentToolApplication,
    "normalizeName" | "rename"
  >,
): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "当前工作场景的新名称",
      },
    },
    required: ["name"],
  };
  return {
    name: WORKSCENE_PRODUCT_TOOL_IDS.renameCurrent,
    description:
      "重命名当前工作场景。只改当前场景登记名，不退出、不重进；当前窗口里的旧称呼可到下次窗口或重进时自然更新。",
    inputSchema,
    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    requiresExplicitConfirmation:
      worksceneToolRequiresExplicitConfirmation("workscene_rename_current"),
    boundaries: getWorksceneToolBoundaries("workscene_rename_current"),
    confirmationDisplayContext: currentDisplayContext(scene),
    async call(input, context) {
      const rawName = typeof input.name === "string" ? input.name : "";
      let name: string;
      try {
        name = application.normalizeName(rawName);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      const renamed = await application.rename({
        sceneId: scene.sceneId,
        name,
        toolCallId: context?.toolCallId,
      });
      if (!renamed) return fail(`当前工作场景 "${scene.sceneId}" 不存在`);
      return ok(
        `已记录将当前工作场景重命名为「${name}」；本轮成功完成后生效。当前窗口名称保持不变。`,
      );
    },
  };
}

/**
 * workscene_set_workdir_current（power-only）—— 确认后暂存当前场景工作区变更。
 */
export function createWorksceneSetWorkdirCurrentTool(
  scene: WorksceneCurrentToolContext,
  application: Pick<WorksceneAssignmentToolApplication, "setWorkspace">,
  workscenes: Pick<WorksceneToolDirectory, "selectWorkspace">,
): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: {
      deviceName: {
        type: "string",
        description: "目标设备的显示名称",
      },
      workspaceName: {
        type: "string",
        description: "目标设备已授权工作区的显示名称",
      },
      handoff: handoffSchema,
    },
    required: ["deviceName", "workspaceName"],
  };
  return {
    name: WORKSCENE_PRODUCT_TOOL_IDS.setWorkdirCurrent,
    description:
      "更换当前工作场景的设备工作区。本轮成功提交后生效；需要在新环境继续原任务时提供 handoff，随后结束本轮。",
    inputSchema,
    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    requiresExplicitConfirmation:
      worksceneToolRequiresExplicitConfirmation("workscene_set_workdir_current"),
    boundaries: getWorksceneToolBoundaries("workscene_set_workdir_current"),
    confirmationDisplayContext: currentDisplayContext(scene),
    async call(input, context) {
      const handoff = readHandoff(input);
      const selected = await selectWorkspace(workscenes, input);
      if ("error" in selected) return fail(selected.error);
      const changed = await application.setWorkspace({
        sceneId: scene.sceneId,
        workspace: selected.workspace,
        toolCallId: context?.toolCallId,
      });
      if (!changed) return fail(`当前工作场景 "${scene.sceneId}" 不存在`);
      if (handoff) emitPostTurnControlIntent({ kind: "set_workdir", sceneId: scene.sceneId, workspace: selected.workspace, handoff });
      return ok("已记录当前工作场景的工作区变更；本轮成功完成后生效。");
    },
  };
}

/**
 * workscene_clear_workdir_current（power-only）—— 暂存解除当前场景设备工作区绑定。
 */
export function createWorksceneClearWorkdirCurrentTool(
  scene: WorksceneCurrentToolContext,
  application: Pick<WorksceneAssignmentToolApplication, "setWorkspace">,
): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: { handoff: handoffSchema },
  };
  return {
    name: WORKSCENE_PRODUCT_TOOL_IDS.clearWorkdirCurrent,
    description:
      "解除当前工作场景的设备工作区绑定。本轮成功提交后生效；需要在无工作区环境继续原任务时提供 handoff，随后结束本轮。",
    inputSchema,
    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    requiresExplicitConfirmation:
      worksceneToolRequiresExplicitConfirmation("workscene_clear_workdir_current"),
    boundaries: getWorksceneToolBoundaries("workscene_clear_workdir_current"),
    confirmationDisplayContext: currentDisplayContext(scene),
    async call(input, context) {
      const handoff = readHandoff(input);
      const changed = await application.setWorkspace({
        sceneId: scene.sceneId,
        workspace: null,
        toolCallId: context?.toolCallId,
      });
      if (!changed) return fail(`当前工作场景 "${scene.sceneId}" 不存在`);
      if (handoff) emitPostTurnControlIntent({ kind: "set_workdir", sceneId: scene.sceneId, workspace: null, handoff });
      return ok("已记录解除当前工作场景的工作区绑定；本轮成功完成后生效。");
    },
  };
}
