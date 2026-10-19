import { userMessageFromTurnInput } from '@zhixing/core';
import type { ConversationMessageStatus } from '@zhixing/core/conversation/application';
import type { ArtifactStore, AuthorityCommitLog, DurableLogCheckpoint, DurableProjectionReadContext } from '@zhixing/core/authority';
import type { ConversationRunState, UserTurnInput } from '@zhixing/core/contracts';
import { validateNonEmptyUserTurnInput } from '@zhixing/core/protocol';
import { currentMaintenanceAbortSignal, isHoldingMaintenanceExclusion, maintenanceRetryDelayMs,
  StorageMaintenanceCancelledError, waitForMaintenanceRetry } from '@zhixing/core/resources';
import { consumedInitialRuns, projectInputDelivery, isMessageDeliveryFact, type MessageDeliveryRecord } from './conversation-message-delivery.js';
import type { ConversationReadIndex, InputPointer, TimelinePointer } from './conversation-read-index.js';
import type { ConversationBaseSource } from './conversation-base-source.js';
import { readConversationRunViewMetadata } from './conversation-run-state-view.js';

type LocatedInput = { pointer: InputPointer; initial: boolean; identity?: NonNullable<ConversationMessageStatus['message']['inputIdentity']> };
function emptyFacts() {
  return {
    assignedById: new Map<string, { record: { runId: string } }>(), assignmentByRun: new Map<string, string>(),
    stateByRun: new Map<string, { state: ConversationRunState }>(), cancelOrigins: new Map<string, ConversationRunState>(),
    uncertainOrigins: new Map<string, ConversationRunState>(), supersedeStartedObservations: new Set<string>(),
    committedByAssignment: new Set<string>(), openInputAssignments: new Map<string, string>(),
    closedInputAssignments: new Set<string>(), consumed: new Set<string>(), inputs: new Map<string, LocatedInput>(),
    initialConsumed: new Set<string>(),
    deleted: false, localClear: 0, baseClear: 0, baseHidden: false,
  };
}
type Facts = ReturnType<typeof emptyFacts>;

/** A query retains control facts and source locators, never dispatch or transcript bodies.
 * A completed page is resumable after pressure; incomplete candidates never escape. */
export class ConversationMessageInputReader {
  #generation = 0;
  #base = emptyFacts();
  #baseSource: ConversationBaseSource | undefined;
  #baseView: DurableProjectionReadContext | undefined;
  #baseDirectoryView: DurableProjectionReadContext | undefined;
  #baseFacts: Facts | undefined;
  #cache: { state: Facts; cursor: DurableLogCheckpoint } | undefined;
  constructor(readonly log: AuthorityCommitLog, readonly directory: ConversationReadIndex,
    readonly artifacts: ArtifactStore, readonly conversationId: string) {}

  installBase(records: readonly { lsn: number; at: string; stream: string; body: unknown }[]): void {
    const state = emptyFacts();
    for (const [item, record] of records.entries()) if (record.stream === 'run:' + this.conversationId && isMessageDeliveryFact(record.body)) {
      this.#fold(state, record.body, record.lsn, item);
    }
    this.#baseSource = undefined; this.#baseView = undefined; this.#baseDirectoryView = undefined; this.#baseFacts = undefined;
    this.#base = state; this.#generation++; this.#cache = undefined;
  }

  installBaseView(source: ConversationBaseSource): void {
    this.#baseSource = source;
    this.#baseView = {
      get: key => source.read(view => view.get(key)),
      scan: (range, limit) => source.read(view => view.scan(range, limit)),
    };
    this.#baseDirectoryView = {
      get: key => source.read(view => view.get('directory/' + key)),
      scan: async (range, limit) => {
        const prefix = 'directory/';
        const query = { ...(range.gte ? { gte: prefix + range.gte } : {}), ...(range.gt ? { gt: prefix + range.gt } : {}), ...(range.lt ? { lt: prefix + range.lt } : {}) };
        const page = await source.read(view => view.scan(query, limit));
        return { entries: page.entries.map(entry => ({ key: entry.key.slice(prefix.length), value: entry.value })),
          ...(page.continuation ? { continuation: page.continuation.slice(prefix.length) } : {}) };
      },
    };
    this.#baseFacts = undefined;
    this.#base = emptyFacts();
    this.#generation++; this.#cache = undefined;
  }

  async #loadBaseFacts(): Promise<Facts> {
    if (this.#baseFacts) return this.#baseFacts;
    const view = this.#baseView;
    if (!view) return this.#base;
    const id = this.conversationId, p = JSON.stringify(id) + ':timeline:';
    // The legacy outside-history view still folds its message facts (package
    // 1b owns its bounded replacement). Preserve complete paging here. Exact
    // messageStatus uses the separate identity lookup and never takes this path.
    const pointers: InputPointer[] = [];
    let after: string | undefined;
    do {
      if (currentMaintenanceAbortSignal().aborted) throw new StorageMaintenanceCancelledError();
      const page = await this.#baseDirectoryView!.scan({ ...(after ? { gt: after } : { gte: p }), lt: p + '\uffff' }, 64);
      for (const entry of page.entries) {
        const value = entry.value as unknown as TimelinePointer;
        if (value.kind === 'input') pointers.push(value.input);
      }
      after = page.continuation ? page.entries.at(-1)!.key : undefined;
      if (after) await new Promise<void>(setImmediate);
    } while (after);
    const runs = [...new Set(pointers.map(pointer => pointer.runId))];
    const selected = await readConversationRunViewMetadata(view, id, { current: true, runs });
    const state = selected.state, facts = emptyFacts();
    for (const [assignmentId, assigned] of state.assignedById) facts.assignedById.set(assignmentId, { record: { runId: assigned.record.runId } });
    for (const [runId, value] of state.assignmentByRun) facts.assignmentByRun.set(runId, value);
    for (const [runId, value] of state.stateByRun) facts.stateByRun.set(runId, value);
    for (const [assignmentId, value] of state.cancelOrigins) facts.cancelOrigins.set(assignmentId, value);
    for (const [assignmentId, value] of state.uncertainOrigins) facts.uncertainOrigins.set(assignmentId, value);
    for (const assignmentId of state.supersedeStartedObservations.keys()) facts.supersedeStartedObservations.add(assignmentId);
    for (const assignmentId of state.committedByAssignment.keys()) facts.committedByAssignment.add(assignmentId);
    for (const [runId, value] of state.openInputAssignments) facts.openInputAssignments.set(runId, value);
    for (const assignmentId of state.closedInputAssignments) facts.closedInputAssignments.add(assignmentId);
    facts.deleted = state.deleted;
    facts.baseClear = state.clearedThroughLsn;
    facts.baseHidden = false;
    const first = new Map<string, number>();
    for (const pointer of pointers) if (!first.has(pointer.runId) || pointer.position < first.get(pointer.runId)!) first.set(pointer.runId, pointer.position);
    for (const pointer of pointers) {
      const initial = pointer.initial ?? first.get(pointer.runId) === pointer.position;
      facts.inputs.set(pointer.inputKey, { initial, pointer, ...(pointer.identity ? { identity: pointer.identity } : {}) });
      const consumedKey = JSON.stringify(id) + (initial ? ':initial-consumed:' + JSON.stringify(pointer.runId) : ':input-consumed:' + JSON.stringify(pointer.inputKey));
      if (await this.#baseDirectoryView!.get(consumedKey) === true) {
        if (initial) facts.initialConsumed.add(pointer.runId); else facts.consumed.add(pointer.inputKey);
      }
    }
    this.#baseFacts = facts;
    return facts;
  }

  #fold(state: Facts, body: MessageDeliveryRecord, lsn: number, item: number, checkpoint?: DurableLogCheckpoint): void {
    switch (body.t) {
      case 'admitted': case 'run-input-appended': {
        const identity = body.ingress.turnOrigin?.messageIdentity;
        state.inputs.set(body.ingressKey, { initial: body.t === 'admitted', ...(identity ? { identity } : {}),
          pointer: { runId: body.runId, inputKey: body.ingressKey, lsn, item,
            position: body.t === 'admitted' ? body.queuedPosition : body.position,
            identity: identity ?? { id: body.ingress.ingressId, source: { kind: 'user' } }, ...(checkpoint ? { checkpoint } : {}) } });
        break;
      }
      case 'assigned': state.assignedById.set(body.assignmentId, { record: { runId: body.runId } });
        state.assignmentByRun.set(body.runId, body.assignmentId); break;
      case 'cancel-fence': {
        const run = state.assignedById.get(body.assignmentId)?.record.runId;
        const previous = run && state.stateByRun.get(run)?.state;
        if (previous) state.cancelOrigins.set(body.assignmentId, previous);
        break;
      }
      case 'supersede-started-observed': state.supersedeStartedObservations.add(body.assignmentId); break;
      case 'assignment-superseded': {
        const run = state.assignedById.get(body.assignmentId)?.record.runId;
        if (run && state.assignmentByRun.get(run) === body.assignmentId) state.assignmentByRun.delete(run);
        break;
      }
      case 'state': {
        const previous = state.stateByRun.get(body.runId)?.state, assignment = state.assignmentByRun.get(body.runId);
        if (body.state === 'uncertain' && previous && previous !== 'uncertain' && assignment) state.uncertainOrigins.set(assignment, previous);
        state.stateByRun.set(body.runId, { state: body.state });
        if (body.state === 'failed' && body.assignmentId !== undefined) state.assignmentByRun.delete(body.runId);
        break;
      }
      case 'resolution': if (body.fact.resolution && body.fact.subject.execution === 'conversation' &&
          state.assignmentByRun.get(body.runId) === body.fact.subject.assignmentId) state.assignmentByRun.delete(body.runId); break;
      case 'committed': state.committedByAssignment.add(body.assignmentId); break;
      case 'run-input-opened': state.openInputAssignments.set(body.runId, body.assignmentId); break;
      case 'run-input-closed': state.openInputAssignments.delete(body.runId); state.closedInputAssignments.add(body.assignmentId); break;
      case 'run-input-consumed': for (const key of body.ingressKeys) state.consumed.add(key); break;
      case 'session-meta': if (body.operation === 'delete') state.deleted = true; break;
      case 'session-lifecycle':
        if (body.mutation === 'delete') state.deleted = true;
        else if (checkpoint) { state.localClear = lsn; state.baseHidden = true; } else state.baseClear = lsn;
        break;
    }
  }

  async #prepare(signal: AbortSignal): Promise<{ state: Facts; cursor: DurableLogCheckpoint } | undefined> {
    const generation = this.#generation, cached = this.#cache;
    const head = await this.log.checkpoint(cached?.cursor);
    if (generation !== this.#generation) return;
    if (cached && head === cached.cursor) return cached;
    if (cached) {
      if (cached.cursor.logId !== head.logId || cached.cursor.lsn > head.lsn) throw Error('Message input source prefix changed');
      if (cached.cursor.lsn) await this.log.readEnvelopeAt(cached.cursor);
    }
    const base = cached ? cached.state : this.#baseSource ? await this.#loadBaseFacts() : this.#base;
    if (generation !== this.#generation) return;
    let state = structuredClone(base), after = cached?.cursor.lsn ?? 0;
    for (;;) {
      if (signal.aborted) throw new StorageMaintenanceCancelledError();
      const page = await this.directory.messagePage(this.conversationId, after);
      const selected = page.filter(cursor => cursor.lsn <= head.lsn);
      const envelopes = await this.log.readEnvelopesAt<unknown>(selected);
      for (const [index, envelope] of envelopes.entries()) {
        for (const [item, record] of envelope.entries.entries()) if (record.stream === 'run:' + this.conversationId && isMessageDeliveryFact(record.body)) {
          this.#fold(state, record.body, envelope.lsn, item, selected[index]!);
        }
        after = envelope.lsn;
      }
      if (generation !== this.#generation) return;
      if (signal.aborted) throw new StorageMaintenanceCancelledError();
      const candidate = { state, cursor: page.length < 64 || page.at(-1)!.lsn >= head.lsn ? head : selected.at(-1)! };
      // Readers prepare private candidates without holding an owner/Authority
      // exclusion. Publishing a validated page is synchronous; concurrent reads
      // cannot regress the cache or mutate a page another reader retained.
      if (!this.#cache || this.#cache.cursor.lsn <= candidate.cursor.lsn) this.#cache = candidate;
      if (page.length < 64 || page.at(-1)!.lsn >= head.lsn) {
        return candidate;
      }
      // Retain only fully validated pages; the next candidate owns its maps.
      state = structuredClone(state);
      await new Promise<void>(setImmediate);
    }
  }

  async #read(messageId?: string): Promise<{ inputs: readonly ConversationMessageStatus[]; truncated: boolean;
    interruptibleRuns: readonly { runId: string; state: ConversationRunState }[] }> {
    const signal = currentMaintenanceAbortSignal(); let deadline: number | undefined;
    let changeDeadline: number | undefined;
    for (;;) {
      if (signal.aborted) throw new StorageMaintenanceCancelledError();
      try {
        const result = await (async () => {
          const generation = this.#generation, prepared = await this.#prepare(signal);
          if (!prepared || generation !== this.#generation) return;
          const { state, cursor: head } = prepared, consumed = new Set(consumedInitialRuns(state));
          for (const run of state.initialConsumed) consumed.add(run);
          const located = [...state.inputs.values()].sort((a, b) => a.pointer.position - b.pointer.position);
          const candidates = located.filter(input => messageId !== undefined ? input.identity?.id === messageId :
            !state.deleted && (input.pointer.checkpoint ? input.pointer.lsn > state.localClear : !state.baseHidden && input.pointer.lsn > state.baseClear))
            .map(input => ({ input, delivery: projectInputDelivery(state, input.pointer.runId,
              input.initial ? consumed.has(input.pointer.runId) : state.consumed.has(input.pointer.inputKey)) }))
            .filter(value => messageId !== undefined || value.delivery.state !== 'committed' || !value.delivery.consumed);
          const active = new Map(candidates.filter(value => value.input.identity?.source.kind === 'conversation' &&
            ['queued', 'dispatched', 'running', 'cancel-requested'].includes(value.delivery.state))
            .map(value => [value.delivery.runId, value.delivery]));
          const activeRuns = [...active.values()].filter(value => value.state !== 'queued');
          const interruptibleRuns = (activeRuns.length ? activeRuns : [...active.values()]).slice(0, 2)
            .map(({ runId, state }) => ({ runId, state }));
          const uncertain = candidates.filter(value => value.delivery.state === 'uncertain');
          const remaining = Math.max(0, 200 - uncertain.length);
          const selected = messageId !== undefined ? candidates.slice(0, 1) : [...uncertain,
            ...(remaining ? candidates.filter(value => value.delivery.state !== 'uncertain').slice(-remaining) : [])]
            .slice(0, 200).sort((a, b) => a.input.pointer.position - b.input.pointer.position);
          const inputs: ConversationMessageStatus[] = [];
          for (let start = 0; start < selected.length; start += 64) {
            if (signal.aborted) throw new StorageMaintenanceCancelledError();
            const batch = selected.slice(start, start + 64);
            const values = await this.directory.inputsAt(this.conversationId, batch.map(value => value.input.pointer));
            for (const [index, { input, delivery }] of batch.entries()) {
            const value = values[index];
            if (!value) throw Error('Message input locator is missing');
            const stored = value.input;
            const decoded = typeof stored === 'object' && stored !== null && Object.keys(stored).length === 1 && 'ref' in stored
              ? JSON.parse(Buffer.from(await this.artifacts.get(stored.ref)).toString('utf8')) as UserTurnInput : stored;
            const userInput = validateNonEmptyUserTurnInput(decoded);
            inputs.push({ ...delivery, message: { ...userMessageFromTurnInput(userInput),
              ...(input.identity ? { inputIdentity: structuredClone(input.identity) } : {}) } });
            }
          }
          if (signal.aborted) throw new StorageMaintenanceCancelledError();
          const current = await this.log.checkpoint(head);
          // A different conversation or resource sidecar may append while the
          // bodies are read. Only this conversation's new message facts require
          // another snapshot; the physical prefix is still checked above.
          const changed = current !== head && (await this.directory.messagePage(this.conversationId, head.lsn)).length > 0;
          if (generation !== this.#generation || changed) return;
          return { inputs, truncated: candidates.length > 200, interruptibleRuns };
        })();
        if (result) return result;
        changeDeadline ??= performance.now() + 5_000;
        if (performance.now() >= changeDeadline) throw new Error('Message input source did not stabilize before the read deadline');
      } catch (error) {
        const delay = maintenanceRetryDelayMs(error);
        if (delay === undefined || isHoldingMaintenanceExclusion() || signal.aborted) throw error;
        deadline ??= performance.now() + 5000;
        if (performance.now() >= deadline) throw error;
        await waitForMaintenanceRetry(Math.min(delay, 250, Math.max(1, deadline - performance.now())));
      }
    }
  }

  async messageStatus(id: string): Promise<ConversationMessageStatus | undefined> {
    const signal = currentMaintenanceAbortSignal(); let deadline: number | undefined;
    for (;;) {
      if (signal.aborted) throw new StorageMaintenanceCancelledError();
      try {
        const generation = this.#generation, selected = await this.directory.messageMetadata(this.conversationId, id);
        if (!selected.value) return undefined;
        const { pointer, status, consumed, closed } = selected.value;
        const located = (await this.directory.inputsAt(this.conversationId, [pointer]))[0];
        if (!located) throw Error('Message input locator is missing');
        const { input } = located;
        const decoded = input && typeof input === 'object' && 'ref' in input
          ? JSON.parse(Buffer.from(await this.artifacts.get(input.ref)).toString('utf8')) as UserTurnInput : input;
        const userInput = validateNonEmptyUserTurnInput(decoded);
        if (signal.aborted) throw new StorageMaintenanceCancelledError();
        if (generation !== this.#generation) continue;
        return { runId: pointer.runId, state: status.state, consumed,
          disposition: consumed ? 'consumed' : closed || ['committed', 'failed', 'cancelled'].includes(status.state) ? 'stopped' : 'pending',
          message: { ...userMessageFromTurnInput(userInput), inputIdentity: structuredClone(pointer.identity) } };
      } catch (error) {
        const delay = maintenanceRetryDelayMs(error);
        if (delay === undefined || isHoldingMaintenanceExclusion() || signal.aborted) throw error;
        deadline ??= performance.now() + 5000;
        if (performance.now() >= deadline) throw error;
        await waitForMaintenanceRetry(Math.min(delay, 250));
      }
    }
  }
  messageInputsOutsideHistory() { return this.#read(); }
}
