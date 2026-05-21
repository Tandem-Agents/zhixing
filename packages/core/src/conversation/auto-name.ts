/**
 * 新对话自动命名机制 —— 第一轮 turn 完成后，用 light LLM 给对话起一个短主题
 * 名字，落到 conversation.meta.name 上。
 *
 * 设计原则：
 * - 一次性：永远只在新对话的第一轮 turn 结束后触发一次（turnCounter === 1）。
 *   命名成功后 name !== id，sentinel 永久阻断；命名失败该 turn 周期不重试。
 * - 默契不抢占：用户显式命名（创建时带 name / `/name <x>` / `/new <x>`）的对话
 *   一开始 name !== id，自动命名按"已命名跳过"规则不动用户的对话名。
 * - 主路径零阻塞：turnCounter !== 1 同步 short-circuit；命中第一轮才进异步分
 *   支（磁盘读 + LLM 调用 + 二次门控 + 写盘），调用方 fire-and-forget。
 * - 失败静默：LLM 异常、磁盘异常、内容不合格全部 catch swallow，不影响用户。
 *
 * 跨层职责：
 * - 本模块不依赖 LLM、不依赖 cli runtime；命名生成通过 InferConversationName
 *   函数依赖注入，由调用方装配。
 */

import type { Message } from "../types/messages.js";
import type { IConversationRepository } from "./types.js";

// ─── 生成器接口 ───

/**
 * 推断对话名字 —— 基于第一轮 user message 生成简短主题字符串。
 *
 * 返回 null = 不命名（失败 / 内容不合格 / 主动放弃），caller 静默不更新。
 * 返回 string = 已 sanitize 的短名字，caller 写入 conversation.meta.name。
 *
 * 收窄到 Message 而非整个 Turn：命名的稳定信号源是用户首句的 intent，
 * assistant 回复 / toolCalls / usage 与命名无关。接口收窄带来：
 *   - 模块依赖更短（conversation → types/messages，不引入 transcript/Turn）
 *   - 防未来误用 turn 其他字段做命名（toolCalls 是噪音）
 */
export type InferConversationName = (
  userMessage: Message,
) => Promise<string | null>;

// ─── 触发器协议 ───

export interface MaybeAutoNameFirstTurnOptions {
  conversationId: string;
  /** commitTurn 后 ++ 的值。刚好 === 1 表示第一 turn 完成。 */
  turnCounter: number;
  /** 调用方传 runResult.turn.userMessage —— 命名的稳定信号源 */
  userMessage: Message;
  inferName: InferConversationName;
  convRepo: IConversationRepository;
}

/**
 * 一次性自动命名触发器。
 *
 * 主路径瞬时 short-circuit：turnCounter !== 1 直接 resolved，主路径零额外 IO。
 * 命中第一轮才进入异步分支：
 *   1. 读 conv.meta 检查 name === id（未命名 sentinel）—— 已命名直接 return
 *   2. inferName(userMessage) 生成短名字 —— 失败 / null 直接 return
 *   3. 二次门控：重读 conv.meta 确认 name 仍 === id —— 防 inflight 期间用户
 *      `/name <x>` 被自动命名覆盖。承认极小 TOCTOU 窗口（二次 get 通过到调
 *      rename 之间的 microtask 级），不引入 compareAndSwap 强化原子性。
 *   4. convRepo.rename 写盘
 *
 * 返回 Promise<void>，供测试 await 等待异步完成；调用方主路径用 `void` 不
 * await，实现 fire-and-forget 语义不阻塞 turn 完成。失败：全部 catch swallow。
 * 不维护 UI 缓存：与 /name 命令同款，写盘即完——/switch typeahead 下次自然
 * 读到新值，启动 welcome chrome 下次启动重新渲染。
 */
export function maybeAutoNameFirstTurn(
  opts: MaybeAutoNameFirstTurnOptions,
): Promise<void> {
  if (opts.turnCounter !== 1) return Promise.resolve();

  return (async () => {
    try {
      const conv = await opts.convRepo.get(opts.conversationId);
      if (!conv || conv.name !== conv.id) return;

      const inferred = await opts.inferName(opts.userMessage);
      if (!inferred) return;

      const latest = await opts.convRepo.get(opts.conversationId);
      if (!latest || latest.name !== latest.id) return;

      await opts.convRepo.rename(opts.conversationId, inferred);
    } catch {
      // best-effort：自动命名是辅助能力，不影响用户主路径
    }
  })();
}

// ─── 名字 sanitize ───

const DEFAULT_MAX_LENGTH = 20;

/**
 * 把 LLM 返回的原始字符串处理为合法对话名字。
 *
 * 规则：
 *  - trim 首尾空白
 *  - 去首尾成对的引号（中英双单引号、中英双引号、书名号）
 *  - 折叠所有空白序列（含换行）为单空格
 *  - 截断到 maxLength（按 code point 数，不按 UTF-16 unit）
 *  - 处理后为空 → 返回 null（caller 不更新）
 */
export function sanitizeConversationName(
  raw: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string | null {
  if (typeof raw !== "string") return null;

  let s = raw.trim();
  if (!s) return null;

  s = stripPairedQuotes(s);
  s = s.replace(/\s+/gu, " ").trim();
  if (!s) return null;

  const codePoints = Array.from(s);
  if (codePoints.length > maxLength) {
    s = codePoints.slice(0, maxLength).join("");
  }

  return s || null;
}

const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["『", "』"],
  ["「", "」"],
  ["《", "》"],
];

function stripPairedQuotes(s: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.length >= open.length + close.length && s.startsWith(open) && s.endsWith(close)) {
      return s.slice(open.length, s.length - close.length).trim();
    }
  }
  return s;
}

// ─── prompt 工厂 ───

/**
 * 构造给 light LLM 的"对话命名"prompt。
 *
 * 设计取舍：
 *  - 5-15 字范围给出语义建议，sanitize 兜底截到 20 字符防 typeahead 折行
 *  - 不带任何标点 / 引号 / 编号 / 表情 —— sanitize 二次去重防御
 *  - 用对话主语言（中文提问中文命名）—— 由 LLM 自行判断
 */
export function buildConversationNamerPrompt(userText: string): string {
  return [
    "基于以下用户首次提问，用 5-15 个字概括这次对话的核心主题，作为对话名字。",
    "",
    "要求：",
    "- 用对话的主要语言（中文提问用中文）",
    "- 5-15 个字符，不超过此范围",
    "- 不带任何标点、引号、编号、表情或说明",
    "- 只输出主题字符串本身，不要任何前后缀",
    "",
    "用户提问：",
    userText,
    "",
    "主题：",
  ].join("\n");
}
