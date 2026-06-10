/**
 * cli 装配层的 builtin TurnContextProvider 注册 helper —— REPL + serve 共享。
 *
 * 背景：
 *   `TurnContextProvider` 是 LLM 视角的"per-turn 上下文注入器"集合。Time / Scheduler
 *   / TaskList 三类 provider 中：
 *     - TimeProvider 由 `createAgentRuntime` 内部默认装配（不依赖 cli 资源）
 *     - SchedulerProvider 和 TaskListProvider 依赖 cli 注入的 Scheduler / TaskListService
 *
 *   后两者需要在每一个 user-facing runtime 装配点全部注册：REPL 侧（bootstrap /
 *   reload 重建 main / 进入工作模式建 power / reload 在工作模式连带重建 power）
 *   由 RuntimeSession 内单一 attachTurnContextProviders 封装统一调用本 helper；
 *   serve 侧（per-session / ephemeral）各自直接调用本 helper。本 helper 把"该
 *   注册什么"和"注册逻辑细节"集中一处，各 caller 只提供"如何取 scheduler 状态
 *   + 哪个 service"两个 deps。
 *
 * 为什么单独成文件 / 不塞进 BuiltinExtraToolsAssembly：
 *   - assembly 的语义是"task_list-aware 工具/服务集合"——把 SchedulerProvider 塞进
 *     assembly 会破坏单一职责（SchedulerProvider 与 task_list 无关）
 *   - helper 是"cli 装配层 turn-context provider 集合"——单一职责清晰
 *   - assembly 提供 taskListService 作为 helper 的 dep，是依赖关系不是嵌入关系
 *
 * 未来扩展模板：
 *   新增 cli 装配层的 TurnContextProvider（如未来 SegmentMetadataProvider 把段切换
 *   边界信息注入 LLM），只需在本 helper 内追加 register 调用 + 在 deps 接口加对应
 *   service 引用——所有 caller 装配代码不动。**杜绝"两入口不对齐"类回归**。
 */

import {
  SchedulerProvider,
  TaskListProvider,
  type TaskStatusSummary,
} from "@zhixing/core";
import {
  runContextStorage,
  type AgentRuntime,
} from "@zhixing/orchestrator/runtime";
import type { TaskListService } from "@zhixing/tools-builtin";

/**
 * Scheduler 不可用时的空状态 fallback —— serve 模式 lazy scheduler ref 未就绪时
 * 复用此常量，避免每个 caller 内联同款字面量。
 *
 * **双重不变性保障**（编译期 + 运行时）：
 *   - 编译期：`TaskStatusSummary` 接口字段已 readonly 化，caller 在 TypeScript
 *     层面就被阻止 `summary.active.push(...)` 等 mutate 操作 —— 错误立即可见
 *   - 运行时：`Object.freeze` 顶层对象 + 三个内层空数组，违规 mutate（如绕过类型
 *     系统的 `as any` cast）在严格模式下 throw，**绝不污染共享常量**
 *
 * 无类型谎言：受益于 `TaskStatusSummary` 接口的 readonly 化重构，`Object.freeze([])`
 * 返回的 `readonly never[]` 与 `readonly X[]` 字段类型自然 widening 兼容，整体表达式
 * 可直接类型化为 `TaskStatusSummary`，无需 `as unknown` 双重断言。
 */
export const EMPTY_TASK_STATUS_SUMMARY: TaskStatusSummary = Object.freeze({
  active: Object.freeze([]),
  recentlyCompleted: Object.freeze([]),
  recentlyFailed: Object.freeze([]),
});

/**
 * cli 装配层 TurnContextProvider 的依赖项。
 *
 * `getSchedulerStatus`：让 caller 用 closure 控制"如何取 scheduler 状态"——REPL
 * 模式读 scheduler.json 从属投影（readSchedulerSummarySync，cli 无本地 scheduler），
 * serve 模式直接由本进程 scheduler 算 summary。helper 不假设 scheduler 状态来源。
 *
 * `taskListService`：assembly 持有的 service 单例。helper 内部用 ALS 取
 * conversationId 后通过 service 同步读 cache。
 */
export interface BuiltinTurnContextDeps {
  getSchedulerStatus: () => TaskStatusSummary;
  taskListService: TaskListService;
}

/**
 * 注册 cli 装配层的 builtin TurnContextProvider 集合到指定 runtime。
 *
 * 当前注册：
 *   - SchedulerProvider —— 让 LLM 看到当前活跃定时任务 / 最近完成 / 最近失败
 *   - TaskListProvider  —— 让 LLM 看到当前 conversation 的 task_list 状态（修复
 *     段切换后 LLM 视角 task_list 读路径缺失的 gap）
 *
 * 设计要点：
 *   - 顺序：先 scheduler 后 task_list —— 与 TurnContextInjector 内 registration
 *     order 同步，让 turn-context 输出顺序稳定（便于人眼对照 / 测试断言）
 *   - 闭包：TaskListProvider 内 getItems 通过 ALS 取 conversationId，缺失时返空
 *     数组 → provider.shouldInject false → 整段跳过（不污染 turn-context）。
 *     ephemeral 路径（定时任务等）天然走这条降级
 *   - 不返回 provider 数组让 caller 自己 register——直接 register 到 runtime 让
 *     helper 是终态（不能被 caller 漏掉某个 provider 的注册）
 */
export function registerCliTurnContextProviders(
  runtime: AgentRuntime,
  deps: BuiltinTurnContextDeps,
): void {
  runtime.registerTurnContextProvider(
    new SchedulerProvider(deps.getSchedulerStatus),
  );
  runtime.registerTurnContextProvider(
    new TaskListProvider(() => {
      const conversationId = runContextStorage.getStore()?.conversationId;
      if (!conversationId) return [];
      return deps.taskListService.getAllTasks(conversationId);
    }),
  );
}
