import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifactStore } from '@zhixing/core/authority';
import { prepareStreamDataPayload, validateStreamFrame } from '@zhixing/core/protocol';
import type { StreamFrame } from '@zhixing/core/contracts';
import { createSessionBroadcastTransport } from '@zhixing/rpc/session-broadcast';
import { SessionProcessProjector, SessionProcessProjectionOwner, PROCESS_COMPLETION_GRACE_MS } from '../session-process-projection.js';
import { AssignmentStreamPathManager } from '../assignment-stream-path-manager.js';
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'zhixing-j3-')); roots.push(root);
  const artifacts = new FileArtifactStore(root), publish = vi.fn();
  return { artifacts, publish, p: new SessionProcessProjector({ artifacts, publish }) };
}
function frame(seq: number, payload: StreamFrame['payload']): StreamFrame {
  return validateStreamFrame({ v: 1, ref: { execution: 'conversation', conversationId: 'c', runId: 'r', ownerEpoch: 0 },
    assignmentId: 'assignment', streamEpoch: 1, seq, payload, meta: { lineage: 'main' } });
}
describe('verified stream to observer projection', () => {
  it('reads the executor-owned spool through its authenticated path before ACK permits reclamation', async () => {
    const owner = await setup(), executor = await setup();
    const prepared = await prepareStreamDataPayload({ kind: 'agent-yield', yield: { type: 'assistant_message',
      message: { role: 'assistant', content: [{ type: 'text', text: '真实回答'.repeat(25_000) }] } } }, executor.artifacts);
    const original = frame(1, prepared.payload);
    const wrongStore = vi.spyOn(owner.artifacts, 'readRange');
    let reclaimed = false;
    const reads = vi.fn(async (request: import('../assignment-stream-mesh.js').AssignmentStreamArtifactRead) => {
      expect(reclaimed).toBe(false);
      const bytes = await executor.artifacts.readRange(request.ref, request.offset, request.limit);
      return { ref: request.ref, offset: request.offset, bytes, complete: request.offset + bytes.length === request.ref.bytes };
    });
    const manager = new AssignmentStreamPathManager({ assignmentId: original.assignmentId, ref: original.ref,
      consumer: { kind: 'surface-ticket', ticketId: 'surface' },
      direct: { open: async () => ({ subscribe: async () => [original], readArtifact: reads,
        acknowledge: async ack => { if (ack.ackSeq === 1) {
          expect(owner.publish).toHaveBeenCalledOnce(); reclaimed = true;
        } } }) },
      adoptFrame: (value, _checkpoint, _signal, readDisplay) => owner.p.accept(value, readDisplay),
    });
    await manager.poll();
    expect(reclaimed).toBe(true); expect(reads).toHaveBeenCalled(); expect(wrongStore).not.toHaveBeenCalled();
    expect(owner.publish.mock.calls[0]![2]).toMatchObject({ truncated: true, payload: { kind: 'yield' } });
    owner.p.dispose();
  });
  it('does not pause a long streamed answer when its final persistence snapshot exceeds the observer wire', async () => {
    const s = await setup(), text = '中文长回答'.repeat(20_000);
    const prepared = await prepareStreamDataPayload({ kind: 'agent-yield', yield: { type: 'assistant_message',
      message: { role: 'assistant', content: [{ type: 'text', text }] } } }, s.artifacts);
    s.p.accept(frame(1, prepared.payload)); await s.p.idle();
    expect(s.publish.mock.calls[0]![2]).toMatchObject({ truncated: true, payload: { kind: 'yield', delta: { type: 'assistant_message' } } });
    s.p.streamEnded({ conversationId: 'c', runId: 'r', assignmentId: 'assignment', finalSeq: 2 });
    s.p.finish(); await Promise.resolve();
    expect(s.publish.mock.calls.map(call => call[2].payload.kind)).toEqual(['yield', 'closed']);
  });
  it('materializes a real externalized tool artifact through existing authority and publishes a separate bounded DTO', async () => {
    const s = await setup();
    const plain = { id: 1, authenticated: true, closed: false, loopback: true, notify: vi.fn(), presentationProfile: () => 'default' as const };
    const enhanced = { ...plain, id: 2, notify: vi.fn(), presentationProfile: () => 'bounded-v1' as const };
    const transport = createSessionBroadcastTransport({ connections: new Set([plain, enhanced]), observerConnectionIds: () => new Set(['1', '2']) });
    const deliver = vi.fn(transport.session);
    const projection = new SessionProcessProjector({ artifacts: s.artifacts, publish: (conversationId, method, value) => {
      s.publish(conversationId, method, value); deliver(conversationId, method, value);
    } });
    const prepared = await prepareStreamDataPayload({ kind: 'agent-yield', yield: { type: 'tool_end', id: 'edit', name: 'edit', duration: 1,
      result: { content: 'edited', presentation: { kind: 'file-diff', path: 'a.ts', operation: 'modified',
        changeStats: { kind: 'exact', addedLines: 1000, removedLines: 0 },
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1000,
          lines: Array.from({ length: 1000 }, (_, i) => ({ type: 'added', newLineNumber: i + 1, content: '汉'.repeat(100) })) }] } } } }, s.artifacts);
    expect(JSON.stringify(prepared.payload)).toContain('"ref"');
    const original = frame(1, prepared.payload); projection.accept(original); await projection.idle();
    expect(deliver.mock.results).toEqual([expect.objectContaining({ type: 'return' })]);
    expect(s.publish).toHaveBeenCalledOnce();
    const projected = s.publish.mock.calls[0]![2];
    expect(projected.payload.delta.result).toEqual({ content: 'edited' });
    expect(projected.payload.artifact.kind).toBe('file-diff');
    expect(projected.source).toMatchObject({ conversationId: 'c', runId: 'r', assignmentId: 'assignment', streamEpoch: 1, sourceSeq: 1 });
    expect(projected.source.turnId).toBeUndefined();
    expect(JSON.stringify(projected)).not.toContain('"ref"'); expect(projected).not.toHaveProperty('v');
    expect(original.payload).toEqual(prepared.payload);
    expect(JSON.stringify(plain.notify.mock.calls)).not.toMatch(/file-diff|"ref"/u);
    expect(JSON.stringify(enhanced.notify.mock.calls)).toContain('file-diff');
    expect(plain.notify).toHaveBeenCalledOnce(); expect(enhanced.notify).toHaveBeenCalledOnce();
    expect(enhanced.notify.mock.calls[0]![1].source).toEqual(plain.notify.mock.calls[0]![1].source);
    projection.dispose();
  });
  it('holds the ACK-facing acceptance until its read completes, and releases it without late delivery on dispose', async () => {
    const s = await setup();
    const prepared = await prepareStreamDataPayload({ kind: 'agent-yield', yield: { type: 'text_delta', text: 'x'.repeat(40000) } }, s.artifacts);
    const actual = s.artifacts.readRange.bind(s.artifacts); let release!: () => void;
    vi.spyOn(s.artifacts, 'readRange').mockImplementation(async (...args) => {
      await new Promise<void>(resolve => { release = resolve; }); return actual(...args);
    });
    let acknowledged = false;
    const accepted = Promise.resolve(s.p.accept(frame(1, prepared.payload))).then(() => { acknowledged = true; });
    await Promise.resolve(); expect(acknowledged).toBe(false);
    s.p.dispose(); await accepted; expect(acknowledged).toBe(true);
    release(); await s.p.idle(); expect(s.publish).not.toHaveBeenCalled();
  });
  it('bounds an unavailable display read without indefinitely blocking protocol acknowledgment', async () => {
    const s = await setup(); vi.useFakeTimers();
    let release!: (value: { kind: 'agent-yield'; yield: { type: 'text_delta'; text: string } }) => void;
    const accepted = s.p.accept(frame(1, { kind: 'agent-yield', yield: { type: 'text_delta', text: 'prefix' } }),
      () => new Promise(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(PROCESS_COMPLETION_GRACE_MS);
    await accepted; expect(s.publish.mock.calls.map(call => call[2].payload.kind)).toEqual(['gap']);
    release({ kind: 'agent-yield', yield: { type: 'text_delta', text: 'late' } });
    await s.p.idle(); expect(s.publish).toHaveBeenCalledOnce();
  });
  it('bounds queued frames and emits exactly one gap without failing the producer', async () => {
    const s = await setup();
    const prepared = await prepareStreamDataPayload({ kind: 'agent-yield', yield: { type: 'text_delta', text: 'x'.repeat(40000) } }, s.artifacts);
    let release!: (value: Uint8Array) => void;
    vi.spyOn(s.artifacts, 'readRange').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    for (let i = 1; i <= 50; i++) s.p.accept(frame(i, prepared.payload));
    expect(s.publish).toHaveBeenCalledOnce(); expect(s.publish.mock.calls[0]![2].payload.kind).toBe('gap');
    release(Buffer.from('corrupt')); await s.p.idle(); expect(s.publish).toHaveBeenCalledOnce();
  });
  it('does not infer parent closure from provisional final, and closes after accepted display work', async () => {
    const s = await setup();
    s.p.accept(frame(1, { kind: 'agent-yield', yield: { type: 'text_delta', text: 'answer' } }));
    s.p.accept(frame(2, { kind: 'provisional-final', finalSeq: 2, streamDigest: `sha256:${'a'.repeat(64)}` }));
    await s.p.idle(); expect(s.publish.mock.calls.map(c => c[2].payload.kind)).toEqual(['yield']);
    s.p.finish(); await Promise.resolve();
    expect(s.publish.mock.calls.map(c => c[2].payload.kind)).toEqual(['yield', 'closed']);
  });
  it('the generation owner keeps final-first tail frames until their real stream boundary, then rejects late frames', async () => {
    const s = await setup(), owner = new SessionProcessProjectionOwner({ artifacts: s.artifacts, publish: s.publish });
    owner.finish('c', 'r'); owner.accept(frame(1, { kind: 'agent-yield', yield: { type: 'text_delta', text: 'real tail' } }));
    await vi.waitFor(() => expect(s.publish).toHaveBeenCalledOnce());
    expect(s.publish.mock.calls[0]![2].payload.delta.text).toBe('real tail');
    owner.accept(frame(2, { kind: 'provisional-final', finalSeq: 2, streamDigest: `sha256:${'a'.repeat(64)}` }));
    await vi.waitFor(() => expect(s.publish).toHaveBeenCalledTimes(2));
    expect(s.publish.mock.calls[1]![2].payload.kind).toBe('closed');
    owner.accept(frame(3, { kind: 'agent-yield', yield: { type: 'text_delta', text: 'late' } }));
    owner.dispose(); expect(s.publish).toHaveBeenCalledTimes(2);
  });
  it('joins the local producer boundary with parent completion without inventing an extra source sequence', async () => {
    const s = await setup();
    s.p.accept(frame(1, { kind: 'agent-yield', yield: { type: 'text_delta', text: 'answer' } }));
    s.p.streamEnded({ conversationId: 'c', runId: 'r', assignmentId: 'assignment', finalSeq: 2 });
    await s.p.idle(); expect(s.publish).toHaveBeenCalledOnce();
    s.p.finish(); await Promise.resolve();
    expect(s.publish.mock.calls[1]![2]).toMatchObject({ source: { sourceSeq: 1 }, payload: { kind: 'closed' } });
  });
  it('emits one bounded gap when the real tail boundary is unavailable after parent completion', async () => {
    const s = await setup(); vi.useFakeTimers();
    s.p.accept(frame(1, { kind: 'agent-yield', yield: { type: 'text_delta', text: 'prefix' } }));
    await s.p.idle(); s.p.finish();
    await vi.advanceTimersByTimeAsync(PROCESS_COMPLETION_GRACE_MS);
    expect(s.publish.mock.calls.map(call => call[2].payload.kind)).toEqual(['yield', 'gap']);
    expect(s.publish.mock.calls[1]![2].source.sourceSeq).toBe(1);
    s.p.accept(frame(2, { kind: 'agent-yield', yield: { type: 'text_delta', text: 'late' } }));
    expect(s.publish).toHaveBeenCalledTimes(2);
  });
  it('waits for the last accepted artifact read after both real completion signals', async () => {
    const s = await setup();
    const prepared = await prepareStreamDataPayload({ kind: 'agent-yield', yield: { type: 'text_delta', text: 'x'.repeat(40000) } }, s.artifacts);
    const actual = s.artifacts.readRange.bind(s.artifacts); let release!: () => void;
    vi.spyOn(s.artifacts, 'readRange').mockImplementation(async (...args) => {
      await new Promise<void>(resolve => { release = resolve; }); return actual(...args);
    });
    s.p.finish(); s.p.accept(frame(1, prepared.payload));
    s.p.accept(frame(2, { kind: 'provisional-final', finalSeq: 2, streamDigest: `sha256:${'a'.repeat(64)}` }));
    expect(s.publish).not.toHaveBeenCalled();
    release(); await s.p.idle(); await Promise.resolve();
    expect(s.publish.mock.calls.map(call => call[2].payload.kind)).toEqual(['yield', 'closed']);
  });
});
