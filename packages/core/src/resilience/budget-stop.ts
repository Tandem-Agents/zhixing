/**
 * 模型调用被资源额度挡下时的错误识别。
 *
 * 额度拒绝来自资源治理（core protocol resource-governor 的 assertDimension：
 * “<标签> tokens|calls|cost exceeds budget”），跨进程只保留消息文本，所以按文本识别。
 * 重试尝试被额度挡下时，额度只是停止重试的原因，真实首因是上一次失败：组合错误把上一次失败的原文带上。
 */

const BUDGET_EXCEEDED = /^(?:Resource|Delegated resource) [A-Za-z ]+ (tokens|calls|cost) exceeds budget$/u;
const AFTER_FAILURE = "Model usage budget exhausted while retrying after: ";
const BUDGET_STOP_PREFIX = "Model call resource budget stop: ";

export type ModelBudgetDimension = "tokens" | "calls" | "cost";

export type ModelBudgetStopReason =
  | "zero-token-grant"
  | "input-exceeds-grant"
  | "thinking-exceeds-grant"
  | "single-call-exceeds-grant"
  | "cumulative-tokens"
  | "calls-limit"
  | "cost-limit";

const VALID_BUDGET_STOP_REASONS: ReadonlySet<ModelBudgetStopReason> = new Set([
  "zero-token-grant",
  "input-exceeds-grant",
  "thinking-exceeds-grant",
  "single-call-exceeds-grant",
  "cumulative-tokens",
  "calls-limit",
  "cost-limit",
]);

export function parseResourceBudgetDimension(
  message: string,
): ModelBudgetDimension | undefined {
  const match = BUDGET_EXCEEDED.exec(message);
  return match ? (match[1] as ModelBudgetDimension) : undefined;
}

export function isResourceBudgetExceeded(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (BUDGET_EXCEEDED.test(error.message)) return true;
  if (error.message.startsWith(BUDGET_STOP_PREFIX)) {
    const reason = error.message.slice(BUDGET_STOP_PREFIX.length);
    return VALID_BUDGET_STOP_REASONS.has(reason as ModelBudgetStopReason);
  }
  return false;
}

/** 构造携带可证事实分类的单次预占停止错误（跨进程保留在 message，原始治理拒绝保留在 cause）。 */
export function formatModelBudgetStop(
  reason: ModelBudgetStopReason,
  cause?: unknown,
): TypeError {
  return new TypeError(
    BUDGET_STOP_PREFIX + reason,
    cause !== undefined ? { cause } : undefined,
  );
}

/** 重试尝试被额度挡下时交给上层的错误：消息以上一次失败为首因，额度拒绝放在 cause。 */
export function budgetStopAfterFailure(prior: unknown, budget: Error): Error {
  const message = prior instanceof Error ? prior.message : String(prior);
  return new Error(AFTER_FAILURE + message, { cause: budget });
}

/** 识别额度停止：组合错误给出上一次失败的原文；带分类原因返回 reason；原始治理拒绝返回 `{}`；其他错误返回 undefined。 */
export function parseModelBudgetStop(
  message: string,
): {
  readonly afterFailure?: string;
  readonly reason?: ModelBudgetStopReason;
} | undefined {
  if (message.startsWith(AFTER_FAILURE)) {
    return { afterFailure: message.slice(AFTER_FAILURE.length) };
  }
  if (message.startsWith(BUDGET_STOP_PREFIX)) {
    const candidate = message.slice(BUDGET_STOP_PREFIX.length);
    if (VALID_BUDGET_STOP_REASONS.has(candidate as ModelBudgetStopReason)) {
      return { reason: candidate as ModelBudgetStopReason };
    }
  }
  return BUDGET_EXCEEDED.test(message) ? {} : undefined;
}
