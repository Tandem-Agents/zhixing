/**
 * 工作模式控制器接口 —— workmode agent 工具与 RuntimeSession 之间的窄接口。
 *
 * 为什么是接口而非直接捕获 RuntimeSession 实例：
 *   - 解循环引用：工具经 assembly 装配，assembly 早于 RuntimeSession 构造；
 *     工具捕获本接口（由 ExtraToolsRuntimeContext 的 getter 延迟取），不反向
 *     依赖 cli/runtime/session 具体类。
 *   - 可独立测试：工具单测只需 mock 本接口（断言 emit / registry 调用），
 *     无需起整个 RuntimeSession。
 *
 * 暴露面刻意最小（spec 焊死）：注册表 CRUD + emit 切换意图。切换意图只 emit
 * 不执行——run() 侧 accumulator 收集、REPL 主回路 turn 边界唯一 applyModeSwitch
 * 消费（命令入口与本工具入口最终汇聚同一原语，仅触发面不同）。
 */

import type {
  IWorkSceneRegistry,
  WorkModeSwitchIntent,
} from "@zhixing/core";

export interface IWorkModeController {
  /** 工作场景注册表 —— workscene_change_approve 用户拍板后的 CRUD 落点。 */
  readonly registry: IWorkSceneRegistry;

  /**
   * emit 一条模式切换意图到当前 run 的 EventBus —— 用户已拍板（needsPermission
   * 工具）或 LLM 自判（workmode_exit）后调用。**只产生意图、不执行切换**：
   * run() 侧 subscribeWorkModeAccumulator 收集、随 RunResult.pendingModeSwitch
   * 带出，REPL 主回路在 turn 边界唯一消费。非 run 上下文（无 bus）下为 no-op。
   */
  emitModeSwitch(intent: WorkModeSwitchIntent): void;
}
