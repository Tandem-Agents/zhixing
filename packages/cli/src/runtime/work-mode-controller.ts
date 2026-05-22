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
 * 暴露面刻意最小（spec 焊死）：注册表 CRUD（无 guard 操作）+ emit 切换意图 +
 * 带 guard 的删除入口。带 guard 的操作必须通过本接口的语义方法（非 registry 直调），
 * 让 CLI 命令入口与 LLM 工具入口最终汇聚同一原语，仅触发面不同。
 */

import type {
  IWorkSceneRegistry,
  WorkModeSwitchIntent,
} from "@zhixing/core";

export interface IWorkModeController {
  /**
   * 工作场景注册表 —— 无 guard 操作的 CRUD 落点（list / get / add / rename /
   * touch）。**写性操作中需要业务规则守卫的（如 remove 不能
   * 删活跃场景），不要直接调 registry，走本接口的语义方法**（如 `removeWorkScene`）。
   */
  readonly registry: IWorkSceneRegistry;

  /**
   * emit 一条模式切换意图到当前 run 的 EventBus —— 用户已拍板（needsPermission
   * 工具）或 LLM 自判（workmode_exit）后调用。**只产生意图、不执行切换**：
   * run() 侧 subscribeWorkModeAccumulator 收集、随 RunResult.pendingModeSwitch
   * 带出，REPL 主回路在 turn 边界唯一消费。非 run 上下文（无 bus）下为 no-op。
   */
  emitModeSwitch(intent: WorkModeSwitchIntent): void;

  /**
   * 彻底删除工作场景（带 active 守卫）—— CLI `/work remove <id>` 与
   * LLM 工具 `workscene_change_approve action=remove` 共用入口。
   *
   * **Guard**：不能删除当前活跃的工作场景。power runtime 正在使用该场景的
   * `me/` 与 `conversations/` 目录，物理 rm 后续 memory 写入 / task_list
   * 持久化 / exit digest 全撞 ENOENT。要删活跃场景必须先 `/exit` 退出。
   *
   * 业务规则归属 session 层（机制与策略分离）：registry 是低层 CRUD 原语，
   * 不该知道 activeMode；让"唯一持有 activeMode 的 RuntimeSession"做 guard，
   * 两入口同源经此 chokepoint，guard 不可绕过。
   */
  removeWorkScene(id: string): Promise<void>;
}
