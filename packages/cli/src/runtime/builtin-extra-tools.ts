/**
 * builtin extra tools 装配 —— cli REPL + serve 共享的"外部依赖型工具"装配点。
 *
 * 背景：
 *   "外部依赖型工具"指需要 cli 注入运行时依赖（Scheduler / ConversationRepository
 *   等）才能装配的工具。它们走 `createAgentRuntime({ extraTools })` 注入，与
 *   `BUILTIN_TOOL_FACTORIES` 中的纯 builtin 工具（read / write / bash 等）分两条
 *   装配路径。
 *
 * 为什么集中到一个 assembly：
 *   - REPL（`cli/runtime/session.ts`）和 serve（`cli/serve/command.ts`）原本各
 *     自装配 scheduleTool，导致 task_list 接入时 serve 漏装配（PR-C1 审查 Gap-1）
 *   - 集中后两入口共用一处装配代码，新工具加入只改 assembly 一处，杜绝"两入口不
 *     对齐"类 bug
 *   - 同时把 service 单例（如 `TaskListService`）的所有权也集中到 assembly，让
 *     "service 跨 runtime 复用 + 工具实例随 runtime 重建"的契约由 assembly 强制
 *
 * 生命周期约束：
 *   - assembly 自身是 process-wide 单例（cli 进程级），跨 runtime swap 持续
 *   - `assembleTools()` 每次 runtime 创建时调一次，返回**新的 ToolDefinition 数组**
 *     （工具实例闭包引用 assembly 内 service —— 不同 runtime 看到的工具对象 ≠，但
 *     行为一致）
 *   - cli 在切换 conversation / 清空对话时调 `taskListService.prime() / clear()`
 *     维护 cache —— 这是 conversation 边界事件，不在 runtime 边界
 */

import type { Scheduler, ToolDefinition } from "@zhixing/core";
import { runContextStorage } from "@zhixing/orchestrator/runtime";
import {
  createScheduleTool,
  TaskListService,
  type ScheduleToolOrigin,
  type TaskListStore,
} from "@zhixing/tools-builtin";

// ─── Assembly 接口 ───

/**
 * 装配 extra tools 实例时需要的 per-runtime 上下文。
 *
 * scheduler 用 getter —— REPL 模式 scheduler 在 session 内部 lazy 创建，必须
 * 用 closure getter 避开 chicken-and-egg；serve 模式同样用 lazy getter 解循环
 * 依赖（ScheduleTool ↔ Scheduler ↔ runAgentTurn ↔ ConversationManager）。
 */
export interface ExtraToolsRuntimeContext {
  scheduler: () => Scheduler;
  /** 定时任务源 origin（可选） —— serve 模式按 sessionId 解析投递目标，REPL 模式不传 */
  scheduleOrigin?: () => ScheduleToolOrigin | null;
}

export interface BuiltinExtraToolsAssembly {
  /**
   * task_list 服务单例 —— cli 主线程在 conversation 切换 / `/clear` 时直接调用
   * `prime(convId)` / `clear(convId)` 维护 cache。SegmentManager（PR-D1）通过此
   * 引用调 `getInProgressTasks(convId)` 同步读。
   */
  readonly taskListService: TaskListService;

  /**
   * 装配某次 runtime 创建用的 extra tools 实例。
   *
   * 每次 runtime 创建（首次 bootstrap / reload swap / serve 新 session）调一次，
   * 返回新的 ToolDefinition 数组。工具内部都闭包引用 assembly 持有的 service /
   * scheduler getter —— state 共享但实例独立。
   */
  assembleTools(ctx: ExtraToolsRuntimeContext): ToolDefinition[];
}

// ─── 工厂 ───

/**
 * 创建 builtin extra tools assembly —— REPL / serve 顶层各调一次。
 *
 * `taskListStore` 决定 task_list 持久化层：
 *   - REPL 模式：传 `ConversationRepoTaskListStore`（落盘到 conversation meta）
 *   - serve 模式：当前传 `InMemoryTaskListStore`（过渡，进程重启丢失），待 serve
 *     接入 conversation meta 后切换
 */
export function createBuiltinExtraToolsAssembly(
  taskListStore: TaskListStore,
): BuiltinExtraToolsAssembly {
  const taskListService = new TaskListService(taskListStore);

  return {
    taskListService,

    assembleTools(ctx: ExtraToolsRuntimeContext): ToolDefinition[] {
      const scheduleTool = createScheduleTool(
        ctx.scheduler,
        ctx.scheduleOrigin,
      );

      // task_list 工具通过 ALS 拿 conversationId —— `runContextStorage` 由
      // `runtime.run({ conversationId })` 入口在 per-run 范围内注入。ephemeral
      // 路径（定时任务 / --print）未注入时返回 undefined，工具 call 内部检测到
      // 直接 isError 拒绝（不污染任何 conversation 的 cache）。
      const taskListTool = taskListService.createTool(
        () => runContextStorage.getStore()?.conversationId,
      );

      return [scheduleTool, taskListTool];
    },
  };
}
