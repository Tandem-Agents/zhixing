/**
 * ConversationDirectory 的持久层实现 —— 包装 ConversationRepository(meta 清单 /
 * 改名 / 删除)与 ShardedTranscriptStore 的倒读通道,注入给 @zhixing/server。
 *
 * scope 路由:对话归属编码在全域键里(ws: 前缀 = 场景对话)——rename / remove /
 * readRunsReverse 按键解析落对应库;list 保持 user scope(场景是独立工作台,
 * main 列表不混场景对话)。场景库句柄惰性建、按 sceneId 缓存。
 */

import {
  ConversationRepository,
  ShardedTranscriptStore,
  conversationsDir,
  parseConversationId,
  readRunsReverse,
  type Conversation,
  type ConversationScope,
  type RunRecordWithRef,
} from "@zhixing/core";
import type {
  ConversationDirectory,
  RunsPageCursor,
} from "@zhixing/server";

interface ScopeHandles {
  repo: ConversationRepository;
  transcript: ShardedTranscriptStore;
}

export function createConversationDirectory(deps: {
  repo: ConversationRepository;
  transcript: ShardedTranscriptStore;
}): ConversationDirectory {
  const sceneHandles = new Map<string, ScopeHandles>();

  const handlesFor = (conversationId: string): ScopeHandles & { localId: string } => {
    const { scope, localId } = parseConversationId(conversationId);
    if (scope.kind === "workscene") {
      let entry = sceneHandles.get(scope.sceneId);
      if (!entry) {
        entry = {
          repo: new ConversationRepository(scope as ConversationScope),
          transcript: new ShardedTranscriptStore(conversationsDir(scope)),
        };
        sceneHandles.set(scope.sceneId, entry);
      }
      return { ...entry, localId };
    }
    return { repo: deps.repo, transcript: deps.transcript, localId: conversationId };
  };

  return {
    list() {
      return deps.repo.list();
    },

    async rename(id, name): Promise<Conversation | null> {
      const h = handlesFor(id);
      try {
        return await h.repo.rename(h.localId, name);
      } catch {
        // repo 对不存在的对话 throw——目录契约用 null 表达"不存在"
        return null;
      }
    },

    async remove(id): Promise<boolean> {
      const h = handlesFor(id);
      const existing = await h.repo.get(h.localId);
      if (!existing) return false;
      await h.repo.delete(h.localId);
      return true;
    },

    async readRunsReverse(
      id,
      opts: { limit: number; before?: RunsPageCursor },
    ) {
      const h = handlesFor(id);
      // 多读一条探测 hasMore——倒读生成器跨分片续读、读容错自愈
      const runs: RunRecordWithRef[] = [];
      let hasMore = false;
      for await (const item of readRunsReverse(h.transcript, h.localId, {
        before: opts.before,
      })) {
        if (runs.length >= opts.limit) {
          hasMore = true;
          break;
        }
        runs.push(item);
      }
      return { runs, hasMore };
    },
  };
}
