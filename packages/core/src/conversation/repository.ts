import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { toSafePathSegment } from '../paths.js';
import { getWorkSceneConversationsRoot } from '../workscene/paths.js';
import { ensureDurableDirectory, replaceFile, syncDirectory, durablyRemoveFile } from '../persistence/index.js';
import { ConversationDirectoryIndex } from './directory-index.js';
import type { ConversationDirectoryPageRequest } from './directory-page.js';
import type { Conversation, ConversationScope, CreateConversationOptions, EnsureConversationOptions,
  IConversationRepository, SegmentMeta, SegmentMetadata, TaskListState } from './types.js';
import { DEFAULT_CONVERSATION_ID, DEFAULT_CONVERSATION_NAME } from './types.js';

export function conversationsDir(scope: ConversationScope, zhixingHome: string): string {
  return scope.kind === 'workscene' ? getWorkSceneConversationsRoot(scope.sceneId, zhixingHome) : path.join(zhixingHome, 'conversations');
}
function autoChatId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `chat-${date}-${Math.random().toString(16).slice(2, 6).padEnd(4, '0')}`;
}
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || autoChatId();
}

/** Metadata remains the source. The derived directory owns the cross-process
 * writer fence and repair intent; it never creates business facts on recovery. */
export class ConversationRepository implements IConversationRepository {
  private readonly root: string;
  private readonly index: ConversationDirectoryIndex;
  constructor(private readonly scope: ConversationScope, zhixingHome: string) {
    this.root = conversationsDir(scope, zhixingHome);
    this.index = new ConversationDirectoryIndex(this.root);
  }
  async list(opts?: { includeArchived?: boolean }): Promise<Conversation[]> {
    return this.index.list(opts?.includeArchived, segment => this.readSegment(segment));
  }
  async listPage(input: ConversationDirectoryPageRequest) {
    return this.index.page(input, segment => this.readSegment(segment));
  }
  async get(id: string): Promise<Conversation | null> { return this.readSegment(toSafePathSegment(id)); }
  async create(opts: CreateConversationOptions): Promise<Conversation> {
    return this.index.mutate(async () => {
      const id = opts.name ? await this.ensureUnique(slugify(opts.name)) : await this.ensureUnique(autoChatId());
      const now = new Date().toISOString();
      const value: Conversation = { id, name: opts.name ?? id, createdAt: now, lastActiveAt: now,
        isDefault: false, archived: false, preferredModel: opts.preferredModel, preferredProvider: opts.preferredProvider,
        scope: opts.scope ?? this.scope };
      return { segment: toSafePathSegment(id), apply: async () => { await this.write(value); return value; } };
    });
  }
  async ensure(id: string, opts: EnsureConversationOptions = {}): Promise<Conversation> {
    const found = await this.get(id);
    if (found) return found;
    return this.index.mutate<Conversation>(async () => {
      const existing = await this.get(id);
      if (existing) return { value: existing };
      const now = new Date().toISOString(), isDefault = id === DEFAULT_CONVERSATION_ID;
      const value: Conversation = { id, name: opts.name ?? (isDefault ? DEFAULT_CONVERSATION_NAME : id),
        createdAt: now, lastActiveAt: now, isDefault, archived: false, preferredModel: opts.preferredModel,
        preferredProvider: opts.preferredProvider, scope: opts.scope ?? this.scope };
      return { segment: toSafePathSegment(id), apply: async () => { await this.write(value); return value; } };
    });
  }
  async rename(id: string, name: string): Promise<Conversation> {
    return this.index.mutate<Conversation>(async () => {
      const value = await this.requireConversation(id);
      if (value.name === name) return { value };
      value.name = name;
      return { segment: toSafePathSegment(id), apply: async () => { await this.write(value); return value; } };
    });
  }
  async archive(id: string, archived: boolean): Promise<Conversation> {
    return this.index.mutate<Conversation>(async () => {
      const value = await this.requireConversation(id);
      if (value.isDefault && archived) throw new Error('默认对话不可归档');
      if (value.archived === archived) return { value };
      value.archived = archived;
      return { segment: toSafePathSegment(id), apply: async () => { await this.write(value); return value; } };
    });
  }
  async delete(id: string): Promise<void> {
    const segment = toSafePathSegment(id), directory = path.join(this.root, segment);
    if (path.dirname(path.resolve(directory)) !== path.resolve(this.root)) throw new Error('Conversation deletion escaped its source root');
    await this.index.mutate(async () => ({ segment, apply: async () => {
      const info = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (!info) return;
      if (!info.isSymbolicLink()) await durablyRemoveFile(path.join(directory, 'meta.json'));
      await fs.rm(directory, { recursive: true, force: true });
      await syncDirectory(this.root);
    } }));
  }
  async ensureDefault(): Promise<Conversation> { return this.ensure(DEFAULT_CONVERSATION_ID); }
  async touch(id: string, at = new Date().toISOString()): Promise<void> {
    if (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) throw new TypeError('Conversation activity time is invalid');
    await this.index.mutate(async () => {
      const value = await this.requireConversation(id);
      if (Date.parse(at) <= Date.parse(value.lastActiveAt)) return { value: undefined };
      value.lastActiveAt = at;
      return { segment: toSafePathSegment(id), apply: () => this.write(value) };
    });
  }
  async findLatest(): Promise<string | null> { return (await this.listPage({ limit: 1 })).records[0]?.id ?? null; }
  async updateTaskListState(id: string, state: TaskListState | undefined): Promise<void> {
    await this.updateView(id, value => { if (state === undefined) delete value.taskListState; else value.taskListState = state; return true; });
  }
  async appendSegmentMeta(id: string, meta: SegmentMeta): Promise<void> {
    await this.updateView(id, value => {
      const previous = value.segmentMetadata?.segments ?? [];
      const replay = previous.find(candidate => candidate.segmentId === meta.segmentId);
      if (replay) {
        if (JSON.stringify(replay) !== JSON.stringify(meta)) throw new Error(`Segment "${meta.segmentId}" conflicts with its committed projection`);
        return false;
      }
      const next: SegmentMetadata = { currentSegmentId: meta.segmentId, segments: [...previous, meta] };
      value.segmentMetadata = next;
      return true;
    });
  }
  async clearViewLayerState(id: string): Promise<void> {
    await this.updateView(id, value => { delete value.taskListState; delete value.segmentMetadata; return true; });
  }
  private async updateView(id: string, change: (value: Conversation) => boolean): Promise<void> {
    await this.index.mutate(async () => {
      const value = await this.get(id);
      if (!value || !change(value)) return { value: undefined };
      return { segment: toSafePathSegment(id), directoryChanged: false, apply: () => this.write(value) };
    });
  }
  private async readSegment(segment: string): Promise<Conversation | null> {
    try {
      const value = JSON.parse(await fs.readFile(path.join(this.root,segment,'meta.json'),'utf8')) as Conversation & Record<string,unknown>;
      if (!value || typeof value !== 'object') return null;
      delete value.capabilityState;
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }
  private async requireConversation(id: string): Promise<Conversation> {
    const value = await this.get(id);
    if (!value) throw new Error(`对话 "${id}" 不存在`);
    return value;
  }
  private async write(value: Conversation): Promise<void> {
    const file = path.join(this.root,toSafePathSegment(value.id),'meta.json'), directory = path.dirname(file);
    await ensureDurableDirectory(directory);
    const temporary = file + '.' + randomUUID() + '.tmp';
    const handle = await fs.open(temporary,'wx',0o600);
    try { await handle.writeFile(JSON.stringify(value,null,2)); await handle.sync(); }
    catch (error) { await handle.close().catch(()=>{}); await fs.unlink(temporary).catch(()=>{}); throw error; }
    await handle.close();
    try { await replaceFile(temporary,file); await syncDirectory(directory); }
    catch (error) { await fs.unlink(temporary).catch(()=>{}); throw error; }
  }
  private async ensureUnique(base: string): Promise<string> {
    if (base === DEFAULT_CONVERSATION_ID || base.startsWith('__')) return `${base}-1`;
    if (!await this.get(base)) return base;
    for (let n=2;n<=100;n++) { const id=`${base}-${n}`; if (!await this.get(id)) return id; }
    return autoChatId();
  }
}
