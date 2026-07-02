import {
  renderReviewAttribution,
  userTurnInputFromText,
  type AdvancementProxyMessage,
  type AdvancementRunReview,
  type ConfirmedRubricSnapshot,
  type FailureHandlingSpec,
  type ReviewAttribution,
} from "@zhixing/core";

/**
 * 代理消息拼装的唯一真相源——正常入队与恢复重建共用同一组纯函数，
 * 同一条已持久化 review 重渲染即得 byte 等价的 content。
 */

export function selectFailureHandling(
  rubric: ConfirmedRubricSnapshot,
  selectedId: string | undefined,
): FailureHandlingSpec | undefined {
  const handlers = rubric.content.failureHandling;
  if (selectedId) {
    return handlers.find((handler) => handler.id === selectedId);
  }
  return handlers[0];
}

export function buildProxyVariables(
  review: AdvancementRunReview,
): Readonly<Record<string, string>> {
  return {
    unmet_criteria: review.unmetCriteria.join("\n"),
    review_id: review.id,
  };
}

function renderFailureHandlingReply(
  handling: FailureHandlingSpec,
  variables: Readonly<Record<string, string>>,
): string {
  return handling.reply.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    const value = variables[key];
    return value === undefined ? match : value;
  });
}

/**
 * 代理消息全文 = 意图骨架 + 归因事实块。
 * 意图骨架来自用户确认的 failureHandling（守推进意图不被改写）；
 * 归因块把裁判的逐条结论与独立证据事实传给执行侧，判断分歧一轮解开。
 */
export function composeProxyContent(
  handling: FailureHandlingSpec,
  variables: Readonly<Record<string, string>>,
  attribution: ReviewAttribution,
  rubric: ConfirmedRubricSnapshot,
): string {
  const reply = renderFailureHandlingReply(handling, variables);
  const facts = renderReviewAttribution(
    attribution,
    rubric.content.passCriteria,
  );
  return facts ? `${reply}\n\n${facts}` : reply;
}

/**
 * 从 review 构造完整代理消息实体。id 与 createdAt 由调用方给：
 * 首次入队用新生成 id，恢复重建恒复用 review.proxyMessageId（id 换新
 * 会让「proxyMessageId 缺失于 proxyMessages」谓词重建后依然为真，
 * 下次扫描再次命中造成循环重建）；createdAt 不在等价范围。
 */
export function buildAdvancementProxyMessage(input: {
  readonly id: string;
  readonly sessionId: string;
  readonly review: AdvancementRunReview;
  readonly handling: FailureHandlingSpec;
  readonly rubric: ConfirmedRubricSnapshot;
  readonly createdAt: string;
}): AdvancementProxyMessage {
  const variables = buildProxyVariables(input.review);
  return {
    id: input.id,
    sessionId: input.sessionId,
    reviewId: input.review.id,
    content: userTurnInputFromText(
      composeProxyContent(
        input.handling,
        variables,
        input.review.attribution,
        input.rubric,
      ),
    ),
    rubricFailureHandlingId: input.handling.id,
    variables,
    attribution: input.review.attribution,
    createdAt: input.createdAt,
  };
}
