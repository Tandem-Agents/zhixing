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
import { getZhixingHome } from "../paths.js";
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
  return path.join(conversationsDir(scope), id);
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

  // ─── 内部方法 ───

  private async readMeta(id: string): Promise<Conversation | null> {
    try {
      const content = await fs.readFile(metaPath(this.scope, id), "utf-8");
      return JSON.parse(content) as Conversation;
    } catch {
      return null;
    }
  }

  private async writeMeta(conversation: Conversation): Promise<void> {
    const dir = conversationDir(this.scope, conversation.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      metaPath(this.scope, conversation.id),
      JSON.stringify(conversation, null, 2),
      "utf-8",
    );
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
