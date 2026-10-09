import { describe, expect, it, vi } from 'vitest';
import { createTempDir } from '@zhixing/test-utils';
import { FileArtifactStore, artifactJsonIndex } from '@zhixing/core/authority';
import type { ConversationBodyCursor } from '@zhixing/core/contracts';
import { ConversationBodyReader } from '../conversation-body-reader.js';
import type { ConversationReadIndex, CommitPointer } from '../conversation-read-index.js';

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
