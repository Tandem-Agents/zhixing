/**
 * Per-Turn 上下文注入
 *
 * 规格引用：turn-context-injection.md
 *
 * 设计原则：
 * - 每轮 user message 前注入动态上下文（<turn-context> 标签）
 * - 不修改 system prompt，保护 prompt cache
 * - Provider 按需注入：shouldInject() 返回 false 时整段跳过，节省 token
 * - 可组合：注册 provider 即可扩展，无需改注入管道
 */

import type { Message, TextBlock } from "../types/messages.js";
import type { TaskStatusSummary } from "../scheduler/types.js";
import type { TaskItem } from "../conversation/types.js";

// ─── Provider 接口 ───

/** Provider 渲染输出 */
export interface TurnContextSection {
  readonly title: string;
  readonly body: string;
}

/**
 * Turn Context Provider — 提供 per-turn 动态上下文段落。
 *
 * 实现者在构造时捕获依赖（scheduler 引用、时区等），
 * render() 零参数，每次调用返回当前状态快照。
 */
export interface TurnContextProvider {
  readonly id: string;
  shouldInject(): boolean;
  render(): TurnContextSection;
}

// ─── TimeProvider ───

export class TimeProvider implements TurnContextProvider {
  readonly id = "time";

  constructor(private readonly timezone: string) {}

  shouldInject(): boolean {
    return true;
  }

  render(): TurnContextSection {
    const now = new Date();
    const formatted = now.toLocaleString("zh-CN", {
      timeZone: this.timezone,
      dateStyle: "full",
      timeStyle: "medium",
    });
    return {
      title: "当前时间",
      body: `${formatted} (${this.timezone})`,
    };
  }
}

// ─── SchedulerProvider ───

export interface SchedulerProviderOptions {
  /** 活跃任务最大显示数（默认 10） */
  maxActive?: number;
  /** 最近完成最大显示数（默认 5） */
  maxRecentlyCompleted?: number;
  /** 最近失败最大显示数（默认 3） */
  maxRecentlyFailed?: number;
}

export class SchedulerProvider implements TurnContextProvider {
  readonly id = "scheduler";

  private readonly maxActive: number;
  private readonly maxRecentlyCompleted: number;
  private readonly maxRecentlyFailed: number;

  constructor(
    private readonly getStatus: () => TaskStatusSummary,
    options: SchedulerProviderOptions = {},
  ) {
    this.maxActive = options.maxActive ?? 10;
    this.maxRecentlyCompleted = options.maxRecentlyCompleted ?? 5;
    this.maxRecentlyFailed = options.maxRecentlyFailed ?? 3;
  }

  shouldInject(): boolean {
    const s = this.getStatus();
    return (
      s.active.length > 0 ||
      s.recentlyCompleted.length > 0 ||
      s.recentlyFailed.length > 0
    );
  }

  render(): TurnContextSection {
    const s = this.getStatus();
    const parts: string[] = [];

    // 概览行（始终显示总数，即使被截断）
    const counts: string[] = [];
    if (s.active.length > 0) counts.push(`${s.active.length} 个活跃`);
    if (s.recentlyCompleted.length > 0)
      counts.push(`${s.recentlyCompleted.length} 个最近完成`);
    if (s.recentlyFailed.length > 0)
      counts.push(`${s.recentlyFailed.length} 个最近失败`);
    parts.push(counts.join(" · "));

    // 活跃任务
    const activeSlice = s.active.slice(0, this.maxActive);
    for (const t of activeSlice) {
      const next = t.nextRunAt ? `，下次 ${formatTime(t.nextRunAt)}` : "";
      parts.push(`- ⏳ "${t.name}" — ${t.schedule}${next}`);
    }
    if (s.active.length > this.maxActive) {
      parts.push(
        `- ... 还有 ${s.active.length - this.maxActive} 个活跃任务`,
      );
    }

    // 最近完成
    const completedSlice = s.recentlyCompleted.slice(
      0,
      this.maxRecentlyCompleted,
    );
    for (const t of completedSlice) {
      const delivery = t.delivered ? "，结果已发送" : "";
      const summary = t.summary ? ` (${t.summary})` : "";
      parts.push(
        `- ✅ "${t.name}" — 完成于 ${formatTime(t.completedAt)}${summary}${delivery}`,
      );
    }
    if (s.recentlyCompleted.length > this.maxRecentlyCompleted) {
      parts.push(
        `- ... 还有 ${s.recentlyCompleted.length - this.maxRecentlyCompleted} 个最近完成`,
      );
    }

    // 最近失败
    const failedSlice = s.recentlyFailed.slice(0, this.maxRecentlyFailed);
    for (const t of failedSlice) {
      parts.push(
        `- ❌ "${t.name}" — 失败于 ${formatTime(t.failedAt)}: ${t.error}`,
      );
    }

    return {
      title: "定时任务（仅在用户主动询问任务相关话题时提及，不要主动提起）",
      body: parts.join("\n"),
    };
  }
}

// ─── TaskListProvider ───

/**
 * task_list 当前状态注入 —— 让 LLM 在每个 turn 都能看到当前的"已规划任务列表"。
 *
 * 为什么需要 turn-context 而不是其他方案：
 *   - LLM 通过 task_list.set 工具维护列表；set 调用记录在 transcript 中
 *   - 段切换会压缩老 turns —— 老的 set 调用从 LLM 视野中消失
 *   - 没有 turn-context 注入时，LLM 在新段开始时**不知道** task_list state 存在，
 *     可能调 set 用新列表完全覆盖（擦写已有任务）
 *   - turn-context 每个 turn 重新注入当前 state，让 LLM 始终能"读到"
 *   - 段切换 cache-safe 路径走 `skipTurnContext: true` 跳过整个 inject，本 provider
 *     自然不会被调用 —— 不影响段切换的 byte-equal 不变量
 *
 * 依赖反转：构造时只接受 `() => readonly TaskItem[]` 闭包，不耦合任何具体上下文
 * 获取方式（ALS / 显式参数 / cache 等）。装配方（cli session）决定如何取数据。
 *
 * 空列表行为：getItems 返回空数组时 `shouldInject` 返回 false，整段跳过 ——
 * **没有任务不污染 turn-context**（与 SchedulerProvider 同协议）。
 * 这也是 ephemeral 路径（无 conversation 绑定）的自然降级：装配方在 ALS
 * 无 conversationId 时让 getItems 返回 []，整段消失。
 */
export class TaskListProvider implements TurnContextProvider {
  readonly id = "task-list";

  constructor(private readonly getItems: () => readonly TaskItem[]) {}

  shouldInject(): boolean {
    return this.getItems().length > 0;
  }

  render(): TurnContextSection {
    const items = this.getItems();
    const lines = items.map((t, i) => {
      const mark =
        t.status === "completed"
          ? "[x]"
          : t.status === "in_progress"
            ? "[~]"
            : "[ ]";
      return `${i + 1}. ${mark} ${t.content}`;
    });
    return {
      title: "当前任务列表（你已通过 task_list 工具维护的计划，set 时请保留历史项）",
      body: lines.join("\n"),
    };
  }
}

function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return isoString;
  }
}

// ─── TurnContextInjector ───

const TURN_CONTEXT_TAG = "<turn-context>";
const TURN_CONTEXT_TAG_END = "</turn-context>";

export class TurnContextInjector {
  private readonly providers: TurnContextProvider[] = [];

  register(provider: TurnContextProvider): this {
    this.providers.push(provider);
    return this;
  }

  /**
   * 构建 <turn-context> 块。
   * 无活跃 provider 时返回 null（不注入空标签）。
   */
  build(): string | null {
    const sections: TurnContextSection[] = [];
    for (const p of this.providers) {
      if (p.shouldInject()) {
        sections.push(p.render());
      }
    }
    if (sections.length === 0) return null;

    const body = sections.map((s) => `[${s.title}] ${s.body}`).join("\n");
    return `${TURN_CONTEXT_TAG}\n${body}\n${TURN_CONTEXT_TAG_END}`;
  }

  /**
   * 将 turn context 注入到消息列表的最新 user message 前。
   * 不修改原数组，返回浅拷贝。
   * 已包含 <turn-context> 的消息会被替换（防止重复注入）。
   *
   * `opts.skipTurnContext=true` 短路返回原 messages 的浅拷贝：用于"缓存安全
   * 分叉"格式的特殊请求路径（段切换压缩请求等）—— 这些路径要求 messages 与
   * 上一轮 byte-equal（不剥离旧 turn-context 块、不注入新块），保 prefix cache
   * 在两轮请求间继续命中。
   */
  inject(
    messages: readonly Message[],
    opts?: { skipTurnContext?: boolean },
  ): Message[] {
    if (opts?.skipTurnContext) return [...messages];

    const block = this.build();
    if (!block) return [...messages];

    const result = [...messages];
    const lastUserIdx = findLastUserIndex(result);
    if (lastUserIdx === -1) return result;

    const lastUser = result[lastUserIdx]!;
    const currentText = extractFirstText(lastUser);

    // 去掉旧的 turn-context（如果有），防止多次 run() 重复注入
    const cleanText = stripTurnContext(currentText);
    const injectedText = `${block}\n\n${cleanText}`;
    result[lastUserIdx] = replaceFirstText(lastUser, injectedText);

    return result;
  }
}

// ─── Message 操作辅助 ───

function findLastUserIndex(messages: readonly Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return i;
  }
  return -1;
}

function extractFirstText(message: Message): string {
  const textBlock = message.content.find(
    (b): b is TextBlock => b.type === "text",
  );
  return textBlock?.text ?? "";
}

function replaceFirstText(message: Message, newText: string): Message {
  const hasText = message.content.some((b) => b.type === "text");

  if (!hasText) {
    return {
      ...message,
      content: [{ type: "text" as const, text: newText }, ...message.content],
    };
  }

  let replaced = false;
  const newContent = message.content.map((block) => {
    if (block.type === "text" && !replaced) {
      replaced = true;
      return { ...block, text: newText };
    }
    return block;
  });

  return { ...message, content: newContent };
}

/**
 * 去除已注入的 <turn-context>...</turn-context> 块。
 * 防止多次 inject() 导致重复注入。
 */
function stripTurnContext(text: string): string {
  const startIdx = text.indexOf(TURN_CONTEXT_TAG);
  if (startIdx === -1) return text;
  const endIdx = text.indexOf(TURN_CONTEXT_TAG_END);
  if (endIdx === -1) return text;

  const before = text.slice(0, startIdx);
  const after = text.slice(endIdx + TURN_CONTEXT_TAG_END.length);
  return (before + after).replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
}
