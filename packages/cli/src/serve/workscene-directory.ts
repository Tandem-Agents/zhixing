/**
 * WorksceneDirectory 的持久层实现 —— 包装 FsWorkSceneRegistry(场景登记)与
 * per-scene ConversationRepository(场景对话域),注入给 @zhixing/server。
 *
 * enter 的执行体:取场景最近对话(场景库已按 lastActiveAt 排序),无则创建;
 * 返回全域键(ws: 前缀)——后续 send / 持久化 / 装配全部由键纯函数派生。
 */

import {
  ConversationRepository,
  normalizeSceneName,
  normalizeWorkdir,
  probeWorkdir,
  WORKSCENE_CONVERSATION_PREFIX,
  worksceneConversationId,
  type IWorkSceneRegistry,
  type WorkScene,
} from "@zhixing/core";
import {
  type ConversationManager,
  type WorksceneDirectory,
  type WorksceneWriteResult,
} from "@zhixing/server";
import { isAbsolute } from "node:path";

export function createWorksceneDirectory(deps: {
  registry: IWorkSceneRegistry;
  conversations?: () => ConversationManager | null;
}): WorksceneDirectory {
  const { registry } = deps;

  const sceneChains = new Map<string, Promise<unknown>>();

  function inputError(message: string): Error {
    return Object.assign(new Error(message), {
      name: "WorksceneInputError",
      code: "WORKSCENE_INPUT",
    });
  }

  function coerceInputError(err: unknown): Error {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as Error & { code?: unknown }).code === "WORKSCENE_INPUT"
    ) {
      return err;
    }
    return inputError(err instanceof Error ? err.message : String(err));
  }

  function busyError(message: string): Error {
    return Object.assign(new Error(message), {
      name: "WorksceneBusyError",
      code: "WORKSCENE_BUSY",
    });
  }

  function isMissingSceneError(err: unknown, sceneId: string): boolean {
    return (
      err instanceof Error &&
      err.message.includes(`工作场景 "${sceneId}" 不存在`)
    );
  }

  function sceneConversationPrefix(sceneId: string): string {
    return `${WORKSCENE_CONVERSATION_PREFIX}${sceneId}:`;
  }

  function validateSceneName(input: string): string {
    try {
      return normalizeSceneName(input);
    } catch (err) {
      throw coerceInputError(err);
    }
  }

  function runSceneOperation<T>(sceneId: string, fn: () => Promise<T>): Promise<T> {
    const prev = sceneChains.get(sceneId) ?? Promise.resolve();
    const task = prev.catch(() => {}).then(fn);
    sceneChains.set(sceneId, task);
    const cleanup = () => {
      if (sceneChains.get(sceneId) === task) sceneChains.delete(sceneId);
    };
    void task.then(cleanup, cleanup);
    return task;
  }

  async function validateWorkdir(
    input: string,
  ): Promise<{ workdir: string; warning?: string }> {
    let workdir: string;
    try {
      workdir = normalizeWorkdir(input);
    } catch (err) {
      throw coerceInputError(err);
    }
    if (!isAbsolute(workdir)) {
      throw inputError("工作目录必须是绝对路径");
    }
    const probe = await probeWorkdir(workdir);
    switch (probe.kind) {
      case "directory":
        return { workdir };
      case "missing":
        return {
          workdir,
          warning: `工作目录当前不存在，下次进入将自动创建：${workdir}`,
        };
      case "non_directory":
        throw inputError("工作目录已存在但不是目录");
      case "inaccessible":
        throw inputError(`工作目录不可访问(${probe.code})`);
      case "error":
        throw inputError(`工作目录无法确认(${probe.code})`);
    }
  }

  async function quiesceScene(sceneId: string): Promise<() => void> {
    const manager = deps.conversations?.();
    if (!manager) return () => {};
    return await manager.quiescePrefix(sceneConversationPrefix(sceneId));
  }

  return {
    list() {
      return registry.list();
    },

    get(id) {
      return registry.get(id);
    },

    async create(opts): Promise<WorksceneWriteResult> {
      const name = validateSceneName(opts.name);
      const validated =
        opts.workdir === undefined ? undefined : await validateWorkdir(opts.workdir);
      const scene = await registry.add({
        name,
        workdir: validated?.workdir,
      });
      return {
        scene,
        ...(validated?.warning ? { workdirWarning: validated.warning } : {}),
      };
    },

    async rename(id, name): Promise<WorkScene | null> {
      try {
        return await registry.rename(id, validateSceneName(name));
      } catch (err) {
        // registry 对不存在的场景 throw——目录契约用 null 表达"不存在"
        if (!isMissingSceneError(err, id)) throw err;
        return null;
      }
    },

    async setWorkdir(id, workdir): Promise<WorksceneWriteResult | null> {
      return await runSceneOperation(id, async () => {
        const validated = workdir === null ? null : await validateWorkdir(workdir);
        const existing = await registry.get(id);
        if (!existing) return null;

        const release = await quiesceScene(id);
        try {
          const scene = await registry.setWorkdir(id, validated?.workdir ?? null);
          return {
            scene,
            ...(validated?.warning ? { workdirWarning: validated.warning } : {}),
          };
        } catch (err) {
          if (!isMissingSceneError(err, id)) throw err;
          return null;
        } finally {
          release();
        }
      });
    },

    async remove(id): Promise<boolean> {
      return await runSceneOperation(id, async () => {
        const existing = await registry.get(id);
        if (!existing) return false;

        const release = await quiesceScene(id);
        try {
          await registry.remove(id);
          return true;
        } finally {
          release();
        }
      });
    },

    async touch(id): Promise<void> {
      await registry.touch(id);
    },

    async enterScene(sceneId, observerId, opts) {
      return await runSceneOperation(sceneId, async () => {
        const scene = await registry.get(sceneId);
        if (!scene) return null;
        const repo = new ConversationRepository({
          kind: "workscene",
          sceneId,
        });
        // 场景库按 lastActiveAt 新→旧排序——首条即"场景当前对话";无则创建。
        const existing = await repo.list();
        const local = existing[0] ?? (await repo.create({}));
        const conversationId = worksceneConversationId(sceneId, local.id);

        const manager = deps.conversations?.();
        if (manager) {
          const registered = manager.addObserver(conversationId, observerId, {
            allowInactive: true,
          });
          if (!registered) {
            throw busyError(`Workscene ${sceneId} is being changed; try again later`);
          }
        }

        if (opts?.touch !== false) {
          await registry.touch(sceneId).catch(() => {});
        }
        return {
          conversationId,
          scene,
        };
      });
    },
  };
}
