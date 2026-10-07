import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifactStore } from '../authority/artifact-store.js';
import { projectSessionEvent, type SessionEventProjection } from '../types/agent-events.js';
import { prepareStreamDataPayload, readStreamDisplayPayload, validateSessionEventProjection } from './stream.js';
import { stripPresentationFromAgentYield } from '../loop/presentation.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function store() { const root = await mkdtemp(join(tmpdir(), 'zhixing-process-')); roots.push(root); return new FileArtifactStore(root); }
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
