/**
 * RuntimeSession 公共契约。
 *
 * 资源所有权约定：
 * - 注入式（caller 持有，session 借用，不在 dispose 中关闭）：renderer / schedulerEventBus / 配置数据
 * - 持有式（session 拥有，通过 dispose 释放）：agentRuntime / scheduler / channels / deliveryStack
 *
 * 外部访问持有式资源走 getter——每次读最新实例，跨 reload swap 自动响应。
 */

import type { CreateAgentRuntimeOptions } from "@zhixing/orchestrator/runtime";
import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";
import type { IEventBus, SchedulerEventMap } from "@zhixing/core";
import type { OutputRenderer } from "../output/index.js";
import type { CliWriter, ScreenController } from "../screen/index.js";
import type { BuiltinExtraToolsAssembly } from "./builtin-extra-tools.js";
import type { CliSegmentDeps } from "./segment-deps.js";

/** 从 createAgentRuntime 公共契约推导 callback 类型——避免依赖 orchestrator 内部路径 */
type OnSecurityBlockedFn = NonNullable<CreateAgentRuntimeOptions["onSecurityBlocked"]>;
type OnUserDeniedFn = NonNullable<CreateAgentRuntimeOptions["onUserDenied"]>;

export interface RuntimeSessionOptions {
  /** 启动期已 load 的配置——session 持有用于后续 reload 时与新文件 diff */
  config: ZhixingConfig;
  credentials: ZhixingCredentials;

  /** CLI override（仅启动时一次，reload 不读取这些字段——reload 永远从配置文件读） */
  cliWorkspace?: string;
  cliModel?: string;
  cliProvider?: string;

  /** 顶层资源——session 借用，不在 dispose 中关闭 */
  renderer: OutputRenderer;
  /**
   * 写屏统一接口——所有 EventBus 事件渲染（retry / compact / interrupt 等）经此协调。
   * REPL 模式注入 ScreenWriter（chrome 协调），runOnce 注入 StdoutWriter（直写）。
   */
  writer: CliWriter;
  /**
   * 屏幕协调器——cli REPL 模式下注入，启用 status-bar 动态状态展示；
   * 非 REPL 模式（runOnce）可省略，status-bar 不启用，事件渲染仍经 writer 正常工作。
   */
  screen?: ScreenController;
  zhixingHome: string;
  /**
   * Scheduler 事件总线——稳定的"事件集线器"，跨 reload 持久。
   * REPL 在外部订阅 task-completed 等事件；session 内部 reload 时即使重建 scheduler，
   * 新 scheduler 仍发送到同一 eventBus，外部 listener 不丢。
   */
  schedulerEventBus: IEventBus<SchedulerEventMap>;

  /** 安全管线 UI 回调——透传给 createAgentRuntime */
  onSecurityBlocked: OnSecurityBlockedFn;
  onUserDenied: OnUserDeniedFn;

  /**
   * builtin extra tools 装配实例 —— cli 顶层创建（注入 task_list 持久化 store），
   * session 在每次 createAgent 时调 `assembly.assembleTools()` 拿新 ToolDefinition
   * 数组并入 createAgentRuntime.extraTools。
   *
   * 设计要点：
   *   - assembly 跨 reload 持久（store + service 单例不重建），保 task_list cache
   *     与持久化连续性
   *   - 工具实例每次 createAgent 新建 —— 工具是 ToolDefinition 对象包装，实例不同
   *     但闭包共享同一 service，行为一致
   *   - REPL 与 serve 模式都用同一个 assembly 抽象，装配逻辑统一
   */
  builtinExtraTools: BuiltinExtraToolsAssembly;
  /**
   * 段切换外部依赖 —— taskListReader + persistence。
   *
   * 与 builtinExtraTools 平行：assembly 负责工具装配 / 视图层 service；segmentDeps
   * 负责把 cli 已有资源（TaskListService + TranscriptStore + ConversationRepository）
   * 适配为 orchestrator 装配 SegmentManager 所需的两个抽象接口。
   *
   * cli 装配层在创建 session 之前通过 createCliSegmentDeps 工厂构造，避免每个
   * createAgent 路径各自重做适配（reload swap / runOnce 路径同样复用一份 deps）。
   *
   * 设计上 segmentDeps 是 required —— cli 始终启用段切换；非 cli 集成路径（纯
   * orchestrator 集成测试）可省略 createCliSegmentDeps，直接调 createAgentRuntime
   * 时不传 segmentDeps（orchestrator 会优雅降级为 budget-only 兜底）。
   */
  segmentDeps: CliSegmentDeps;
}

/**
 * reload 结果——discriminated union 让 caller 必须穷举处理三种情况。
 *
 * - `no-change`：配置未变化，session 状态完全不动
 * - `applied`：reload 成功，新资源已活跃；`changedDomains` 标识哪些域被重建
 * - `failed`:  reload 中途失败，session 保持旧状态；磁盘已写新值，下次启动自然 pickup
 */
export type ReloadResult =
  | { kind: "no-change" }
  | { kind: "applied"; changedDomains: ReadonlyArray<"channels" | "agent"> }
  | { kind: "failed"; error: Error };
