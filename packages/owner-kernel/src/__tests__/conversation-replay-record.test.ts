import { describe, expect, it, vi } from 'vitest';
import { FileArtifactStore, artifactJsonIndex } from '@zhixing/core/authority';
import { canonicalize } from '@zhixing/core/protocol';
import { createTempDir } from '@zhixing/test-utils';
import { readConversationReplayRecord } from '../conversation-replay-record.js';

describe('bounded conversation replay validation', () => {
  it('validates a giant completed local run without getting any complete body and still binds real inputs and nested references', async () => {
    const store = new FileArtifactStore(await createTempDir('replay-record'));
    const input = { role: 'user' as const, content: [{ type: 'text' as const, text: '真实输入😀' }], inputIdentity: { id: 'input-1', source: { kind: 'user' as const } } };
    const dependency = await store.put(Buffer.from('dependency'));
    const source = { type: 'run', runId: 'run-1', runIndex: 0, timestamp: '2026-10-09T00:00:00.000Z', messages: [input,
      { role: 'assistant', content: [{ type: 'text', text: '中文😀\\\n'.repeat(180000) }, { type: 'tool_use', id: 'tool-1', name: 'Read', input: { nested: dependency } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tool-1', content: 'result'.repeat(150000) }] }],
      usage: { inputTokens: 1, outputTokens: 2 } };
    const ref = await store.put(Buffer.from(canonicalize(source)));
    const get = vi.spyOn(store, 'get').mockRejectedValue(Error('whole body forbidden')), range = vi.spyOn(store, 'readRange');
    try {
      const projection = await readConversationReplayRecord(store, ref, 'run-1', [input]);
      expect(projection?.metadata).toMatchObject({ runId: 'run-1', usage: { outputTokens: 2 } });
      expect(projection?.metadata).not.toHaveProperty('messages'); expect(projection?.references).toEqual([dependency]);
      expect(get).not.toHaveBeenCalled(); expect(Math.max(...range.mock.calls.map(call => call[2]))).toBeLessThanOrEqual(65536);
      range.mockClear(); await readConversationReplayRecord(store, ref, 'run-1', [input]);
      expect(range.mock.calls.reduce((sum, call) => sum + call[2], 0)).toBeLessThan(8192);
      await expect(readConversationReplayRecord(store, ref, 'run-1', [{ ...input, content: [{ type: 'text', text: 'spoof' }] }])).rejects.toThrow('identities/content');
      await expect(readConversationReplayRecord(store, ref, 'run-1', [])).rejects.toThrow('identities/content');
    } finally { await artifactJsonIndex(store).close(); }
  }, 30_000);
  it('does not relax canonical bytes or the closed message schema', async () => {
    const store = new FileArtifactStore(await createTempDir('replay-record-invalid'));
    const record = { type: 'run', runId: 'run-1', runIndex: 0, timestamp: '2026-10-09T00:00:00.000Z', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
    try {
      for (const text of [JSON.stringify(record), canonicalize(record) + '\n', canonicalize(record).replace('"hi"', '"\\u0068i"')]) {
        const ref = await store.put(Buffer.from(text));
        await expect(readConversationReplayRecord(store, ref, 'run-1', [])).rejects.toThrow('not canonical');
      }
      for (const content of [[{ type: 'text', text: 3 }], [{ type: 'tool_use', name: 'Read', id: 'a', input: [] }], [{ type: 'text', text: 'hi', extra: true }]]) {
        const ref = await store.put(Buffer.from(canonicalize({ ...record, messages: [{ role: 'user', content }] })));
        await expect(readConversationReplayRecord(store, ref, 'run-1', [])).rejects.toThrow();
      }
    } finally { await artifactJsonIndex(store).close(); }
  });
});
