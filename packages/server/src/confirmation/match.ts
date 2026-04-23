/**
 * 文本 → ConfirmationDecision 匹配规则
 *
 * 远程确认（[remote-confirmation-execution.md §3.6]）的核心业务逻辑：
 * 用户在通道里回复任意文本后，这里把它翻译成 broker 可消费的 decision。
 *
 * 设计原则（详见 spec §3.6）：
 *   - **保守完全匹配**：去末尾标点后仍须完全等于集合成员才识别为 allow/deny；
 *     其他任意文本一律作为 `{ kind: "deny", reason }` 回流给 LLM（自由文本拒绝）
 *   - **末尾标点 trim**：覆盖 IM 习惯性标点（"好。" / "yes." / "好的！"）
 *   - **只 trim 末尾不 trim 中间**：保留理由文本中的表达（"不要删！那是生产"里的 ！）
 *   - **reason 长度截断**：防超长消息膨胀 LLM 上下文与 token 成本
 *   - **LLM 友好**：不在集合的文本作为拒绝理由（deny + reason），语义由 LLM 解读
 */

import type {
  ConfirmationDecision,
  ConfirmationRequest,
} from "@zhixing/core";

// ─── 词集定义 ───

/** 允许本次——覆盖常见肯定表达（中英文 + 数字 + 口语 + 情绪） */
const APPROVE_SET = new Set<string>([
  // 英文
  "y", "yes", "yep", "yeah", "yup", "ok", "okay", "sure", "approve",
  // 数字
  "1",
  // 中文短词
  "好", "好的", "好啊", "行", "行的", "可以", "同意", "允许",
  "批准", "通过", "执行", "继续", "没问题",
  // 口语 / 情绪
  "干吧", "去吧", "做吧", "来", "来吧", "嗯", "嗯嗯",
]);

/** 拒绝——覆盖常见否定表达（中英文 + 数字 + 口语 + 情绪） */
const DENY_SET = new Set<string>([
  // 英文
  "n", "no", "nope", "cancel", "stop", "deny", "reject",
  // 数字
  "2",
  // 中文短词
  "不", "不行", "不要", "不用", "拒绝", "否",
  "不同意", "不可以", "不批准", "不通过",
  // 口语 / 情绪
  "算了", "别", "停", "取消", "不了",
]);

/**
 * 拒绝理由最大长度——超过截断，防止膨胀 LLM 上下文与 token 成本。
 * 2000 字符约 500-700 token，足够完整表达绝大多数拒绝意图。
 */
export const MAX_REASON_LENGTH = 2000;

/**
 * 末尾标点 / 空白 trim——中英文 IM 习惯性在短回复后加标点，不处理会被当成
 * 自由文本拒绝导致批准命中率塌方。只 trim **末尾**，保守避免误伤
 * （"不要删！"里的 `！` 不能 trim——那是理由的一部分）。
 *
 * 覆盖字符：中英全半角常用句末标点 + 波浪号 + 空白。
 */
const TRAILING_PUNCT_RE = /[。！？、,，：;；!?.:~～\s]+$/u;

// ─── 核心匹配 ───

/**
 * 文本 → ConfirmationDecision。
 *
 * 匹配流程：
 *   1. trim 两端空白
 *   2. 再 trim 末尾标点 → NFKC 半角化（识别全角输入法产出）→ 小写化
 *   3. key ∈ APPROVE_SET → `{ kind: "allow-once" }`（结构化批准）
 *   4. key ∈ DENY_SET    → `{ kind: "deny" }`（结构化拒绝，无 reason）
 *   5. 其他               → `{ kind: "deny", reason: 原文 }`（自由文本拒绝）
 *      - 原文长度超过 MAX_REASON_LENGTH → 截断 + "…（理由已截断）"
 *
 * 结构化 deny 和自由文本 deny 共用 `kind: "deny"`——语义上都是"用户拒绝"；
 * 下游（埋点 / Bridge 推送 / secure-executor）通过 `reason` 是否存在区分。
 * 判别辅助见 `@zhixing/core` 的 `isFreeTextDeny`。
 *
 * 空白输入应由调用方提前过滤（见 InboundRouter.tryHandleAsConfirmationReply）。
 */
export function matchTextToDecision(text: string): ConfirmationDecision {
  const trimmed = text.trim();
  const key = trimmed
    .replace(TRAILING_PUNCT_RE, "")
    .normalize("NFKC")
    .toLowerCase();
  if (APPROVE_SET.has(key)) return { kind: "allow-once" };
  if (DENY_SET.has(key)) return { kind: "deny" };
  const reason =
    trimmed.length > MAX_REASON_LENGTH
      ? trimmed.slice(0, MAX_REASON_LENGTH) + "…（理由已截断）"
      : trimmed;
  return { kind: "deny", reason };
}

/**
 * 格式化用户回复的回执消息——给通道用户看的"已处理"反馈。
 *
 * 分支语义：
 *   - `ok=false`：broker.resolve 返回 false（请求已超时 / 已在其他端被解决）
 *   - allow-once：结构化批准
 *   - deny（无 reason）：结构化拒绝
 *   - deny（带 reason）：自由文本理由 → 回流到 LLM
 */
export function formatResolutionReceipt(
  request: ConfirmationRequest,
  decision: ConfirmationDecision,
  ok: boolean,
): string {
  if (!ok) {
    return `⚠️ 操作已被处理（可能已超时或在其他端批准 / 拒绝）：${request.display.title}`;
  }
  switch (decision.kind) {
    case "allow-once":
      return `✅ 已允许：${request.display.title}`;
    case "deny":
      // reason 存在 → 自由文本拒绝（带理由段）；无 reason → 结构化拒绝
      return decision.reason
        ? `❌ 已拒绝：${request.display.title}\n理由已转给 AI：${decision.reason}`
        : `❌ 已拒绝：${request.display.title}`;
    default:
      return `已处理：${request.display.title}`;
  }
}
