import {
  formatProviderErrorForUser,
  parseModelBudgetStop,
} from '@zhixing-ai/core/resilience';

const BUDGET_EXHAUSTED = '本次运行的模型用量已达上限，已停止：发送新消息会按新的额度继续；对话很长时可先用 /compact 整理上下文。';

/** 模型服务失败给用户的说明：统一消费 core/resilience 的四协议脱敏分类与中文指引，不在终端另建厂商分支。
 *  原文另在运行日志里（模型调用重试裁决与耗尽事件）。 */
export function modelFailureText(message: string): string {
  // 重试时被额度挡下：先说真实首因，再说为什么不再重试
  const budget = parseModelBudgetStop(message);
  if (budget) {
    return budget.afterFailure === undefined
      ? BUDGET_EXHAUSTED
      : `${modelFailureText(budget.afterFailure)}（重试时本次运行的模型用量已达上限，已停止重试。）`;
  }
  return formatProviderErrorForUser(message);
}
