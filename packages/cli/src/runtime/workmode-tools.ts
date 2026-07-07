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
 *     power runtime 物理不持有 main-only 工具。
 *
 * 权限策略（**load-bearing 字段是 boundaries，不是 needsPermission**）：
 *   `needsPermission` 在当前实现里只是自描述文档字段（grep 全仓库无运行时消费）。
 *   真正驱动 confirm 弹窗的是 `OperationClassifier`：声明 `boundaries` 让分类器
 *   把 enter/exit/change_approve 归到 `agent-context` / `filesystem.write` 这类
 *   external 类，自然升级到 confirm；list / memory_query 声明 `filesystem.read`
 *   归为 observe，自动放行。声明而非依赖 BoundaryImpactClassifier 的 fail-closed
 *   critical 兜底 —— 那条路径是"忘了声明的最后保底"，不应该作为 intended 行为。
 *
 *   - LLM 调 enter / exit / change_approve → 系统弹 confirm 让用户拍板
 *   - LLM 调 list / memory_query → 自动放行
 *   - 用户命令 `/work` / `/exit` 走 cli 命令分发，根本不经 SecurityPipeline，
 *     天然不需要确认（用户意图即授权）
 */

import {
  MemoryStore,
  getEnabledWorksceneToolActions,
  getWorkSceneMemoryDir,
  getWorksceneToolBoundaries,
  getWorksceneToolPostTurnControlKind,
  worksceneToolRequiresExplicitConfirmation,
  type JsonSchema,
  type MemoryCategory,
  type ToolDefinition,
  type WorkScene,
  type WorksceneManagementToolName,
} from "@zhixing/core";
import {
  emitPostTurnControlIntent,
  hasPostTurnControlCapability,
} from "@zhixing/orchestrator/runtime";
import type { WorksceneDirectory } from "@zhixing/server";

export type WorksceneToolDirectory = Pick<
  WorksceneDirectory,
  "list" | "get" | "create" | "rename" | "setWorkdir" | "remove"
>;

/** 单条记忆片段上限 —— 控制注入主上下文的体量（只读检索非 raw dump）。 */
const MEMORY_SNIPPET_CAP = 500;

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

function appendWorkdirWarning(content: string, warning?: string): string {
  return warning ? `${content}\n提示：${warning}` : content;
}

function formatSceneLine(scene: WorkScene): string {
  const parts = [
    `- ${scene.name} (id: ${scene.id})`,
    `  工作目录：${scene.workdir ?? "未绑定"}`,
  ];
  if (scene.lastActiveAt) parts.push(`  最近使用：${scene.lastActiveAt}`);
  return parts.join("\n");
}

/**
 * workmode_enter（main-only，needsPermission）—— 用户拍板且接入面可消费后 emit 进入意图。
 *
 * 只依赖工作场景领域服务做存在性校验;意图经 emitPostTurnControlIntent 发当前
 * run 的 bus——与 controller 解耦,宿主侧装配同样可用。
 */
export function createWorkmodeEnterTool(
  workscenes: Pick<WorksceneToolDirectory, "get">,
): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: {
      sceneId: {
        type: "string",
        description: "要进入的工作场景 id（用 workscene_list 或 workscene_memory_query 确认 id）",
      },
    },
    required: ["sceneId"],
  };
  return {
    name: "workmode_enter",
    description:
      "进入一个工作场景：后续对话切到该场景的独立运行态（场景目录 + 场景记忆域 + power 模型）。" +
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
      const scene = await workscenes.get(sceneId);
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
 * 用户主动用 `/exit` cli 命令则不经此工具，天然无需确认（用户意图即授权）。
 *
 * 零依赖:意图经 emitPostTurnControlIntent 发当前 run 的 bus,turn 边界由
 * 调用方消费——cli 直驱与宿主装配同一工具。
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
    "create" | "remove" | "rename" | "setWorkdir"
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
      workdir: {
        type: "string",
        description: "add 可选、set_workdir 必填：该场景的工作目录（必须是绝对路径）",
      },
    },
    required: ["action"],
  };
  return {
    name: "workscene_change_approve",
    description:
      "增删改工作场景注册表（add/remove/rename/set_workdir/clear_workdir）。需用户确认。",
    inputSchema,
    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    requiresExplicitConfirmation:
      worksceneToolRequiresExplicitConfirmation("workscene_change_approve"),
    permissionArgumentKey: "action",
    // 写场景注册表落盘文件 → filesystem.write → external → confirm。
    boundaries: getWorksceneToolBoundaries("workscene_change_approve"),
    async call(input) {
      const action = String(input.action ?? "");
      const name = typeof input.name === "string" ? input.name.trim() : "";
      const sceneId =
        typeof input.sceneId === "string" ? input.sceneId.trim() : "";
      try {
        switch (action) {
          case "add": {
            if (!name) return fail("add 需要 name");
            const workdir =
              typeof input.workdir === "string" && input.workdir.trim()
                ? input.workdir.trim()
                : undefined;
            const result = await workscenes.create({ name, workdir });
            return ok(
              appendWorkdirWarning(
                `已创建工作场景「${result.scene.name}」（id: ${result.scene.id}）`,
                result.workdirWarning,
              ),
            );
          }
          case "remove": {
            if (!sceneId) return fail("remove 需要 sceneId");
            // 用户的 workdir 不动 —— 那是用户的代码资产,系统不碰。
            const removed = await workscenes.remove(sceneId);
            if (!removed) return fail(`工作场景 "${sceneId}" 不存在`);
            return ok(`已删除工作场景 ${sceneId}（系统数据已物理清除）`);
          }
          case "rename": {
            if (!sceneId || !name)
              return fail("rename 需要 sceneId 与 name");
            const s = await workscenes.rename(sceneId, name);
            if (!s) return fail(`工作场景 "${sceneId}" 不存在`);
            return ok(`已重命名为「${s.name}」`);
          }
          case "set_workdir": {
            if (!sceneId) return fail("set_workdir 需要 sceneId");
            const workdir =
              typeof input.workdir === "string" ? input.workdir.trim() : "";
            if (!workdir) return fail("set_workdir 需要 workdir");
            const result = await workscenes.setWorkdir(sceneId, workdir);
            if (!result) return fail(`工作场景 "${sceneId}" 不存在`);
            return ok(
              appendWorkdirWarning(
                `已将工作场景「${result.scene.name}」的工作目录设为：${result.scene.workdir}`,
                result.workdirWarning,
              ),
            );
          }
          case "clear_workdir": {
            if (!sceneId) return fail("clear_workdir 需要 sceneId");
            const result = await workscenes.setWorkdir(sceneId, null);
            if (!result) return fail(`工作场景 "${sceneId}" 不存在`);
            return ok(`已解除工作场景「${result.scene.name}」的工作目录绑定`);
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
  workscenes: Pick<WorksceneToolDirectory, "list">,
): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: {},
  };
  return {
    name: "workscene_list",
    description:
      "只读列出工作场景管理元数据（id、名称、工作目录、最近使用时间），用于选择目标场景或查看目录绑定。",
    inputSchema,
    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: false,
    boundaries: getWorksceneToolBoundaries("workscene_list"),
    async call() {
      const scenes = await workscenes.list();
      if (scenes.length === 0) return ok("当前没有任何工作场景");
      return ok(scenes.map(formatSceneLine).join("\n\n"));
    },
  };
}

/**
 * workscene_memory_query（main-only，只读）—— 检索任一/全部工作场景记忆域。
 *
 * v1：按 query 子串搜（无 query 则列目录索引），返回 id + 标题 + 截断片段；
 * 各场景独立 readonly MemoryStore，不写。
 */
export function createWorksceneMemoryQueryTool(
  workscenes: Pick<WorksceneToolDirectory, "list" | "get">,
): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: {
      sceneId: {
        type: "string",
        description: "限定某个工作场景 id；省略则检索全部工作场景",
      },
      query: {
        type: "string",
        description: "关键词子串；省略则返回各场景记忆条目索引",
      },
    },
  };
  return {
    name: "workscene_memory_query",
    description:
      "只读检索工作场景的记忆域（人物/画像）。用于进入场景前先探查已有积累，" +
      "据此决定直接进入、还是先向用户澄清。",
    inputSchema,
    isReadOnly: true,
    isParallelSafe: true,
    needsPermission: false,
    // 只读检索各场景记忆域目录 → filesystem.read → observe → 自动放行。
    boundaries: [{ boundaryType: "filesystem", access: "read", dynamic: false }],
    async call(input) {
      const sceneId =
        typeof input.sceneId === "string" ? input.sceneId.trim() : "";
      const query =
        typeof input.query === "string" ? input.query.trim() : "";

      const scenes = sceneId
        ? await (async () => {
            const s = await workscenes.get(sceneId);
            return s ? [s] : [];
          })()
        : await workscenes.list();

      if (scenes.length === 0) {
        return ok(
          sceneId
            ? `工作场景 "${sceneId}" 不存在`
            : "当前没有任何工作场景",
        );
      }

      const blocks: string[] = [];
      for (const scene of scenes) {
        const store = new MemoryStore(getWorkSceneMemoryDir(scene.id));
        const header = `# 工作场景「${scene.name}」(id: ${scene.id})`;
        if (query) {
          const hits = await store.search(query);
          if (hits.length === 0) {
            blocks.push(`${header}\n（无匹配「${query}」的记忆）`);
            continue;
          }
          const lines = hits.map((e) => {
            const title = String(e.meta.title ?? e.meta.name ?? e.id);
            const snippet = e.content.slice(0, MEMORY_SNIPPET_CAP);
            return `- [${e.id}] ${title}\n  ${snippet}`;
          });
          blocks.push(`${header}\n${lines.join("\n")}`);
        } else {
          const cats: MemoryCategory[] = ["person", "profile"];
          const idx: string[] = [];
          for (const cat of cats) {
            const entries = await store.list(cat);
            if (entries.length > 0) {
              idx.push(
                `${cat}: ${entries.map((e) => e.id).join(", ")}`,
              );
            }
          }
          blocks.push(
            `${header}\n${idx.length > 0 ? idx.join("\n") : "（记忆域为空）"}`,
          );
        }
      }
      return ok(blocks.join("\n\n"));
    },
  };
}
