/**
 * WorksceneDirectory 的持久层实现 —— 包装 FsWorkSceneRegistry(场景登记)与
 * per-scene ConversationRepository(场景对话域),注入给 @zhixing/server。
 *
 * enter 的执行体:取场景最近对话(场景库已按 lastActiveAt 排序),无则创建;
 * 返回全域键(ws: 前缀)——后续 send / 持久化 / 装配全部由键纯函数派生。
 */

import {
  ConversationRepository,
  worksceneConversationId,
  type IWorkSceneRegistry,
  type WorkScene,
} from "@zhixing/core";
import type { WorksceneDirectory } from "@zhixing/server";

export function createWorksceneDirectory(deps: {
  registry: IWorkSceneRegistry;
}): WorksceneDirectory {
  const { registry } = deps;

  // per-scene enter 串行链——"查最近对话、无则建"的查建窗口在并发 enter 下
  // 会建出两个"当前对话";链式锁把同场景的 enter 串行化(宿主 per-home 单例,
  // 进程内串行即全局串行)。链尾完成后清条目,Map 不随场景数单调增长。
  const enterChains = new Map<string, Promise<unknown>>();

  return {
    list() {
      return registry.list();
    },

    get(id) {
      return registry.get(id);
    },

    create(opts) {
      return registry.add(opts);
    },

    async rename(id, name): Promise<WorkScene | null> {
      try {
        return await registry.rename(id, name);
      } catch {
        // registry 对不存在的场景 throw——目录契约用 null 表达"不存在"
        return null;
      }
    },

    async remove(id): Promise<boolean> {
      const existing = await registry.get(id);
      if (!existing) return false;
      await registry.remove(id);
      return true;
    },

    async touch(id): Promise<void> {
      await registry.touch(id);
    },

    async enterConversation(sceneId) {
      const prev = enterChains.get(sceneId) ?? Promise.resolve();
      const task = prev
        .catch(() => {})
        .then(async () => {
          const scene = await registry.get(sceneId);
          if (!scene) return null;
          const repo = new ConversationRepository({
            kind: "workscene",
            sceneId,
          });
          // 场景库按 lastActiveAt 新→旧排序——首条即"场景当前对话";无则创建
          const existing = await repo.list();
          const local = existing[0] ?? (await repo.create({}));
          return {
            conversationId: worksceneConversationId(sceneId, local.id),
            scene,
          };
        });
      enterChains.set(sceneId, task);
      try {
        return await task;
      } finally {
        if (enterChains.get(sceneId) === task) enterChains.delete(sceneId);
      }
    },
  };
}
