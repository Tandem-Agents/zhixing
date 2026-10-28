import { describe, expect, it } from 'vitest';
import { DEFAULT_LOG_POLICY, LogRecorder, type LogCapture, type LogSink, type LogStatus } from '@zhixing/core/logging';
import { RUNTIME_LOG_SOURCE } from './runtime-source.js';
import { recordTerminalFailure } from '../terminal/failure.js';

describe('terminal timing through the standard recorder', () => {
  it('preserves every numeric timing while excluding actual arguments, environment and paths', async () => {
    const stored: LogCapture[] = [];
    const status: LogStatus = { layout: 'zxlog/1', storeId: 'fixture', policy: { version: 1, effective: DEFAULT_LOG_POLICY },
      bytes: 0, files: 0, retainedSegments: 0, pendingReclaims: 0, overdue: false, upper: 0 };
    const sink: LogSink = { initialize: async () => status, append: async rows => { stored.push(...rows); return status; },
      maintain: async () => status, close: async () => {} };
    const recorder = new LogRecorder(sink), port = recorder.bind(RUNTIME_LOG_SOURCE, { scope: 'storage' });
    const data = { instance: 'instance', role: 'recovery', spawnId: 'spawn', durationMs: 100, permitMs: 1,
      endpointMs: 2, parameterMs: 3, dispatchMs: 4, nativeQueueMs: 5, nativeSetupMs: 6, nativeCreateMs: 70,
      nativePublishMs: 1, nativeTotalMs: 82, observationMs: 5, errorCode: 0 };
    port.record({ event: 'terminalCreation', result: 'success', data: { ...data, arguments: ['private-command'], environment: { SECRET: 'private-value' }, path: 'private-path' } });
    await recorder.start(); await recorder.close(1000);
    const record = stored.find(row => row.record.event === 'terminalCreation')?.record;
    expect(record?.data).toEqual(data);
    expect(JSON.stringify(stored)).not.toContain('private-');
  });

  it('终端实例存储请求的上下文经标准记录器完整落地', async () => {
    const stored: LogCapture[] = [];
    const status: LogStatus = { layout: 'zxlog/1', storeId: 'fixture', policy: { version: 1, effective: DEFAULT_LOG_POLICY },
      bytes: 0, files: 0, retainedSegments: 0, pendingReclaims: 0, overdue: false, upper: 0 };
    const sink: LogSink = { initialize: async () => status, append: async rows => { stored.push(...rows); return status; },
      maintain: async () => status, close: async () => {} };
    const recorder = new LogRecorder(sink), port = recorder.bind(RUNTIME_LOG_SOURCE, { scope: 'storage' });
    const asset = { operation: 'reserve', bucket: 'display', bytes: 4096, attempts: 2, retriedOn: 'terminal-root-busy',
      capacity: { kind: 'cancelled' } } as const;
    recordTerminalFailure(port, Error('terminal-assets-deadline'), 'terminal-assets-operation-failed', { durationMs: 4001, asset });
    port.record({ event: 'terminalAssetRetried', result: 'success', data: { durationMs: 120,
      asset: { operation: 'settle', bytes: 0, attempts: 3, retriedOn: 'terminal-assets-capacity-backpressured' } } });
    await recorder.start(); await recorder.close(1000);
    expect(stored.find(row => row.record.event === 'terminalFailure')?.record.data).toMatchObject({ durationMs: 4001,
      failure: { code: 'terminal-assets-deadline' }, asset });
    expect(stored.find(row => row.record.event === 'terminalAssetRetried')?.record.data).toEqual({ durationMs: 120,
      asset: { operation: 'settle', bytes: 0, attempts: 3, retriedOn: 'terminal-assets-capacity-backpressured' } });
  });
});
