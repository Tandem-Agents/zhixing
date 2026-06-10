/**
 * RuntimeSession 公共契约。
 *
 * 资源所有权约定：
 * - 注入式（caller 持有，session 借用，不在 dispose 中关闭）：renderer / 配置数据
 * - 注入但 dispose 责任移交 session：schedulerFacade —— caller 创建并注入，但其底层
 *   RPC 连接 / 事件订阅的生命周期随 session，由 session.dispose 调 facade.dispose 关闭
 * - 持有式（session 拥有，通过 dispose 释放）：agentRuntime
 *
 * 调度权威在核心宿主，cli 经注入的 schedulerFacade 接入——session 不再持有本地
 * Scheduler / channels / deliveryStack（cli 是纯交互接入面）。
 */

import type { CreateAgentRuntimeOptions } from "@zhixing/orchestrator/runtime";
import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";
import type { SchedulerFacade } from "@zhixing/core";
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

  /** CLI 指定的工作区目录（仅启动时一次，reload 不读取——reload 永远从配置文件读）。 */
  cliWorkspace?: string;

  /** 顶层资源——session 借用，不在 dispose 中关闭 */
  renderer: OutputRenderer;
  /**
   * 写屏统一接口——所有 EventBus 事件渲染（retry / compact / interrupt 等）经此协调。
   * REPL 模式注入 ScreenWriter（chrome 协调），serve 等非交互模式注入 StdoutWriter（直写）。
   */
  writer: CliWriter;
  /**
   * 屏幕协调器——cli REPL 模式下注入，启用 status-bar 动态状态展示；
   * 非 REPL 模式可省略，status-bar 不启用，事件渲染仍经 writer 正常工作。
   */
  screen?: ScreenController;
  zhixingHome: string;
  /**
   * 调度门面 —— cli 经它接入核心宿主（RpcSchedulerFacade）。session 把它注入 schedule
   * 工具、turn-context provider；自身不持有本地 Scheduler（调度权威在核心宿主）。
   */
  schedulerFacade: SchedulerFacade;

  /** 安全管线 UI 回调——透传给 createAgentRuntime */
  onSecurityBlocked: OnSecurityBlockedFn;
  /**
   * 用户拒绝回调 —— optional。
   *
   * cli 已不再用此回调渲染独立 banner（拒绝反馈由 ◆ 工具失败破窗 + tool-card-format
   * 的 `formatUserDeniedResult` 翻译承担，避免视觉重复）。保留 optional 字段
   * 兼容未来其他渲染器需求（譬如 ServePush 推送、文件日志等）。
   */
  onUserDenied?: OnUserDeniedFn;

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
   * 负责把 cli 已有资源（TaskListService + ConversationRepository）适配为
   * orchestrator 装配 SegmentManager 所需的两个抽象接口。
   *
   * cli 装配层在创建 session 之前通过 createCliSegmentDeps 工厂构造，避免每个
   * createAgent 路径各自重做适配（reload swap 路径同样复用一份 deps）。
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
