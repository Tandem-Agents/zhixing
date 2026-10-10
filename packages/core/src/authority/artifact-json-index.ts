import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ArtifactRef } from '../contracts/index.js';
import type { ArtifactStore } from './interfaces.js';
import { SerialTaskQueue } from '../persistence/serial-task-queue.js';
import { createFileLockAcquirer } from '../persistence/file-lock.js';
import { durablyRemoveFiles } from '../persistence/durable-removal.js';
import { assertArtifactRef } from './artifact-references.js';

/** Disposable byte-position index. Original artifact bytes remain the only
 * source. Large JSON strings are never materialized to find their tail. */
export interface ArtifactJsonNode {
  readonly id: number; readonly parent: number; readonly field: string; readonly ordinal: number;
  readonly kind: string; readonly lo: number; readonly hi: number; readonly units: number;
}
interface Frame { id: number; kind: 'object' | 'array'; phase: 'first' | 'key' | 'colon' | 'value' | 'comma'; key?: string; previousKey?: string; count: number }
interface Token { id?: number; key: boolean; start: number; piece: number; units: number; escaped: boolean; unicode: number; primitive?: string }
interface Scan { ref: ArtifactRef; at: number; next: number; stack: Frame[]; token?: Token; root: boolean; canonical: boolean; hash: ReturnType<typeof createHash> }
const BLOCK = 64 * 1024, PIECE = 24 * 1024, MAX_BYTES = 128 * 1024 * 1024;
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const cache = new WeakMap<ArtifactStore, ArtifactJsonIndex>();

export function artifactJsonIndex(store: ArtifactStore): ArtifactJsonIndex {
  let value = cache.get(store);
  if (!value) { value = new ArtifactJsonIndex(store, store.jsonIndexDirectory); cache.set(store, value); }
  return value;
}

/** Release only a reader already owned by this store; shutdown must not create one. */
export async function closeArtifactJsonIndex(store: ArtifactStore): Promise<void> {
  await cache.get(store)?.close();
}

export class ArtifactJsonIndex {
  readonly #acquireFileLock = createFileLockAcquirer();
  readonly #queue = new SerialTaskQueue();
  #db?: DatabaseSync;
  readonly #scans = new Map<string, Scan>();
  #idle?: ReturnType<typeof setTimeout>;
  #unlock?: () => Promise<void>;
  constructor(readonly store: Pick<ArtifactStore, 'readRange' | 'readIdentity'>, readonly directory?: string) {}
  async #open(): Promise<DatabaseSync> {
    clearTimeout(this.#idle);
    if (this.#db) return this.#db;
    if (this.directory) await mkdir(this.directory, { recursive: true });
    // node:sqlite is prefix-only. getBuiltinModule also keeps bundlers from
    // rewriting it into the unrelated npm package named "sqlite".
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const filename = this.directory ? path.join(this.directory, 'positions-v1.sqlite') : ':memory:';
    let db = new DatabaseSync(filename);
    const initialize = () => db.exec(`PRAGMA busy_timeout=3000; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA cache_size=-1024;
      PRAGMA temp_store=MEMORY; PRAGMA journal_mode=DELETE; PRAGMA max_page_count=32768;
      CREATE TABLE IF NOT EXISTS artifacts(ref TEXT PRIMARY KEY, bytes INTEGER NOT NULL, ready INTEGER NOT NULL, touched INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes(ref TEXT NOT NULL, id INTEGER NOT NULL, parent INTEGER NOT NULL, field TEXT NOT NULL,
        ordinal INTEGER NOT NULL, kind TEXT NOT NULL, lo INTEGER NOT NULL, hi INTEGER NOT NULL, units INTEGER NOT NULL,
        PRIMARY KEY(ref,id));
      CREATE UNIQUE INDEX IF NOT EXISTS children ON nodes(ref,parent,field);
      CREATE INDEX IF NOT EXISTS ordinals ON nodes(ref,parent,ordinal);
      CREATE TABLE IF NOT EXISTS pieces(ref TEXT NOT NULL, node INTEGER NOT NULL, offset INTEGER NOT NULL, lo INTEGER NOT NULL,
        hi INTEGER NOT NULL, units INTEGER NOT NULL, PRIMARY KEY(ref,node,offset));
      CREATE TABLE IF NOT EXISTS sources(identity TEXT PRIMARY KEY, ref TEXT NOT NULL, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS slices(identity TEXT NOT NULL, tail INTEGER NOT NULL, start INTEGER NOT NULL, ref TEXT NOT NULL,
        PRIMARY KEY(identity,tail));`);
    try { initialize(); }
    catch (error) {
      db.close();
      // Only SQLite's corruption codes authorize rebuilding this disposable
      // index. Permissions, busy/disk-full and original artifacts are untouched.
      if (!this.directory || ![11, 26].includes(Number((error as { errcode?: unknown }).errcode))) throw error;
      const release = await this.#acquireFileLock(path.join(this.directory, 'positions-v1.lock'), { staleMs: 30_000, waitMs: 3000, resourceName: 'Artifact read index' });
      try {
        await durablyRemoveFiles([filename, filename + '-journal']);
        db = new DatabaseSync(filename); initialize();
      } finally { await release(); }
    }
    if (!db.prepare('PRAGMA table_info(artifacts)').all().some(row => row.name === 'canonical')) db.exec('ALTER TABLE artifacts ADD COLUMN canonical INTEGER');
    if (!db.prepare('PRAGMA table_info(artifacts)').all().some(row => row.name === 'identity')) db.exec('ALTER TABLE artifacts ADD COLUMN identity TEXT');
    this.#db = db; return db;
  }
  #release(): void {
    if (!this.directory) return;
    this.#idle = setTimeout(() => { void this.close().catch(() => {}); }, 5000);
    this.#idle.unref();
  }
  async close(): Promise<void> { await this.#queue.run(async () => {
    clearTimeout(this.#idle);
    try { if (this.#db) for (const ref of this.#scans.keys()) this.#remove(this.#db, ref); }
    finally { this.#db?.close(); this.#db = undefined; this.#scans.clear(); await this.#releaseWriter(); }
  }); }
  async #releaseWriter(): Promise<void> { if (this.#scans.size) return; const release = this.#unlock; this.#unlock = undefined; await release?.(); }
  async #run<T>(fn: (db: DatabaseSync) => Promise<T>): Promise<T> {
    return this.#queue.run(async () => { const db = await this.#open(); try { return await fn(db); } finally { this.#release(); } });
  }
  #remove(db: DatabaseSync, ref: string): void {
    db.prepare('DELETE FROM slices WHERE ref=?').run(ref);
    db.prepare('DELETE FROM sources WHERE ref=?').run(ref);
    db.prepare('DELETE FROM pieces WHERE ref=?').run(ref); db.prepare('DELETE FROM nodes WHERE ref=?').run(ref); db.prepare('DELETE FROM artifacts WHERE ref=?').run(ref);
  }
  /** Immutable file slices can reuse an already verified JSON index. The
   * caller must bind the source identity to its open file and exact extent. */
  async sourceRef(identity: string): Promise<ArtifactRef | undefined> {
    return this.#run(async db => {
      const row = db.prepare('SELECT s.ref,s.bytes FROM sources s JOIN artifacts a ON a.ref=s.ref WHERE s.identity=? AND a.ready=1').get(identity);
      return row ? { digest: String(row.ref) as ArtifactRef['digest'], bytes: Number(row.bytes) } : undefined;
    });
  }
  async bindSource(identity: string, ref: ArtifactRef): Promise<void> {
    if (identity.length > 4096) throw Error('artifact-json-source-identity');
    await this.#run(async db => {
      if (db.prepare('SELECT ready FROM artifacts WHERE ref=?').get(ref.digest)?.ready !== 1) throw Error('artifact-json-not-ready');
      db.prepare('INSERT OR REPLACE INTO sources VALUES(?,?,?)').run(identity, ref.digest, ref.bytes);
    });
  }
  /** A verified JSONL record boundary is disposable alongside its byte index. */
  async sourceSlice(identity: string, tail: number): Promise<number | undefined> {
    return this.#run(async db => {
      const row = db.prepare('SELECT s.start FROM slices s JOIN artifacts a ON a.ref=s.ref WHERE s.identity=? AND s.tail=? AND a.ready=1').get(identity, tail);
      return row ? Number(row.start) : undefined;
    });
  }
  async bindSourceSlice(identity: string, start: number, tail: number, ref: ArtifactRef): Promise<void> {
    if (identity.length > 4096 || !Number.isSafeInteger(start) || !Number.isSafeInteger(tail) || start < 0 || tail <= start) throw Error('artifact-json-source-slice');
    await this.#run(async db => {
      if (db.prepare('SELECT ready FROM artifacts WHERE ref=?').get(ref.digest)?.ready !== 1) throw Error('artifact-json-not-ready');
      db.prepare('INSERT OR REPLACE INTO slices VALUES(?,?,?,?)').run(identity, tail, start, ref.digest);
    });
  }
  /** Each call performs at most the supplied source-byte quantum. The caller
   * may cancel between calls and report progress instead of declaring empty. */
  async prepare(ref: ArtifactRef, signal?: AbortSignal, budget = 4 * 1024 * 1024): Promise<{ ready: boolean; bytes: number; total: number }> {
    assertArtifactRef(ref);
    if (!Number.isSafeInteger(budget) || budget < BLOCK || budget > 8 * 1024 * 1024) throw Error('artifact-json-budget');
    return this.#run(async db => {
      signal?.throwIfAborted();
      const identity = await this.store.readIdentity?.(ref);
      const found = db.prepare('SELECT bytes,ready,canonical,identity FROM artifacts WHERE ref=?').get(ref.digest);
      if (found?.ready === 1 && found.bytes === ref.bytes && found.canonical !== null && (identity === undefined || found.identity === identity)) {
        db.prepare('UPDATE artifacts SET touched=? WHERE ref=?').run(Date.now(), ref.digest);
        return { ready: true, bytes: ref.bytes, total: ref.bytes };
      }
      if (this.directory && !this.#unlock) {
        this.#unlock = await this.#acquireFileLock(path.join(this.directory, 'positions-v1.lock'), { staleMs: 30_000, waitMs: 3000, resourceName: 'Artifact read index' });
        // A different process may have finished while this caller waited.
        const ready = db.prepare('SELECT ready,canonical,identity FROM artifacts WHERE ref=?').get(ref.digest);
        if (ready?.ready === 1 && ready.canonical !== null && (identity === undefined || ready.identity === identity)) {
          await this.#releaseWriter(); return { ready: true, bytes: ref.bytes, total: ref.bytes };
        }
      }
      // A history reader and model activation must not reset each other's
      // partial work. Four tiny parser stacks/hash states share the byte budget.
      if (!this.#scans.has(ref.digest)) {
        if (this.#scans.size >= 4) { const oldest = this.#scans.keys().next().value!; this.#remove(db, oldest); this.#scans.delete(oldest); }
        this.#remove(db, ref.digest);
        this.#scans.set(ref.digest, { ref, at: 0, next: 1, stack: [], root: false, canonical: true, hash: createHash('sha256') });
        db.prepare('INSERT INTO artifacts(ref,bytes,ready,touched,identity) VALUES(?,?,0,?,?)').run(ref.digest, ref.bytes, Date.now(), identity ?? null);
      }
      const scan = this.#scans.get(ref.digest)!; this.#scans.delete(ref.digest); this.#scans.set(ref.digest, scan);
      const until = Math.min(ref.bytes, scan.at + budget);
      try {
        await this.#assertIdentity(db, ref);
        while (scan.at < until) {
          signal?.throwIfAborted();
          const bytes = await this.#read(ref, scan.at, Math.min(BLOCK, until - scan.at));
          if (!bytes.length) throw Error('artifact-json-short-read');
          db.exec('BEGIN IMMEDIATE');
          try {
            for (const byte of bytes) { const pending = this.#byte(db, scan, byte); if (pending) await pending; scan.at++; }
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          scan.hash.update(bytes);
          await new Promise<void>(setImmediate);
          const pages = Number(db.prepare('PRAGMA page_count').get()!.page_count);
          if (pages * 4096 > MAX_BYTES * .75) {
            const victims = db.prepare('SELECT ref FROM artifacts WHERE ref<>? ORDER BY touched LIMIT 16').all(ref.digest);
            for (const victim of victims) if (!this.#scans.has(String(victim.ref))) this.#remove(db, String(victim.ref));
            db.exec('PRAGMA incremental_vacuum(256)');
          }
        }
        if (scan.at === ref.bytes) {
          await this.#assertIdentity(db, ref);
          if (scan.token?.primitive !== undefined) this.#primitive(db, scan);
          if (!scan.root || scan.stack.length || scan.token || `sha256:${scan.hash.digest('hex')}` !== ref.digest) throw Error('artifact-json-invalid');
          db.prepare('UPDATE artifacts SET ready=1,touched=?,canonical=? WHERE ref=?').run(Date.now(), Number(scan.canonical), ref.digest);
          this.#scans.delete(ref.digest); await this.#releaseWriter(); return { ready: true, bytes: ref.bytes, total: ref.bytes };
        }
        return { ready: false, bytes: scan.at, total: ref.bytes };
      } catch (error) { this.#remove(db, ref.digest); this.#scans.delete(ref.digest); await this.#releaseWriter(); throw error; }
    });
  }
  #node(db: DatabaseSync, scan: Scan, kind: string): number {
    const parent = scan.stack.at(-1);
    if (parent && !['first', 'value'].includes(parent.phase) || !parent && scan.root) throw Error('artifact-json-value');
    if (parent?.kind === 'object' && parent.key === undefined) throw Error('artifact-json-key');
    const id = scan.next++, field = parent?.kind === 'array' ? String(parent.count) : parent?.key ?? '';
    db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?)').run(scan.ref.digest, id, parent?.id ?? 0, field, parent?.count ?? 0, kind, scan.at, -1, 0);
    if (!parent) scan.root = true;
    return id;
  }
  #done(scan: Scan): void { const parent = scan.stack.at(-1); if (parent) { parent.phase = 'comma'; parent.count++; delete parent.key; } }
  async #piece(db: DatabaseSync, scan: Scan, end: number): Promise<void> {
    const token = scan.token!;
    if (end === token.piece) return;
    const raw = await this.#read(scan.ref, token.piece, end - token.piece);
    const text = JSON.parse(`"${dec.decode(raw)}"`) as string;
    if (/[\ud800-\udfff]/u.test(text) || JSON.stringify(text).slice(1, -1) !== dec.decode(raw)) scan.canonical = false;
    db.prepare('INSERT INTO pieces VALUES(?,?,?,?,?,?)').run(scan.ref.digest, token.id!, token.units, token.piece, end, text.length);
    token.units += text.length; token.piece = end;
  }
  #primitive(db: DatabaseSync, scan: Scan): void {
    const token = scan.token!, value: unknown = JSON.parse(token.primitive!);
    if (JSON.stringify(value) !== token.primitive) scan.canonical = false;
    if (value !== null && typeof value !== 'number' && typeof value !== 'boolean' || typeof value === 'number' && !Number.isFinite(value)) throw Error('artifact-json-primitive');
    db.prepare('UPDATE nodes SET hi=? WHERE ref=? AND id=?').run(scan.at, scan.ref.digest, token.id!);
    scan.token = undefined; this.#done(scan);
  }
  #byte(db: DatabaseSync, scan: Scan, byte: number): Promise<void> | void {
    let token = scan.token;
    if (token?.primitive !== undefined) {
      if (![9, 10, 13, 32, 44, 93, 125].includes(byte)) {
        if (token.primitive.length >= 64) throw Error('artifact-json-number');
        token.primitive += String.fromCharCode(byte); return;
      }
      this.#primitive(db, scan); token = undefined;
    }
    if (token) {
      if (byte < 32) throw Error('artifact-json-control');
      if (token.unicode) { if (!/[\da-f]/iu.test(String.fromCharCode(byte))) throw Error('artifact-json-unicode'); token.unicode--; return; }
      if (token.escaped) { token.escaped = false; if (byte === 117) token.unicode = 4; else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(byte)) throw Error('artifact-json-escape'); return; }
      if (byte === 34) {
        return (async () => {
        if (token.key) {
          if (scan.at - token.start > 2048) throw Error('artifact-json-key-size');
          const raw = await this.#read(scan.ref, token.start, scan.at - token.start + 1);
          const frame = scan.stack.at(-1)!; frame.key = JSON.parse(dec.decode(raw)); frame.phase = 'colon';
          if (/[\ud800-\udfff]/u.test(frame.key!) || JSON.stringify(frame.key) !== dec.decode(raw) ||
              frame.previousKey !== undefined && frame.previousKey >= frame.key!) scan.canonical = false;
          frame.previousKey = frame.key;
        } else {
          await this.#piece(db, scan, scan.at);
          db.prepare('UPDATE nodes SET hi=?,units=? WHERE ref=? AND id=?').run(scan.at + 1, token.units, scan.ref.digest, token.id!);
          this.#done(scan);
        }
        scan.token = undefined;
        })();
      }
      if (!token.key && scan.at - token.piece >= PIECE && (byte & 0xc0) !== 0x80) {
        // Avoid dividing an escaped surrogate pair across independent pieces.
        return (async () => {
          const tail = Buffer.from(await this.#read(scan.ref, Math.max(token.piece, scan.at - 6), Math.min(6, scan.at - token.piece))).toString('latin1');
          if (!/\\u[dD][89aAbB][\da-fA-F]{2}$/u.test(tail)) await this.#piece(db, scan, scan.at);
          if (byte === 92) token.escaped = true;
        })();
      }
      if (byte === 92) token.escaped = true;
      if (token.key && scan.at - token.start > 2048) throw Error('artifact-json-key-size');
      return;
    }
    if ([9, 10, 13, 32].includes(byte)) { scan.canonical = false; return; }
    const frame = scan.stack.at(-1);
    if (byte === 125 || byte === 93) {
      if (!frame || (byte === 125 ? frame.kind !== 'object' : frame.kind !== 'array') || !['first', 'comma'].includes(frame.phase)) throw Error('artifact-json-close');
      db.prepare('UPDATE nodes SET hi=?,units=? WHERE ref=? AND id=?').run(scan.at + 1, frame.count, scan.ref.digest, frame.id);
      scan.stack.pop(); this.#done(scan); return;
    }
    if (frame?.phase === 'comma') { if (byte !== 44) throw Error('artifact-json-comma'); frame.phase = frame.kind === 'object' ? 'key' : 'value'; return; }
    if (frame?.phase === 'colon') { if (byte !== 58) throw Error('artifact-json-colon'); frame.phase = 'value'; return; }
    const key = frame?.kind === 'object' && ['first', 'key'].includes(frame.phase);
    if (key && byte !== 34) throw Error('artifact-json-key');
    if (byte === 34) { scan.token = { id: key ? undefined : this.#node(db, scan, 'string'), key, start: scan.at, piece: scan.at + 1, units: 0, escaped: false, unicode: 0 }; return; }
    if (byte === 123 || byte === 91) {
      if (scan.stack.length >= 128) throw Error('artifact-json-depth');
      const kind = byte === 123 ? 'object' : 'array', id = this.#node(db, scan, kind);
      scan.stack.push({ id, kind, phase: 'first', count: 0 }); return;
    }
    if (!'-0123456789tfn'.includes(String.fromCharCode(byte))) throw Error('artifact-json-token');
    scan.token = { id: this.#node(db, scan, 'scalar'), key: false, start: scan.at, piece: scan.at, units: 0, escaped: false, unicode: 0, primitive: String.fromCharCode(byte) };
  }
  async node(ref: ArtifactRef, keys: readonly (string | number)[]): Promise<ArtifactJsonNode | undefined> {
    return this.#run(async db => {
      if (db.prepare('SELECT ready FROM artifacts WHERE ref=?').get(ref.digest)?.ready !== 1) throw Error('artifact-json-not-ready');
      let node = db.prepare('SELECT * FROM nodes WHERE ref=? AND parent=0').get(ref.digest) as unknown as ArtifactJsonNode | undefined;
      for (const key of keys) { if (!node) return; node = db.prepare('SELECT * FROM nodes WHERE ref=? AND parent=? AND field=?').get(ref.digest, node.id, String(key)) as unknown as ArtifactJsonNode | undefined; }
      return node;
    });
  }
  async value(ref: ArtifactRef, keys: readonly (string | number)[], maximum = 32 * 1024): Promise<unknown> {
    const node = await this.node(ref, keys); if (!node) return undefined;
    if (node.hi < node.lo || node.hi - node.lo > maximum) throw Error('artifact-json-value-budget');
    return JSON.parse(dec.decode(await this.#read(ref, node.lo, node.hi - node.lo)));
  }
  async canonical(ref: ArtifactRef): Promise<boolean> {
    return this.#run(async db => { await this.#assertIdentity(db, ref); return db.prepare('SELECT canonical FROM artifacts WHERE ref=? AND ready=1').get(ref.digest)?.canonical === 1; });
  }
  async #assertIdentity(db: DatabaseSync, ref: ArtifactRef): Promise<void> {
    if (this.store.readIdentity && db.prepare('SELECT identity FROM artifacts WHERE ref=?').get(ref.digest)?.identity !== await this.store.readIdentity(ref))
      throw Error('artifact-json-source-changed');
  }
  async assertCurrent(ref: ArtifactRef): Promise<void> { await this.#run(db => this.#assertIdentity(db, ref)); }
  async #read(ref: ArtifactRef, offset: number, limit: number): Promise<Uint8Array> {
    await this.#assertIdentity(this.#db!, ref);
    const bytes = await this.store.readRange(ref, offset, limit);
    await this.#assertIdentity(this.#db!, ref);
    return bytes;
  }
  async children(ref: ArtifactRef, node: ArtifactJsonNode, after = -1, limit = 64): Promise<readonly ArtifactJsonNode[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw Error('artifact-json-children-limit');
    return this.#run(async db => db.prepare('SELECT * FROM nodes WHERE ref=? AND parent=? AND ordinal>? ORDER BY ordinal LIMIT ?')
      .all(ref.digest, node.id, after, limit) as unknown as ArtifactJsonNode[]);
  }
  async digestRange(ref: ArtifactRef, node: ArtifactJsonNode): Promise<string> {
    const hash = createHash('sha256');
    for (let offset = node.lo; offset < node.hi;) {
      const bytes = await this.#read(ref, offset, Math.min(BLOCK, node.hi - offset));
      if (!bytes.length) throw Error('artifact-json-short-read'); hash.update(bytes); offset += bytes.length;
      await new Promise<void>(setImmediate);
    }
    return `sha256:${hash.digest('hex')}`;
  }
  async references(ref: ArtifactRef): Promise<ArtifactRef[]> {
    const found = new Map<string, ArtifactRef>(); let after = 0;
    for (;;) {
      const rows = await this.#run(async db => db.prepare(`SELECT d.id,d.lo,d.hi,b.lo blo,b.hi bhi FROM nodes d
        JOIN nodes b ON b.ref=d.ref AND b.parent=d.parent AND b.field='bytes' AND b.kind='scalar'
        JOIN nodes p ON p.ref=d.ref AND p.id=d.parent AND p.kind='object'
        WHERE d.ref=? AND d.field='digest' AND d.kind='string' AND d.id>? ORDER BY d.id LIMIT 64`).all(ref.digest, after));
      if (!rows.length) return [...found.values()].sort((a, b) => a.digest.localeCompare(b.digest));
      for (const row of rows) {
        after = Number(row.id);
        const bytes = JSON.parse(dec.decode(await this.#read(ref, Number(row.blo), Number(row.bhi) - Number(row.blo))));
        if (typeof bytes !== 'number') continue;
        if (Number(row.hi) - Number(row.lo) > 80) throw Error('artifact-json-reference-digest');
        const value = { digest: JSON.parse(dec.decode(await this.#read(ref, Number(row.lo), Number(row.hi) - Number(row.lo)))), bytes };
        assertArtifactRef(value);
        if (found.has(value.digest) && found.get(value.digest)!.bytes !== value.bytes) throw Error('artifact-json-reference-size');
        found.set(value.digest, value);
      }
      await new Promise<void>(setImmediate);
    }
  }
  async text(ref: ArtifactRef, node: ArtifactJsonNode, before = Number.MAX_SAFE_INTEGER, count = 4): Promise<readonly { text: string; offset: number; final: boolean }[]> {
    if (node.kind !== 'string' || !Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(count) || count < 1 || count > 4) throw Error('artifact-json-text');
    return this.#run(async db => {
      const rows = db.prepare('SELECT offset,lo,hi,units FROM pieces WHERE ref=? AND node=? AND offset<? ORDER BY offset DESC LIMIT ?').all(ref.digest, node.id, before, count);
      const values = [];
      for (const row of rows) {
        const lo = Number(row.lo), hi = Number(row.hi), offset = Number(row.offset);
        if (hi - lo > PIECE + 16 || lo < 0 || hi > ref.bytes) throw Error('artifact-json-range');
        const piece = JSON.parse(`"${dec.decode(await this.#read(ref, lo, hi - lo))}"`) as string;
        // A page boundary need not coincide with an index piece. Never repeat
        // the suffix that the caller has already consumed.
        const text = piece.slice(0, Math.min(piece.length, before - offset));
        values.push({ text, offset, final: offset + text.length === node.units });
      }
      return values;
    });
  }
  async textRange(ref: ArtifactRef, node: ArtifactJsonNode, offset: number): Promise<{ text: string; offset: number; final: boolean }> {
    if (node.kind !== 'string' || !Number.isSafeInteger(offset) || offset < 0 || offset > node.units) throw Error('artifact-json-text-range');
    if (offset === node.units) return { text: '', offset, final: true };
    return this.#run(async db => {
      const row = db.prepare('SELECT offset,lo,hi,units FROM pieces WHERE ref=? AND node=? AND offset<=? ORDER BY offset DESC LIMIT 1').get(ref.digest, node.id, offset);
      if (!row) throw Error('artifact-json-piece-missing');
      const lo = Number(row.lo), hi = Number(row.hi), start = Number(row.offset);
      if (hi - lo > PIECE + 16 || lo < 0 || hi > ref.bytes) throw Error('artifact-json-range');
      const piece = JSON.parse(`"${dec.decode(await this.#read(ref, lo, hi - lo))}"`) as string;
      const text = piece.slice(offset - start);
      return { text, offset, final: offset + text.length === node.units };
    });
  }
}
