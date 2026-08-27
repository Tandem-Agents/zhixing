/**
 * 工作模式 agent 工具 —— 经 builtinExtraTools.assembleTools 按 spec.kind 注入。
 *
 * 设计要点：
 *   - 工具只捕获工作场景领域服务窄接口（不反依赖宿主具体类），故可脱离
 *     核心宿主用 mock 接口单测。
 *   - 切换类工具（enter/exit）**只 emit 意图、不执行切换**：run() 侧 accumulator
 *     收集、随 RunResult 带出，CLI 主回路 turn 边界唯一 post-turn consumer 消费。
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
  normalizeSceneName,
  worksceneToolRequiresExplicitConfirmation,
  type JsonSchema,
  type ToolDefinition,
  type WorksceneManagementToolName,
} from "@zhixing/core";
import type {
  AssignmentMutationOverlayRecord,
  GlobalStagedMutation,
  WorksceneDto,
} from "@zhixing/core/contracts";
import {
  emitPostTurnControlIntent,
  hasPostTurnControlCapability,
  runContextStorage,
} from "@zhixing/orchestrator/runtime";
import type { WorksceneToolDirectory } from "./workscene-port.js";
export type { WorksceneToolDirectory } from "./workscene-port.js";

export interface WorksceneCurrentToolContext {
  readonly sceneId: string;
  readonly sceneName: string;
}

function activeAssignment() {
  const run = runContextStorage.getStore();
  if (!run?.assignmentMutations || !run.globalQuery) {
    throw new Error("工作场景操作需要处于可耐久提交的当前任务中");
  }
  return {
    mutations: run.assignmentMutations,
    query: run.globalQuery,
  };
}

function operationId(toolCallId: string | undefined, action: string): string {
  if (!toolCallId?.trim()) {
    throw new Error(`${action} 缺少耐久工具调用身份`);
  }
  return `workscene:${toolCallId}`;
}

async function worksceneOverlayRecords(): Promise<
  readonly AssignmentMutationOverlayRecord[]
> {
  return (await activeAssignment().mutations.readOverlay())
    .filter((record) => record.domain === "global")
    .sort((left, right) => left.recordSeq - right.recordSeq);
}

function applyWorksceneOverlay(
  scene: WorksceneDto,
  records: readonly AssignmentMutationOverlayRecord[],
): WorksceneDto | null {
  let current: WorksceneDto | null = { ...scene };
  for (const record of records) {
    const mutation = record.mutation;
    if (!current || !("kind" in mutation)) continue;
    if (
      mutation.kind !== "workscene-rename" &&
      mutation.kind !== "workscene-set-workdir" &&
      mutation.kind !== "workscene-delete"
    ) {
      continue;
    }
    if (mutation.sceneId !== current.id) continue;
    if (mutation.expectedRevision !== current.revision) {
      throw new Error(`工作场景 ${current.id} 的当前任务内版本链不连续`);
    }
    if (mutation.kind === "workscene-delete") {
      current = null;
      continue;
    }
    current = {
      ...current,
      revision: current.revision + 1,
      ...(mutation.kind === "workscene-rename"
        ? { name: mutation.name }
        : mutation.workspace
          ? { workspace: mutation.workspace }
          : { workspace: undefined }),
    };
  }
  return current;
}

async function readWorkscene(sceneId: string): Promise<WorksceneDto | null> {
  const { query } = activeAssignment();
  const result = await query.read({ kind: "workscene-get", sceneId });
  if (result.kind !== "workscene-get") {
    throw new Error("工作场景查询返回了错误的结果类型");
  }
  return result.scene
    ? applyWorksceneOverlay(result.scene, await worksceneOverlayRecords())
    : null;
}

async function readWorkscenes(): Promise<WorksceneDto[]> {
  const { query } = activeAssignment();
  const result = await query.read({ kind: "workscene-list" });
  if (result.kind !== "workscene-list") {
    throw new Error("工作场景列表返回了错误的结果类型");
  }
  const records = await worksceneOverlayRecords();
  return result.scenes
    .map((scene) => applyWorksceneOverlay(scene, records))
    .filter((scene): scene is WorksceneDto => scene !== null);
}

async function stageWorkscene(
  mutation: GlobalStagedMutation,
  toolCallId: string | undefined,
): Promise<void> {
  await activeAssignment().mutations.stage({
    domain: "global",
    mutation,
    operationId: operationId(toolCallId, mutation.kind),
  });
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
  return fail("当前接入面暂不支持本轮结束后的工作场景控制，请在 CLI 中操作");
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
  _workscenes: Pick<WorksceneToolDirectory, "get">,
): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: {
      sceneId: {
        type: "string",
        description: "要进入的工作场景 id（用 workscene_list 确认 id）",
      },
    },
    required: ["sceneId"],
  };
  return {
    name: "workmode_enter",
    description:
      "进入一个工作场景：后续对话切到该场景的独立运行态（场景目录 + power 模型）。" +
      "切换在用户确认后、于本 turn 结束的 turn 边界发生——调用本工具后请正常把本轮回复收尾，不要假设已经切换。",
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
      const unsupported = assertPostTurnControlSupported("workmode_enter");
      if (unsupported) return unsupported;
      const scene = await readWorkscene(sceneId);
      if (!scene) return fail(`工作场景 "${sceneId}" 不存在，未切换`);
      emitPostTurnControlIntent({ kind: "enter", sceneId });
      return ok(
        `已请求进入工作场景「${scene.name}」，将在本轮结束后切换。请先把本轮回复收尾。`,
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
    properties: {},
  };
  return {
    name: "workmode_exit",
    description:
      "结束当前工作场景、返回主对话。当本场景的工作已告一段落时调用。" +
      "切换在本 turn 结束的 turn 边界发生——调用后请正常把本轮回复收尾。",
    inputSchema,
    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    requiresExplicitConfirmation:
      worksceneToolRequiresExplicitConfirmation("workmode_exit"),
    boundaries: getWorksceneToolBoundaries("workmode_exit"),
    async call() {
      const unsupported = assertPostTurnControlSupported("workmode_exit");
      if (unsupported) return unsupported;
      emitPostTurnControlIntent({ kind: "exit" });
      return ok("已请求退出工作场景，将在本轮结束后返回主对话。");
    },
  };
}

/**
 * workscene_change_approve（main-only，needsPermission）—— 用户拍板后改注册表。
 */
export function createWorksceneChangeApproveTool(
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
    name: "workscene_change_approve",
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
            await stageWorkscene(
              {
                kind: "workscene-create",
                name: normalizeSceneName(name),
                ...(selected ? { workspace: selected.workspace } : {}),
              },
              context?.toolCallId,
            );
            return ok(`已记录创建工作场景「${name}」；本轮成功完成后生效。`);
          }
          case "remove": {
            if (!sceneId) return fail("remove 需要 sceneId");
            // 用户工作区不动——它是用户资产，删除只清理场景系统数据。
            const scene = await readWorkscene(sceneId);
            if (!scene) return fail(`工作场景 "${sceneId}" 不存在`);
            await stageWorkscene(
              {
                kind: "workscene-delete",
                sceneId,
                expectedRevision: scene.revision,
              },
              context?.toolCallId,
            );
            return ok(`已记录删除工作场景「${scene.name}」；本轮成功完成后生效。`);
          }
          case "rename": {
            if (!sceneId || !name)
              return fail("rename 需要 sceneId 与 name");
            const scene = await readWorkscene(sceneId);
            if (!scene) return fail(`工作场景 "${sceneId}" 不存在`);
            const normalized = normalizeSceneName(name);
            await stageWorkscene(
              {
                kind: "workscene-rename",
                sceneId,
                name: normalized,
                expectedRevision: scene.revision,
              },
              context?.toolCallId,
            );
            return ok(`已记录将工作场景重命名为「${normalized}」；本轮成功完成后生效。`);
          }
          case "set_workdir": {
            if (!sceneId) return fail("set_workdir 需要 sceneId");
            const selected = await selectWorkspace(workscenes, input);
            if ("error" in selected) return fail(selected.error);
            const scene = await readWorkscene(sceneId);
            if (!scene) return fail(`工作场景 "${sceneId}" 不存在`);
            await stageWorkscene(
              {
                kind: "workscene-set-workdir",
                sceneId,
                workspace: selected.workspace,
                expectedRevision: scene.revision,
              },
              context?.toolCallId,
            );
            return ok(`已记录工作场景「${scene.name}」的工作区变更；本轮成功完成后生效。`);
          }
          case "clear_workdir": {
            if (!sceneId) return fail("clear_workdir 需要 sceneId");
            const scene = await readWorkscene(sceneId);
            if (!scene) return fail(`工作场景 "${sceneId}" 不存在`);
            await stageWorkscene(
              {
                kind: "workscene-set-workdir",
                sceneId,
                workspace: null,
                expectedRevision: scene.revision,
              },
              context?.toolCallId,
            );
            return ok(`已记录解除工作场景「${scene.name}」的工作区绑定；本轮成功完成后生效。`);
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
  workscenes: Pick<WorksceneToolDirectory, "workspaceCatalog">,
): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: {},
  };
  return {
    name: "workscene_list",
    description:
      "只读列出工作场景管理元数据（id、名称、设备工作区、最近使用时间），用于选择目标场景或查看工作区绑定。",
    inputSchema,
    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: false,
    boundaries: getWorksceneToolBoundaries("workscene_list"),
    async call() {
      const scenes = await readWorkscenes();
      if (scenes.length === 0) return ok("当前没有任何工作场景");
      const catalog = await workscenes.workspaceCatalog();
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
  _workscenes: Pick<WorksceneToolDirectory, "rename">,
  scene: WorksceneCurrentToolContext,
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
    name: "workscene_rename_current",
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
        name = normalizeSceneName(rawName);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      const current = await readWorkscene(scene.sceneId);
      if (!current) return fail(`当前工作场景 "${scene.sceneId}" 不存在`);
      await stageWorkscene(
        {
          kind: "workscene-rename",
          sceneId: scene.sceneId,
          name,
          expectedRevision: current.revision,
        },
        context?.toolCallId,
      );
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
    },
    required: ["deviceName", "workspaceName"],
  };
  return {
    name: "workscene_set_workdir_current",
    description:
      "更换当前工作场景的设备工作区。变更在本轮成功提交后生效，后续运行使用新工作区。",
    inputSchema,
    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    requiresExplicitConfirmation:
      worksceneToolRequiresExplicitConfirmation("workscene_set_workdir_current"),
    boundaries: getWorksceneToolBoundaries("workscene_set_workdir_current"),
    confirmationDisplayContext: currentDisplayContext(scene),
    async call(input, context) {
      const selected = await selectWorkspace(workscenes, input);
      if ("error" in selected) return fail(selected.error);
      const current = await readWorkscene(scene.sceneId);
      if (!current) return fail(`当前工作场景 "${scene.sceneId}" 不存在`);
      await stageWorkscene(
        {
          kind: "workscene-set-workdir",
          sceneId: scene.sceneId,
          workspace: selected.workspace,
          expectedRevision: current.revision,
        },
        context?.toolCallId,
      );
      return ok("已记录当前工作场景的工作区变更；本轮成功完成后生效。");
    },
  };
}

/**
 * workscene_clear_workdir_current（power-only）—— 暂存解除当前场景设备工作区绑定。
 */
export function createWorksceneClearWorkdirCurrentTool(
  scene: WorksceneCurrentToolContext,
): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: {},
  };
  return {
    name: "workscene_clear_workdir_current",
    description:
      "解除当前工作场景的设备工作区绑定。变更在本轮成功提交后生效，后续运行使用无工作区工具面。",
    inputSchema,
    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    requiresExplicitConfirmation:
      worksceneToolRequiresExplicitConfirmation("workscene_clear_workdir_current"),
    boundaries: getWorksceneToolBoundaries("workscene_clear_workdir_current"),
    confirmationDisplayContext: currentDisplayContext(scene),
    async call(_input, context) {
      const current = await readWorkscene(scene.sceneId);
      if (!current) return fail(`当前工作场景 "${scene.sceneId}" 不存在`);
      await stageWorkscene(
        {
          kind: "workscene-set-workdir",
          sceneId: scene.sceneId,
          workspace: null,
          expectedRevision: current.revision,
        },
        context?.toolCallId,
      );
      return ok("已记录解除当前工作场景的工作区绑定；本轮成功完成后生效。");
    },
  };
}
