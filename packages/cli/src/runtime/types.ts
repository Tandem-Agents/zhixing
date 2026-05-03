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
import type { Renderer } from "../render.js";

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
  renderer: Renderer;
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
