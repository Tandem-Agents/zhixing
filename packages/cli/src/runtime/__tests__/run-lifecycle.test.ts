import { describe, expect, it } from 'vitest';
import type { ConversationStatusNotice } from '@zhixing-ai/core/contracts';
import { RunLifecycleTracker } from '../run-lifecycle.js';

const DIGEST = `sha256:${'1'.repeat(64)}`;
function notice(runId: string, state: string, statusRevision: number, extra: Record<string, unknown> = {}): ConversationStatusNotice {
  return { v: 1, ref: { execution: 'conversation', conversationId: 'conv', ownerEpoch: 1, runId }, state, statusRevision,
    actions: state === 'uncertain' ? ['verify-side-effects', 'abandon', 'retry-risk-ack'] : [], at: '2026-11-06T00:00:00.000Z',
    ...(state === 'uncertain' || state === 'uncertain-closed' ? { openFactDigest: DIGEST } : {}), ...extra } as never;
}

describe('RunLifecycleTracker', () => {
  it('treats a receipt as unknown and never lets it override a status or a terminal state', () => {
    const tracker = new RunLifecycleTracker();
    expect(tracker.receipt('conv', 'run', 'turn')).toBe(true);
    expect(tracker.get('run')).toMatchObject({ state: 'unknown', local: true, turnId: 'turn', statusRevision: 0 });
    tracker.status(notice('run', 'queued', 1));
    expect(tracker.receipt('conv', 'run', 'turn')).toBe(false);
    expect(tracker.get('run')).toMatchObject({ state: 'queued', local: true });
    // 状态先于回执：回执只补“本接入面”，不改状态
    tracker.status(notice('early', 'queued', 1));
    tracker.receipt('conv', 'early', 'turn-early');
    expect(tracker.get('early')).toMatchObject({ state: 'queued', local: true, turnId: 'turn-early' });
    // 终态先于回执：回执不复活
    tracker.final('conv', 'done');
    tracker.receipt('conv', 'done', 'turn-done');
    expect(tracker.get('done')).toMatchObject({ state: 'terminal' });
  });

  it('accepts only higher status revisions of the same run and keeps a confirmed terminal state', () => {
    const tracker = new RunLifecycleTracker();
    tracker.status(notice('run', 'dispatched', 2, { assignmentId: 'a' }));
    expect(tracker.status(notice('run', 'queued', 1)).changed).toBe(false);
    expect(tracker.get('run')).toMatchObject({ state: 'dispatched', assignmentId: 'a' });
    tracker.status(notice('run', 'running', 5, { assignmentId: 'a' }));
    // final 的 commitRevision 与 statusRevision 属于不同计数域：数字再小也表示已提交
    expect(tracker.final('conv', 'run')).toBe(true);
    expect(tracker.get('run')).toMatchObject({ state: 'terminal' });
    expect(tracker.get('run')).not.toHaveProperty('assignmentId');
    expect(tracker.status(notice('run', 'running', 6, { assignmentId: 'a' })).changed).toBe(false);
    expect(tracker.get('run')).toMatchObject({ state: 'terminal' });
  });

  it('maps an uncertain closure by its resulting state', () => {
    const tracker = new RunLifecycleTracker();
    tracker.status(notice('retry', 'running', 2, { assignmentId: 'a' }));
    tracker.status(notice('retry', 'uncertain', 3));
    expect(tracker.get('retry')).toMatchObject({ state: 'uncertain' });
    expect(tracker.get('retry')).not.toHaveProperty('assignmentId');
    tracker.status(notice('retry', 'uncertain-closed', 4, { closedBy: 'user-retry-acknowledged', resultingState: 'queued' }));
    expect(tracker.get('retry')).toMatchObject({ state: 'queued' });
    tracker.status(notice('failed', 'uncertain', 1));
    tracker.status(notice('failed', 'uncertain-closed', 2, { closedBy: 'user-verified-side-effects', resultingState: 'failed' }));
    expect(tracker.get('failed')).toMatchObject({ state: 'terminal' });
  });

  it('confirms the current attempt only from authoritative statuses and isolates stale attempts', () => {
    const tracker = new RunLifecycleTracker();
    expect(tracker.admitProcess('run', 'a', undefined)).toBe('unconfirmed');
    tracker.status(notice('run', 'dispatched', 2, { assignmentId: 'a' }));
    expect(tracker.admitProcess('run', 'a', undefined)).toBe('accept');
    tracker.status(notice('run', 'uncertain', 3));
    tracker.status(notice('run', 'uncertain-closed', 4, { closedBy: 'user-retry-acknowledged', resultingState: 'queued' }));
    // 重新排队：旧身份作废，迟到的旧帧不被认作当前尝试
    expect(tracker.admitProcess('run', 'a', 'a')).toBe('unconfirmed');
    const confirmed = tracker.status(notice('run', 'dispatched', 5, { assignmentId: 'b' }));
    // 与此前确证过的尝试不同：是新尝试，旧尝试的展示须作废
    expect(confirmed).toEqual({ changed: true, attemptChanged: true, newAttempt: true });
    // B 已派发、A 的尾帧先到：丢弃；B 的帧遇到 A 的旧条目：旧条目作废后重新开始
    expect(tracker.admitProcess('run', 'a', 'a')).toBe('drop');
    expect(tracker.admitProcess('run', 'b', 'a')).toBe('restart');
    expect(tracker.admitProcess('run', 'b', 'b')).toBe('accept');
    // 取消中仍是同一次尝试：状态没带身份时沿用
    tracker.status(notice('run', 'cancel-requested', 6));
    expect(tracker.get('run')).toMatchObject({ state: 'cancel-requested', assignmentId: 'b' });
    expect(tracker.admitProcess('run', 'a', 'b')).toBe('drop');
    // 派发没带身份时无法确证
    tracker.status(notice('other', 'dispatched', 1));
    expect(tracker.admitProcess('other', 'x', undefined)).toBe('unconfirmed');
  });

  it('stays bounded and evicts finished runs first', () => {
    const tracker = new RunLifecycleTracker();
    tracker.final('conv', 'finished');
    for (let index = 0; index < 64; index++) tracker.status(notice(`run-${index}`, 'queued', 1));
    expect(tracker.get('finished')).toBeUndefined();
    expect(tracker.snapshot('conv')).toHaveLength(64);
    expect(tracker.snapshot('other')).toHaveLength(0);
  });
});
