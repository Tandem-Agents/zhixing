/**
 * 启动装填器 —— 重启 / 切换对话时，把"摘要快照 + 预算化倒读的最近原文"
 * 渲染为一条 system-meta 装填对，由 owner 在建窗时作为窗口起始条目置入。
 *
 * 分层定位：本模块是"持久化 → 注意力窗口"的桥——上下文层消费持久层的
 * 倒读原语与快照缓存，产出窗口的 bootstrap 条目。窗口模块自身保持存储
 * 无关，owner（会话层）只做装配。
 *
 * 设计要点：
 *   - **预算化**：装多少由 token 预算决定（组数是结果不是参数）；最近一组
 *     必装（连贯底线），单组超预算时降级为压缩核（开头意图 + 末尾结论与
 *     原话，机械截取、无 LLM）。
 *   - **摘要严格早于原文**：只取 coveredThroughRunIndex 严格早于已装原文
 *     起点的快照（不满足回退更旧），宁缺毋滥——快照是派生缓存，缺失只是
 *     连贯性降级，绝不现场生成。
 *   - **clear 边界天然生效**：倒读原语止于 ClearRecord；清空前的快照按
 *     createdAt 退役。清空后的对话装填自然为空。
 *   - 工具轮渲染为可读文本、不伪装协议消息；用户与助手内容保持原文。
 */

import type { Message } from "../../types/messages.js";
import { readRunsReverse } from "../../transcript/shard/reader.js";
import type { ShardedTranscriptStore } from "../../transcript/shard/store.js";
import type { RunRecord } from "../../transcript/shard/types.js";
import type { SnapshotStore } from "../../transcript/snapshot/store.js";
import type { SegmentSnapshotFile } from "../../transcript/snapshot/types.js";
import { buildStartupBootstrapPair } from "../system-meta.js";
import { estimateTextTokensRaw } from "../token-estimator.js";

// ─── 依赖与常量 ───

export interface StartupBootstrapDeps {
  readonly conversationId: string;
  /** 持久层原文（倒读原语 + clear 边界的数据源） */
  readonly store: ShardedTranscriptStore;
  /** 派生摘要快照读端 */
  readonly snapshots: SnapshotStore;
  /** 模型注意力能力 —— 预算基准（调用方按当前模型解析后注入数值） */
  readonly capability: { readonly optimalMaxTokens: number };
  /** token 估算（与运行期同一估算器实现） */
  readonly estimator: {
    estimateMessages(messages: readonly Message[]): number;
  };
}

/** 装填预算的绝对上限 —— 注意力优质区间内为"接续感"付出的最大成本 */
const BOOTSTRAP_BUDGET_CAP_TOKENS = 24_000;
/** 摘要段的字符封顶（超出截 active 尾、保 facts/state） */
const SUMMARY_CHAR_CAP = 800;
/** 摘要段在预算中的预留（按封顶字数的保守 token 估算） */
const SUMMARY_TOKEN_RESERVE = 400;
/** 工具结果渲染的单块字符截断 —— 装填要的是脉络，细节留给磁盘原文 */
const TOOL_RESULT_RENDER_CAP = 200;
/** 压缩核保留的末尾消息数（最后两轮原话） */
const CORE_TAIL_MESSAGE_COUNT = 4;
/** 压缩核中首条用户消息（意图）的字符截断 */
const CORE_INTENT_CHAR_CAP = 600;

// ─── 装填器 ───

/**
 * 构建启动装填对。返回 null = 无可装内容（新对话 / 清空后），owner 空窗起步。
 */
export async function buildStartupBootstrap(
  deps: StartupBootstrapDeps,
): Promise<readonly [Message, Message] | null> {
  const { conversationId, store, snapshots, capability, estimator } = deps;

  // 1. 预算基准：优质上限的四分之一，封顶绝对值。
  //    摘要预留按需：无任何快照时预算全给原文（绝不现场生成摘要）。
  const budgetBase = Math.min(
    Math.floor(capability.optimalMaxTokens / 4),
    BOOTSTRAP_BUDGET_CAP_TOKENS,
  );
  const candidateSnapshots = await snapshots.list(conversationId);
  const summaryReserve =
    candidateSnapshots.length > 0 ? SUMMARY_TOKEN_RESERVE : 0;

  // 2. 倒读装原文：逐组（整 run record）入预算，装满即止。
  //    最近一组必装——它是连贯底线，预算放不下时降级为压缩核而非丢弃；
  //    连贯地板（最近一组 + 一条摘要的成本）可顶起过小的预算基准。
  const picked: Array<{ record: RunRecord; compressed: boolean }> = [];
  let usedTokens = 0;
  let budget = budgetBase;
  for await (const { record } of readRunsReverse(store, conversationId)) {
    if (picked.length === 0) {
      const fullCost = estimator.estimateMessages(record.messages);
      const compressed = fullCost > budgetBase;
      // 压缩核以原文预算基准为硬上限（独占原文预算）——收敛后 cost ≤ 基准，
      // 连贯地板顶起的 budget 随之恒有界
      const cost = compressed
        ? estimateTextTokensRaw(
            renderRun(record, { compressed: true, budgetTokens: budgetBase }),
          )
        : fullCost;
      picked.push({ record, compressed });
      usedTokens = cost;
      budget = Math.max(budgetBase, cost + summaryReserve);
      continue;
    }
    const cost = estimator.estimateMessages(record.messages);
    if (usedTokens + cost + summaryReserve > budget) break;
    picked.push({ record, compressed: false });
    usedTokens += cost;
  }
  if (picked.length === 0) return null;

  // picked 为倒序（新→旧）；装填文本按时间正序渲染
  picked.reverse();
  const earliestLoadedRunIndex = picked[0]!.record.runIndex;

  // 3. 摘要：最新的"未退役且严格早于已装原文起点"的快照；不满足向更旧回退
  const summaryText = await pickSnapshotSummary(
    candidateSnapshots,
    store,
    conversationId,
    earliestLoadedRunIndex,
  );

  // 4. 渲染装填文本：摘要在前、最近原文正序在后（最贴近用户即将说的话）
  const sections: string[] = [
    "〔接续既有对话：以下是此前对话的回顾，按时间从早到晚排列〕",
  ];
  if (summaryText) {
    sections.push(`== 更早内容的摘要 ==\n${summaryText}`);
  }
  sections.push(
    `== 最近对话原文 ==\n${picked
      .map(({ record, compressed }) =>
        renderRun(record, { compressed, budgetTokens: budgetBase }),
      )
      .join("\n---\n")}`,
  );

  return buildStartupBootstrapPair(sections.join("\n\n"));
}

// ─── 快照选择 ───

/**
 * 从新到旧找首个满足两条件的快照并渲染为摘要文本：
 *   - 未退役：createdAt 晚于最近一次清空（清空前的摘要对新事实流无效）
 *   - 严格早于原文起点：coveredThroughRunIndex < 已装原文最早 runIndex
 *     （否则摘要与原文重叠，向更旧快照回退）
 */
async function pickSnapshotSummary(
  candidates: readonly SegmentSnapshotFile[],
  store: ShardedTranscriptStore,
  conversationId: string,
  earliestLoadedRunIndex: number,
): Promise<string | null> {
  if (candidates.length === 0) return null;

  const lastClearAt = (await store.ensureReadableIndex(conversationId))
    ?.lastClearAt;

  for (const snapshot of candidates) {
    if (lastClearAt !== undefined && snapshot.createdAt <= lastClearAt) {
      // 列表按 createdAt 降序——首个退役者之后全部退役
      return null;
    }
    if (snapshot.coveredThroughRunIndex < earliestLoadedRunIndex) {
      return renderSummary(snapshot);
    }
  }
  return null;
}

/** 三段摘要渲染 + 字符封顶：超出先截 active 尾，仍超保 facts 优先 */
function renderSummary(snapshot: SegmentSnapshotFile): string {
  const { facts, state, active } = snapshot.structuredSummary;
  const parts = [facts, state, active].filter((part) => part !== "");
  let text = parts.join("\n\n");
  if (text.length <= SUMMARY_CHAR_CAP) return text;

  // 截 active 尾：facts + state 保全，active 用剩余空间
  const head = [facts, state].filter((part) => part !== "").join("\n\n");
  if (head.length < SUMMARY_CHAR_CAP) {
    const room = SUMMARY_CHAR_CAP - head.length - 2;
    text = room > 0 && active ? `${head}\n\n${active.slice(0, room)}…` : head;
    return text;
  }
  // facts/state 自身已超封顶 → 硬截尾（facts 在前，优先保全）
  return `${head.slice(0, SUMMARY_CHAR_CAP)}…`;
}

// ─── run 渲染 ───

/**
 * 把一条 run record 渲染为可读文本。
 *
 * 压缩核形态（单组超预算的机械降级）：开头意图（首条用户消息截头）+
 * 省略标注 + 末尾原话（最后几条消息，含最终结论），再以 budgetTokens 为
 * **硬上限**做文本级收敛（保头保尾、减半细化）——消息条数少但单条超长的
 * run 同样被收敛覆盖。无 LLM、严格有界。
 */
function renderRun(
  record: RunRecord,
  opts: { compressed: boolean; budgetTokens?: number },
): string {
  if (!opts.compressed) {
    return record.messages.map(renderMessage).join("\n");
  }

  const raw =
    record.messages.length <= CORE_TAIL_MESSAGE_COUNT + 1
      ? record.messages.map(renderMessage).join("\n")
      : [
          `用户：${textOf(record.messages[0]!).slice(0, CORE_INTENT_CHAR_CAP)}`,
          `〔本轮过长，中间过程已省略，完整原文在对话历史中〕`,
          ...record.messages.slice(-CORE_TAIL_MESSAGE_COUNT).map(renderMessage),
        ].join("\n");
  return opts.budgetTokens !== undefined
    ? clampTextToBudget(raw, opts.budgetTokens)
    : raw;
}

const CORE_TRUNCATION_NOTE = "\n〔内容过长已截断，完整原文在对话历史中〕\n";

/**
 * 文本级预算收敛 —— 预算是硬上限：保头（任务意图在前）保尾（结论与最终
 * 答复在后），按"目标/当前"比例一次裁剪（估算对字符近似线性，乘 0.9 安全
 * 系数）；标注自身有开销，减半细化收敛——保留长度严格收敛到 0，循环必然
 * 终止，最差退化为仅剩标注的占位（该预算下能给出的最大连贯性）。
 */
function clampTextToBudget(text: string, maxTokens: number): string {
  if (estimateTextTokensRaw(text) <= maxTokens) return text;

  const ratio = Math.max(
    0,
    Math.min(1, (maxTokens / Math.max(1, estimateTextTokensRaw(text))) * 0.9),
  );
  let headKeep = Math.floor((text.length * ratio) / 2);
  let tailKeep = Math.floor((text.length * ratio) / 2);

  const build = (): string =>
    text.slice(0, headKeep) +
    CORE_TRUNCATION_NOTE +
    text.slice(text.length - tailKeep);

  let out = build();
  while (estimateTextTokensRaw(out) > maxTokens && headKeep + tailKeep > 0) {
    headKeep = Math.floor(headKeep / 2);
    tailKeep = Math.floor(tailKeep / 2);
    out = build();
  }
  return out;
}

/** 单条协议消息 → 可读行：用户 / 助手原话保留，工具轮降为标注文本 */
function renderMessage(message: Message): string {
  const lines: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text.trim() === "") continue;
      lines.push(
        message.role === "user" ? `用户：${block.text}` : `助手：${block.text}`,
      );
    } else if (block.type === "tool_use") {
      lines.push(`助手：[调用工具 ${block.name}]`);
    } else if (block.type === "tool_result") {
      const text = toolResultText(block.content).slice(
        0,
        TOOL_RESULT_RENDER_CAP,
      );
      lines.push(`[工具结果] ${text}`);
    }
  }
  return lines.join("\n");
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === "object" && b !== null && "text" in b
          ? String((b as { text: unknown }).text)
          : "",
      )
      .join(" ");
  }
  return "";
}

function textOf(message: Message): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
