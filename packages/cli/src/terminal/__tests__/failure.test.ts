import { describe, expect, it, vi } from 'vitest';
import { recordTerminalFailure, terminalStorageFullMessage } from '../failure.js';
import type { LogDraft, LogRecordPort } from '@zhixing/core/logging';

describe('terminal first-cause logging', () => {
  it.each(['timeout', 'size', 'busy', 'incomplete', 'unavailable', 'encoding', 'read-failed', 'aborted', 'output-capacity'])
  ('records clipboard %s with its action and request identity', reason => {
    const record = vi.fn(), records = { record } as unknown as LogRecordPort;
    recordTerminalFailure(records, Error('terminal-clipboard-' + reason), 'terminal-request-failed',
      { action: 'clipboard-read', requestId: 37, durationMs: 1501 });
    expect(record.mock.calls[0]![0]).toMatchObject({ data: { action: 'clipboard-read', requestId: 37, durationMs: 1501,
      failure: { category: 'terminal', code: 'terminal-clipboard-' + reason } } });
    recordTerminalFailure(records, Error('clipboard contains private-message'), 'terminal-request-failed', { action: 'clipboard-write' });
    expect(JSON.stringify(record.mock.calls)).not.toContain('private-message');
    expect(record.mock.calls[1]![0].data.action).toBe('clipboard-write');
  });
  it('S 记录角色通道失败时带上另一端的角色与积压', () => {
    const entries: LogDraft[] = [];
    const records: LogRecordPort = { record: value => { entries.push(typeof value === 'function' ? value() : value); } };
    recordTerminalFailure(records, Error('terminal-delivery-timeout'), 'terminal-delivery-timeout', { role: 'application', pending: 3, queued: 1 });
    expect(entries[0]?.data).toMatchObject({ reason: 'terminal-delivery-timeout', role: 'application', pending: 3, queued: 1 });
  });

  it('记录有限错误码/请求及代码位置，不记录原始错误秘密或绝对路径', () => {
    const record = vi.fn(), records = { record } as unknown as LogRecordPort;
    const cause = Error('secret provider payload');
    cause.stack = 'Error: secret provider payload\n    at receive (file:///C:/private-home/packages/cli/dist/application-ABCD.js:18:7)\n    at file:///C:/private-home/custom-secret-path.js:8:1';
    const error = Error('terminal-application-request-capacity', { cause });
    error.stack = 'Error: terminal-application-request-capacity';
    recordTerminalFailure(records, error, 'terminal-receive-failed', { action: 'history-previous', requestId: 18, pending: 8 });
    expect(record.mock.calls[0]![0]).toMatchObject({ event: 'terminalFailure', data: {
      action: 'history-previous', requestId: 18, pending: 8,
      failure: { code: 'terminal-application-request-capacity' }, sourceFrames: ['cli/application-ABCD.js:18:7'],
    } });
    const serialized = JSON.stringify(record.mock.calls);
    expect(serialized).not.toMatch(/secret|private-home|C:/u);
  });

  it('资产失败的接续原因只记白名单码', () => {
    const entries: LogDraft[] = [];
    const records: LogRecordPort = { record: value => { entries.push(typeof value === 'function' ? value() : value); } };
    recordTerminalFailure(records, Error('terminal-assets-deadline'), 'terminal-assets-operation-failed',
      { durationMs: 4001, asset: { operation: 'reserve', bucket: 'display', bytes: 10, attempts: 3, retriedOn: 'terminal-root-busy' } });
    recordTerminalFailure(records, Error('terminal-assets-deadline'), 'terminal-assets-operation-failed',
      { asset: { operation: 'settle', bytes: 0, attempts: 2, retriedOn: 'private-secret' } });
    expect(entries[0]?.data).toMatchObject({ durationMs: 4001, failure: { code: 'terminal-assets-deadline' },
      asset: { operation: 'reserve', bucket: 'display', bytes: 10, attempts: 3, retriedOn: 'terminal-root-busy' } });
    expect(JSON.stringify(entries[1])).not.toContain('private-secret');
  });

  it('真实容量不足按哪一层满了给出出路；策略缺口与其余原因不算存储满', () => {
    expect(terminalStorageFullMessage('terminal-instance-display-capacity')).toContain('新开一个终端窗口');
    expect(terminalStorageFullMessage('terminal-root-capacity')).toContain('关闭其他终端窗口');
    expect(terminalStorageFullMessage('terminal-disk-capacity')).toContain('释放磁盘空间');
    for (const code of ['terminal-assets-capacity-gap', 'terminal-assets-capacity-backpressured', 'terminal-assets-deadline', 'terminal-assets-unavailable', undefined])
      expect(terminalStorageFullMessage(code)).toBeUndefined();
  });
});
