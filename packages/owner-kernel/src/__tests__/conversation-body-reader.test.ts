import { describe, expect, it, vi } from 'vitest';
import { createTempDir } from '@zhixing/test-utils';
import { FileArtifactStore, artifactJsonIndex } from '@zhixing/core/authority';
import type { ConversationBodyCursor, ConversationBodyFragment } from '@zhixing/core/contracts';
import { ConversationBodyReader } from '../conversation-body-reader.js';
import type { ConversationReadIndex, CommitPointer } from '../conversation-read-index.js';

it.each(['clear', 'delete'] as const)('rechecks %s after an empty lookup without repeating the initial state read', async (mutation) => {
  const state = { count: 0, clearedThrough: 0, baseRevision: 0, activity: '', clearId: undefined as string | undefined, deleted: false };
  const read = vi.fn(async () => state);
  const directory = { state: read, latest: async () => {
    if (mutation === 'clear') state.clearId = 'clear-during-read'; else state.deleted = true;
    return undefined;
  } } as unknown as ConversationReadIndex;
  const artifacts = new FileArtifactStore(await createTempDir('empty-history-generation'));
  const reader = new ConversationBodyReader(directory, artifacts, 'c-1', 1);
  expect(await reader.page({})).toEqual({ fragments: [], hasMore: mutation === 'clear', reset: true });
  expect(read).toHaveBeenCalledTimes(2);
});

it('reads a giant single run through bounded source pages and preserves all source positions', async () => {
  const root = await createTempDir('conversation-body'), artifacts = new FileArtifactStore(root);
  const text = '中文😀 line\\\n'.repeat(90000);
  const record = await artifacts.put(Buffer.from(JSON.stringify({ runId: 'run-1', runIndex: 0, messages: [
    { role: 'user', content: [{ type: 'text', text: 'question' }] },
    { role: 'assistant', content: [{ type: 'text', text }] },
  ], postTurnControl: { intent: { kind: 'enter', sceneId: 'scene-1' } } })));
  const bundle = await artifacts.put(Buffer.from(JSON.stringify({ assignmentId: 'a-1', body: { runId: 'run-1', conversationId: 'c-1', baseRevision: 0, runRecord: { ref: record } } })));
  const pointer: CommitPointer = { runId: 'run-1', assignmentId: 'a-1', commitRevision: 1, bundle };
  const state = { count: 1, clearedThrough: 0, clearId: undefined as string | undefined, deleted: false };
  const directory = { state: async () => state, latest: async (_: string, before = Number.MAX_SAFE_INTEGER) => before > 1 ? pointer : undefined,
    commit: async (_: string, id: string) => id === pointer.runId && !state.clearId ? pointer : undefined } as unknown as ConversationReadIndex;
  const get = vi.spyOn(artifacts, 'get').mockRejectedValue(Error('whole body reads forbidden'));
  const range = vi.spyOn(artifacts, 'readRange');
  const reader = new ConversationBodyReader(directory, artifacts, 'c-1', 1);
  try {
    let cursor: ConversationBodyCursor | undefined, output = '', question = '', first = true, repeats = 0;
    for (;;) {
      const page = await reader.page({ cursor }); expect(page.reset).toBe(false);
      if (page.preparing) { cursor = page.cursor; expect(++repeats).toBeLessThan(20); continue; }
      for (const fragment of page.fragments) {
        if (fragment.role === 'assistant') {
          if (first) {
            const forward = await reader.page({ cursor: { ...fragment.cursor, offset: 0 }, runId: fragment.runId, direction: 'forward' });
            expect(forward.fragments[0]?.offset).toBe(0); expect(text.startsWith(forward.fragments[0]!.text)).toBe(true); first = false;
          }
          expect(fragment.offset + fragment.text.length).toBe(text.length - output.length); output = fragment.text + output;
        } else question = fragment.text + question;
      }
      cursor = page.cursor; if (!page.hasMore) break;
    }
    expect(output).toBe(text); expect(question).toBe('question'); expect(get).not.toHaveBeenCalled();
    expect(Math.max(...range.mock.calls.map(call => call[2]))).toBeLessThanOrEqual(64 * 1024);
    expect(await reader.summary(pointer)).toMatchObject({ runIndex: 0, navigation: { kind: 'enter', sceneId: 'scene-1' }, handedOff: false, conflict: false });
    range.mockClear();
    const context = await reader.context();
    expect(context.turnCount).toBe(1); expect(context.text).toContain('用户：question');
    expect(context.text).toContain('知行：' + text.slice(0, 200) + '...');
    expect(range.mock.calls.reduce((sum, call) => sum + call[2], 0)).toBeLessThan(64 * 1024);
    expect(get).not.toHaveBeenCalled();
    state.clearId = 'clear-1'; state.clearedThrough = 1;
    expect(await reader.page({ cursor: { conversationId: 'c-1', ownerEpoch: 1, revision: 1, message: 1, block: 0, offset: 0 } })).toMatchObject({ reset: true, fragments: [] });
  } finally { await artifactJsonIndex(artifacts).close(); }
}, 30_000);

it('工具块按结果处配对给出有界事实：并行调用不错位、调用块不重复、成功大结果不读正文、清空后回读失效', async () => {
  const root = await createTempDir('conversation-body-tools'), artifacts = new FileArtifactStore(root);
  const bigOk = 'L\n'.repeat(1_000_000), longError = 'boom\n' + 'e'.repeat(100_000);
  const record = await artifacts.put(Buffer.from(JSON.stringify({ runId: 'run-1', runIndex: 0, messages: [
    { role: 'user', content: [{ type: 'text', text: 'question' }] },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.ts' } },
      { type: 'tool_use', id: 't2', name: 'bash', input: { command: 'make' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', toolUseId: 't1', content: bigOk },
      { type: 'tool_result', toolUseId: 't2', content: longError, isError: true },
    ] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ] })));
  const bundle = await artifacts.put(Buffer.from(JSON.stringify({ assignmentId: 'a-1', body: { runId: 'run-1', conversationId: 'c-1', baseRevision: 0, runRecord: { ref: record } } })));
  const pointer: CommitPointer = { runId: 'run-1', assignmentId: 'a-1', commitRevision: 1, bundle };
  const state = { count: 1, clearedThrough: 0, clearId: undefined as string | undefined, deleted: false };
  const directory = { state: async () => state, latest: async (_: string, before = Number.MAX_SAFE_INTEGER) => before > 1 ? pointer : undefined,
    commit: async (_: string, id: string) => id === pointer.runId && !state.clearId ? pointer : undefined } as unknown as ConversationReadIndex;
  const reader = new ConversationBodyReader(directory, artifacts, 'c-1', 1);
  try {
    // 建索引会扫全文；只统计历史读取本身
    let page = await reader.page({});
    for (let repeats = 0; page.preparing; repeats++) { expect(repeats).toBeLessThan(40); page = await reader.page({ cursor: page.cursor }); }
    const range = vi.spyOn(artifacts, 'readRange');
    const seen: string[] = [];
    let cursor: ConversationBodyCursor | undefined = undefined;
    for (let pages = 0; pages < 40; pages++) {
      const current = pages === 0 ? page : await reader.page({ cursor });
      // 与在线终端投影一致：消费第一个片段后从它的坐标续读
      const first = current.fragments[0];
      if (first) { seen.push(first.tool ? `${first.type}:${first.toolId}` : first.text); cursor = first.cursor; continue; }
      cursor = current.cursor; if (!current.hasMore) break;
    }
    expect(seen).toEqual(['done', 'tool_result:t2', 'tool_result:t1', 'question']);
    const total = range.mock.calls.reduce((sum, call) => sum + call[2], 0);
    expect(total).toBeLessThan(256 * 1024);
    expect(Math.max(...range.mock.calls.map(call => call[2]))).toBeLessThanOrEqual(64 * 1024);

    const resultCursor: ConversationBodyCursor = { conversationId: 'c-1', ownerEpoch: 1, revision: 1, message: 2, block: 1, offset: 0 };
    const forward = await reader.page({ cursor: resultCursor, runId: 'run-1', direction: 'forward' });
    expect(forward.fragments[0]?.tool).toMatchObject({ kind: 'result', isError: true, length: longError.length,
      call: { name: 'bash', input: { command: 'make' }, message: 1, block: 1 } });
    const ok = await reader.page({ cursor: { ...resultCursor, block: 0 }, runId: 'run-1', direction: 'forward' });
    expect(ok.fragments[0]?.tool).toEqual({ kind: 'result', call: { name: 'read', input: { path: 'a.ts' }, message: 1, block: 0 }, length: bigOk.length, isError: false });
    state.clearId = 'clear-1'; state.clearedThrough = 1;
    expect(await reader.page({ cursor: resultCursor, runId: 'run-1', direction: 'forward' })).toMatchObject({ reset: true, fragments: [] });
  } finally { await artifactJsonIndex(artifacts).close(); }
}, 60_000);

it('在线路径超过一次预算的配对：按请求新建的读取器也续查到底，一调用一卡，查完前只返回准备中', async () => {
  const root = await createTempDir('conversation-body-tools-many'), artifacts = new FileArtifactStore(root);
  const count = 130, id = (index: number) => `call-${String(index).padStart(3, '0')}-${'i'.repeat(390)}`;
  const record = await artifacts.put(Buffer.from(JSON.stringify({ runId: 'run-1', runIndex: 0, messages: [
    { role: 'user', content: [{ type: 'text', text: 'question' }] },
    { role: 'assistant', content: [{ type: 'text', text: '开始' },
      ...Array.from({ length: count }, (_, index) => ({ type: 'tool_use', id: id(index), name: 'read', input: { path: `f${index}.ts` } }))] },
    { role: 'user', content: [...Array.from({ length: count }, (_, index) => ({ type: 'tool_result', toolUseId: id(index), content: `ok ${index}` })),
      { type: 'text', text: '附注' }] },
  ] })));
  const bundle = await artifacts.put(Buffer.from(JSON.stringify({ assignmentId: 'a-1', body: { runId: 'run-1', conversationId: 'c-1', baseRevision: 0, runRecord: { ref: record } } })));
  const pointer: CommitPointer = { runId: 'run-1', assignmentId: 'a-1', commitRevision: 1, bundle };
  const state = { count: 1, clearedThrough: 0, clearId: undefined as string | undefined, deleted: false };
  const directory = { state: async () => state, latest: async (_: string, before = Number.MAX_SAFE_INTEGER) => before > 1 ? pointer : undefined,
    commit: async (_: string, runId: string) => runId === pointer.runId ? pointer : undefined } as unknown as ConversationReadIndex;
  try {
    const cards: ConversationBodyFragment[] = [];
    let cursor: ConversationBodyCursor | undefined, preparing = 0;
    for (let pages = 0; pages < 2000; pages++) {
      // 与服务端一致：每个请求新建读取器
      const page = await new ConversationBodyReader(directory, artifacts, 'c-1', 1).page({ cursor });
      if (page.preparing) { preparing++; cursor = page.cursor; continue; }
      const first = page.fragments[0];
      if (first) { if (first.tool) cards.push(first); cursor = first.cursor; continue; }
      cursor = page.cursor; if (!page.hasMore) break;
    }
    expect(cards).toHaveLength(count);
    expect(cards.every(card => card.type === 'tool_result' && card.tool?.kind === 'result')).toBe(true);
    for (const card of cards) {
      const index = Number(card.toolId!.slice(5, 8));
      expect(card.tool).toMatchObject({ call: { name: 'read', input: { path: `f${index}.ts` }, message: 1, block: index + 1 } });
    }
    expect(preparing).toBeGreaterThan(0);
  } finally { await artifactJsonIndex(artifacts).close(); }
}, 120_000);
