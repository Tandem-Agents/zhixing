/**
 * ConversationDirectory 的持久层适配 —— 包装有限 meta 与 transcript 端口,
 * 供 Anchor Conversation
 * application、Correctness adapter 与尚待归位的本机 lifecycle 消费。
 *
 * scope 路由:对话归属编码在全域键里(ws: 前缀 = 场景对话)——rename / remove /
 * readRunsReverse 按键解析落对应库;list 保持 user scope(场景是独立工作台,
 * main 列表不混场景对话)。场景库句柄惰性建、按 sceneId 缓存。
 */

import { parseConversationId, type Conversation, type ConversationRevealIntent, type IConversationRepository } from "@zhixing/core/conversation";
import { readRunsReverse, type RunRecordWithRef, type TranscriptReadSource } from "@zhixing/core/transcript";
import type {
  ConversationClearProjectionPort,
  ConversationDirectoryStorage,
  ConversationIdentityLifecycleMechanism,
  ConversationShellOptions,
} from "@zhixing/core/conversation/application";
import type { WorksceneConversationStorageRemovalPort } from "./workscene-storage-removal.js";

interface ConversationDirectoryTranscriptPort extends TranscriptReadSource {
  exists(conversationId: string): Promise<boolean>;
  init(conversationId: string): Promise<void>;
  appendClear(conversationId: string): Promise<void>;
  /** 会话目录被删除后丢弃打开态缓存 */
  forget(conversationId: string): Promise<void>;
}

interface ScopeHandles {
  repo: IConversationRepository;
  transcript: ConversationDirectoryTranscriptPort;
}

export function createConversationDirectory(deps: {
  user: ScopeHandles;
  routeConversation(conversationId: string): ScopeHandles & {
    readonly localId: string;
  };
  worksceneConversationStorageRemoval: WorksceneConversationStorageRemovalPort;
  /**
   * task_list 进程内 cache 的清理钩子(可选)——clear 抹掉 meta 里的
   * task_list 盘上状态,cache 与盘是同一数据的两层,在同一实现点维护一致性。
   */
  clearTaskListCache?: (conversationId: string) => void;
}): ConversationDirectoryStorage &
  Pick<ConversationIdentityLifecycleMechanism, "exists" | "ensureTranscript"> &
  Pick<ConversationClearProjectionPort, "clearStoredView"> & {
    ensure(id: string, options?: ConversationShellOptions): Promise<Conversation>;
    reveal(id: string): Promise<void>;
    beginReveal(id: string, intent: ConversationRevealIntent): Promise<boolean>;
    abandonReveal(id: string, intent: ConversationRevealIntent): Promise<void>;
    listRevealIntents(): Promise<readonly { readonly conversationId: string; readonly intent: ConversationRevealIntent }[]>;
    touch(id: string, at?: string): Promise<Conversation | null>;
    deleteStoredConversation(conversationId: string): Promise<boolean>;
    /** Temporary read-only Advancement recovery bridge; it shares the same storage primitive. */
    readRunsReverse: ConversationDirectoryStorage["readHistory"];
    listForAdvancement(): Promise<readonly Conversation[]>;
  } {
  const handlesFor = deps.routeConversation;

  const readHistory: ConversationDirectoryStorage["readHistory"] = async (
    id,
    opts,
  ) => {
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
  };

  return {
    async list() {
      return (await deps.user.repo.list()).map((item) => ({
        conversationId: item.id,
        name: item.name,
        createdAt: item.createdAt,
        lastActiveAt: item.lastActiveAt,
      }));
    },
    ...(deps.user.repo.listPage ? { async listPage(page: import('@zhixing/core/conversation/application').ConversationDirectoryPageRequest) {
      const result = await deps.user.repo.listPage!(page);
      return { records: result.records.map(item => ({ conversationId: item.id, name: item.name, createdAt: item.createdAt, lastActiveAt: item.lastActiveAt })), next: result.next };
    } } : {}),
    listForAdvancement() {
      // 恢复是责任型读取：只为失败回执而建的会话同样要看到
      return deps.user.repo.list({ includeHidden: true });
    },

    async exists(id): Promise<boolean> {
      const h = handlesFor(id);
      return (
        (await h.repo.get(h.localId)) !== null ||
        (await h.transcript.exists(h.localId))
      );
    },

    async create() {
      // user 域新对话:meta + transcript 壳一并建——身份即刻进列表
      const created = await deps.user.repo.create({});
      await deps.user.transcript.init(created.id);
      return {
        conversationId: created.id,
        name: created.name,
        createdAt: created.createdAt,
        lastActiveAt: created.lastActiveAt,
      };
    },

    async ensure(id, options): Promise<Conversation> {
      const h = handlesFor(id);
      const { scope } = parseConversationId(id);
      const ensured = await h.repo.ensure(h.localId, { scope, ...(options?.createdFor ? { createdFor: options.createdFor } : {}) });
      await h.transcript.init(h.localId);
      return ensured;
    },

    async reveal(id): Promise<void> {
      const h = handlesFor(id);
      await h.repo.reveal(h.localId);
    },

    async beginReveal(id, intent): Promise<boolean> {
      const h = handlesFor(id);
      return h.repo.beginReveal(h.localId, intent);
    },

    async abandonReveal(id, intent): Promise<void> {
      const h = handlesFor(id);
      await h.repo.abandonReveal(h.localId, intent);
    },

    async listRevealIntents() {
      // 只为失败回执而建的会话都在用户区（不带会话 id 的发送）；按索引单独取等待复核的条目
      return (await deps.user.repo.listRevealIntents()).flatMap(value =>
        value.revealIntent ? [{ conversationId: value.id, intent: value.revealIntent }] : []);
    },

    async ensureTranscript(id): Promise<void> {
      const h = handlesFor(id);
      await h.transcript.init(h.localId);
    },

    async touch(id, at): Promise<Conversation | null> {
      const h = handlesFor(id);
      try {
        await h.repo.touch(h.localId, at);
        return await h.repo.get(h.localId);
      } catch {
        return null;
      }
    },

    async clearStoredView(id): Promise<boolean> {
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

    async rename(id, name) {
      const h = handlesFor(id);
      try {
        const renamed = await h.repo.rename(h.localId, name);
        return {
          conversationId: id,
          name: renamed.name,
          createdAt: renamed.createdAt,
          lastActiveAt: renamed.lastActiveAt,
        };
      } catch {
        // repo 对不存在的对话 throw——目录契约用 null 表达"不存在"
        return null;
      }
    },

    async deleteStoredConversation(id): Promise<boolean> {
      const h = handlesFor(id);
      const { scope } = parseConversationId(id);
      const existing =
        (await h.repo.get(h.localId)) !== null ||
        (await h.transcript.exists(h.localId));
      if (scope.kind === "workscene") {
        await deps.worksceneConversationStorageRemoval.removeConversation(
          scope.sceneId,
          h.localId,
        );
        await h.transcript.forget(h.localId);
        return existing;
      }
      if (!existing) return false;
      await h.repo.delete(h.localId);
      // 目录已删：丢弃转录的打开态缓存，同 id 重建时从磁盘重新打开
      await h.transcript.forget(h.localId);
      return true;
    },

    readHistory,
    readRunsReverse: readHistory,
  };
}
