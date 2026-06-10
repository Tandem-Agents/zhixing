/**
 * 注意力窗口运行态实现。
 *
 * ─── 窗口事实的形态 = 蒸馏对 ───
 *
 * 每个被接受的 run 以 [用户原文, 最终 assistant] 配对留存；run 内的工具协议
 * 消息是 run 瞬态，跨 run 不留存——这精确保持"跨 run 只见用户与最终回复"的
 * 既有窗口语义，token 成本可控，工具细节的跨 run 可见性留给启动装填的文本
 * 渲染与未来的检索召回。
 *
 * ─── 三类条目与单 frontier 折叠 ───
 *
 * 条目：bootstrap（启动装填对）、summary（折叠摘要对）、pair（run 配对）。
 * 折叠时新摘要对置首并取代其前**全部**条目（含 bootstrap 与旧摘要——新摘要
 * 由 LLM 在含旧摘要的窗口上生成，语义上已递归覆盖它们），再按 pairsCompacted
 * 截掉被摘的前 N 个配对。任何时刻窗口至多一个摘要对（单 frontier）。
 *
 * ─── 派生与兜底 ───
 *
 * 配对从 runMessages 派生：[首条, 末条 assistant]。无 assistant 的 run
 * （中断 / 错误在首次 LLM 完成之前）派生空 assistant 成对入窗——记录侧不
 * 伪造消息，兜底收敛在派生这一个点。
 */

import type { Message } from "../../types/messages.js";
import {
  emptyAssistantMessage,
  findLastAssistantMessage,
} from "../../types/messages.js";
import { buildCompactSummaryPair, detectSystemMetaKind } from "../system-meta.js";
import type {
  AcceptRunInput,
  AttentionWindowState,
  CreateAttentionWindowOptions,
  WindowCompact,
  WindowFoldOutcome,
  WindowResetReason,
} from "./types.js";

// ─── 内部条目 ───

type WindowEntry =
  | { readonly kind: "bootstrap"; readonly messages: readonly [Message, Message] }
  | { readonly kind: "summary"; readonly messages: readonly [Message, Message] }
  | {
      readonly kind: "pair";
      readonly messages: readonly [Message, Message];
      readonly runIndex?: number;
    };

// ─── 实现 ───

class AttentionWindow implements AttentionWindowState {
  readonly conversationId?: string;
  private entries: WindowEntry[] = [];

  constructor(
    options: CreateAttentionWindowOptions,
    initialEntries?: WindowEntry[],
  ) {
    this.conversationId = options.conversationId;
    if (initialEntries) {
      this.entries.push(...initialEntries);
    }
    if (options.bootstrap) {
      this.entries.push({ kind: "bootstrap", messages: options.bootstrap });
    }
  }

  getMessages(): readonly Message[] {
    return this.entries.flatMap((entry) => entry.messages);
  }

  acceptRun(input: AcceptRunInput): WindowFoldOutcome {
    if (input.runMessages.length === 0) {
      throw new Error(
        "AttentionWindow.acceptRun: runMessages 为空——窗口配对至少需要用户消息",
      );
    }

    const outcome = input.windowCompact
      ? this.fold(input.windowCompact)
      : {};

    // 无 assistant（run 在首次 LLM 完成前被中断 / 出错）→ 空 assistant 兜底，
    // 让"完成与中断的 run 都能成对入窗"无需调用方特判。
    const user = input.runMessages[0]!;
    const assistant =
      findLastAssistantMessage(input.runMessages) ?? emptyAssistantMessage();
    this.entries.push({
      kind: "pair",
      messages: [user, assistant],
      runIndex: input.runIndex,
    });

    return outcome;
  }

  applyCompact(windowCompact: WindowCompact): WindowFoldOutcome {
    return this.fold(windowCompact);
  }

  reset(_reason: WindowResetReason): void {
    this.entries = [];
  }

  /**
   * 单 frontier 折叠：新摘要对置首，取代其前全部 bootstrap / summary 条目，
   * 并截掉被摘的前 N 个配对（N 超过现存配对数时 clamp 到现存数——摘要可能
   * 覆盖了进行中 run 的内容，该 run 的配对尚未入窗，多出的计数自然落空）。
   *
   * 返回被折最后一个配对的 runIndex，供 owner 给派生摘要快照定覆盖边界。
   */
  private fold(windowCompact: WindowCompact): WindowFoldOutcome {
    const pairs = this.entries.filter(
      (entry): entry is Extract<WindowEntry, { kind: "pair" }> =>
        entry.kind === "pair",
    );
    const foldedCount = Math.min(
      Math.max(0, windowCompact.pairsCompacted),
      pairs.length,
    );
    const folded = pairs.slice(0, foldedCount);
    const retained = pairs.slice(foldedCount);

    const [summaryMsg, ackMsg] = buildCompactSummaryPair(windowCompact.summary);
    this.entries = [
      { kind: "summary", messages: [summaryMsg, ackMsg] },
      ...retained,
    ];

    return foldedCount > 0
      ? { coveredThroughRunIndex: folded[foldedCount - 1]!.runIndex }
      : {};
  }
}

/**
 * 建窗 —— owner（会话层）在会话编排启动时构造；bootstrap 为启动装填对，
 * 无历史 / 清空后为 undefined（空窗起步）。
 */
export function createAttentionWindow(
  options: CreateAttentionWindowOptions = {},
): AttentionWindowState {
  return new AttentionWindow(options);
}

/**
 * 启动保尾护栏 —— 全量加载重建窗口时的机械截断配置（过渡期，预算化启动
 * 装填落地后随 restore 一起删除）。
 *
 * 为什么需要：磁盘是 append-only 原文、不再因压缩截断，超长对话全量加载
 * 重建的窗口可能超过模型物理上限——此时段评估想自愈，但摘要 LLM 调用本身
 * 要发送整个超限窗口，自愈失效。护栏在重建时从尾部机械保留（无 LLM、不碰
 * 磁盘）：摘要对放得下则保留，配对从最新往回装，至少保最后一个配对。
 */
export interface RestoreTailGuard {
  /** 保尾预算（token）——挂模型的风险注意力上限，不挂物理窗口百分比 */
  readonly maxTokens: number;
  /** token 估算（与运行期同一估算器实现） */
  estimateMessages(messages: readonly Message[]): number;
}

/**
 * 从持久化 canonical 重建窗口 —— **过渡期桥**，预算化启动装填落地后删除。
 *
 * 现阶段窗口的初始内容仍来自 store 产出的 canonical（`summaryPair? + 严格
 * 交替的 [user, assistant] 配对`，由 rebuild 算法保证形态）。条目类型必须
 * 还原准确：summaryPair 若被误标为普通配对，后续折叠的 pairsCompacted 计数
 * 就会错位——这是该解析必须住在窗口模块内（拥有条目语义）的原因。
 *
 * 严格解析、畸形即抛：canonical 只可能来自 store（load / commitTurn /
 * compactAll 返回值），恒为洁净形；宽容解析只会把数据损坏静默搅进窗口，
 * 不如在边界上立即暴露。
 */
export function restoreAttentionWindowFromCanonical(
  canonical: readonly Message[],
  options: CreateAttentionWindowOptions & {
    readonly tailGuard?: RestoreTailGuard;
  } = {},
): AttentionWindowState {
  const entries: WindowEntry[] = [];
  let i = 0;

  if (
    canonical.length >= 2 &&
    detectSystemMetaKind(canonical[0]!) === "compact-summary" &&
    detectSystemMetaKind(canonical[1]!) === "ack"
  ) {
    entries.push({
      kind: "summary",
      messages: [canonical[0]!, canonical[1]!],
    });
    i = 2;
  }

  for (; i < canonical.length; i += 2) {
    const user = canonical[i]!;
    const assistant = canonical[i + 1]; // 奇数尾时为 undefined → 同样判为畸形
    if (user.role !== "user" || assistant?.role !== "assistant") {
      throw new Error(
        `restoreAttentionWindowFromCanonical: canonical 第 ${i} 条起不是 ` +
          "[user, assistant] 配对——store 产出的 canonical 不应出现此形态，" +
          "可能是数据损坏",
      );
    }
    entries.push({ kind: "pair", messages: [user, assistant] });
  }

  return new AttentionWindow(
    options,
    options.tailGuard ? clampEntriesToTail(entries, options.tailGuard) : entries,
  );
}

/**
 * 机械保尾 —— 预算是**硬上限**（护栏存在的全部意义就是让段评估的摘要调用
 * 发得出去，超限即失效）。优先序：
 *
 *   1. 最后一个配对必保（连贯底线：空窗起步让模型对"接续旧对话"完全失忆）
 *      ——但它单独超限时**截断降级**而非硬塞：用户消息保开头（意图）、
 *      assistant 保结尾（结论），机械按比例裁剪，是"超大组放压缩核"思路的
 *      无 LLM 形态；
 *   2. 摘要对放得下剩余额度则保留（高信号蒸馏优先于更多原文）；
 *   3. 余额给更早配对，从新到旧装满即止。
 */
function clampEntriesToTail(
  entries: WindowEntry[],
  guard: RestoreTailGuard,
): WindowEntry[] {
  const summary = entries.find((e) => e.kind === "summary");
  const pairs = entries.filter(
    (e): e is Extract<WindowEntry, { kind: "pair" }> => e.kind === "pair",
  );

  if (pairs.length === 0) {
    return summary &&
      guard.estimateMessages(summary.messages) <= guard.maxTokens
      ? [summary]
      : [];
  }

  const last = pairs[pairs.length - 1]!;
  const lastCost = guard.estimateMessages(last.messages);
  if (lastCost > guard.maxTokens) {
    // 末配对单独超限：截断降级，独占全部预算（摘要与更早配对都放弃——
    // 硬上限优先，细节留给磁盘上的完整原文与未来的检索召回）
    return [truncatePairToBudget(last, guard)];
  }

  let budget = guard.maxTokens - lastCost;
  const keepSummary =
    summary !== undefined && guard.estimateMessages(summary.messages) <= budget;
  if (keepSummary) {
    budget -= guard.estimateMessages(summary!.messages);
  }

  const keptPairs: WindowEntry[] = [last];
  for (let i = pairs.length - 2; i >= 0; i--) {
    const cost = guard.estimateMessages(pairs[i]!.messages);
    if (cost > budget) break;
    keptPairs.unshift(pairs[i]!);
    budget -= cost;
  }

  return keepSummary ? [summary!, ...keptPairs] : keptPairs;
}

const TAIL_TRUNCATION_NOTE = "…〔启动加载时截断，完整原文在对话历史中〕…";

/**
 * 把单个超限配对机械裁剪进预算：用户消息保**开头**（提问/任务的意图在前），
 * assistant 保**结尾**（结论与最终答复在后），按"目标/当前"比例一次性裁剪
 * （估算器对字符近似线性，乘 0.9 安全系数落在预算内）。
 *
 * 有损降级：非文本块（图片等）不保留——截断本就是丢细节换可用性，
 * 完整原文仍在磁盘上。
 */
function truncatePairToBudget(
  pair: Extract<WindowEntry, { kind: "pair" }>,
  guard: RestoreTailGuard,
): WindowEntry {
  const [user, assistant] = pair.messages;
  const userText = textOf(user);
  const assistantText = textOf(assistant);
  const cost = guard.estimateMessages(pair.messages);
  const ratio = Math.max(
    0,
    Math.min(1, (guard.maxTokens / Math.max(1, cost)) * 0.9),
  );

  let userKeep = Math.floor(userText.length * ratio);
  let assistantKeep = Math.floor(assistantText.length * ratio);

  const build = (): readonly [Message, Message] => [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: userText.slice(0, userKeep) + TAIL_TRUNCATION_NOTE,
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text:
            TAIL_TRUNCATION_NOTE +
            assistantText.slice(assistantText.length - assistantKeep),
        },
      ],
    },
  ];

  // 标注自身有开销，极小预算下一次比例裁剪可能仍超限——逐次减半细化，
  // 保留长度严格收敛到 0，循环必然终止；最差退化为仅剩标注的占位对
  //（预算小到连标注都放不下时也接受占位——护栏的职责是让窗口可用，
  // 占位对是该预算下能给出的最大连贯性）。
  let messages = build();
  while (
    guard.estimateMessages(messages) > guard.maxTokens &&
    userKeep + assistantKeep > 0
  ) {
    userKeep = Math.floor(userKeep / 2);
    assistantKeep = Math.floor(assistantKeep / 2);
    messages = build();
  }

  return { kind: "pair", messages, runIndex: pair.runIndex };
}

function textOf(message: Message): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
