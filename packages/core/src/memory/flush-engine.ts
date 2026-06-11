/**
 * Memory Flush 引擎 — 上下文压缩时自动提取记忆 (L1.5)
 *
 * 在内容即将离开注意力窗口之时（段切换 afterSummarize 挂载），给 LLM 一次
 * 机会从原文中提取值得长期保存的信息。
 *
 * 设计要点：
 * - 不修改消息，仅执行持久化副作用
 * - 提取结果分流到记忆支柱 + Journal：
 *   profile（身份信息）、person（关系人）、journal（事件日志）
 * - 提取失败时静默降级——不能因为记忆提取失败阻塞对话
 *
 * 与 Hermes flush_memories 的对比：
 * - Hermes 在压缩前注入哨兵消息让模型调用 memory 工具，然后删除痕迹——侵入式
 * - 知行直接用独立 LLM 调用从消息中提取结构化数据——无侵入、可独立测试
 */

import type { Message } from "../types/messages.js";
import type { TextCallLLMFn } from "../types/llm.js";
import {
  calculateMessageTurns,
  splitMessagesPairAware,
} from "../context/message-turns.js";
import { MemoryStore, type MemoryCategory } from "./memory-store.js";

// ─── 类型 ───


/**
 * buildExtractionRequest 的尾部截断 turn 数。
 *
 * 设计目的：Flush 在 usage 高时被触发，如果把全量 messages 塞给 LLM，
 * 提取请求自身就可能超过 token 预算，导致静默失败。
 * 保留首条 user（意图锚）+ 最后 N 个完整 turn + 提取指令，保证请求永远可控。
 *
 * 为什么按 turn 数而不是消息数：硬切消息数可能劈开 tool_use/tool_result
 * 对 —— 那样 Anthropic API 会直接报 `tool_result without matching tool_use`，
 * 提取请求整个失败，反而比不做截断更糟。按 turn 切（splitMessagesPairAware）
 * 保证 tool pair 完整。
 *
 * 8 turn ≈ 原来的 ~20 条消息（纯对话 2 条/turn，tool 场景 3-4 条/turn 平均）。
 */
const EXTRACTION_TAIL_TURNS = 8;

/** LLM 返回的单条提取结果 */
export interface FlushExtraction {
  category: "profile" | "person" | "journal";
  id: string;
  meta: Record<string, unknown>;
  content: string;
}

/** Flush 执行结果（不改变消息，但报告提取了多少条） */
export interface FlushResult {
  extracted: number;
  saved: number;
  errors: string[];
}

// ─── 提取核心 ───

export interface MemoryFlusherConfig {
  readonly callLLM: TextCallLLMFn;
  readonly store: MemoryStore;
}

/**
 * 记忆提取核心 —— 从一段对话原文中提取长期记忆并分流持久化
 * （profile / person / journal）。
 *
 * 触发形态无关：段切换 hook 与任何未来挂载点共用同一提取实现；
 * 自身无状态（store / callLLM 为注入依赖），跨 run 共享安全。
 */
export class MemoryFlusher {
  private readonly callLLM: TextCallLLMFn;
  private readonly store: MemoryStore;

  constructor(config: MemoryFlusherConfig) {
    this.callLLM = config.callLLM;
    this.store = config.store;
  }

  /** 从消息中提取记忆并保存。 */
  async flush(
    messages: readonly Message[],
    opts?: { abortSignal?: AbortSignal },
  ): Promise<FlushResult> {
    const extractionMessages = buildExtractionRequest(messages);
    const rawResponse = await this.callLLM(extractionMessages, opts);
    const extractions = parseExtractions(rawResponse);

    const errors: string[] = [];
    let saved = 0;

    for (const ext of extractions) {
      try {
        if (ext.category === "journal") {
          await this.appendJournal(ext);
        } else {
          await this.store.save({
            category: ext.category as MemoryCategory,
            id: ext.id,
            meta: ext.meta,
            content: ext.content,
          });
        }
        saved++;
      } catch (err) {
        errors.push(
          `${ext.category}/${ext.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { extracted: extractions.length, saved, errors };
  }

  /** Journal 是追加模式：读取已有内容，在末尾追加新条目。 */
  private async appendJournal(ext: FlushExtraction): Promise<void> {
    const existing = await this.store.load("journal", ext.id);

    if (existing) {
      const newContent = `${existing.content}\n\n---\n\n${ext.content}`;
      await this.store.save({
        category: "journal",
        id: ext.id,
        meta: { ...existing.meta, ...ext.meta },
        content: newContent,
      });
    } else {
      await this.store.save({
        category: "journal",
        id: ext.id,
        meta: ext.meta,
        content: ext.content,
      });
    }
  }
}

// ─── 提取 Prompt ───

export const FLUSH_EXTRACTION_PROMPT = `You are a memory extraction assistant. Analyze the conversation above and extract information worth preserving long-term.

Extract ONLY genuinely important information. Do NOT extract trivial or transient details.

Return a JSON array of extractions. Each extraction must have:
- category: one of "profile", "person", "journal"
- id: a slug identifier (e.g. "wife-xiaoli", "2025-06-15")
- meta: frontmatter fields appropriate for the category
- content: markdown body text

Category guidelines:
- "profile": User's identity, preferences, technical stack, work style (id should be "profile")
- "person": People mentioned by name with relationship context (id: slug like "wife-xiaoli")
- "journal": Notable events, decisions, or outcomes from this session (id: today's date YYYY-MM-DD)

Rules:
- Use the conversation's primary language for content
- If nothing is worth extracting, return an empty array: []
- For journal entries, append to existing content (use "---" separator between entries)
- For profile, only extract if genuinely new identity information was shared
- Keep extractions concise — each content field should be 2-5 lines max

Respond with ONLY a valid JSON array, no markdown fences, no explanation.`;

// ─── 策略实现 ───


// ─── 辅助函数 ───

/**
 * 构建提取请求：首条 user（意图锚）+ 最近 EXTRACTION_TAIL_TURNS 个完整 turn + 提取指令。
 *
 * 为什么按 turn 数 pair-aware 切分：硬切消息数会劈开 tool_use/tool_result 对，
 * LLM provider 直接报 API 错 → 提取请求整个失败。按 turn 切保证 tool pair 完整。
 *
 * 只有实际 turn 数超过保留阈值时才截断；否则全量发送（小对话无需截断）。
 */
function buildExtractionRequest(messages: readonly Message[]): Message[] {
  const conversationMessages: Message[] = [];

  const turns = calculateMessageTurns(messages);
  const maxTurn = turns[turns.length - 1] ?? 0;

  if (maxTurn > EXTRACTION_TAIL_TURNS) {
    conversationMessages.push({ ...messages[0]! });
    const { toPreserve } = splitMessagesPairAware(
      messages,
      EXTRACTION_TAIL_TURNS,
    );
    for (const m of toPreserve) {
      conversationMessages.push({ ...m });
    }
  } else {
    for (const m of messages) {
      conversationMessages.push({ ...m });
    }
  }

  conversationMessages.push({
    role: "user" as const,
    content: [{ type: "text" as const, text: FLUSH_EXTRACTION_PROMPT }],
  });

  return conversationMessages;
}

/**
 * 解析 LLM 返回的 JSON 提取结果。
 * 容错处理：提取失败时返回空数组。
 */
export function parseExtractions(raw: string): FlushExtraction[] {
  const trimmed = raw.trim();

  // 去除可能的 markdown 代码块包裹
  const jsonStr = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "")
    : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed.filter((item): item is FlushExtraction => {
    if (!item || typeof item !== "object") return false;
    const obj = item as Record<string, unknown>;
    if (!["profile", "person", "journal"].includes(String(obj.category))) return false;
    if (typeof obj.id !== "string" || !obj.id) return false;
    if (typeof obj.content !== "string") return false;
    return true;
  }).map((item) => ({
    category: item.category,
    id: item.id,
    meta: (typeof item.meta === "object" && item.meta !== null ? item.meta : {}) as Record<string, unknown>,
    content: item.content,
  }));
}

