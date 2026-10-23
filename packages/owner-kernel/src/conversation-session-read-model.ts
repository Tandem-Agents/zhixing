import { awaitAuthorityPreparation, type AuthorityCommitLog, type DurableLogCheckpoint } from '@zhixing/core/authority';
import type { ConversationReadIndex } from './conversation-read-index.js';
import type { CommitEnvelope, LogicalRecord } from '@zhixing/core/contracts';
import { SerialTaskQueue } from '@zhixing/core/persistence';
import { protocolDigest } from '@zhixing/core/protocol';
import {
  currentMaintenanceAbortSignal, currentMaintenanceUrgency, isHoldingMaintenanceExclusion,
  maintenanceRetryDelayMs, runWithMaintenanceUrgency, StorageMaintenanceCancelledError,
} from '@zhixing/core/resources';

/** The owner reducer remains the single definition of advancement and its shared
 * session revision rules. Directory reads never hydrate execution artifacts. */
export class ConversationSessionReadModel<State extends { readonly domainRevision: number }> {
  readonly #operations = new SerialTaskQueue();
  #generation = 0;
  #base: readonly CommitEnvelope<unknown>[] = [];
  #baseSource: { current(): Promise<State>; atRevision(through: number): Promise<State> } | undefined;
  #cache: { state: State; cursor: DurableLogCheckpoint } | undefined;

  constructor(
    readonly log: AuthorityCommitLog,
    readonly directory: ConversationReadIndex,
    readonly conversationId: string,
    readonly empty: () => State,
    readonly reduce: (state: State, record: LogicalRecord<unknown>, envelope: CommitEnvelope<unknown>, throughRevision?: number) => Promise<State>,
  ) {}

  installBase(records: readonly { lsn: number; at: string; stream: string; body: unknown }[]): void {
    const grouped = new Map<string, { lsn: number; at: string; entries: LogicalRecord<unknown>[] }>();
    for (const record of records) {
      if (record.stream !== 'run:' + this.conversationId && record.stream !== 'session-activity:' + this.conversationId && record.stream !== 'publish' && record.stream !== 'final-outbox') continue;
      if (record.stream.startsWith('run:') && !this.#relevant(record) && !(record.body && typeof record.body === 'object' && 'kind' in record.body && record.body.kind === 'content-asset-index')) continue;
      const key = record.lsn + '\0' + record.at;
      const group = grouped.get(key) ?? { lsn: record.lsn, at: record.at, entries: [] };
      group.entries.push({ stream: record.stream, body: structuredClone(record.body) });
      grouped.set(key, group);
    }
    this.#base = [...grouped.values()].sort((a, b) => a.lsn - b.lsn || a.at.localeCompare(b.at)).map(group => {
      const payload = { v: 1 as const, ...group };
      return { ...payload, envelopeDigest: protocolDigest('CommitEnvelope', 1, payload) };
    });
    this.#baseSource = undefined;
    this.#generation++;
    this.#cache = undefined;
  }

  installBaseSource(source: { current(): Promise<State>; atRevision(through: number): Promise<State> }): void {
    this.#base = [];
    this.#baseSource = source;
    this.#generation++;
    this.#cache = undefined;
  }

  #relevant(record: LogicalRecord<unknown>): boolean {
    return record.stream === 'run:' + this.conversationId && !!record.body && typeof record.body === 'object' &&
      't' in record.body && ['advancement-event', 'session-meta', 'session-control', 'session-lifecycle', 'committed'].includes(String(record.body.t));
  }

  async #prepare(signal: AbortSignal): Promise<void> {
    const generation = this.#generation, base = this.#base, cached = this.#cache;
    const head = await this.log.checkpoint(cached?.cursor);
    if (generation !== this.#generation) return;
    // Only Authority can preserve an already verified read view. An equal LSN
    // from a new checkpoint still requires validating our old source prefix.
    if (cached && head === cached.cursor) return;
    if (cached?.cursor.lsn) await this.log.readEnvelopeAt(cached.cursor);
    if (cached && cached.cursor.logId !== head.logId) throw new Error('Session read prefix changed');
    if (cached && cached.cursor.lsn >= head.lsn) return;
    let state = cached ? structuredClone(cached.state) : this.#baseSource ? await this.#baseSource.current() : this.empty();
    let afterLsn = cached?.cursor.lsn ?? 0;
    const fold = async (envelope: CommitEnvelope<unknown>) => {
      if (signal.aborted) throw new StorageMaintenanceCancelledError();
      for (const record of envelope.entries) if (this.#relevant(record)) state = await this.reduce(state, record, envelope);
    };
    if (!cached) for (const envelope of base) await fold(envelope);
    for (;;) {
      const page = await this.directory.sessionPage(this.conversationId, afterLsn);
      const selected = page.filter(checkpoint => checkpoint.lsn <= head.lsn);
      for (const envelope of await this.log.readEnvelopesAt(selected)) {
        await fold(envelope);
        afterLsn = envelope.lsn;
      }
      if (page.length < 64 || page.at(-1)!.lsn >= head.lsn) break;
      await new Promise<void>(setImmediate);
    }
    await this.#operations.run(async () => {
      if (signal.aborted) throw new StorageMaintenanceCancelledError();
      if (generation !== this.#generation) return;
      if (!this.#cache || this.#cache.cursor.lsn <= head.lsn) this.#cache = { state, cursor: head };
    });
  }

  async read<Value>(select: (state: State) => Value): Promise<Value> {
    return this.#withRetry(async signal => {
      await this.#prepare(signal);
      if (signal.aborted) throw new StorageMaintenanceCancelledError();
      return this.#cache ? { value: select(this.#cache.state) } : undefined;
    });
  }

  /** Only an actual retry folds the old prefix. Ordinary reads retain no historical lists. */
  async beforeRevision<Value>(revision: (state: State) => number | undefined, select: (state: State) => Value): Promise<Value | undefined> {
    return this.#withRetry(async signal => {
      await this.#prepare(signal);
      if (signal.aborted) throw new StorageMaintenanceCancelledError();
      const cached = this.#cache, generation = this.#generation, base = this.#base;
      if (!cached) return undefined;
      const before = revision(cached.state);
      if (before === undefined) return { value: undefined };
      const through = before - 1;
      const initialBase = this.#baseSource ? await this.#baseSource.current() : undefined;
      let state = initialBase ? initialBase.domainRevision > through
        ? await this.#baseSource!.atRevision(through) : initialBase : this.empty(), afterLsn = 0;
      const fold = async (envelope: CommitEnvelope<unknown>) => {
        for (const record of envelope.entries) {
          if (signal.aborted) throw new StorageMaintenanceCancelledError();
          if (state.domainRevision >= through) break;
          if (this.#relevant(record)) state = await this.reduce(state, record, envelope, through);
        }
      };
      for (const envelope of base) {
        if (state.domainRevision >= through) break;
        await fold(envelope);
      }
      while (state.domainRevision < through) {
        const page = await this.directory.sessionPage(this.conversationId, afterLsn);
        const selected = page.filter(checkpoint => checkpoint.lsn <= cached.cursor.lsn);
        for (const envelope of await this.log.readEnvelopesAt(selected)) {
          if (state.domainRevision >= through) break;
          await fold(envelope);
          afterLsn = envelope.lsn;
        }
        if (page.length < 64 || page.at(-1)!.lsn >= cached.cursor.lsn) break;
        await new Promise<void>(setImmediate);
      }
      if (signal.aborted) throw new StorageMaintenanceCancelledError();
      if (generation !== this.#generation) return undefined;
      if (state.domainRevision !== through) throw new Error('Session retry prefix is incomplete');
      return { value: select(state) };
    });
  }

  async #withRetry<Value>(operation: (signal: AbortSignal) => Promise<{ value: Value } | undefined>): Promise<Value> {
    const external = currentMaintenanceAbortSignal(), urgency = currentMaintenanceUrgency();
    const deadline = new AbortController(), signal = AbortSignal.any([external, deadline.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined, pressure: unknown;
    try {
      for (;;) {
        if (external.aborted) throw new StorageMaintenanceCancelledError();
        if (deadline.signal.aborted) throw pressure;
        try {
          const result = await runWithMaintenanceUrgency(() => urgency, signal, async () => {
            return operation(signal);
          });
          if (result !== undefined) return result.value;
        } catch (error) {
          if (external.aborted) throw new StorageMaintenanceCancelledError();
          if (deadline.signal.aborted) throw pressure ?? error;
          const delay = maintenanceRetryDelayMs(error);
          if (delay === undefined || isHoldingMaintenanceExclusion()) throw error;
          if (await awaitAuthorityPreparation(error)) continue;
          pressure = error;
          timer ??= setTimeout(() => deadline.abort(), 5_000);
          await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(wait); signal.removeEventListener('abort', finish); resolve(); };
            const wait = setTimeout(finish, Math.max(1, Math.min(delay, 250)));
            signal.addEventListener('abort', finish, { once: true });
            if (signal.aborted) finish();
          });
        }
      }
    } finally { if (timer) clearTimeout(timer); }
  }
}
