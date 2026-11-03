/**
 * 模型调用被资源额度挡下时的错误识别。
 *
 * 额度拒绝来自资源治理（core protocol resource-governor 的 assertDimension：
 * “<标签> tokens|calls|cost exceeds budget”），跨进程只保留消息文本，所以按文本识别。
 * 重试尝试被额度挡下时，额度只是停止重试的原因，真实首因是上一次失败：组合错误把上一次失败的原文带上。
 */

const BUDGET_EXCEEDED = /^Resource [A-Za-z ]+ (?:tokens|calls|cost) exceeds budget$/u;
const AFTER_FAILURE = "Model usage budget exhausted while retrying after: ";

export function isResourceBudgetExceeded(error: unknown): boolean {
  return error instanceof Error && BUDGET_EXCEEDED.test(error.message);
}

/** 重试尝试被额度挡下时交给上层的错误：消息以上一次失败为首因，额度拒绝放在 cause。 */
export function budgetStopAfterFailure(prior: unknown, budget: Error): Error {
  const message = prior instanceof Error ? prior.message : String(prior);
  return new Error(AFTER_FAILURE + message, { cause: budget });
}

/** 识别额度停止：组合错误给出上一次失败的原文；单独的额度拒绝没有 afterFailure；其他错误返回 undefined。 */
export function parseModelBudgetStop(message: string): { readonly afterFailure?: string } | undefined {
  if (message.startsWith(AFTER_FAILURE)) return { afterFailure: message.slice(AFTER_FAILURE.length) };
  return BUDGET_EXCEEDED.test(message) ? {} : undefined;
}
