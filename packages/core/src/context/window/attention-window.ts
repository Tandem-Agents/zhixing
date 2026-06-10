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
  options: CreateAttentionWindowOptions = {},
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

  return new AttentionWindow(options, entries);
}
