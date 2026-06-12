/**
 * 工作模式 agent 工具 —— 经 builtinExtraTools.assembleTools 按 spec.kind 注入。
 *
 * 设计要点：
 *   - 工具只捕获 {@link IWorkModeController} 窄接口（不反依赖 RuntimeSession
 *     具体类），故可脱离 session 用 mock 接口单测。
 *   - 切换类工具（enter/exit）**只 emit 意图、不执行切换**：run() 侧 accumulator
 *     收集、随 RunResult 带出，REPL 主回路 turn 边界唯一 applyModeSwitch 消费。
 *     工具 call 体返回的文本提示 LLM「切换将在本 turn 结束后发生」，让其先把
 *     本 turn 收尾。
 *   - by-construction 隔离：注入哪组由 spec.kind 决定（见 assembleTools），
 *     power runtime 物理不持有 main-only 工具。
 *
 * 权限策略（**load-bearing 字段是 boundaries，不是 needsPermission**）：
 *   `needsPermission` 在当前实现里只是自描述文档字段（grep 全仓库无运行时消费）。
 *   真正驱动 confirm 弹窗的是 `OperationClassifier`：声明 `boundaries` 让分类器
 *   把 enter/exit/change_approve 归到 `agent-context` / `filesystem.write` 这类
 *   external 类，自然升级到 confirm；memory_query 声明 `filesystem.read` 归为
 *   observe，自动放行。声明而非依赖 BoundaryImpactClassifier 的 fail-closed
 *   critical 兜底 —— 那条路径是"忘了声明的最后保底"，不应该作为 intended 行为。
 *
 *   - LLM 调 enter / exit / change_approve → 系统弹 confirm 让用户拍板
 *   - LLM 调 memory_query → 自动放行
 *   - 用户命令 `/work` / `/exit` 走 cli 命令分发，根本不经 SecurityPipeline，
 *     天然不需要确认（用户意图即授权）
 */

import {
  MemoryStore,
  getWorkSceneMemoryDir,
  type BoundaryCrossing,
  type IWorkSceneRegistry,
  type JsonSchema,
  type MemoryCategory,
  type ToolDefinition,
} from "@zhixing/core";
import { emitWorkModeSwitchIntent } from "@zhixing/orchestrator/runtime";
import type { IWorkModeController } from "./work-mode-controller.js";

/** 单条记忆片段上限 —— 控制注入主上下文的体量（只读检索非 raw dump）。 */
const MEMORY_SNIPPET_CAP = 500;

/**
 * 切换 agent 自身运行态的边界 —— enter / exit 共用。
 *
 * `agent-context.switch` 在 BoundaryImpactClassifier 里映射为 external（见
 * `BOUNDARY_WRITE_IMPACT["agent-context"]`），让分类器把 enter / exit 升级到
 * confirm，让用户对"切换"本身拍板（而不是等切换后子操作再问）。dynamic=false：
 * 工具一旦调用就确定地表达"切换意图"，无需运行时解析参数判断是否触发。
 */
const AGENT_CONTEXT_SWITCH_BOUNDARIES: readonly BoundaryCrossing[] = [
  { boundaryType: "agent-context", access: "switch", dynamic: false },
];

function ok(content: string): Promise<{ content: string }> {
  return Promise.resolve({ content });
}

function fail(content: string): Promise<{ content: string; isError: true }> {
  return Promise.resolve({ content, isError: true });
}

/**
 * workmode_enter（main-only，needsPermission）—— 用户拍板后 emit 进入意图。
 *
 * 只依赖场景注册表(存在性校验);意图经 emitWorkModeSwitchIntent 发当前
 * run 的 bus——与 controller 解耦,宿主侧装配同样可用。
 */
export function createWorkmodeEnterTool(
  registry: IWorkSceneRegistry,
): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: {
      sceneId: {
        type: "string",
        description: "要进入的工作场景 id（用 workscene_memory_query 或场景列表确认 id）",
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
    permissionArgumentKey: "sceneId",
    boundaries: [...AGENT_CONTEXT_SWITCH_BOUNDARIES],
    async call(input) {
      const sceneId = String(input.sceneId ?? "").trim();
      if (!sceneId) return fail("workmode_enter 需要 sceneId");
      const scene = await registry.get(sceneId);
      if (!scene) return fail(`工作场景 "${sceneId}" 不存在，未切换`);
      emitWorkModeSwitchIntent({ kind: "enter", sceneId });
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
 * 零依赖:意图经 emitWorkModeSwitchIntent 发当前 run 的 bus,turn 边界由
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
    boundaries: [...AGENT_CONTEXT_SWITCH_BOUNDARIES],
    async call() {
      emitWorkModeSwitchIntent({ kind: "exit" });
      return ok("已请求退出工作场景，将在本轮结束后返回主对话。");
    },
  };
}

/**
 * workscene_change_approve（main-only，needsPermission）—— 用户拍板后改注册表。
 */
export function createWorksceneChangeApproveTool(
  controller: IWorkModeController,
): ToolDefinition {
  const inputSchema: JsonSchema = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "remove", "rename"],
        description: "对工作场景注册表的变更动作",
      },
      name: {
        type: "string",
        description: "add：新场景名；rename：新名称",
      },
      sceneId: {
        type: "string",
        description: "remove/rename 的目标场景 id",
      },
      workdir: {
        type: "string",
        description: "add 可选：该场景的工作目录（仅涉本地文件的场景需要）",
      },
    },
    required: ["action"],
  };
  return {
    name: "workscene_change_approve",
    description:
      "增删改工作场景注册表（add/remove/rename）。需用户确认。",
    inputSchema,
    isReadOnly: false,
    isParallelSafe: false,
    needsPermission: true,
    permissionArgumentKey: "action",
    // 写场景注册表落盘文件 → filesystem.write → external → confirm。
    boundaries: [{ boundaryType: "filesystem", access: "write", dynamic: false }],
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
            const s = await controller.registry.add({ name, workdir });
            return ok(`已创建工作场景「${s.name}」（id: ${s.id}）`);
          }
          case "remove": {
            if (!sceneId) return fail("remove 需要 sceneId");
            // 走 controller.removeWorkScene(带 active guard):active 场景 id
            // 命中时抛 friendly error,catch 回包到 isError 让 LLM 见错文本。
            // 虽然本工具是 main-only(power 模式 by-construction 拿不到),
            // 仍走 guard 入口做 defense-in-depth + 与 CLI 命令同源。
            // 用户的 workdir 不动 —— 那是用户的代码资产,系统不碰。
            await controller.removeWorkScene(sceneId);
            return ok(`已删除工作场景 ${sceneId}（系统数据已物理清除）`);
          }
          case "rename": {
            if (!sceneId || !name)
              return fail("rename 需要 sceneId 与 name");
            const s = await controller.registry.rename(sceneId, name);
            return ok(`已重命名为「${s.name}」`);
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
 * workscene_memory_query（main-only，只读）—— 检索任一/全部工作场景记忆域。
 *
 * v1：按 query 子串搜（无 query 则列目录索引），返回 id + 标题 + 截断片段；
 * 各场景独立 readonly MemoryStore，不写。
 */
export function createWorksceneMemoryQueryTool(
  controller: IWorkModeController,
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
            const s = await controller.registry.get(sceneId);
            return s ? [s] : [];
          })()
        : await controller.registry.list();

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
