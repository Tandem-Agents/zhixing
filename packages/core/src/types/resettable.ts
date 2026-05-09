/**
 * 可重置组件 —— 跨对话切换 / `/clear` 等会话级重置场景需要清除自身状态的组件契约。
 *
 * 用途：
 * - cli `/clear` 在清磁盘 transcript 后调一次 runtime.resetConversationState()，
 *   让所有注册的 Resettable 自描述地清掉对话级状态
 * - 视图层 stage（如未来的 capabilityState / taskListState / taskBriefState 等）
 *   实现此接口，在 runtime 装配时注册一次，跟随 /clear 自动清空
 *
 * 边界：
 * - 仅清"对话级"状态（与当前 conversation 绑定的工作集），不清"工具级"状态
 *   （estimator calibration / anchor registry / boundary registry 等跨对话共享）
 * - 失败应抛 throw —— runtime 在串行 reset 链中收集异常聚合上抛，调用方决定
 *   是否阻塞 /clear 完成
 */
export interface Resettable {
  /**
   * 用于诊断 / 错误聚合的标识符。runtime 在 reset 失败时把 id 拼进异常消息，
   * 让排查者知道哪个组件 reset 抛错。同 runtime 内同名注册不去重，调用方自管。
   */
  readonly id: string;

  /**
   * 清空本组件的对话级状态。
   *
   * 实现可同步可异步；runtime 一律 await。
   * 抛错由 runtime 统一捕获 + 聚合到 ResetConversationStateError。
   */
  reset(): void | Promise<void>;
}
