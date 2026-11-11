import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FileArtifactStore } from '../authority/artifact-store.js';
import { projectSessionEvent, type SessionEventProjection } from '../types/agent-events.js';
import { prepareStreamDataPayload, readStreamDisplayPayload, validateSessionEventProjection } from './stream.js';
import { stripPresentationFromAgentYield } from '../loop/presentation.js';
import { errorCauseSummary } from '../resilience/classify.js';
import { createTempDir } from '@zhixing/test-utils';
async function store() { const root = await createTempDir('process'); return new FileArtifactStore(root); }
describe('finite process events and canonical display read', () => {
  it('keeps the default result closed instead of exposing display extensions through alternate keys', () => {
    const input = { type: 'tool_end' as const, id: 't', name: 'edit', duration: 1,
      result: { content: 'real result', committedToUser: true, displayRef: { digest: 'private' } } };
    expect(stripPresentationFromAgentYield(input)).toEqual({ type: 'tool_end', id: 't', name: 'edit', duration: 1,
      result: { content: 'real result', committedToUser: true } });
    expect(input.result.displayRef.digest).toBe('private');
  });
  it('projects call start without input and rejects input at the exact stream validator', () => {
    const p = projectSessionEvent('tool:call_start', { id: 'call', name: 'read', input: { private: 'not on wire' } })!;
    expect(p).toEqual({ event: 'tool:call_start', payload: { id: 'call', name: 'read' } });
    expect(() => validateSessionEventProjection(p)).not.toThrow();
    expect(() => validateSessionEventProjection({ ...p, payload: { ...p.payload, input: {} } } as SessionEventProjection)).toThrow();
  });
  it.each([
    { event: 'tool:call_end', payload: { id: 'call', name: 'read', duration: 2, success: false, resultSize: 10 } },
    { event: 'tool:child_start', payload: { parentToolCallId: 'call', childLineage: 'main/sub-a', childAgentId: 'child', label: '核对' } },
    { event: 'tool:child_end', payload: { parentToolCallId: 'call', childLineage: 'main/sub-a', childAgentId: 'child', status: 'aborted', duration: 2 } },
    { event: 'llm:request_end', payload: { model: 'model', duration: 5, usage: { inputTokens: 2, totalInputTokens: 8, outputTokens: 3, cacheReadTokens: 6 }, stopReason: 'end_turn' } },
  ] satisfies SessionEventProjection[])('accepts finite $event and rejects extra keys', p => {
    expect(() => validateSessionEventProjection(p)).not.toThrow();
    expect(() => validateSessionEventProjection({ ...p, payload: { ...p.payload, arbitrary: true } } as SessionEventProjection)).toThrow();
  });
  it('用量未报来的请求结束只接受 usageReported: false 一种写法', () => {
    const ended = { model: 'm', duration: 1, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' as const };
    expect(() => validateSessionEventProjection({ event: 'llm:request_end', payload: { ...ended, usageReported: false } })).not.toThrow();
    expect(() => validateSessionEventProjection({ event: 'llm:request_end', payload: { ...ended, usageReported: true } })).toThrow();
  });
  it('carries the bounded retry cause summary from the real producer through projection and the exact stream validator', async () => {
    // 生产端真实摘要 → 事件 → 会话投影 → 流协议精确校验：这一跳曾漏校验，导致首次重试即中止运行
    const refused = (address: string) => Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED', syscall: 'connect' });
    const error = Object.assign(new Error('Connection error.'), { cause: Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new AggregateError([refused('::1:1'), refused('127.0.0.1:1')]), { code: 'ECONNREFUSED' }) }) });
    const cause = errorCauseSummary(error)!;
    expect(cause).toBe('Error ← TypeError ← AggregateError ECONNREFUSED ← Error ECONNREFUSED connect ×2');
    for (const [event, payload] of [
      ['retry:attempt', { errorType: 'network', attempt: 1, maxRetries: 3, delayMs: 10, willRetry: true, cause }],
      ['retry:exhausted', { errorType: 'network', totalAttempts: 4, lastError: 'Connection error.', cause }],
      ['retry:attempt', { errorType: 'network', attempt: 1, maxRetries: 3, delayMs: 10, willRetry: true }],
    ] as const) {
      const projected = projectSessionEvent(event, payload as never)!;
      expect(() => validateSessionEventProjection(projected)).not.toThrow();
    }
    const exhausted = { event: 'retry:exhausted', payload: { errorType: 'network', totalAttempts: 4, lastError: 'x' } } as SessionEventProjection;
    for (const bad of [1, '', 'x'.repeat(513)]) {
      expect(() => validateSessionEventProjection({ ...exhausted, payload: { ...exhausted.payload, cause: bad } } as SessionEventProjection)).toThrow();
    }
    expect(() => validateSessionEventProjection({ ...exhausted, payload: { ...exhausted.payload, other: 'x' } } as SessionEventProjection)).toThrow();
  });
  it('rejects non-finite usage and invalid child terminal states', () => {
    expect(() => validateSessionEventProjection({ event: 'llm:request_end', payload: { model: 'm', duration: 1, usage: { inputTokens: Infinity, outputTokens: 1 }, stopReason: 'end_turn' } })).toThrow();
    expect(() => validateSessionEventProjection({ event: 'tool:child_end', payload: { parentToolCallId: 'p', childLineage: 'main/sub-a', childAgentId: 'c', status: 'running', duration: 0 } } as unknown as SessionEventProjection)).toThrow();
  });
  it('reads a real externalized value through a bounded authority range without changing its canonical ref', async () => {
    const artifacts = await store(), text = 'x'.repeat(40 * 1024);
    const prepared = await prepareStreamDataPayload({ kind: 'agent-yield', yield: { type: 'text_delta', text } }, artifacts);
    const frozen = JSON.stringify(prepared.payload), range = vi.spyOn(artifacts, 'readRange'), get = vi.spyOn(artifacts, 'get');
    expect(await readStreamDisplayPayload(prepared.payload, artifacts)).toEqual({ kind: 'agent-yield', yield: { type: 'text_delta', text } });
    expect(JSON.stringify(prepared.payload)).toBe(frozen); expect(range).toHaveBeenCalledOnce(); expect(get).not.toHaveBeenCalled();
  });
  it('rejects declared oversize before reading and rejects corrupt bounded bytes', async () => {
    const artifacts = await store();
    const prepared = await prepareStreamDataPayload({ kind: 'agent-yield', yield: { type: 'text_delta', text: 'x'.repeat(40 * 1024) } }, artifacts);
    const range = vi.spyOn(artifacts, 'readRange');
    await expect(readStreamDisplayPayload(prepared.payload, artifacts, 1024)).rejects.toThrow('capacity');
    expect(range).not.toHaveBeenCalled();
    range.mockResolvedValue(Buffer.from('different'));
    await expect(readStreamDisplayPayload(prepared.payload, artifacts)).rejects.toThrow(/identity/);
  });
});
