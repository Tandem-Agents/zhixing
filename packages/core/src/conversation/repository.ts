/**
 * ConversationRepository — Conversation 磁盘 CRUD
 *
 * 对应 conversation-model.md §12.1。纯文件操作，不涉及 SessionRuntime。
 *
 * 磁盘结构：
 *   用户级:  ~/.zhixing/conversations/<id>/meta.json
 *   项目级:  ~/.zhixing/projects/<projectId>/conversations/<id>/meta.json
 *
 * delete 走回收站（~/.zhixing/trash/<id>-<ts>/），7 天后由外部清理。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getZhixingHome, toSafePathSegment } from "../paths.js";
import { writeAtomic } from "../transcript/serializer.js";
import type {
  Conversation,
  ConversationScope,
  CreateConversationOptions,
  IConversationRepository,
} from "./types.js";
import {
  DEFAULT_CONVERSATION_ID,
  DEFAULT_CONVERSATION_NAME,
} from "./types.js";

function conversationsDir(scope: ConversationScope): string {
  const home = getZhixingHome();
  if (scope.kind === "project") {
    return path.join(home, "projects", scope.projectId, "conversations");
  }
  return path.join(home, "conversations");
}

function conversationDir(scope: ConversationScope, id: string): string {
  return path.join(conversationsDir(scope), toSafePathSegment(id));
}

function metaPath(scope: ConversationScope, id: string): string {
  return path.join(conversationDir(scope, id), "meta.json");
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
      const meta = await this.readMeta(entry);
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
    const conversation = await this.requireConversation(id);
    if (conversation.isDefault) {
      throw new Error("默认对话不可删除");
    }

    const srcDir = conversationDir(this.scope, id);
    const trashDir = path.join(
      getZhixingHome(),
      "trash",
      `${id}-${Date.now()}`,
    );
    await fs.mkdir(path.dirname(trashDir), { recursive: true });
    await fs.rename(srcDir, trashDir);
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
    // Per-id 锁保护读路径：Windows 原子写在 unlink + rename 之间有瞬态文件不存在窗口，
    // 并发的 readFile 撞上会 ENOENT。读路径走同一把锁，让读看到完整 meta.json，
    // 不会与 writeMeta 的中段步骤竞态。跨 id 读不互斥。
    return this.withMetaLock(id, async () => {
      try {
        const content = await fs.readFile(metaPath(this.scope, id), "utf-8");
        const parsed = JSON.parse(content) as Conversation &
          Record<string, unknown>;
        // 清理历史已弃用字段 —— writeMeta 会把整个对象 stringify 写回，
        // 不清理则 phantom 字段长期保留在磁盘上；下次 commitTurn 后自然干净。
        delete parsed.capabilityState;
        return parsed;
      } catch {
        return null;
      }
    });
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
    const prev = this.metaLocks.get(id) ?? Promise.resolve();
    const result = prev.then(fn);
    const tail = result.then(
      () => {},
      () => {},
    );
    this.metaLocks.set(id, tail);
    // 过期锁 GC —— 只在当前 tail 仍是末尾时才清
    tail.then(() => {
      if (this.metaLocks.get(id) === tail) {
        this.metaLocks.delete(id);
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
