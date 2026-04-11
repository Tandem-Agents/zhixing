/**
 * Memory Flush 引擎 — 上下文压缩时自动提取记忆 (L1.5)
 *
 * 在上下文压缩管线中，L1（ToolResult 截断）之后、L2（消息丢弃）之前执行。
 * 给 LLM 一次机会，从即将被压缩掉的消息中提取值得长期保存的信息。
 *
 * 设计要点：
 * - 作为 CompactionStrategy 嵌入引擎，零侵入现有管线
 * - 不修改消息（compacted: false），仅执行持久化副作用
 * - 提取结果分流到三支柱 + Journal：
 *   profile（身份信息）、person（关系人）、skill（方法论）、journal（事件日志）
 * - 提取失败时静默降级——不能因为记忆提取失败阻塞对话
 *
 * 与 Hermes flush_memories 的对比：
 * - Hermes 在压缩前注入哨兵消息让模型调用 memory 工具，然后删除痕迹——侵入式
 * - 知行直接用独立 LLM 调用从消息中提取结构化数据——无侵入、可独立测试
 */

import type { Message } from "../types/messages.js";
import type {
  CompactionContext,
  CompactionResult,
  CompactionStrategy,
} from "../context/types.js";
import { MemoryStore, type MemoryCategory } from "./memory-store.js";

// ─── 类型 ───

/**
 * Flush 用的 LLM 调用函数。
 * 接收消息列表（含提取指令），返回纯文本 JSON。
 */
export type FlushLLMFn = (messages: Message[]) => Promise<string>;

export interface FlushEngineConfig {
  callLLM: FlushLLMFn;
  store: MemoryStore;
  /** 最少需要多少条消息才值得做 Flush（默认 6） */
  minMessages?: number;
}

/** LLM 返回的单条提取结果 */
export interface FlushExtraction {
  category: "profile" | "person" | "skill" | "journal";
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

// ─── 提取 Prompt ───

export const FLUSH_EXTRACTION_PROMPT = `You are a memory extraction assistant. Analyze the conversation above and extract information worth preserving long-term.

Extract ONLY genuinely important information. Do NOT extract trivial or transient details.

Return a JSON array of extractions. Each extraction must have:
- category: one of "profile", "person", "skill", "journal"
- id: a slug identifier (e.g. "docker-network-debug", "wife-xiaoli")
- meta: frontmatter fields appropriate for the category
- content: markdown body text

Category guidelines:
- "profile": User's identity, preferences, technical stack, work style (id should be "profile")
- "person": People mentioned by name with relationship context (id: slug like "wife-xiaoli")
- "skill": Reusable methodology discovered through problem-solving (id: slug like "docker-network-debug", meta must include title, tags, triggers)
- "journal": Notable events, decisions, or outcomes from this session (id: today's date YYYY-MM-DD)

Rules:
- Use the conversation's primary language for content
- If nothing is worth extracting, return an empty array: []
- For journal entries, append to existing content (use "---" separator between entries)
- For profile, only extract if genuinely new identity information was shared
- For skills, only extract if a non-trivial methodology was discovered through effort
- Keep extractions concise — each content field should be 2-5 lines max

Respond with ONLY a valid JSON array, no markdown fences, no explanation.`;

// ─── 策略实现 ───

/**
 * Memory Flush 策略 — 优先级 3（L1 之后、L2 之前）。
 *
 * 不修改消息列表，仅将值得保留的信息持久化到记忆存储。
 * 返回 compacted: false 让后续策略（L2/L3）继续执行。
 */
export class MemoryFlushStrategy implements CompactionStrategy {
  readonly name = "memory_flush";
  readonly priority = 3;
  readonly requiresLLM = true;

  private readonly callLLM: FlushLLMFn;
  private readonly store: MemoryStore;
  private readonly minMessages: number;
  private _lastResult: FlushResult | null = null;

  constructor(config: FlushEngineConfig) {
    this.callLLM = config.callLLM;
    this.store = config.store;
    this.minMessages = config.minMessages ?? 6;
  }

  /** 最近一次 flush 的结果（用于 CLI 渲染和测试） */
  get lastResult(): FlushResult | null {
    return this._lastResult;
  }

  canApply(context: CompactionContext): boolean {
    return context.messages.length >= this.minMessages;
  }

  async apply(context: CompactionContext): Promise<CompactionResult> {
    const { messages } = context;

    try {
      const result = await this.flush(messages as Message[]);
      this._lastResult = result;
    } catch {
      this._lastResult = { extracted: 0, saved: 0, errors: ["flush failed"] };
    }

    // 不修改消息——Flush 只做副作用（持久化），让后续策略继续压缩
    return {
      messages: messages as Message[],
      tokensBefore: 0,
      tokensAfter: 0,
      compacted: false,
    };
  }

  // ─── 核心逻辑 ───

  /**
   * 从消息中提取记忆并保存。
   */
  async flush(messages: readonly Message[]): Promise<FlushResult> {
    const extractionMessages = buildExtractionRequest(messages);
    const rawResponse = await this.callLLM(extractionMessages);
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
        errors.push(`${ext.category}/${ext.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { extracted: extractions.length, saved, errors };
  }

  /**
   * Journal 是追加模式：读取已有内容，在末尾追加新条目。
   */
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

// ─── 辅助函数 ───

/**
 * 构建提取请求：对话历史 + 提取指令作为末尾 user 消息。
 */
function buildExtractionRequest(messages: readonly Message[]): Message[] {
  const conversationMessages = messages.map((m) => ({ ...m }));

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
    if (!["profile", "person", "skill", "journal"].includes(String(obj.category))) return false;
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

export function createMemoryFlushStrategy(config: FlushEngineConfig): MemoryFlushStrategy {
  return new MemoryFlushStrategy(config);
}
