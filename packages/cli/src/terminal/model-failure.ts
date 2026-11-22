import {
  formatProviderErrorForUser,
  parseModelBudgetStop,
  parseResourceBudgetDimension,
  type ModelBudgetStopReason,
} from '@zhixing-ai/core/resilience';

const CUMULATIVE_TOKENS_EXHAUSTED =
  '本次运行在连续处理中剩余的模型可用额度已不足以预留下一步请求（本次请求未发出）：发送新消息会按新一次运行额度继续；若对话历史较长，可先用 /compact 整理上下文。';

const NEUTRAL_TOKENS_BUDGET_REJECTED =
  '本次请求未发出：请求的输入与输出保守预留超出当前运行可用额度。若在多步连续执行中出现，发送新消息可按新一次运行额度继续；若在新对话首轮出现，可在 /model 或 /config 中调低输出上限偏好或精简输入；对话较长时可用 /compact 整理上下文。';

function formatBudgetStopReason(reason: ModelBudgetStopReason): string {
  switch (reason) {
    case 'zero-token-grant':
      return '本次请求未发出：当前运行未获模型可用额度（许可上限为 0）。';
    case 'input-exceeds-grant':
      return '本次请求未发出：当前输入与上下文的保守预留上界已超出单次运行许可，无法留出输出空间。请精简本条输入或附件材料；若对话已有较长历史，可先执行 /compact 或 /new。';
    case 'thinking-exceeds-grant':
      return '本次请求未发出：当前输入预留加上已配置的思考预算超出本次运行可用许可，无法在不违背思考预算的前提下裁剪输出上限。可在 /model 或 /config 中调低或关闭思考预算，或精简输入后再试。';
    case 'single-call-exceeds-grant':
      return '本次请求未发出：单次调用的输入与输出保守预留超出当前运行许可上限。可在 /model 或 /config 中调低输出上限偏好，或精简输入后再试。';
    case 'cumulative-tokens':
      return CUMULATIVE_TOKENS_EXHAUSTED;
    case 'calls-limit':
      return '本次运行的模型调用次数已达许可上限（本次请求未发出）：发送新消息会按新一次运行继续。';
    case 'cost-limit':
      return '本次请求未发出：模型调用费用预留超出当前运行许可上限。';
  }
}

function formatBareBudgetRejection(message: string): string {
  const dimension = parseResourceBudgetDimension(message);
  if (dimension === 'calls') {
    return '本次请求未发出：模型调用次数超出当前运行许可上限。';
  }
  if (dimension === 'cost') {
    return '本次请求未发出：模型调用费用预留超出当前运行许可上限。';
  }
  return NEUTRAL_TOKENS_BUDGET_REJECTED;
}

/** 模型服务失败给用户的说明：统一消费 core/resilience 的四协议脱敏分类与中文指引，不在终端另建厂商分支。
 *  原文另在运行日志里（模型调用重试裁决与耗尽事件）。 */
export function modelFailureText(message: string): string {
  // 重试时被额度挡下：先说真实首因，再说为什么不再重试
  const budget = parseModelBudgetStop(message);
  if (budget) {
    if (budget.afterFailure !== undefined) {
      return `${modelFailureText(budget.afterFailure)}（重试时本次运行的模型用量已达上限，已停止重试。）`;
    }
    if (budget.reason !== undefined) {
      return formatBudgetStopReason(budget.reason);
    }
    return formatBareBudgetRejection(message);
  }
  return formatProviderErrorForUser(message);
}
