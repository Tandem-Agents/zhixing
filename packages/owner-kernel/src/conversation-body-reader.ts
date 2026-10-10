import { artifactJsonIndex, assertArtifactRef, type ArtifactStore } from '@zhixing/core/authority';
import type { ArtifactRef, ConversationBodyCursor, ConversationBodyFragment, ConversationBodyPage, ConversationCommitSummary } from '@zhixing/core/contracts';
import { ConversationReadIndex, type CommitPointer, type ReadMeta } from './conversation-read-index.js';
import { assertConversationCommitSummary } from './conversation-run-contracts.js';

type Keys = readonly (string | number)[];
type Source = { ref: ArtifactRef; keys: Keys };
type Preparing = { ready: false; bytes: number; total: number };
const MAX = Number.MAX_SAFE_INTEGER;
/** The reader follows committed locators only. It never initializes a business
 * replay, accepts caller-provided artifacts, or modifies transcript content. */
export class ConversationBodyReader {
  readonly json;
  constructor(readonly directory: ConversationReadIndex, readonly artifacts: ArtifactStore, readonly conversationId: string, readonly ownerEpoch: number) {
    this.json = artifactJsonIndex(artifacts);
  }
  async source(commit: CommitPointer): Promise<Source | Preparing> {
    const prepared = await this.json.prepare(commit.bundle);
    if (!prepared.ready) return { ...prepared, ready: false };
    const read = (keys: Keys) => this.json.value(commit.bundle, keys, 4096);
    if (await read(['assignmentId']) !== commit.assignmentId || await read(['body', 'conversationId']) !== this.conversationId ||
        await read(['body', 'runId']) !== commit.runId || await read(['body', 'baseRevision']) !== commit.commitRevision - 1) throw Error('conversation-body-commit-binding');
    const ref = await read(['body', 'runRecord', 'ref']);
    if (!ref) {
      if (await read(['body', 'runRecord', 'runId']) !== commit.runId) throw Error('conversation-body-run-binding');
      return { ref: commit.bundle, keys: ['body', 'runRecord'] };
    }
    assertArtifactRef(ref);
    const record = await this.json.prepare(ref);
    if (!record.ready) return { ...record, ready: false };
    if (await this.json.value(ref, ['runId'], 4096) !== commit.runId) throw Error('conversation-body-run-binding');
    return { ref, keys: [] };
  }
  async summary(commit: CommitPointer): Promise<ConversationCommitSummary | Preparing> {
    if (commit.readSummary) { assertConversationCommitSummary(commit.readSummary); return commit.readSummary; }
    const source = await this.source(commit); if ('ready' in source) return source;
    const read = (keys: Keys, limit = 32 * 1024) => this.json.value(source.ref, [...source.keys, ...keys], limit);
    const runIndex = await read(['runIndex']);
    if (!Number.isSafeInteger(runIndex) || (runIndex as number) < 0) throw Error('conversation-body-run-index');
    const control = [...source.keys, 'postTurnControl'], intent = [...control, 'intent'];
    const remaining = await this.json.node(source.ref, [...intent, 'handoff', 'remaining']);
    const handedOff = (remaining?.units ?? 0) > 0, kind = await read(['postTurnControl', 'intent', 'kind']);
    let navigation: ConversationCommitSummary['navigation'];
    if (!handedOff && kind === 'exit') navigation = { kind };
    if (!handedOff && (kind === 'enter' || kind === 'set_workdir')) {
      const sceneId = await read(['postTurnControl', 'intent', 'sceneId']);
      if (typeof sceneId !== 'string') throw Error('conversation-body-navigation');
      navigation = kind === 'enter' ? { kind, sceneId } : { kind, sceneId, workspace: await read(['postTurnControl', 'intent', 'workspace']) as Extract<NonNullable<ConversationCommitSummary['navigation']>, { kind: 'set_workdir' }>['workspace'] };
    }
    const result = { runIndex: runIndex as number, usage: await read(['usage']) as ConversationCommitSummary['usage'],
      ...(navigation ? { navigation } : {}), handedOff, conflict: !!await this.json.node(source.ref, [...control, 'conflict']) };
    assertConversationCommitSummary(result); return result;
  }
  /** Same recent-context product budget as the owner bootstrap (100 messages,
   * 200 characters per message, 1200 total), without materializing every run.
   * Only text is projected, so an incomplete tool pair cannot enter the model. */
  async context(): Promise<import('@zhixing/core/contracts').ConversationContextPage> {
    const state = await this.directory.state(this.conversationId), lines: string[] = [];
    let commit = await this.directory.latest(this.conversationId), count = 0, total = 0;
    while (commit && count < 100 && total < 1200) {
      const source = await this.source(commit);
      if ('ready' in source) return { turnCount: state.count, preparing: { bytes: source.bytes, total: source.total } };
      const messages = await this.json.node(source.ref, [...source.keys, 'messages']);
      if (messages?.kind !== 'array') throw Error('conversation-context-messages');
      for (let m = messages.units - 1; m >= 0 && count < 100; m--, count++) {
        const keys = [...source.keys, 'messages', m], content = await this.json.node(source.ref, [...keys, 'content']);
        if (content?.kind !== 'array') throw Error('conversation-context-content');
        let text = '', blocks = 0;
        for (let b = 0; b < content.units && text.length <= 200; b++) {
          const block = [...keys, 'content', b];
          if (b % 64 === 0) await new Promise<void>(setImmediate);
          if (await this.json.value(source.ref, [...block, 'type'], 128) !== 'text') continue;
          const node = await this.json.node(source.ref, [...block, 'text']);
          if (node?.kind !== 'string') throw Error('conversation-context-text');
          if (blocks++ && text) text += '\n';
          // Leading whitespace belongs to trim(), not the 200-character
          // context allowance. Advance through it with fixed-size reads.
          for (let offset = 0; offset < node.units && text.length <= 200;) {
            const part = await this.json.textRange(source.ref, node, offset);
            offset += part.text.length;
            if (!part.text.length) throw Error('conversation-context-short-read');
            const value = text ? part.text : part.text.trimStart();
            text += value.slice(0, 201 - text.length);
            if (!text) await new Promise<void>(setImmediate);
          }
        }
        text = text.trim(); if (!text) continue;
        const role = await this.json.value(source.ref, [...keys, 'role'], 128);
        const line = `${role === 'user' ? '用户' : '知行'}：${text.length > 200 ? text.slice(0, 200) + '...' : text}`;
        if (total + line.length > 1200) { count = 100; break; }
        total += line.length; lines.unshift(line);
      }
      commit = await this.directory.latest(this.conversationId, commit.commitRevision);
    }
    const after = await this.directory.state(this.conversationId);
    if (after.deleted || after.clearId !== state.clearId) throw Error('conversation-context-generation-changed');
    return { turnCount: state.count, ...(lines.length ? { text: lines.join('\n') } : {}) };
  }
  async page(input: { cursor?: ConversationBodyCursor; direction?: 'forward' | 'reverse'; runId?: string }): Promise<ConversationBodyPage> {
    const before = { ...await this.directory.state(this.conversationId) };
    const result = await this.#page(input, before);
    const after = await this.directory.state(this.conversationId);
    return after.deleted || after.clearId !== before.clearId ? { fragments: [], hasMore: !after.deleted, reset: true } : result;
  }
  async #page(input: { cursor?: ConversationBodyCursor; direction?: 'forward' | 'reverse'; runId?: string }, state: ReadMeta): Promise<ConversationBodyPage> {
    const cursor = input.cursor;
    if (state.deleted || cursor && (cursor.conversationId !== this.conversationId || cursor.ownerEpoch !== this.ownerEpoch || cursor.clearId !== state.clearId || cursor.revision <= state.clearedThrough))
      return { fragments: [], hasMore: !state.deleted, reset: true };
    const reverse = input.direction !== 'forward';
    if (!reverse && !cursor) throw Error('conversation-body-forward-cursor');
    let commit = input.runId ? await this.directory.commit(this.conversationId, input.runId) : await this.directory.latest(this.conversationId, cursor ? cursor.revision + 1 : MAX);
    let message = cursor?.message ?? MAX, block = cursor?.block ?? MAX, offset = cursor?.offset ?? MAX;
    const fragments: ConversationBodyFragment[] = [];
    let scanned = 0;
    const position = (): ConversationBodyCursor => ({ conversationId: this.conversationId, ownerEpoch: this.ownerEpoch, clearId: state.clearId, revision: commit!.commitRevision, message, block, offset });
    while (commit && ++scanned <= 64 && fragments.length < 4) {
      if (cursor && input.runId && commit.commitRevision !== cursor.revision) throw Error('conversation-body-cursor-run');
      const source = await this.source(commit);
      if ('ready' in source) return { fragments, hasMore: true, reset: false, cursor: position(),
        // Deliver the completed page before reporting work for its successor.
        // Consumers may retry a preparing response without rendering it.
        ...(fragments.length ? {} : { preparing: { bytes: source.bytes, total: source.total } }) };
      const messages = await this.json.node(source.ref, [...source.keys, 'messages']);
      if (!messages || messages.kind !== 'array') throw Error('conversation-body-messages');
      if (message === MAX) message = messages.units - 1;
      if (message < 0) {
        if (input.runId || !reverse) return { fragments, hasMore: false, reset: false };
        commit = await this.directory.latest(this.conversationId, commit.commitRevision); message = MAX; block = MAX; offset = MAX; continue;
      }
      if (message >= messages.units) throw Error('conversation-body-message-cursor');
      const messagePath = [...source.keys, 'messages', message], contents = await this.json.node(source.ref, [...messagePath, 'content']);
      if (!contents || contents.kind !== 'array') throw Error('conversation-body-content');
      if (block === MAX) block = contents.units - 1;
      if (block < 0) { message--; block = MAX; offset = MAX; continue; }
      if (block >= contents.units) {
        if (!reverse && block === contents.units) return { fragments, hasMore: false, reset: false, cursor: position() };
        throw Error('conversation-body-block-cursor');
      }
      const keys = [...messagePath, 'content', block], read = (field: string) => this.json.value(source.ref, [...keys, field], 4096);
      const type = await read('type'), role = await this.json.value(source.ref, [...messagePath, 'role'], 128);
      if (typeof type !== 'string' || typeof role !== 'string') throw Error('conversation-body-kind');
      const field = type === 'text' ? 'text' : type === 'thinking' ? 'thinking' : type === 'tool_use' ? 'name' : type === 'tool_result' ? 'content' : undefined;
      const node = field && await this.json.node(source.ref, [...keys, field]);
      const runIndex = await this.json.value(source.ref, [...source.keys, 'runIndex'], 128);
      if (!Number.isSafeInteger(runIndex)) throw Error('conversation-body-run-index');
      if (!node || node.kind !== 'string') {
        if (offset !== 0) fragments.push({ cursor: { ...position(), offset: 0 }, runId: commit.runId, runIndex: runIndex as number, message, block, role, type, text: '[图像材料]', offset: 0, length: 6, final: true });
        offset = 0;
      } else {
        const parts = reverse ? await this.json.text(source.ref, node, offset, 4 - fragments.length) : [await this.json.textRange(source.ref, node, offset)];
        const toolId = type === 'tool_use' ? await read('id') : type === 'tool_result' ? await read('toolUseId') : undefined;
        const isError = type === 'tool_result' && await read('isError') === true;
        for (const part of parts) fragments.push({ cursor: { ...position(), offset: part.offset }, runId: commit.runId, runIndex: runIndex as number, message, block, role, type,
          ...(typeof toolId === 'string' ? { toolId } : {}), ...(isError ? { isError } : {}), ...part, length: node.units });
        if (reverse) offset = parts.at(-1)?.offset ?? 0;
        else {
          const part = parts[0]!; offset = part.offset + part.text.length;
          if (part.final) { block++; offset = 0; }
          return { fragments, hasMore: block < contents.units, reset: false, cursor: position() };
        }
      }
      if (!reverse) { block++; offset = 0; return { fragments, hasMore: block < contents.units, reset: false, cursor: position() }; }
      if (offset === 0) { block--; offset = MAX; }
    }
    // page() checks the visibility generation for every return path, including
    // preparing and forward pages, after all artifact work has finished.
    return { fragments, hasMore: !!commit, reset: false, ...(commit ? { cursor: position() } : {}) };
  }
}
