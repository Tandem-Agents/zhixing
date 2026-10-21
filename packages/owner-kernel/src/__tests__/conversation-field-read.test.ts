import { expect, it, vi } from 'vitest';
import { readConversationGuardView, conversationStateBase, conversationStateFieldKey, encodeConversationState } from '../conversation-run-state-index.js';
import type { JsonValue } from '@zhixing/core/contracts';

it('reads a finite guard field set in batches and does not reread missing fields on its relation-closing pass', async () => {
  const id = 'field-batch-conversation';
  const values = new Map<string, JsonValue>([
    [conversationStateBase(id) + 'root', { conversationId: id, version: 7 }],
    [conversationStateFieldKey(id, 'stateByRun', 'run'), { key: 'run', value: encodeConversationState({ state: 'queued' }) }],
  ]);
  const get = vi.fn(async (key: string) => values.get(key));
  const getMany = vi.fn(async (keys: readonly string[]) => keys.map(key => values.get(key)));
  const result = await readConversationGuardView({ get, getMany, scan: async () => ({ entries: [] }) }, id, { runs: ['run'] });
  expect(result.version).toBe(7);
  expect(result.state.stateByRun.get('run')).toEqual({ state: 'queued' });
  expect(result.state.admittedByRun.size).toBe(0);
  expect(get.mock.calls.filter(([key]) => key.includes('/guard/'))).toEqual([]);
  expect(getMany).toHaveBeenCalledTimes(1);
  expect(getMany.mock.calls[0]![0]).toHaveLength(5);
});
