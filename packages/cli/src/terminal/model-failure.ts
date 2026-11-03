import { classifyProviderError, parseModelBudgetStop } from '@zhixing/core/resilience';

const BUDGET_EXHAUSTED = '本次运行的模型用量已达上限，已停止：发送新消息会按新的额度继续；对话很长时可先用 /compact 整理上下文。';

/** 模型服务失败给用户的说明：按与重试策略同一分类器判类，已知类给原因与下一步；未知类保持原文。
 *  原文另在运行日志里（模型调用重试裁决与耗尽事件）。 */
export function modelFailureText(message: string): string {
  // 重试时被额度挡下：先说真实首因，再说为什么不再重试
  const budget = parseModelBudgetStop(message);
  if (budget) return budget.afterFailure === undefined ? BUDGET_EXHAUSTED
    : `${modelFailureText(budget.afterFailure)}（重试时本次运行的模型用量已达上限，已停止重试。）`;
  switch (classifyProviderError(new Error(message))) {
    case 'network': return '无法连接模型服务：请检查网络、代理或服务地址后重试。';
    case 'timeout': return '模型服务响应超时：请稍后重试；持续出现时检查网络或代理。';
    case 'auth': return '模型服务拒绝了凭据：请在 /config 检查 API Key。';
    case 'rate_limit': return '模型服务限流：请稍后重试。';
    case 'provider_error': return '模型服务暂时出错：请稍后重试。';
    default: return message;
  }
}
