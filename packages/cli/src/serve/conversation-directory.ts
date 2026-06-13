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
  type IConversationRepository,
  type RunRecordWithRef,
} from "@zhixing/core";
import type {
  ConversationDirectory,
  RunsPageCursor,
} from "@zhixing/server";

interface ScopeHandles {
  repo: IConversationRepository;
  transcript: ShardedTranscriptStore;
}

interface ConversationRepoRoute {
  repo: IConversationRepository;
  /** scope 库内的 conversation id。 */
  localId: string;
}

export function createConversationDirectory(deps: {
  repo: ConversationRepository;
  transcript: ShardedTranscriptStore;
  /**
   * task_list 进程内 cache 的清理钩子(可选)——clear 抹掉 meta 里的
   * task_list 盘上状态,cache 与盘是同一数据的两层,在同一实现点维护一致性。
   */
  clearTaskListCache?: (conversationId: string) => void;
  /**
   * 宿主级 repo 路由(可选)——task_list store 与目录 clear 共用同一 repo 实例,
   * 保证同一 meta.json 的并发写不会因各自 new repository 绕开 per-id 锁。
   */
  repoForConversationId?: (conversationId: string) => ConversationRepoRoute;
}): ConversationDirectory {
  const sceneHandles = new Map<string, ScopeHandles>();

  const handlesFor = (conversationId: string): ScopeHandles & { localId: string } => {
    const routed = deps.repoForConversationId?.(conversationId);
    const { scope, localId } = parseConversationId(conversationId);
    if (scope.kind === "workscene") {
      let entry = sceneHandles.get(scope.sceneId);
      if (!entry) {
        entry = {
          repo: routed?.repo ?? new ConversationRepository(scope as ConversationScope),
          transcript: new ShardedTranscriptStore(conversationsDir(scope)),
        };
        sceneHandles.set(scope.sceneId, entry);
      }
      return { ...entry, localId: routed?.localId ?? localId };
    }
    return {
      repo: routed?.repo ?? deps.repo,
      transcript: deps.transcript,
      localId: routed?.localId ?? localId,
    };
  };

  return {
    list() {
      return deps.repo.list();
    },

    async exists(id): Promise<boolean> {
      const h = handlesFor(id);
      return (await h.repo.get(h.localId)) !== null;
    },

    async create(): Promise<Conversation> {
      // user 域新对话:meta + transcript 壳一并建——身份即刻进列表
      const created = await deps.repo.create({});
      await deps.transcript.init(created.id);
      return created;
    },

    async touch(id): Promise<Conversation | null> {
      const h = handlesFor(id);
      try {
        await h.repo.touch(h.localId);
        return await h.repo.get(h.localId);
      } catch {
        return null;
      }
    },

    async clear(id): Promise<boolean> {
      const h = handlesFor(id);
      const existing = await h.repo.get(h.localId);
      if (!existing) return false;
      // 先 transcript clear 事件(倒读边界),后 meta 视图层清理——任一失败
      // 即中止,调用方收到错误、不发 cleared 通知
      await h.transcript.appendClear(h.localId);
      await h.repo.clearViewLayerState(h.localId);
      deps.clearTaskListCache?.(id);
      return true;
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
