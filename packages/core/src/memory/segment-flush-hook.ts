/**
 * 记忆提取的段切换挂载 —— 内容即将离开注意力窗口（被摘要替代）之时，正是
 * 从原文蒸馏长期记忆的自然时刻。
 *
 * 挂 afterSummarize 由失败语义决定：段切换成功才提取（不为失败的切段白花
 * 提取成本）；hook 抛错由段管理器降级 warning 继续——记忆提取失败绝不
 * 陪葬段切换。被摘段原文经 ctx.messages 交付（hook 看不到也不需要全量窗口）。
 *
 * ephemeral 段切换同样触发：记忆是用户域资产，与对话域持久化差分无关。
 */

import type { SegmentTransitionHook } from "../context/segment/types.js";
import type { MemoryFlusher } from "./flush-engine.js";

export interface MemoryFlushHookConfig {
  readonly flusher: MemoryFlusher;
  /** 被摘段少于该消息数不值得花一次提取 LLM 调用（默认 6） */
  readonly minMessages?: number;
}

export function createMemoryFlushHook(
  config: MemoryFlushHookConfig,
): SegmentTransitionHook {
  const minMessages = config.minMessages ?? 6;
  return {
    async afterSummarize(ctx) {
      if (ctx.messages.length < minMessages) return;
      await config.flusher.flush(ctx.messages, {
        abortSignal: ctx.abortSignal,
      });
    },
  };
}
