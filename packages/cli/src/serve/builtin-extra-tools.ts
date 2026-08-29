/**
 * builtin extra tools 装配 —— Anchor 产品组合边界共享的外部依赖型工具装配点。
 *
 * 背景：
 *   "外部依赖型工具"指需要宿主注入运行时依赖（Scheduler / ConversationRepository
 *   等）才能装配的工具。它们走 `createAgentRuntime({ extraTools })` 注入，与
 *   `BUILTIN_TOOL_FACTORIES` 中的纯 builtin 工具（read / write / bash 等）分两条
 *   装配路径。
 *
 * 为什么集中到一个 assembly：
 *   - 不同产品入口原本各自装配 scheduleTool，新增工具时容易遗漏其中一条路径
 *   - 集中后两入口共用一处装配代码，新工具加入只改 assembly 一处，杜绝"两入口不
 *     对齐"类 bug
 *   - 同时把 service 单例（如 `TaskListService`）的所有权也集中到 assembly，让
 *     "service 跨 runtime 复用 + 工具实例随 runtime 重建"的契约由 assembly 强制
 *
 * 生命周期约束：
 *   - assembly 自身是 process-wide 单例（宿主进程级），跨 runtime 实例持续
 *   - `assembleTools()` 每次 runtime 创建时调一次，返回**新的 ToolDefinition 数组**
 *     （工具实例闭包引用 assembly 内 service —— 不同 runtime 看到的工具对象 ≠，但
 *     行为一致）
 *   - 产品组合层在切换 conversation / 清空对话时调 `taskListService.prime() / clear()`
 *     维护 cache —— 这是 conversation 边界事件，不在 runtime 边界
 */

import type { SchedulerFacade, ToolDefinition } from "@zhixing/core";
import { mapServerTools, type McpHub } from "@zhixing/mcp";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import {
  createScheduleTool,
  TaskListService,
  type TaskListStore,
} from "@zhixing/tools-builtin";

export const BUILTIN_EXTRA_TOOL_CAPABILITIES = [
  {
    key: "schedule:manage",
    toolName: "schedule",
    authorityWrite: true,
    runtimeKinds: ["main", "workscene"],
  },
  {
    key: "schedule:run",
    toolName: "schedule",
    authorityWrite: true,
    runtimeKinds: ["main", "workscene"],
  },
  {
    key: "task-list",
    toolName: "task_list",
    authorityWrite: true,
    runtimeKinds: ["main", "workscene"],
  },
  {
    key: "workscene:enter",
    toolName: "workmode_enter",
    authorityWrite: true,
    runtimeKinds: ["main"],
  },
  {
    key: "workscene:exit",
    toolName: "workmode_exit",
    authorityWrite: true,
    runtimeKinds: ["workscene"],
  },
  {
    key: "workscene:change-approve",
    toolName: "workscene_change_approve",
    authorityWrite: true,
    runtimeKinds: ["main"],
  },
  {
    key: "workscene:rename-current",
    toolName: "workscene_rename_current",
    authorityWrite: true,
    runtimeKinds: ["workscene"],
  },
  {
    key: "workscene:set-workdir-current",
    toolName: "workscene_set_workdir_current",
    authorityWrite: true,
    runtimeKinds: ["workscene"],
  },
  {
    key: "workscene:clear-workdir-current",
    toolName: "workscene_clear_workdir_current",
    authorityWrite: true,
    runtimeKinds: ["workscene"],
  },
] as const;

// ─── Assembly 接口 ───

/**
 * 装配 extra tools 实例时需要的 per-runtime 上下文。
 *
 * scheduler 用 SchedulerFacade getter —— 交互端可注入 RpcSchedulerFacade（懒接入核心宿主），
 * ephemeral 运行可注入宿主本地 facade。getter 形态让工具不感知
 * "本地实例 vs 远程接入"，也解除 scheduler 延迟装配的顺序依赖。
 */
export interface ExtraToolsRuntimeContext {
  scheduler: () => SchedulerFacade;
}

export interface BuiltinExtraToolsAssembly {
  /**
   * task_list 服务单例 —— 产品组合层在 conversation 切换 / `/clear` 时直接调用
   * `prime(convId)` / `clear(convId)` 维护 cache。SegmentManager（PR-D1）通过此
   * 引用调 `getInProgressTasks(convId)` 同步读。
   */
  readonly taskListService: TaskListService;

  /**
   * MCP 连接层 hub（进程级单例）—— assembleTools 从其 catalog 物化 MCP 工具；
   * 入口退出链调用 hub.dispose() 关闭所有连接 / 子进程。空配置时为 no-op 实例。
   */
  readonly mcpHub: McpHub;

  /**
   * 装配某次 runtime 创建用的 extra tools 实例。
   *
   * 每次 runtime 创建（会话 / 场景 / ephemeral 实例发放）调一次，
   * 返回新的 ToolDefinition 数组。工具内部都闭包引用 assembly 持有的 service /
   * scheduler getter —— state 共享但实例独立。
   */
  assembleTools(ctx: ExtraToolsRuntimeContext): ToolDefinition[];
}

// ─── 工厂 ───

/**
 * 创建 builtin extra tools assembly —— 宿主资产层构建时创建一次。
 *
 * `taskListStore` 决定 task_list 持久化层：
 *   - 单 scope：传 `ConversationRepoTaskListStore`（落盘到 conversation meta）
 *   - 核心宿主：传 `RoutedConversationRepoTaskListStore`（按全域 conversationId
 *     路由到 user / workscene 等 scope repo）
 */
export function createBuiltinExtraToolsAssembly(
  taskListStore: TaskListStore,
  mcpHub: McpHub,
): BuiltinExtraToolsAssembly {
  const taskListService = new TaskListService(taskListStore);

  return {
    taskListService,
    mcpHub,

    assembleTools(ctx: ExtraToolsRuntimeContext): ToolDefinition[] {
      const scheduleTool = createScheduleTool(ctx.scheduler);

      // task_list 工具通过 ALS 拿 conversationId —— `runContextStorage` 由
      // `runtime.run({ identity: { conversationId } })` 入口在 per-run 范围内注入。ephemeral
      // 路径（定时任务等 ephemeral）未注入时返回 undefined，工具 call 内部检测到
      // 直接 isError 拒绝（不污染任何 conversation 的 cache）。
      const taskListTool = taskListService.createTool(
        () => runContextStorage.getStore()?.conversationId,
        () => runContextStorage.getStore()?.assignmentMutations,
      );

      const tools: ToolDefinition[] = [scheduleTool, taskListTool];

      // MCP 工具：外部服务能力，与本地文件 / workscene 隔离正交（不属本地文件操作
      // 面），故 main 与所有 workscene 一律注入。空配置时 catalog() 返回 []，自然
      // 不注入；catalog 在 connectAll 后已就绪，此处同步物化。
      for (const { server, tools: descriptors } of mcpHub.catalog()) {
        tools.push(...mapServerTools(server, descriptors, mcpHub.callTool));
      }

      return tools;
    },
  };
}
