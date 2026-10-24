import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { ArtifactJsonIndex } from '../../authority/artifact-json-index.js';
import type { ArtifactRef } from '../../contracts/index.js';
import { publishedShardSize, readDirectoryView, strictOffsetOf } from './directory-view.js';
import type { TranscriptView } from './types.js';

const MAX = Number.MAX_SAFE_INTEGER, CHUNK = 64 * 1024;
export interface TranscriptBodyCursor {
  readonly shard: string; readonly from: number; readonly to: number; readonly identity: string;
  readonly message: number; readonly block: number; readonly offset: number;
  readonly unsealed?: true;
  /** Last visible tail when this source was admitted. Appends may add a clear. */
  readonly visibleThrough?: { readonly shard: string; readonly to: number; readonly identity: string };
}
export interface TranscriptBodyFragment {
  readonly cursor: TranscriptBodyCursor; readonly runIndex: number; readonly runId?: string;
  readonly message: number; readonly block: number; readonly type: string; readonly role: string;
  readonly text: string; readonly offset: number; readonly length: number; readonly final: boolean;
  readonly toolId?: string; readonly isError?: boolean;
}
export interface TranscriptBodyPage {
  readonly fragments: readonly TranscriptBodyFragment[]; readonly cursor?: TranscriptBodyCursor;
  readonly hasMore: boolean; readonly preparing?: { readonly bytes: number; readonly total: number };
}

/** Legacy JSONL is an append-only source, not a reason to parse an entire
 * shard/run. Scan line boundaries backwards with fixed buffers; reuse the
 * verified byte index under the identity of the open file and exact slice. */
export class TranscriptByteReader {
  readonly json: ArtifactJsonIndex;
  #source?: { file: FileHandle; identity: string; from: number; to: number; key: string; ref?: ArtifactRef;
    expected?: ArtifactRef; hash: ReturnType<typeof createHash>; at: number };
  #closed = false;
  #lastClearAt?: string;
  #view?: TranscriptView;
  readonly #published = new Map<number, number | undefined>();
  readonly #visibility = new Map<string, { checked: NonNullable<TranscriptBodyCursor['visibleThrough']>; tail?: TranscriptBodyCursor; scan?: TranscriptBodyCursor }>();
  get lastClearAt(): string | undefined { return this.#lastClearAt; }
  constructor(readonly directory: string, indexDirectory?: string) {
    this.json = new ArtifactJsonIndex({ readRange: async (ref, offset, bytes) => {
      const source = this.#source;
      if (!source?.ref || source.ref.digest !== ref.digest || offset < 0 || offset + bytes > ref.bytes) throw Error('transcript-byte-source');
      await this.#assertIdentity(source.file, source.identity);
      const buffer = Buffer.alloc(bytes), result = await source.file.read(buffer, 0, bytes, source.from + offset);
      if (result.bytesRead !== bytes) throw Error('transcript-byte-short-read');
      await this.#assertIdentity(source.file, source.identity); return buffer;
    } }, indexDirectory);
  }
  async close(): Promise<void> { this.#closed = true; this.#visibility.clear(); await this.#source?.file.close(); this.#source = undefined; await this.json.close(); }
  async #identity(file: FileHandle): Promise<string> {
    const s = await file.stat({ bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  }
  async #assertIdentity(file: FileHandle, identity: string): Promise<void> {
    if (this.#closed || await this.#identity(file) !== identity) throw Error('transcript-byte-generation-changed');
  }
  /**
   * 每次读取开始时取一次视图：前驱按序号算出，每片只读到视图下的已发布长度。文件短于已发布长度
   * 是损坏；末尾不完整的记录只在旧测试格式转换来的区域内跳过，严格区内同样是损坏。
   */
  async #refreshView(): Promise<void> { this.#view = await readDirectoryView(this.directory) ?? undefined; this.#published.clear(); }
  /** 同一视图下每片的已发布长度只取一次：封存片要读后继片的位置文件头，逐条倒退时不重复读 */
  async #publishedSize(seq: number): Promise<number | null | undefined> {
    const view = this.#view;
    if (!view) return undefined;
    if (this.#published.has(seq)) return this.#published.get(seq);
    const size = await publishedShardSize(this.directory, view, seq);
    if (size !== null) this.#published.set(seq, size);
    return size;
  }
  async #previous(shard?: string): Promise<string | undefined> {
    const view = this.#view;
    if (!view) return;
    const seq = shard ? Number.parseInt(shard, 10) - 1 : view.tailSize > 0 ? view.activeSeq : view.activeSeq - 1;
    return Number.isSafeInteger(seq) && seq >= view.fromSeq && seq >= 1 ? `${String(seq).padStart(6, '0')}.jsonl` : undefined;
  }
  async #missing(seq: number): Promise<undefined> {
    // 视图之后 retention 已撤可见并删除：新视图不含该片即到此为止，否则是损坏
    await this.#refreshView();
    if (this.#view && seq < this.#view.fromSeq) return undefined;
    throw Error('transcript-byte-shard-missing');
  }
  async #line(shard: string, before?: number): Promise<TranscriptBodyCursor | undefined> {
    if (!/^\d{6}\.jsonl$/u.test(shard)) throw Error('transcript-byte-shard');
    const seq = Number.parseInt(shard, 10), view = this.#view;
    const published = await this.#publishedSize(seq);
    if (published === null) return await this.#missing(seq);
    let file: FileHandle;
    try { file = await open(path.join(this.directory, shard), 'r'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return await this.#missing(seq);
    }
    try {
      const stat = (await file.stat()).size, strictFrom = strictOffsetOf(view, seq);
      if (published !== undefined && stat < published) throw Error('transcript-byte-shard-truncated');
      const identity = await this.#identity(file), size = published ?? stat;
      let to = Math.min(size, before ?? size), at = to;
      const sliceIdentity = JSON.stringify([path.resolve(this.directory), shard, identity]);
      const terminal = Buffer.alloc(1);
      if (to > 0 && (await file.read(terminal, 0, 1, to - 1)).bytesRead === 1 && terminal[0] === 10) to--;
      else if (to > strictFrom) throw Error('transcript-byte-shard-truncated');
      const cached = await this.json.sourceSlice(sliceIdentity, to);
      if (cached !== undefined) {
        await this.#assertIdentity(file, identity);
        return { shard, from: cached, to, identity, message: MAX, block: MAX, offset: MAX,
          ...(before === undefined && to === size ? { unsealed: true as const } : {}) };
      }
      at = to;
      const buffer = Buffer.alloc(CHUNK);
      while (at > 0) {
        const from = Math.max(0, at - CHUNK), n = at - from;
        if ((await file.read(buffer, 0, n, from)).bytesRead !== n) throw Error('transcript-byte-short-read');
        for (let i = n - 1; i >= 0; i--) if (buffer[i] === 10) {
          if (from + i + 1 === to) { to--; continue; }
          await this.#assertIdentity(file, identity);
          return { shard, from: from + i + 1, to, identity, message: MAX, block: MAX, offset: MAX,
            ...(before === undefined && to === size ? { unsealed: true as const } : {}) };
        }
        at = from; await new Promise<void>(setImmediate);
      }
      await this.#assertIdentity(file, identity);
      return to > 0 ? { shard, from: 0, to, identity, message: MAX, block: MAX, offset: MAX,
        ...(before === undefined && to === size ? { unsealed: true as const } : {}) } : undefined;
    } finally { await file.close(); }
  }
  async #prepare(cursor: TranscriptBodyCursor, signal?: AbortSignal) {
    const key = JSON.stringify([path.resolve(this.directory), cursor.shard, cursor.identity, cursor.from, cursor.to]);
    if (this.#source?.key === key && await this.#identity(this.#source.file) !== this.#source.identity) {
      await this.#source.file.close(); this.#source = undefined;
    }
    if (this.#source?.key !== key) {
      await this.#source?.file.close(); this.#source = undefined;
      if (!/^\d{6}\.jsonl$/u.test(cursor.shard) || !Number.isSafeInteger(cursor.from) || cursor.from < 0 || !Number.isSafeInteger(cursor.to) || cursor.to <= cursor.from) throw Error('transcript-byte-cursor');
      const file = await open(path.join(this.directory, cursor.shard), 'r');
      try {
        const identity = await this.#identity(file), ref = await this.json.sourceRef(key);
        // Appending a newer run changes mtime/size. An old cursor may continue
        // only after re-verifying its exact immutable line, never merely by PID,
        // filename or the fact that the file grew.
        if (identity !== cursor.identity && (!ref || (await file.stat()).size < cursor.to)) throw Error('transcript-byte-generation-changed');
        this.#source = { file, identity, from: cursor.from, to: cursor.to, key,
          ...(identity === cursor.identity ? { ref } : { expected: ref }), hash: createHash('sha256'), at: 0 };
      } catch (e) { await file.close(); throw e; }
    }
    const source = this.#source!, bytes = cursor.to - cursor.from;
    if (!source.ref) {
      const buffer = Buffer.alloc(CHUNK), end = Math.min(bytes, source.at + 4 * 1024 * 1024);
      while (source.at < end) {
        signal?.throwIfAborted(); const n = Math.min(CHUNK, end - source.at);
        if ((await source.file.read(buffer, 0, n, cursor.from + source.at)).bytesRead !== n) throw Error('transcript-byte-short-read');
        source.hash.update(buffer.subarray(0, n)); source.at += n; await new Promise<void>(setImmediate);
      }
      await this.#assertIdentity(source.file, source.identity);
      if (source.at < bytes) return { ready: false as const, bytes: source.at, total: bytes * 2 };
      source.ref = { digest: `sha256:${source.hash.digest('hex')}`, bytes };
      if (source.expected && (source.expected.digest !== source.ref.digest || source.expected.bytes !== bytes)) {
        await source.file.close(); this.#source = undefined; throw Error('transcript-byte-generation-changed');
      }
    }
    const state = await this.json.prepare(source.ref, signal);
    if (!state.ready) return { ready: false as const, bytes: bytes + state.bytes, total: bytes * 2 };
    await this.json.bindSource(key, source.ref);
    await this.json.bindSourceSlice(JSON.stringify([path.resolve(this.directory), cursor.shard, source.identity]), cursor.from, cursor.to, source.ref);
    return { ready: true as const, ref: source.ref };
  }
  /** Context consumers read metadata and selected fields, never whole runs.
   * The yielded reader is valid until advancing this generator. */
  async *records(signal?: AbortSignal): AsyncGenerator<{ readonly ref: ArtifactRef; readonly json: ArtifactJsonIndex; readonly runIndex: number }> {
    this.#lastClearAt = undefined;
    await this.#refreshView();
    const last = await this.#previous(); let cursor = last ? await this.#line(last) : undefined;
    while (cursor) {
      signal?.throwIfAborted();
      let prepared;
      try {
        prepared = await this.#prepare(cursor, signal);
        while (!prepared.ready) { await new Promise<void>(setImmediate); signal?.throwIfAborted(); prepared = await this.#prepare(cursor, signal); }
      } catch (error) {
        if (!cursor.unsealed || !(error instanceof SyntaxError || error instanceof Error && error.message === 'artifact-json-invalid')) throw error;
        const previous = await this.#line(cursor.shard, cursor.from);
        if (previous) cursor = previous;
        else { const shard = await this.#previous(cursor.shard); cursor = shard ? await this.#line(shard) : undefined; }
        continue;
      }
      const type = await this.json.value(prepared.ref, ['type'], 128);
      if (type === 'clear') {
        const timestamp = await this.json.value(prepared.ref, ['timestamp'], 128);
        if (typeof timestamp === 'string') this.#lastClearAt = timestamp;
        return;
      }
      if (type === 'run') {
        const runIndex = await this.json.value(prepared.ref, ['runIndex'], 128);
        if (!Number.isSafeInteger(runIndex) || Number(runIndex) < 0) throw Error('transcript-byte-run-index');
        yield { ref: prepared.ref, json: this.json, runIndex: Number(runIndex) };
      }
      const previous = await this.#line(cursor.shard, cursor.from);
      if (previous) cursor = previous;
      else { const shard = await this.#previous(cursor.shard); cursor = shard ? await this.#line(shard) : undefined; }
    }
  }
  /** Verify only records appended since this cursor's visibility frontier.
   * The bounded progress state is disposable; a cold reader derives it again
   * from the cursor and original JSONL. No durable second clear authority. */
  async #visible(cursor: TranscriptBodyCursor, tail: TranscriptBodyCursor | undefined, signal?: AbortSignal): Promise<boolean> {
    if (!tail) throw Error('transcript-byte-generation-changed');
    const frontier = cursor.visibleThrough ?? cursor, key = JSON.stringify(frontier);
    let state = this.#visibility.get(key);
    if (!state) {
      state = { checked: frontier }; this.#visibility.set(key, state);
      if (this.#visibility.size > 64) this.#visibility.delete(this.#visibility.keys().next().value!);
    }
    const after = (a: { shard: string; to: number }, b: { shard: string; to: number }) => a.shard > b.shard || a.shard === b.shard && a.to > b.to;
    if (!after(tail, state.checked)) {
      if (after(state.checked, tail)) throw Error('transcript-byte-generation-changed');
      return true;
    }
    if (!state.tail || state.tail.shard !== tail.shard || state.tail.to !== tail.to || state.tail.identity !== tail.identity) {
      state.tail = tail; state.scan = tail;
    }
    for (let n = 0; state.scan && after(state.scan, state.checked) && n < 64; n++) {
      signal?.throwIfAborted();
      const scan = state.scan;
      try {
        const prepared = await this.#prepare(scan, signal);
        if (!prepared.ready) return false;
        if (await this.json.value(prepared.ref, ['type'], 128) === 'clear') throw Error('transcript-byte-generation-changed');
      } catch (error) {
        if (!scan.unsealed || !(error instanceof SyntaxError || error instanceof Error && error.message === 'artifact-json-invalid')) throw error;
      }
      state.scan = await this.#line(scan.shard, scan.from);
      if (!state.scan) { const previous = await this.#previous(scan.shard); state.scan = previous ? await this.#line(previous) : undefined; }
    }
    if (state.scan && after(state.scan, state.checked)) return false;
    state.checked = tail; state.tail = undefined; state.scan = undefined;
    return true;
  }
  async page(input: { cursor?: TranscriptBodyCursor; forward?: boolean; signal?: AbortSignal } = {}): Promise<TranscriptBodyPage> {
    input.signal?.throwIfAborted();
    let cursor = input.cursor;
    await this.#refreshView();
    const shard = await this.#previous(), tail = shard ? await this.#line(shard) : undefined;
    if (cursor && !await this.#visible(cursor, tail, input.signal)) return { fragments: [], cursor, hasMore: true, preparing: { bytes: 0, total: 1 } };
    const visibleThrough = cursor?.visibleThrough ?? (tail ? { shard: tail.shard, to: tail.to, identity: tail.identity } : undefined);
    if (!cursor) cursor = tail;
    for (let scanned = 0; cursor && scanned < 64; scanned++) {
      cursor = { ...cursor, visibleThrough };
      input.signal?.throwIfAborted();
      let prepared;
      try { prepared = await this.#prepare(cursor, input.signal); }
      catch (error) {
        // The existing JSONL durability boundary is the complete record. Only
        // an incomplete final record may be ignored; a bad committed interior
        // line, IO failure or identity change must remain an explicit failure.
        if (!input.forward && cursor.unsealed && (error instanceof SyntaxError || error instanceof Error && error.message === 'artifact-json-invalid')) {
          const previous = await this.#line(cursor.shard, cursor.from);
          if (previous) cursor = previous;
          else { const shard = await this.#previous(cursor.shard); cursor = shard ? await this.#line(shard) : undefined; }
          continue;
        }
        throw error;
      }
      if (!prepared.ready) return { fragments: [], cursor, hasMore: true, preparing: { bytes: prepared.bytes, total: prepared.total } };
      const ref = prepared.ref, value = (keys: readonly (string | number)[], budget = 4096) => this.json.value(ref, keys, budget);
      const type = await value(['type']);
      if (type === 'clear') return { fragments: [], hasMore: false };
      const messages = await this.json.node(ref, ['messages']);
      if (type !== 'run' || messages?.kind !== 'array' || cursor.message < 0) {
        if (input.forward) return { fragments: [], hasMore: false };
        const previous = await this.#line(cursor.shard, cursor.from);
        if (previous) cursor = previous;
        else { const shard = await this.#previous(cursor.shard); cursor = shard ? await this.#line(shard) : undefined; }
        continue;
      }
      let message = cursor.message === MAX ? messages.units - 1 : cursor.message;
      if (message >= messages.units) throw Error('transcript-byte-message');
      if (message < 0) { cursor = { ...cursor, message }; continue; }
      const content = await this.json.node(ref, ['messages', message, 'content']);
      if (content?.kind !== 'array') throw Error('transcript-byte-content');
      let block = cursor.block === MAX ? content.units - 1 : cursor.block;
      if (block < 0) { cursor = { ...cursor, message: message - 1, block: MAX, offset: MAX }; continue; }
      if (block >= content.units) return { fragments: [], cursor, hasMore: false };
      const keys = ['messages', message, 'content', block], kind = await value([...keys, 'type']), role = await value(['messages', message, 'role']);
      if (typeof kind !== 'string' || typeof role !== 'string') throw Error('transcript-byte-kind');
      const field = kind === 'text' ? 'text' : kind === 'thinking' ? 'thinking' : kind === 'tool_use' ? 'name' : kind === 'tool_result' ? 'content' : undefined;
      const node = field ? await this.json.node(ref, [...keys, field]) : undefined;
      const offset = cursor.offset;
      const parts = node?.kind === 'string' ? input.forward ? [await this.json.textRange(ref, node, offset)] : await this.json.text(ref, node, offset) :
        input.forward || offset !== 0 ? [{ text: '[图像材料]', offset: 0, final: true }] : [];
      const runIndex = await value(['runIndex']), runId = await value(['runId']);
      if (!Number.isSafeInteger(runIndex)) throw Error('transcript-byte-run-index');
      const toolId = kind === 'tool_use' ? await value([...keys, 'id']) : kind === 'tool_result' ? await value([...keys, 'toolUseId']) : undefined;
      const isError = kind === 'tool_result' && await value([...keys, 'isError']) === true;
      const fragments = parts.map(part => ({ ...part, cursor: { ...cursor!, message, block, offset: part.offset }, runIndex: runIndex as number,
        ...(typeof runId === 'string' ? { runId } : {}), message, block, type: kind, role, length: node?.units ?? 6,
        ...(typeof toolId === 'string' ? { toolId } : {}), ...(isError ? { isError } : {}) }));
      const next = input.forward ? (parts[0]!.final ? { block: block + 1, offset: 0 } : { block, offset: parts[0]!.offset + parts[0]!.text.length }) :
        (parts.at(-1)?.offset ?? 0) === 0 ? { block: block - 1, offset: MAX } : { block, offset: parts.at(-1)!.offset };
      cursor = { ...cursor, message, ...next };
      if (fragments.length) return { fragments, cursor, hasMore: input.forward ? cursor.block < content.units : true };
    }
    return { fragments: [], ...(cursor ? { cursor: { ...cursor, visibleThrough } } : {}), hasMore: !!cursor };
  }
}
