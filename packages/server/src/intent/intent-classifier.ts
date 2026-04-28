/**
 * 默认 IntentClassifier 实现 — 关键词字面匹配 + 启动期词集互斥校验。
 *
 * 不引入 LLM 调用判定意图:控制意图必须**确定性**,不能 model drift / 无意触发。
 * 关键词集设计为产品级用户表达全集(详见 cancel-keywords.ts);复杂自然语言
 * 意图(如"算了不写了")保留给后续按需扩展。
 *
 * 匹配语义:
 *   - 大小写无关(toLowerCase + NFKC 半角化)
 *   - **精确字面**(不做 substring),避免"我想取消订阅"这种含关键词的 agent
 *     输入误触
 *   - 末尾标点/空白允许 trim,与 confirmation `match.ts` 的 IM 习惯对齐
 */

import type { InboundMessage } from "@zhixing/core";
import { DEFAULT_CANCEL_KEYWORDS } from "./cancel-keywords.js";
import type { Intent, IntentClassifier } from "./types.js";

/** 末尾标点/空白 trim;与 confirmation/match.ts 的 TRAILING_PUNCT_RE 同源,IM 用户习惯 */
const TRAILING_PUNCT_RE = /[。！？、,，：;；!?.:~～\s]+$/u;

function normalize(text: string): string {
  return text.trim().replace(TRAILING_PUNCT_RE, "").normalize("NFKC").toLowerCase();
}

export interface DefaultIntentClassifierOptions {
  /**
   * 自定义 cancel 关键词集合;不传走 `DEFAULT_CANCEL_KEYWORDS`。
   * 注入点用于:测试 / channel-specific 词集 / 关闭 cancel 能力(传 [])。
   */
  readonly cancelKeywords?: ReadonlyArray<string>;
  /**
   * 与本 classifier 共存的 confirmation 词集,用于启动期静态互斥校验。
   * 不传时跳过校验 —— 注入方需自证不会与 confirmation 冲突(测试 / 单独使用)。
   */
  readonly confirmationApproveKeywords?: ReadonlyArray<string>;
  readonly confirmationDenyKeywords?: ReadonlyArray<string>;
  /** 预留 locale 参数,后续多语言扩展时按 locale 切换关键词集 */
  readonly locale?: "zh-CN" | "en";
}

export function createDefaultIntentClassifier(
  opts: DefaultIntentClassifierOptions = {},
): IntentClassifier {
  const cancelKeywords = opts.cancelKeywords ?? DEFAULT_CANCEL_KEYWORDS;

  if (
    opts.confirmationApproveKeywords !== undefined ||
    opts.confirmationDenyKeywords !== undefined
  ) {
    assertDisjoint(
      cancelKeywords,
      opts.confirmationApproveKeywords ?? [],
      opts.confirmationDenyKeywords ?? [],
    );
  }

  // 预归一化 cancel 词表为 Set,classify 走 O(1) 查表 —— 单次 normalize 比 array
  // 线性扫描快,且让 case/punct 等价类一次性折叠(避免每条消息重复折叠)
  const normalizedSet = new Set(cancelKeywords.map(normalize));
  // 反向查找:normalized -> 原始字面,用于 matchedKeyword 字段(诊断/审计)
  const reverseMap = new Map<string, string>();
  for (const kw of cancelKeywords) {
    reverseMap.set(normalize(kw), kw);
  }

  return {
    classify(msg: InboundMessage): Intent {
      const key = normalize(msg.text);
      if (key.length === 0) return { kind: "non-control" };
      if (normalizedSet.has(key)) {
        return {
          kind: "control",
          control: {
            kind: "cancel",
            matchedKeyword: reverseMap.get(key) ?? msg.text,
          },
        };
      }
      return { kind: "non-control" };
    },
  };
}

/**
 * 启动期静态互斥校验 —— cancel 词集 ∩ (approve ∪ deny) ≠ ∅ 时 throw。
 *
 * 词集互斥是硬不变量,不能运行时容忍 —— 冲突会让同一文本在 pending confirmation
 * 与 in-flight turn 场景下产生不同语义,UX 歧义。fail-fast 暴露配置错误优于
 * 让用户在生产遇到不一致行为。
 */
function assertDisjoint(
  cancel: ReadonlyArray<string>,
  approve: ReadonlyArray<string>,
  deny: ReadonlyArray<string>,
): void {
  const approveSet = new Set(approve.map(normalize));
  const denySet = new Set(deny.map(normalize));
  const conflicts: Array<{ word: string; with: "approve" | "deny" }> = [];
  for (const kw of cancel) {
    const key = normalize(kw);
    if (approveSet.has(key)) conflicts.push({ word: kw, with: "approve" });
    if (denySet.has(key)) conflicts.push({ word: kw, with: "deny" });
  }
  if (conflicts.length > 0) {
    const detail = conflicts
      .map((c) => `"${c.word}" (overlaps confirmation ${c.with})`)
      .join(", ");
    throw new Error(
      `IntentClassifier: cancel keywords must be disjoint from confirmation ` +
        `approve/deny sets — found ${conflicts.length} conflict(s): ${detail}`,
    );
  }
}
