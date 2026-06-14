/**
 * ConversationRepository — Conversation 磁盘 CRUD
 *
 * 纯文件操作，不涉及 SessionRuntime。
 *
 * 磁盘结构：
 *   用户级:        ~/.zhixing/conversations/<safe-id>/meta.json
 *   workscene 级:  ~/.zhixing/workscenes/<sceneId>/conversations/<safe-id>/meta.json
 *
 * delete 物理删除整个 conversation 目录（meta + transcript + view layer state），
 * 不可恢复。force:true 让目录已不存在 / 上次中途崩溃残留 partial 都不抛错。
 * 对齐 WorkSceneRegistry.remove 的"废弃 trash 软删"纪律。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getZhixingHome, toSafePathSegment } from "../paths.js";
import { getWorkSceneConversationsRoot } from "../workscene/paths.js";
import { writeAtomic } from "../transcript/serializer.js";
import type {
  Conversation,
  ConversationScope,
  CreateConversationOptions,
  EnsureConversationOptions,
  IConversationRepository,
  SegmentMeta,
  SegmentMetadata,
  TaskListState,
} from "./types.js";
import {
  DEFAULT_CONVERSATION_ID,
  DEFAULT_CONVERSATION_NAME,
} from "./types.js";

/**
 * Conversation 路径源单一 dispatcher —— 按 scope 解析磁盘根目录。
 *
 * 是 conversation 模块的对外路径源 API：cli / serve 等所有消费者通过此函数取得
 * conversation 根目录，与 ConversationRepository / TranscriptStore 共用同源结果，
 * 杜绝跨模块独立拼接 path 字符串。
 */
export function conversationsDir(scope: ConversationScope): string {
  if (scope.kind === "workscene") return getWorkSceneConversationsRoot(scope.sceneId);
  return path.join(getZhixingHome(), "conversations");
}

function conversationDir(scope: ConversationScope, id: string): string {
  return conversationDirForSegment(scope, toSafePathSegment(id));
}

function conversationDirForSegment(
  scope: ConversationScope,
  pathSegment: string,
): string {
  return path.join(conversationsDir(scope), pathSegment);
}

function metaPath(scope: ConversationScope, id: string): string {
  return path.join(conversationDir(scope, id), "meta.json");
}

function metaPathForSegment(
  scope: ConversationScope,
  pathSegment: string,
): string {
  return path.join(conversationDirForSegment(scope, pathSegment), "meta.json");
}

// ─── ID 生成 ───

function autoChatId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
  return `chat-${date}-${rand}`;
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || autoChatId();
}

const RESERVED_ID_PREFIXES = ["__"];

function isReservedId(id: string): boolean {
  return RESERVED_ID_PREFIXES.some((p) => id.startsWith(p));
}

// ─── ConversationRepository 实现 ───

export class ConversationRepository implements IConversationRepository {
  private readonly scope: ConversationScope;
  /**
   * Per-id meta 写入锁。同 id 的所有 writeMeta FIFO 串行；跨 id 不互斥。
   *
   * 锁尾链 + GC：每次把"当前任务完成后"作为新尾部，settle 后清理过期引用，
   * 防止长寿进程的锁表单调增长。
   */
  private readonly metaLocks = new Map<string, Promise<unknown>>();

  constructor(scope: ConversationScope) {
    this.scope = scope;
  }

  async list(
    opts?: { includeArchived?: boolean },
  ): Promise<Conversation[]> {
    const dir = conversationsDir(this.scope);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return [];
    }

    const conversations: Conversation[] = [];
    for (const entry of entries) {
      const meta = await this.readMetaFromPathSegment(entry);
      if (!meta) continue;
      if (!opts?.includeArchived && meta.archived) continue;
      conversations.push(meta);
    }

    return conversations.sort(
      (a, b) =>
        new Date(b.lastActiveAt).getTime() -
        new Date(a.lastActiveAt).getTime(),
    );
  }

  async get(id: string): Promise<Conversation | null> {
    return this.readMeta(id);
  }

  async create(opts: CreateConversationOptions): Promise<Conversation> {
    const id = opts.name ? await this.ensureUnique(slugify(opts.name)) : autoChatId();
    const now = new Date().toISOString();

    const conversation: Conversation = {
      id,
      name: opts.name ?? id,
      createdAt: now,
      lastActiveAt: now,
      isDefault: false,
      archived: false,
      preferredModel: opts.preferredModel,
      preferredProvider: opts.preferredProvider,
      scope: opts.scope ?? this.scope,
    };

    await this.writeMeta(conversation);
    return conversation;
  }

  async ensure(
    id: string,
    opts: EnsureConversationOptions = {},
  ): Promise<Conversation> {
    return this.withMetaLock(id, async () => {
      const existing = await this.readMetaInLock(id);
      if (existing) return existing;

      const now = new Date().toISOString();
      const isDefault = id === DEFAULT_CONVERSATION_ID;
      const conversation: Conversation = {
        id,
        name: opts.name ?? (isDefault ? DEFAULT_CONVERSATION_NAME : id),
        createdAt: now,
        lastActiveAt: now,
        isDefault,
        archived: false,
        preferredModel: opts.preferredModel,
        preferredProvider: opts.preferredProvider,
        scope: opts.scope ?? this.scope,
      };

      await writeAtomic(
        metaPath(this.scope, id),
        JSON.stringify(conversation, null, 2),
      );
      return conversation;
    });
  }

  async rename(id: string, name: string): Promise<Conversation> {
    const conversation = await this.requireConversation(id);
    conversation.name = name;
    await this.writeMeta(conversation);
    return conversation;
  }

  async archive(id: string, archived: boolean): Promise<Conversation> {
    const conversation = await this.requireConversation(id);
    if (conversation.isDefault && archived) {
      throw new Error("默认对话不可归档");
    }
    conversation.archived = archived;
    await this.writeMeta(conversation);
    return conversation;
  }

  async delete(id: string): Promise<void> {
    await fs.rm(conversationDir(this.scope, id), {
      recursive: true,
      force: true,
    });
  }

  async ensureDefault(): Promise<Conversation> {
    const existing = await this.get(DEFAULT_CONVERSATION_ID);
    if (existing) return existing;

    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: DEFAULT_CONVERSATION_ID,
      name: DEFAULT_CONVERSATION_NAME,
      createdAt: now,
      lastActiveAt: now,
      isDefault: true,
      archived: false,
      scope: this.scope,
    };

    await this.writeMeta(conversation);
    return conversation;
  }

  async touch(id: string): Promise<void> {
    const conversation = await this.requireConversation(id);
    conversation.lastActiveAt = new Date().toISOString();
    await this.writeMeta(conversation);
  }

  async findLatest(): Promise<string | null> {
    const conversations = await this.list();
    return conversations.length > 0 ? conversations[0]!.id : null;
  }

  /**
   * 更新 task_list 持久化状态 —— `task_list.set` 工具落盘路径。
   *
   * 在同一把 per-id 锁内做"读-改字段-写"原子操作；conversation 不存在时
   * no-op（不抛错），与 clearViewLayerState 保持一致。`state=undefined` 时
   * 删除字段，让"清空"语义自然走同一入口。
   */
  async updateTaskListState(
    id: string,
    state: TaskListState | undefined,
  ): Promise<void> {
    return this.withMetaLock(id, async () => {
      const content = await fs
        .readFile(metaPath(this.scope, id), "utf-8")
        .catch(() => null);
      if (content === null) return;
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (state === undefined) {
        delete parsed.taskListState;
      } else {
        parsed.taskListState = state;
      }
      await writeAtomic(
        metaPath(this.scope, id),
        JSON.stringify(parsed, null, 2),
      );
    });
  }

  /**
   * 追加一段段切换元数据 —— 段切换成功后调用。
   *
   * 在同一把 per-id 锁内做"读-合并-写"原子操作；conversation 不存在时 no-op。
   * 首次调用（segmentMetadata 缺失）自动初始化结构。
   */
  async appendSegmentMeta(id: string, meta: SegmentMeta): Promise<void> {
    return this.withMetaLock(id, async () => {
      const content = await fs
        .readFile(metaPath(this.scope, id), "utf-8")
        .catch(() => null);
      if (content === null) return;
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const existing = parsed.segmentMetadata as SegmentMetadata | undefined;
      const prevSegments = existing?.segments ?? [];
      const next: SegmentMetadata = {
        currentSegmentId: meta.segmentId,
        segments: [...prevSegments, meta],
      };
      parsed.segmentMetadata = next;
      await writeAtomic(
        metaPath(this.scope, id),
        JSON.stringify(parsed, null, 2),
      );
    });
  }

  /**
   * 清空视图层状态字段 —— `/clear` 命令路径。
   *
   * 在同一把 per-id 锁内做"读-删字段-写"原子操作；conversation 不存在时 no-op。
   * 身份字段（id / name / scope / preferences 等）保留不动。
   */
  async clearViewLayerState(id: string): Promise<void> {
    return this.withMetaLock(id, async () => {
      const content = await fs
        .readFile(metaPath(this.scope, id), "utf-8")
        .catch(() => null);
      if (content === null) return;
      const parsed = JSON.parse(content) as Record<string, unknown>;
      delete parsed.taskListState;
      delete parsed.segmentMetadata;
      // 顺手清理历史已弃用字段（与 readMeta 内的清理同源）
      delete parsed.capabilityState;
      await writeAtomic(
        metaPath(this.scope, id),
        JSON.stringify(parsed, null, 2),
      );
    });
  }

  // ─── 内部方法 ───

  private async readMeta(id: string): Promise<Conversation | null> {
    // Per-path-segment 锁保护读路径：Windows 原子写在 unlink + rename 之间有瞬态文件不存在窗口，
    // 并发的 readFile 撞上会 ENOENT。读路径走同一把锁，让读看到完整 meta.json，
    // 不会与 writeMeta 的中段步骤竞态。跨 id 读不互斥。
    return this.withMetaLock(id, () => this.readMetaInLock(id));
  }

  private async readMetaFromPathSegment(
    pathSegment: string,
  ): Promise<Conversation | null> {
    return this.withMetaLockForPathSegment(pathSegment, () =>
      this.readMetaFromPathSegmentInLock(pathSegment),
    );
  }

  private async readMetaInLock(id: string): Promise<Conversation | null> {
    try {
      const content = await fs.readFile(metaPath(this.scope, id), "utf-8");
      const parsed = JSON.parse(content) as Conversation &
        Record<string, unknown>;
      // 清理历史已弃用字段 —— writeMeta 会把整个对象 stringify 写回，
      // 不清理则 phantom 字段长期保留在磁盘上；下次 writeMeta 后自然干净。
      delete parsed.capabilityState;
      return parsed;
    } catch {
      return null;
    }
  }

  private async readMetaFromPathSegmentInLock(
    pathSegment: string,
  ): Promise<Conversation | null> {
    try {
      const content = await fs.readFile(
        metaPathForSegment(this.scope, pathSegment),
        "utf-8",
      );
      const parsed = JSON.parse(content) as Conversation &
        Record<string, unknown>;
      // 清理历史已弃用字段 —— writeMeta 会把整个对象 stringify 写回，
      // 不清理则 phantom 字段长期保留在磁盘上；下次 writeMeta 后自然干净。
      delete parsed.capabilityState;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * 原子写 + per-id 锁串行化。
   *
   * 原子性：通过 writeAtomic（tmp + rename，含 Windows fallback）保单文件写入完整，
   * 进程崩溃中点不会留下 corrupted JSON。
   *
   * 串行化：同 id 的多次 writeMeta（rename / archive / touch / 未来的 view-layer
   * state 回写）通过锁尾链 FIFO 排队，保后写覆盖前写而非交叉。跨 id 并发不阻塞。
   */
  private async writeMeta(conversation: Conversation): Promise<void> {
    return this.withMetaLock(conversation.id, async () => {
      await writeAtomic(
        metaPath(this.scope, conversation.id),
        JSON.stringify(conversation, null, 2),
      );
    });
  }

  private async withMetaLock<T>(
    id: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.withMetaLockForPathSegment(toSafePathSegment(id), fn);
  }

  private async withMetaLockForPathSegment<T>(
    pathSegment: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.metaLocks.get(pathSegment) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.metaLocks.set(pathSegment, tail);
    // 过期锁 GC —— 只在当前 tail 仍是末尾时才清
    tail.then(() => {
      if (this.metaLocks.get(pathSegment) === tail) {
        this.metaLocks.delete(pathSegment);
      }
    });
    return result;
  }

  private async requireConversation(id: string): Promise<Conversation> {
    const conversation = await this.readMeta(id);
    if (!conversation) {
      throw new Error(`对话 "${id}" 不存在`);
    }
    return conversation;
  }

  private async ensureUnique(base: string): Promise<string> {
    if (base === DEFAULT_CONVERSATION_ID || isReservedId(base)) {
      return `${base}-1`;
    }
    const existing = await this.get(base);
    if (!existing) return base;

    for (let i = 2; i <= 100; i++) {
      const candidate = `${base}-${i}`;
      const exists = await this.get(candidate);
      if (!exists) return candidate;
    }
    return autoChatId();
  }
}
