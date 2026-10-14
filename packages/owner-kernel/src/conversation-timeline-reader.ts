import { artifactJsonIndex, type ArtifactStore } from '@zhixing/core/authority';
import type { ConversationBodyCursor, ConversationBodyFragment, ConversationBodyPage, UserTurnInput } from '@zhixing/core/contracts';
import { ConversationBodyReader } from './conversation-body-reader.js';
import { ConversationReadIndex, type TimelinePointer, type ReadMeta } from './conversation-read-index.js';

const MAX = Number.MAX_SAFE_INTEGER;
/** One owner history merges committed bodies and their uncovered original inputs.
 * Ordering is authority envelope/item order; source bodies remain range-read. */
export class ConversationTimelineReader {
  constructor(readonly directory: ConversationReadIndex, readonly artifacts: ArtifactStore, readonly conversationId: string, readonly ownerEpoch: number) {}
  async page(input: { cursor?: ConversationBodyCursor; direction?: 'forward' | 'reverse'; runId?: string }): Promise<ConversationBodyPage> {
    const state = { ...await this.directory.state(this.conversationId) }, cursor = input.cursor;
    if (state.deleted || cursor && (!cursor.history || cursor.conversationId !== this.conversationId || cursor.ownerEpoch !== this.ownerEpoch || cursor.clearId !== state.clearId))
      return { fragments: [], hasMore: !state.deleted, reset: true };
    const throughLsn = cursor?.history?.throughLsn ?? (await this.directory.log.checkpoint()).lsn;
    const page = await this.#page(input, throughLsn, state);
    const after = await this.directory.state(this.conversationId);
    return after.deleted || after.clearId !== state.clearId ? { fragments: [], hasMore: !after.deleted, reset: true } : { ...page, historyThroughInputLsn: throughLsn };
  }
  async #page(input: { cursor?: ConversationBodyCursor; direction?: 'forward' | 'reverse'; runId?: string }, throughLsn: number, state: ReadMeta): Promise<ConversationBodyPage> {
    const clearId = state.clearId, fragments: ConversationBodyFragment[] = [];
    let cursor = input.cursor, after = cursor?.history?.after ? cursor.history.key : undefined;
    let entries: readonly TimelinePointer[], selectedVisible = false;
    if (cursor?.history && !cursor.history.after) {
      const selected = await this.directory.timelineAt(this.conversationId, cursor.history.key);
      if (!selected || !await this.directory.timelineVisible(this.conversationId, selected, throughLsn)) return { fragments: [], hasMore: true, reset: true };
      entries = [selected]; selectedVisible = true;
    } else entries = await this.directory.timeline(this.conversationId, after);
    const reader = new ConversationBodyReader(this.directory, this.artifacts, this.conversationId, this.ownerEpoch);
    for (let scanned = 0; scanned < 64; scanned++) {
      const entry = entries[0];
      if (!entry) return { fragments, hasMore: false, reset: false };
      const history = { key: entry.key, throughLsn };
      const position = cursor && !cursor.history?.after ? cursor : { conversationId: this.conversationId, ownerEpoch: this.ownerEpoch, clearId,
        revision: entry.kind === 'commit' ? entry.commit.commitRevision : entry.lsn, message: MAX, block: MAX, offset: MAX, history };
      if (selectedVisible || await this.directory.timelineVisible(this.conversationId, entry, throughLsn)) {
        if (input.runId && input.direction === 'forward' && input.runId !== (entry.kind === 'commit' ? entry.commit.runId : entry.input.runId)) throw Error('conversation-history-run-binding');
        const page = entry.kind === 'commit'
          ? await reader.pageFromCommit({ ...input, runId: entry.commit.runId, cursor: { ...position, history: undefined } }, entry.commit, state, 4 - fragments.length)
          : await this.#input(entry, position, input.direction === 'forward', 4 - fragments.length);
        if (page.reset) return page;
        const annotate = (value: ConversationBodyCursor) => ({ ...value, history });
        if (input.direction === 'forward') return { ...page, fragments: page.fragments.map(fragment => ({ ...fragment, cursor: annotate(fragment.cursor) })), ...(page.cursor ? { cursor: annotate(page.cursor) } : {}) };
        fragments.push(...page.fragments.map(fragment => ({ ...fragment, cursor: annotate(fragment.cursor) })));
        if (fragments.length === 4 || page.preparing || page.hasMore) return { fragments, reset: false, hasMore: true,
          cursor: page.hasMore ? annotate(page.cursor ?? position) : { ...position, history: { ...history, after: true } },
          // A preparing successor must not hide the completed fragments.
          ...(!fragments.length && page.preparing ? { preparing: page.preparing } : {}) };
      }
      after = entry.key; cursor = undefined; selectedVisible = false;
      entries = entries.length > 1 ? entries.slice(1) : await this.directory.timeline(this.conversationId, after);
    }
    return { fragments, hasMore: true, reset: false, cursor: { conversationId: this.conversationId, ownerEpoch: this.ownerEpoch, clearId,
      revision: 0, message: MAX, block: MAX, offset: MAX, history: { key: after!, throughLsn, after: true } } };
  }
  async #input(entry: Extract<TimelinePointer, { kind: 'input' }>, cursor: ConversationBodyCursor, forward: boolean, limit: number): Promise<ConversationBodyPage> {
    const { input } = await this.directory.inputAt(this.conversationId, entry.input);
    const json = artifactJsonIndex(this.artifacts), ref = 'ref' in input ? input.ref : undefined;
    if (ref) { const prepared = await json.prepare(ref); if (!prepared.ready) return { fragments: [], cursor, hasMore: true, reset: false, preparing: { bytes: prepared.bytes, total: prepared.total } }; }
    const parts = ref ? await json.node(ref, ['parts']) : undefined;
    if (ref && parts?.kind !== 'array') throw Error('conversation-history-input-parts');
    const count = ref ? parts!.units : (input as UserTurnInput).parts.length;
    let block = cursor.block === MAX ? count - 1 : cursor.block, offset = cursor.offset;
    const fragments: ConversationBodyFragment[] = [];
    const position = () => ({ ...cursor, message: entry.input.position, block, offset });
    for (let scanned = 0; block >= 0 && block < count && scanned < 64 && fragments.length < limit; scanned++) {
      const inline = ref ? undefined : (input as UserTurnInput).parts[block];
      const type = ref ? await json.value(ref, ['parts', block, 'type'], 128) : inline?.type;
      const node = ref && type === 'text' ? await json.node(ref, ['parts', block, 'text']) : undefined;
      if (ref && type === 'text' && node?.kind !== 'string') throw Error('conversation-history-input-text');
      const value = type === 'text' ? inline?.type === 'text' ? inline.text : '' : '[图像材料]';
      const length = node ? node.units : value.length;
      if (forward && offset > length) throw Error('conversation-history-input-offset');
      const append = (text: string, start: number) => fragments.push({ cursor: { ...position(), offset: start }, runId: entry.input.runId, runIndex: entry.input.position,
        message: entry.input.position, block, role: 'user', type: 'text', text, offset: start, length, final: start + text.length === length });
      if (node && ref) {
        const ranges = forward ? [await json.textRange(ref, node, offset)] : await json.text(ref, node, offset, limit - fragments.length);
        for (const range of ranges) append(range.text, range.offset);
        offset = forward ? offset + (ranges[0]?.text.length ?? 0) : ranges.at(-1)?.offset ?? 0;
      } else {
        const end = forward ? Math.min(length, offset + 8192) : Math.min(length, offset);
        let start = forward ? offset : Math.max(0, end - 8192);
        let stop = end;
        if (!forward && start > 0 && /[\uDC00-\uDFFF]/u.test(value[start]!)) start--;
        if (forward && stop < length && /[\uD800-\uDBFF]/u.test(value[stop - 1]!)) stop--;
        if (stop > start) append(value.slice(start, stop), start);
        offset = forward ? stop : start;
      }
      if (forward) { if (offset === length) { block++; offset = 0; } return { fragments, cursor: position(), hasMore: block < count, reset: false }; }
      if (offset === 0) { block--; offset = MAX; }
    }
    return { fragments, cursor: position(), hasMore: block >= 0, reset: false };
  }
}
