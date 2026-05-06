/**
 * 内部诊断日志 hook。
 *
 * core 内部会在某些关键点（LLM 请求摘要 / 工具调用列表 / ...）写诊断文本，
 * 默认 sink 走 `console.log`；调用方可通过 setDiagnosticLogger 注入自定义 sink：
 *   - cli 交互模式（REPL / print）注入 noop，让用户视觉清洁
 *   - server 模式保持默认 console.log，便于运维 / 调试观察
 *   - 测试场景可注入 capture sink 做断言
 *
 * 与 EventBus 的边界：EventBus 是结构化事件流（业务消费），diagnostic 是
 * 人类可读的文本 log，两者职责正交。需要更精细的可视化应订阅 EventBus，
 * 而不是去解析 diagnostic 文本。
 */

export type DiagnosticLogFn = (message: string) => void;

let activeLogger: DiagnosticLogFn = (message) => {
  console.log(message);
};

/**
 * 注入诊断日志 sink。模块级一次性生效；需要恢复请先 save 旧值再回设。
 */
export function setDiagnosticLogger(fn: DiagnosticLogFn): void {
  activeLogger = fn;
}

/** core 内部诊断输出入口——调用方不直接 console.log。 */
export function logDiagnostic(message: string): void {
  activeLogger(message);
}
