import { describe, expect, it, vi } from 'vitest';
import { createSessionBroadcastTransport } from './session-broadcast.js';
import { boundedProcessValue, processText, projectSessionArtifact, projectProcessYield, processForProfile,
  validateSessionProcessProjection, type SessionPresentationProfile } from './session-presentation.js';
const source = { conversationId: 'conv', runId: 'run', assignmentId: 'assignment', streamEpoch: 1, sourceSeq: 1, observedAt: 1 };
const diff = () => ({ kind: 'file-diff' as const, path: 'file.ts', operation: 'modified' as const,
  changeStats: { kind: 'exact' as const, addedLines: 1, removedLines: 1 },
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ type: 'added' as const, newLineNumber: 1, content: 'new' }] }] });
const delta = () => ({ type: 'tool_end' as const, id: 'edit', name: 'edit', duration: 5, result: { content: 'edited', presentation: diff() } });
function connection(id: number, profile: SessionPresentationProfile) {
  return { id, authenticated: true, loopback: true, closed: false, notify: vi.fn(),
    presentationProfile: () => profile, presentationSince: () => 0 };
}
describe('one bounded Server presentation egress', () => {
  it.each([
    { content: 'edited' },
    { content: 'edited', isError: false },
    { content: 'edited', committedToUser: false },
    { content: 'edited', isError: false, committedToUser: false },
    { content: 'edited', isError: true, committedToUser: true },
  ])('keeps optional tool-result flags canonical without losing false or zero: %j', result => {
    const value = projectProcessYield(source, { type: 'tool_end', id: 'edit', name: 'edit', duration: 0,
      result: { ...result, presentation: diff() } });
    expect(() => validateSessionProcessProjection(value)).not.toThrow();
    const plain = connection(1, 'default'), enhanced = connection(2, 'bounded-v1');
    const transport = createSessionBroadcastTransport({ connections: new Set([plain, enhanced]), observerConnectionIds: () => new Set(['1', '2']) });
    expect(() => transport.session('conv', 'session.process', value)).not.toThrow();
    for (const observer of [plain, enhanced]) {
      expect(observer.notify).toHaveBeenCalledOnce();
      const delivered = observer.notify.mock.calls[0]![1];
      expect(delivered.payload.delta).toEqual({ type: 'tool_end', id: 'edit', name: 'edit', duration: 0, result });
      expect(() => validateSessionProcessProjection(delivered)).not.toThrow();
    }
    expect(plain.notify.mock.calls[0]![1].payload.artifact).toBeUndefined();
    expect(enhanced.notify.mock.calls[0]![1].payload.artifact.kind).toBe('file-diff');
  });
  it('validates materialized body values independently from the canonical ref threshold and keeps the latest thinking tail', () => {
    const text = 'x'.repeat(40 * 1024);
    const body = projectProcessYield(source, { type: 'text_delta', text });
    expect(() => validateSessionProcessProjection(body)).not.toThrow();
    expect(body.payload).toMatchObject({ delta: { text } });
    const thinking = projectProcessYield(source, { type: 'thinking_delta', thinking: '汉'.repeat(40_000) + '尾部' });
    expect(thinking).toMatchObject({ truncated: true, payload: { delta: { thinking: expect.stringMatching(/尾部$/u) } } });
    expect(() => validateSessionProcessProjection(thinking)).not.toThrow();
  });
  it('sends ordinary default and enhanced deltas from the same observer transport', () => {
    const plain = connection(1, 'default'), enhanced = connection(2, 'bounded-v1');
    const transport = createSessionBroadcastTransport({ connections: new Set([plain, enhanced]), observerConnectionIds: () => new Set(['1', '2']) });
    const value = { conversationId: 'conv', sessionId: 'conv', turnId: 'turn', delta: delta() };
    transport.session('conv', 'session.delta', value);
    expect(JSON.stringify(plain.notify.mock.calls)).not.toContain('file-diff');
    expect(JSON.stringify(enhanced.notify.mock.calls)).toContain('file-diff');
    expect(value.delta.result.presentation.kind).toBe('file-diff');
  });
  it('projects current-anchor default without artifact/ref while enhanced receives the approved artifact', () => {
    const value = projectProcessYield(source, delta()), plain = processForProfile(value, 'default'), enhanced = processForProfile(value, 'bounded-v1');
    expect(plain.payload).toMatchObject({ kind: 'yield', delta: { result: { content: 'edited' } } });
    expect(JSON.stringify(plain)).not.toMatch(/file-diff|presentation|"ref"/);
    expect(JSON.stringify(enhanced)).toContain('file-diff');
    expect(value).not.toHaveProperty('v'); expect(value).not.toHaveProperty('digest');
  });
  it('does not expose unknown/grep artifacts or mismatched child identity', () => {
    expect(projectSessionArtifact({ kind: 'grep-results', files: ['private'] }, 'tool')).toBeUndefined();
    expect(projectSessionArtifact({ kind: 'future', ref: { digest: 'private' } }, 'tool')).toBeUndefined();
    expect(projectSessionArtifact({ kind: 'sub-agent-result', toolCallId: 'other' }, 'tool')).toBeUndefined();
  });
  it('limits diff hunks, rows, encoded bytes and strips terminal controls with a truncation marker', () => {
    const value = diff(); value.hunks = Array.from({ length: 20 }, () => ({ oldStart: 1, oldLines: 900, newStart: 1, newLines: 900,
      lines: Array.from({ length: 900 }, (_, i) => ({ type: 'added' as const, newLineNumber: i + 1, content: '\x1b[31m汉'.repeat(1000) })) }));
    const projected = projectSessionArtifact(value, 'tool')!;
    expect(projected.kind).toBe('file-diff');
    if (projected.kind !== 'file-diff') throw Error('fixture');
    expect(projected.hunks.length).toBeLessThanOrEqual(6);
    expect(projected.hunks.every(h => h.lines.length <= 80)).toBe(true);
    expect(projected.hunks.flatMap(h => h.lines).length).toBeLessThanOrEqual(300);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(128 * 1024);
    expect(projected.wireTruncated).toBe(true); expect(JSON.stringify(projected)).not.toContain('\\u001b');
  });
  it('keeps unavailable counts distinct from zero and bounds all child diagnostics together', () => {
    expect(projectSessionArtifact({ ...diff(), changeStats: { kind: 'unavailable', reason: 'input-too-large' } }, 'edit')).toMatchObject({ changeStats: { kind: 'unavailable' } });
    const value = projectSessionArtifact({ kind: 'sub-agent-result', toolCallId: 'task', subAgentId: 'child', description: 'inspect',
      status: 'failed', durationMs: 10, toolUses: 3, usage: { inputTokens: 100, outputTokens: 5 },
      diagnostics: Array(50).fill('failure'.repeat(500)), errorOrAbortReason: 'last'.repeat(1000) }, 'task')!;
    expect(value).toMatchObject({ toolCallId: 'task', subAgentId: 'child', status: 'failed', wireTruncated: true });
    if (value.kind !== 'sub-agent-result') throw Error('fixture');
    expect(Buffer.byteLength(JSON.stringify([value.diagnostics, value.errorOrAbortReason]))).toBeLessThan(2200);
    expect(value.errorOrAbortReason).toContain('last');
    expect(projectSessionArtifact(value, 'task')).toMatchObject({ wireTruncated: true, errorOrAbortReason: value.errorOrAbortReason });
  });
  it('rejects huge/deep graphs before invoking arbitrary toJSON and terminates exhausted text budgets', () => {
    const toJSON = vi.fn(() => 'hidden');
    expect(() => boundedProcessValue({ text: 'x'.repeat(1000000), toJSON })).toThrow();
    expect(toJSON).not.toHaveBeenCalled(); expect(processText('anything', 0)).toBe('');
  });
  it('never sends an original canonical frame to observers and prevents a late pre-upgrade artifact', () => {
    const c = connection(1, 'bounded-v1'); c.presentationSince = () => 2;
    const transport = createSessionBroadcastTransport({ connections: new Set([c]), observerConnectionIds: () => new Set(['1']) });
    transport.session('conv', 'session.assignmentStream', { payload: { ref: 'private' } });
    expect(c.notify).not.toHaveBeenCalled();
    transport.session('conv', 'session.process', projectProcessYield(source, delta()));
    expect(JSON.stringify(c.notify.mock.calls)).not.toContain('file-diff');
  });
  it('rejects made-up source fields and non-finite identities without treating DTOs as StreamFrames', () => {
    const value = projectProcessYield(source, delta());
    expect(() => validateSessionProcessProjection({ ...value, streamDigest: 'fake' })).toThrow();
    expect(() => validateSessionProcessProjection({ ...value, source: { ...source, sourceSeq: Infinity } })).toThrow();
    expect(() => validateSessionProcessProjection(value)).not.toThrow();
  });
});
