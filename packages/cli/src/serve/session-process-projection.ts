import type { StreamFrame } from '@zhixing/core/contracts';
import type { ArtifactStore } from '@zhixing/core/authority';
import { readStreamDisplayPayload } from '@zhixing/core/protocol';
import {
  boundedProcessValue, projectProcessYield, projectProcessEvent, processText, SESSION_PROCESS_METHOD,
  type SessionProcessProjection, type SessionProcessSource,
} from '@zhixing/rpc/session-wire';

export interface SessionProcessProjectionOptions {
  /** Same Server-owned transport as other conversation notifications. */
  readonly publish: (conversationId: string, method: string, value: SessionProcessProjection) => void;
  /** Existing stream authority; never an observer-provided locator. */
  readonly artifacts: ArtifactStore;
}
export const PROCESS_COMPLETION_GRACE_MS = 5_000;
/** Trusted local producer's actual final() result; never an observer claim. */
export interface SessionProcessStreamEnd {
  readonly conversationId: string; readonly runId: string;
  readonly assignmentId: string; readonly finalSeq: number;
}

/** A bounded display consumer of VERIFIED canonical frames. Acceptance joins
 * the bounded materialization before the protocol owner ACKs disposable bytes;
 * it never waits for an observer connection or owns protocol checkpoints.
 * Dispose with the assignment/Server generation. Never replay old artifacts on
 * profile upgrades: the Server chooses the current profile at delivery time. */
export class SessionProcessProjector {
  readonly #queue: { frame: StreamFrame; source: SessionProcessSource; bytes: number;
    readDisplay?: () => ReturnType<typeof readStreamDisplayPayload>; release: () => void }[] = [];
  readonly #pending = new Set<() => void>();
  #bytes = 0; #running = false; #closed = false; #failed = false;
  #lastSeq = 0; #identity?: string; #latestSource?: SessionProcessSource;
  #parentFinished = false; #streamFinished = false; #closing = false;
  #completionTimer?: ReturnType<typeof setTimeout>;
  #idle?: Promise<void>; #resolveIdle?: () => void;
  constructor(readonly options: SessionProcessProjectionOptions, readonly settled: () => void = () => {}) {}
  accept(frame: StreamFrame, readDisplay?: () => ReturnType<typeof readStreamDisplayPayload>): void | Promise<void> {
    if (this.#closed || this.#failed || this.#closing || frame.ref.execution !== 'conversation') return;
    const identity = JSON.stringify([frame.ref.conversationId, frame.ref.runId, frame.assignmentId, frame.streamEpoch]);
    if (this.#identity && this.#identity !== identity) { this.#fail(frame, '过程来源已换代，请刷新正文。'); return; }
    this.#identity = identity;
    if (frame.seq <= this.#lastSeq) return;
    this.#lastSeq = frame.seq;
    this.#latestSource = processSource(frame);
    if (frame.payload.kind === 'provisional-final') {
      this.#streamFinished = true; this.#tryComplete(); return;
    }
    if (frame.payload.kind !== 'agent-yield' && frame.payload.kind !== 'agent-event') return;
    let bytes: number;
    try { boundedProcessValue(frame, 512 * 1024); bytes = Buffer.byteLength(JSON.stringify(frame)); }
    catch { this.#fail(frame, '过程展示超出容量，请刷新正文。'); return; }
    if (this.#queue.length + (this.#running ? 1 : 0) >= 32 || this.#bytes + bytes > 1024 * 1024) {
      this.#fail(frame, '过程展示跟不上输出，请刷新正文。'); return;
    }
    let release!: () => void;
    const accepted = new Promise<void>(resolve => {
      const deadline = setTimeout(() => this.#fail(frame, '过程展示读取超时，请从历史恢复正文。'), PROCESS_COMPLETION_GRACE_MS);
      deadline.unref?.();
      release = () => { clearTimeout(deadline); this.#pending.delete(release); resolve(); };
      this.#pending.add(release);
    });
    this.#queue.push({ frame, source: processSource(frame)!, bytes, readDisplay, release }); this.#bytes += bytes;
    void this.#flush();
    return accepted;
  }
  async #flush(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      while (!this.#closed && !this.#failed && this.#queue.length) {
        const item = this.#queue.shift()!;
        try {
          if (item.frame.payload.kind === 'provisional-final') continue;
          const payload = await (item.readDisplay?.() ?? readStreamDisplayPayload(item.frame.payload, this.options.artifacts));
          if (this.#closed || this.#failed) break;
          const source = item.source;
          if (!source) continue;
          let value: SessionProcessProjection | undefined;
          if (payload.kind === 'agent-yield' && !('ref' in payload.yield)) value = projectProcessYield(source, payload.yield);
          else if (payload.kind === 'agent-event' && !('ref' in payload.event)) {
            value = boundedProcessValue({ version: 1, source, payload: { kind: 'event', event: projectProcessEvent(payload.event) } });
          }
          if (value) this.options.publish(source.conversationId, SESSION_PROCESS_METHOD, value);
        } catch { this.#fail(item.frame, '过程展示读取失败，请刷新正文。'); }
        finally { this.#bytes = Math.max(0, this.#bytes - item.bytes); item.release(); }
      }
    } finally {
      this.#running = false;
      this.#resolveIdle?.(); this.#resolveIdle = undefined; this.#idle = undefined;
    }
  }
  #fail(frame: StreamFrame | undefined, reason: string): void {
    if (this.#failed || this.#closed) return;
    this.#failed = true; this.#queue.length = 0; this.#bytes = 0;
    const source = this.#latestSource ?? (frame ? processSource(frame) : undefined);
    if (source) {
      try { this.options.publish(source.conversationId, SESSION_PROCESS_METHOD,
        { version: 1, source, payload: { kind: 'gap', reason: processText(reason, 512) } }); }
      catch { /* Projection failure never changes protocol acceptance or ACK. */ }
    }
    this.dispose();
  }
  /** Test/shutdown join; per-frame producers await accept, never this whole queue. */
  async idle(): Promise<void> {
    if (!this.#running) return;
    this.#idle ??= new Promise<void>(resolve => { this.#resolveIdle = resolve; });
    await this.#idle;
  }
  /** Parent commitment and canonical stream completion may arrive in either order. */
  finish(): void {
    if (this.#parentFinished || this.#closed) return;
    this.#parentFinished = true;
    this.#completionTimer = setTimeout(() => this.#fail(undefined, '过程尾部未能及时读取，请从历史恢复正文。'), PROCESS_COMPLETION_GRACE_MS);
    this.#completionTimer.unref?.();
    this.#tryComplete();
  }
  /** Local fallback has no stream reader callback for final(); its root forwards
   * the real producer boundary after all its observed append calls have returned. */
  streamEnded(boundary: SessionProcessStreamEnd): void {
    if (this.#closed || this.#failed || this.#closing) return;
    const source = this.#latestSource;
    if (!Number.isSafeInteger(boundary.finalSeq) || boundary.finalSeq <= 0 ||
        (source && (source.conversationId !== boundary.conversationId || source.runId !== boundary.runId ||
          source.assignmentId !== boundary.assignmentId || boundary.finalSeq < this.#lastSeq))) {
      this.#fail(undefined, '过程结束水位不一致，请从历史恢复正文。'); return;
    }
    this.#streamFinished = true; this.#tryComplete();
  }
  #tryComplete(): void {
    if (this.#closed || this.#failed || this.#closing || !this.#parentFinished || !this.#streamFinished) return;
    this.#closing = true;
    void this.idle().then(() => {
      if (!this.#closed && !this.#failed && this.#latestSource) {
        try { this.options.publish(this.#latestSource.conversationId, SESSION_PROCESS_METHOD,
          { version: 1, source: this.#latestSource, payload: { kind: 'closed' } }); }
        catch { /* Parent commitment does not depend on display delivery. */ }
      }
      this.dispose();
    });
  }
  dispose(): void {
    if (this.#closed) return;
    this.#closed = true; clearTimeout(this.#completionTimer); this.#queue.length = 0; this.#bytes = 0;
    for (const release of this.#pending) release();
    // A stalled read still occupies its finite owner slot until it releases;
    // timing out display must not permit unbounded detached artifact reads.
    if (this.#running) void this.idle().then(this.settled); else this.settled();
  }
}

/** Server-generation composition helper; a finite set of display readers,
 * not execution state. Roots only forward verified frames and parent finals. */
export class SessionProcessProjectionOwner {
  readonly #readers = new Map<string, { conversationId: string; runId: string; reader: SessionProcessProjector }>();
  #closed = false; #overflow = false;
  readonly #finished = new Set<string>();
  constructor(readonly options: SessionProcessProjectionOptions) {}
  accept(frame: StreamFrame, readDisplay?: () => ReturnType<typeof readStreamDisplayPayload>): void | Promise<void> {
    if (this.#closed || frame.ref.execution !== 'conversation') return;
    const key = JSON.stringify([frame.ref.conversationId, frame.ref.runId]);
    if (this.#finished.has(key)) return;
    let entry = this.#readers.get(key);
    if (!entry) {
      // A replacement assignment makes this display prefix incomplete; the
      // reader emits a gap rather than trusting arrival order as an authority.
      if (this.#readers.size >= 32) {
        if (!this.#overflow) {
          this.#overflow = true;
          const source = processSource(frame)!;
          try { this.options.publish(source.conversationId, SESSION_PROCESS_METHOD,
            { version: 1, source, payload: { kind: 'gap', reason: '同时运行的过程展示超出容量，请刷新正文。' } }); } catch {}
        }
        return;
      }
      entry = this.#create(frame.ref.conversationId, frame.ref.runId);
    }
    return entry.reader.accept(frame, readDisplay);
  }
  finish(conversationId: string, runId: string): void {
    const identity = JSON.stringify([conversationId, runId]);
    if (this.#closed || this.#finished.has(identity)) return;
    const entry = this.#readers.get(identity) ?? (this.#readers.size < 32 ? this.#create(conversationId, runId) : undefined);
    entry?.reader.finish();
  }
  streamEnded(boundary: SessionProcessStreamEnd): void {
    const identity = JSON.stringify([boundary.conversationId, boundary.runId]);
    if (this.#closed || this.#finished.has(identity)) return;
    const entry = this.#readers.get(identity) ?? (this.#readers.size < 32 ? this.#create(boundary.conversationId, boundary.runId) : undefined);
    entry?.reader.streamEnded(boundary);
  }
  #create(conversationId: string, runId: string) {
    const identity = JSON.stringify([conversationId, runId]);
    const reader = new SessionProcessProjector(this.options, () => {
      if (this.#readers.get(identity)?.reader !== reader) return;
      this.#readers.delete(identity); this.#overflow = false;
      if (!this.#closed) {
        this.#finished.add(identity);
        if (this.#finished.size > 128) this.#finished.delete(this.#finished.values().next().value!);
      }
    });
    const entry = { conversationId, runId, reader }; this.#readers.set(identity, entry); return entry;
  }
  dispose(): void { this.#closed = true; for (const { reader } of this.#readers.values()) reader.dispose(); this.#readers.clear(); this.#finished.clear(); }
}

export function processSource(frame: StreamFrame): SessionProcessSource | undefined {
  if (frame.ref.execution !== 'conversation') return;
  return { conversationId: frame.ref.conversationId, runId: frame.ref.runId,
    assignmentId: frame.assignmentId, streamEpoch: frame.streamEpoch, sourceSeq: frame.seq,
    observedAt: performance.now(),
    ...(frame.meta.turnOrigin ? { turnOrigin: frame.meta.turnOrigin } : {}),
    ...(frame.meta.lineage ? { lineage: frame.meta.lineage } : {}) };
}
