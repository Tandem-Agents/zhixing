/**
 * SegmentPersistence 默认实现 —— segmentMetadata 累积写入。
 *
 * 接口隔离：本模块只依赖狭义 `ConversationSegmentRepo`（仅 appendSegmentMeta
 * 一个方法）而不是完整的 `IConversationRepository`，让测试 mock 简单、
 * 未来换实现成本低。真实 IConversationRepository 结构兼容。
 *
 * 不承担 transcript marker 写入 —— marker 走"emit segment:new_started → orchestrator
 * accumulator → run-agent 单点 commitTurn"路径，与本 turn 的 transcript 写入是同一
 * 原子事务，整个 run 内 transcript 写入收敛到唯一路径（与 LLMSummarize 同模式）。
 */

import type { SegmentMeta } from "../../conversation/types.js";
import type { SegmentPersistence } from "./types.js";

/**
 * Conversation repository 侧写入路径的狭义视图 —— 仅段切换 segmentMeta
 * 累积所需的入口。真实 `IConversationRepository` 结构兼容。
 */
export interface ConversationSegmentRepo {
  appendSegmentMeta(id: string, meta: SegmentMeta): Promise<void>;
}

export interface SegmentPersistenceDeps {
  readonly conversationRepo: ConversationSegmentRepo;
}

export function createSegmentPersistence(
  deps: SegmentPersistenceDeps,
): SegmentPersistence {
  return {
    async appendSegment(conversationId, meta) {
      await deps.conversationRepo.appendSegmentMeta(conversationId, meta);
    },
  };
}
