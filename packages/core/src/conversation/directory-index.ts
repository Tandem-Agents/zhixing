import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createFileLockAcquirer, durablyRemoveFiles, SerialTaskQueue } from '../persistence/index.js';
import { fromSafePathSegment, toSafePathSegment } from '../paths.js';
import { assertDirectoryPage, compareDirectoryKeys, ConversationDirectoryPageCollector, type ConversationDirectoryPageRequest, type ConversationDirectoryCursor } from './directory-page.js';
import type { Conversation } from './types.js';

const CACHE = '.directory-index-v1';
const PAGE = 64;
const queues = new Map<string, { queue: SerialTaskQueue; users: number }>();
type MetadataReader = (segment: string) => Promise<Conversation | null>;
type Mutation<T> = { readonly value: T } | {
  readonly segment: string; readonly apply: () => Promise<T>; readonly directoryChanged?: boolean;
};
interface State { root: string; ready: number; phase: string; epoch: number; stamp: string; revision?: string }
interface Row { segment: string; id: string; active: number; id_order: string; digest: string }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const idOrder = (value: string) => Array.from({ length: value.length }, (_, n) => value.charCodeAt(n).toString(16).padStart(4, '0')).join('');
const permissionFailure = (error: unknown): boolean => ['EACCES','EPERM','EROFS'].includes(String((error as NodeJS.ErrnoException)?.code)) ||
  [8,14].includes(Number((error as { errcode?: number })?.errcode) & 255);
const corruptIndex = (error: unknown): boolean => [11,26].includes(Number((error as { errcode?: number })?.errcode) & 255);
class InvalidDirectory extends Error {}
class CacheUnavailable extends Error {}
export class ConversationDirectoryUnavailableError extends Error {
  constructor(cause: unknown) { super('Conversation directory preparation is unavailable; existing conversation metadata has not been changed', { cause }); }
}

/** Metadata is the fact. A publication revision and durable singleton intent
 * let a read-only consumer overlay the one unpublished target, without copying
 * the directory or waiting for its writer. No cross-call private cache exists. */
export class ConversationDirectoryIndex {
  readonly #lock = createFileLockAcquirer();
  #root: string;
  #directory: string;
  #identity: string;
  #bound?: Promise<void>;
  constructor(root: string) {
    this.#root = path.resolve(root);
    this.#identity = identity(this.#root);
    this.#directory = path.join(path.dirname(this.#root), CACHE, digest(this.#identity));
  }

  async mutate<T>(prepare: () => Promise<Mutation<T>>): Promise<T> {
    await fs.mkdir(this.#root, { recursive: true });
    return this.#exclusive(async db => {
      await this.#repair(db);
      const plan = await prepare();
      if ('value' in plan) return plan.value;
      assertSegment(plan.segment);
      this.#transaction(db, () => { db.prepare('INSERT OR REPLACE INTO pending VALUES(1,?)').run(plan.segment); this.#publish(db); });
      // No source write is attempted until intent publication is durable.
      const value = await plan.apply();
      try { await this.#repair(db); }
      catch { /* Source succeeded; the surviving intent makes its result visible. */ }
      return value;
    });
  }

  async page(input: ConversationDirectoryPageRequest, readMetadata: MetadataReader = segment => this.#read(segment), signal?: AbortSignal): Promise<{
    readonly records: readonly (Conversation & { conversationId: string })[]; readonly next?: ConversationDirectoryCursor;
  }> {
    assertDirectoryPage(input);
    if (!await this.#present()) return { records: [] };
    const values = await this.#query(input, false, readMetadata, signal);
    const collector = new ConversationDirectoryPageCollector<Conversation & { conversationId: string }>(input);
    for (const value of values) collector.add({ ...value, conversationId: value.id });
    return collector.result();
  }

  async list(includeArchived = false, readMetadata: MetadataReader = segment => this.#read(segment)): Promise<Conversation[]> {
    if (!await this.#present()) return [];
    return this.#query(undefined, includeArchived, readMetadata);
  }

  async #query(input: ConversationDirectoryPageRequest | undefined, includeArchived: boolean, reader: MetadataReader, signal?: AbortSignal): Promise<Conversation[]> {
    await this.#bind();
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      try {
        const result = await this.#snapshot(input, includeArchived, reader, signal);
        if (result) return result;
        if (result === null) continue;
        await this.#prepare(reader, signal);
      } catch (error) {
        if (error instanceof CacheUnavailable) return this.#direct(input, includeArchived, reader, signal);
        if (!(error instanceof InvalidDirectory) && !corruptIndex(error)) throw error;
        try {
          await this.#exclusive(async db => this.#rebuild(db));
          await this.#prepare(reader, signal);
        } catch (repairError) {
          if (repairError instanceof CacheUnavailable) return this.#direct(input, includeArchived, reader, signal);
          if (corruptIndex(repairError)) continue;
          throw repairError;
        }
      }
    }
    throw new ConversationDirectoryUnavailableError('Conversation directory changed during each read; retry the query');
  }

  /** Read a published snapshot, overlay the real pending target (even outside
   * this page), then observe a fresh revision. All source mutations publish an
   * intent first. A stable pending target may yield either side of its atomic
   * meta replacement; both are complete, linearizable states. */
  async #snapshot(input: ConversationDirectoryPageRequest | undefined, includeArchived: boolean, reader: MetadataReader, signal?: AbortSignal): Promise<Conversation[] | undefined | null> {
    let db: DatabaseSync;
    try {
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
      db = new DatabaseSync(path.join(this.#directory, 'catalog.sqlite'), { readOnly: true });
    } catch (error) {
      if (corruptIndex(error)) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || permissionFailure(error)) {
        // A missing database may be prepared; inaccessible caches use facts.
        try { await fs.access(path.join(this.#directory, 'catalog.sqlite')); }
        catch (accessError) { if ((accessError as NodeJS.ErrnoException).code === 'ENOENT') return; throw new CacheUnavailable('Directory cache is unreadable', { cause: accessError }); }
        throw new CacheUnavailable('Directory cache is unreadable', { cause: error });
      }
      throw error;
    }
    try {
      db.exec('PRAGMA busy_timeout=3000; PRAGMA cache_size=-1024; BEGIN');
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='state'").get()) return;
      const state = this.#state(db);
      if (!state) return;
      if (state.root !== this.#identity) throw new InvalidDirectory('Directory source binding is invalid');
      if (!state.ready || !state.revision) return;
      const pending = db.prepare('SELECT segment FROM pending WHERE singleton=1').get() as { segment: string } | undefined;
      if (pending) assertSegment(pending.segment);
      if (!pending && state.stamp !== await this.#stamp()) return;
      const params: Array<string | number> = [state.epoch];
      let where = 'epoch=?';
      if (!includeArchived) where += ' AND archived=0';
      if (pending) { where += ' AND segment<>?'; params.push(pending.segment); }
      if (input?.after) {
        where += ' AND (active < ? OR (active=? AND id_order>?))';
        const at = Date.parse(input.after.lastActiveAt); params.push(at, at, idOrder(input.after.conversationId));
      }
      if (input?.query) {
        const query = input.query.toLocaleLowerCase();
        db.function('directory_matches', (id, name) => `${id} ${name}`.toLocaleLowerCase().includes(query) ? 1 : 0);
        where += ' AND directory_matches(id,name)=1';
      }
      const limit = input ? ' LIMIT ?' : '';
      if (input) params.push(input.limit + 1);
      const rows = db.prepare(`SELECT segment,id,active,id_order,digest FROM entries WHERE ${where} ORDER BY active DESC,id_order,segment${limit}`).all(...params) as unknown as Row[];
      const values: Conversation[] = []; let stale = false;
      for (const row of rows) {
        signal?.throwIfAborted();
        const meta = await this.#metadata(row.segment, reader);
        if (!meta || !this.#matches(row, meta)) stale = true;
        else values.push(meta);
      }
      if (pending) {
        const meta = await this.#metadata(pending.segment, reader);
        if (meta && (includeArchived || !meta.archived)) values.push(meta);
      }
      db.exec('COMMIT');
      if (this.#state(db).revision !== state.revision) return null;
      if (stale) throw new InvalidDirectory('Directory row no longer matches source metadata');
      return values.sort((a,b) => compareDirectoryKeys({ ...a, conversationId: a.id }, { ...b, conversationId: b.id }));
    } finally { db.close(); }
  }

  /** Inventory and bounded metadata pages have separate durable checkpoints. */
  async prepare(reader: MetadataReader = segment => this.#read(segment), signal?: AbortSignal): Promise<void> {
    if (!await this.#present()) return;
    await this.#bind();
    try { await this.#prepare(reader, signal); }
    catch (error) {
      if (error instanceof CacheUnavailable) { await this.#direct({ limit: 1 }, false, reader, signal); return; }
      if (!(error instanceof InvalidDirectory) && !corruptIndex(error)) throw error;
      await this.#exclusive(async db => this.#rebuild(db));
      await this.#prepare(reader, signal);
    }
  }
  async #prepare(reader: MetadataReader, signal?: AbortSignal): Promise<void> {
    let directory: Awaited<ReturnType<typeof fs.opendir>> | undefined;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const done = await this.#exclusive(async db => {
          await this.#repair(db, reader);
          let state = this.#state(db);
          const stamp = await this.#stamp();
          if (state.ready && state.stamp !== stamp) { this.#rebuild(db); state = this.#state(db); }
          if (state.ready) return true;
          if (state.phase === 'inventory') {
            directory ??= await fs.opendir(this.#root);
            const names: string[] = []; let ended = false;
            for (let n = 0; n < PAGE; n++) {
              signal?.throwIfAborted();
              const entry = await directory.read();
              if (!entry) { ended = true; break; }
              if (entry.isDirectory()) { assertSegment(entry.name); names.push(entry.name); }
            }
            this.#transaction(db, () => {
              const insert = db.prepare('INSERT OR IGNORE INTO inventory(epoch,segment,done) VALUES(?,?,0)');
              for (const name of names) insert.run(state.epoch, name);
              if (ended) db.prepare("UPDATE state SET phase='metadata' WHERE singleton=1").run();
              this.#publish(db);
            });
            return false;
          }
          const rows = db.prepare('SELECT segment FROM inventory WHERE epoch=? AND done=0 ORDER BY segment LIMIT ?').all(state.epoch, PAGE) as unknown as Array<{ segment: string }>;
          const values: Array<{ segment: string; value: Conversation | null }> = [];
          for (const row of rows) { signal?.throwIfAborted(); values.push({ segment: row.segment, value: await this.#metadata(row.segment, reader) }); }
          this.#transaction(db, () => {
            for (const item of values) {
              this.#project(db, item.segment, item.value);
              db.prepare('UPDATE inventory SET done=1 WHERE epoch=? AND segment=?').run(state.epoch, item.segment);
            }
            if (rows.length < PAGE) db.prepare("UPDATE state SET ready=1,phase='ready',stamp=? WHERE singleton=1").run(stamp);
            this.#publish(db);
          });
          return rows.length < PAGE;
        });
        if (done) return;
        await new Promise<void>(setImmediate);
      }
    } finally { await directory?.close().catch(() => {}); }
  }

  async #direct(input: ConversationDirectoryPageRequest | undefined, includeArchived: boolean, reader: MetadataReader, signal?: AbortSignal): Promise<Conversation[]> {
    // Exceptional cache failure: derive only this call from readable facts.
    const collector = input ? new ConversationDirectoryPageCollector<Conversation & { conversationId: string }>(input) : undefined;
    const values: Conversation[] = [];
    const directory = await fs.opendir(this.#root);
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (!entry.isDirectory()) continue;
      const meta = await this.#metadata(entry.name, reader);
      if (!meta || (!includeArchived && meta.archived)) continue;
      if (collector) collector.add({ ...meta, conversationId: meta.id }); else values.push(meta);
    }
    return collector ? collector.entries : values.sort((a,b) => compareDirectoryKeys({ ...a, conversationId: a.id }, { ...b, conversationId: b.id }));
  }
  async #present(): Promise<boolean> {
    try { const info = await fs.stat(this.#root); if (!info.isDirectory()) throw new Error('Conversation source is not a directory'); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async #stamp(): Promise<string> {
    const info = await fs.stat(this.#root, { bigint: true });
    return `${info.dev}:${info.ino}:${info.mtimeNs}`;
  }
  async #metadata(segment: string, reader: MetadataReader): Promise<Conversation | null> {
    assertSegment(segment);
    const expected = path.join(this.#root, segment, 'meta.json');
    let physical: string;
    try { physical = await fs.realpath(expected); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (identity(physical) !== identity(expected)) throw new InvalidDirectory('Conversation metadata locator leaves its source position');
    const value = await reader(segment);
    if (value && (!validMetadata(value) || toSafePathSegment(value.id) !== segment)) throw new Error('Conversation metadata identity does not match its source position');
    return value;
  }
  async #read(segment: string): Promise<Conversation | null> {
    try { return JSON.parse(await fs.readFile(path.join(this.#root, segment, 'meta.json'), 'utf8')) as Conversation; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }
  #matches(row: Row, value: Conversation): boolean {
    return row.id === value.id && row.active === Date.parse(value.lastActiveAt) && row.id_order === idOrder(value.id) && row.digest === metadataDigest(value);
  }
  #project(db: DatabaseSync, segment: string, value: Conversation | null): void {
    if (!value) { db.prepare('DELETE FROM entries WHERE segment=?').run(segment); return; }
    const encoded = metadataDigest(value), existing = db.prepare('SELECT digest,epoch FROM entries WHERE segment=?').get(segment);
    const epoch = this.#state(db).epoch;
    if (existing?.digest === encoded && existing.epoch === epoch) return;
    db.prepare('INSERT OR REPLACE INTO entries VALUES(?,?,?,?,?,?,?,?)').run(segment,value.id,value.name,Date.parse(value.lastActiveAt),idOrder(value.id),Number(!!value.archived),encoded,epoch);
  }
  async #repair(db: DatabaseSync, reader: MetadataReader = segment => this.#read(segment)): Promise<void> {
    const pending = db.prepare('SELECT segment FROM pending WHERE singleton=1').get() as { segment: string } | undefined;
    if (!pending) return;
    const value = await this.#metadata(pending.segment, reader), stamp = await this.#stamp();
    this.#transaction(db, () => { this.#project(db,pending.segment,value); db.exec('DELETE FROM pending'); db.prepare('UPDATE state SET stamp=? WHERE singleton=1').run(stamp); this.#publish(db); });
  }
  #state(db: DatabaseSync): State { return db.prepare('SELECT * FROM state WHERE singleton=1').get() as unknown as State; }
  #publish(db: DatabaseSync): void { db.prepare('UPDATE state SET revision=? WHERE singleton=1').run(randomUUID()); }
  #rebuild(db: DatabaseSync): void {
    this.#transaction(db, () => { db.exec("DELETE FROM pending; UPDATE state SET ready=0,phase='inventory',epoch=epoch+1,stamp='' WHERE singleton=1"); this.#publish(db); });
  }
  #transaction(db: DatabaseSync, work: () => void): void {
    db.exec('BEGIN IMMEDIATE');
    try { work(); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async #bind(): Promise<void> {
    this.#bound ??= fs.realpath(this.#root).then(root => {
      this.#root = root; this.#identity = identity(root);
      this.#directory = path.join(path.dirname(root), CACHE, digest(this.#identity));
    });
    await this.#bound;
  }
  async #exclusive<T>(work: (db: DatabaseSync) => Promise<T>): Promise<T> {
    await this.#bind();
    const key = identity(this.#directory);
    let entry = queues.get(key);
    if (!entry) { entry = { queue: new SerialTaskQueue(), users: 0 }; queues.set(key,entry); }
    entry.users++;
    try { return await entry.queue.run(() => this.#locked(work)); }
    finally { if (--entry.users === 0) queues.delete(key); }
  }
  async #locked<T>(work: (db: DatabaseSync) => Promise<T>): Promise<T> {
    let release: () => Promise<void>;
    try {
      await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
      release = await this.#lock(path.join(this.#directory,'writer.lock'), { staleMs: 30_000, waitMs: 3000, resourceName: 'Conversation directory' });
    } catch (error) { if (permissionFailure(error)) throw new CacheUnavailable('Directory cache cannot be written', { cause: error }); throw error; }
    let db: DatabaseSync | undefined;
    const filename = path.join(this.#directory,'catalog.sqlite');
    try {
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
      const open = () => {
        const value = new DatabaseSync(filename);
        try {
          value.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-1024;
            CREATE TABLE IF NOT EXISTS state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),root TEXT NOT NULL,ready INTEGER NOT NULL,phase TEXT NOT NULL,epoch INTEGER NOT NULL,stamp TEXT NOT NULL,revision TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS entries(segment TEXT PRIMARY KEY,id TEXT NOT NULL,name TEXT NOT NULL,active INTEGER NOT NULL,id_order TEXT NOT NULL,archived INTEGER NOT NULL,digest TEXT NOT NULL,epoch INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS recent ON entries(epoch,archived,active DESC,id_order,segment);
            CREATE TABLE IF NOT EXISTS pending(singleton INTEGER PRIMARY KEY CHECK(singleton=1),segment TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS inventory(epoch INTEGER NOT NULL,segment TEXT NOT NULL,done INTEGER NOT NULL,PRIMARY KEY(epoch,segment));
            CREATE INDEX IF NOT EXISTS unfinished ON inventory(epoch,done,segment);`);
          const columns = value.prepare('PRAGMA table_info(state)').all();
          if (!columns.some(column => column.name === 'revision')) value.exec("ALTER TABLE state ADD COLUMN revision TEXT NOT NULL DEFAULT ''");
          const row = this.#state(value);
          if (row && row.root !== this.#identity) throw new InvalidDirectory('Conversation directory belongs to another source');
          if (!row) value.prepare("INSERT INTO state VALUES(1,?,0,'inventory',1,'',?)").run(this.#identity, randomUUID());
          else if (!row.revision) this.#publish(value);
          return value;
        } catch (error) { value.close(); throw error; }
      };
      try { db = open(); }
      catch (error) {
        if (permissionFailure(error)) throw new CacheUnavailable('Directory cache cannot be written', { cause: error });
        if (!corruptIndex(error)) throw error;
        await durablyRemoveFiles([filename,filename+'-wal',filename+'-shm',filename+'-journal']);
        db = open();
      }
      return await work(db);
    } catch (error) {
      // Only dispose derived storage. Never replay a source mutation callback.
      if (corruptIndex(error)) {
        db?.close(); db = undefined;
        await durablyRemoveFiles([filename,filename+'-wal',filename+'-shm',filename+'-journal']);
      }
      throw error;
    } finally { db?.close(); await release(); }
  }
}

function identity(value: string): string { return process.platform === 'win32' ? value.toLowerCase() : value; }
function assertSegment(segment: string): void {
  if (typeof segment !== 'string' || !segment || toSafePathSegment(fromSafePathSegment(segment)) !== segment) throw new InvalidDirectory('Invalid conversation metadata segment');
}
function validMetadata(value: Conversation | null): value is Conversation {
  return !!value && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.name === 'string' && typeof value.lastActiveAt === 'string' && Number.isFinite(Date.parse(value.lastActiveAt));
}
function metadataDigest(value: Conversation): string {
  return digest(JSON.stringify([value.id,value.name,value.createdAt,value.lastActiveAt,!!value.archived,!!value.isDefault,
    value.scope,value.preferredProvider,value.preferredModel]));
}