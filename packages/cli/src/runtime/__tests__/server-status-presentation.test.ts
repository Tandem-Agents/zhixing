import { describe, expect, it } from 'vitest';
import { serverStatusLines, formatRecoveryBackupState } from '../server-status-presentation.js';
import type { ServerInfoResult } from '../rpc-management-facade.js';

describe('shared terminal status projection', () => {
  it('preserves authoritative access, cancellation, pending delivery and backup recovery information', () => {
    const info: ServerInfoResult = { version: '1', protocol: 1, pid: 42, startedAt: '', uptimeSec: 5,
      activeConversations: 3, busyConversations: 9, connectionCount: 99, memoryRssBytes: 1,
      accessSurfaces: { rpcConnections: 3, channels: [], otherRpcConnections: 2, liveChannels: [{ channelId: 'feishu', state: 'connected' }] },
      activeWork: { count: 3, cancellableCount: 1, drainOnlyCount: 2,
        cancellableWork: [{ id: 'run', kind: 'conversation', label: '当前运行', count: 1 }],
        drainOnlyWork: [{ id: 'delivery', kind: 'delivery', label: '外部投递', count: 2 }] },
      deferredWork: [{ id: 'delivery', kind: 'delivery', label: '离线消息', count: 4 }],
      keepAliveWork: [{ id: 'schedule', kind: 'schedule', label: '定时任务', count: 5 }],
      recoveryBackup: { state: 'unavailable', fullBackupReady: false, nextAction: 'restore-backup-connection' } };
    const text = serverStatusLines('测试', { providerId: 'provider', model: 'model' },
      { mode: 'off', hasResolvedProxy: false, display: '已关闭' }, info).join('\n');
    expect(text).toContain('其他终端 2 · feishu');
    expect(text).not.toContain('其他终端 98');
    expect(text).toContain('可取消 1 · 等待投递 2');
    expect(text).toContain('外部投递 x2');
    expect(text).toContain('4 条待重试');
    expect(text).toContain('5 个已启用');
    expect(text).toContain('恢复连接后重试');
  });

  it('does not turn an unavailable target or an unverified backup into recoverable', () => {
    expect(formatRecoveryBackupState({ state: 'pending-verification', fullBackupReady: false, nextAction: 'run-backup-verify' })).toContain('待验证');
    expect(formatRecoveryBackupState({ state: 'unavailable', fullBackupReady: true, nextAction: 'check-backup-target' })).toContain('检查备份目标');
    expect(formatRecoveryBackupState({ state: 'recoverable', fullBackupReady: true })).toBe('可恢复');
    expect(serverStatusLines('测试', { providerId: '', model: '' }, { mode: 'off', hasResolvedProxy: false, display: '已关闭' }, null)).toContain('宿主状态暂不可用。');
  });
});
