import { describe, expect, it } from 'vitest';
import { serverStatusLines, serverStatusSummary, formatRecoveryBackupState } from '../server-status-presentation.js';
import { summaryLines } from '../../summary-projection.js';
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

  const proxy = { mode: 'auto' as const, hasResolvedProxy: true, display: 'http://127.0.0.1:7890（来自环境变量）' };
  // 运行状态按页拆分；这些用例的内容都在一页之内
  const status = (...args: Parameters<typeof serverStatusSummary>) => { const pages = serverStatusSummary(...args); expect(pages).toHaveLength(1); return pages[0]!; };
  const rows = (summary: ReturnType<typeof status>, title: string) => summary.sections.find(section => section.title === title)?.rows;

  it('keeps the locally known model and network with their source when the host is unavailable, and omits only host sections', () => {
    const summary = status('06 表格（工作场景：论文）', { providerId: 'anthropic', model: 'claude' }, proxy, null);
    expect(summary.lead).toEqual([[{ text: '06 表格（工作场景：论文）', tone: 'accent' }], [{ text: '宿主状态暂不可用。', tone: 'warn' }]]);
    expect(summary.sections.map(section => section.title)).toEqual(['模型与网络']);
    expect(rows(summary, '模型与网络')).toEqual([
      { label: '模型', value: 'claude' }, { label: '服务商', value: 'anthropic' }, { label: '网络代理', value: 'http://127.0.0.1:7890（来自环境变量）' }]);
    expect(rows(status('A', { providerId: '', model: '' }, proxy, null), '模型与网络')!.slice(0, 2).map(row => row.value)).toEqual(['(未配置)', '(未配置)']);
  });

  it('groups service and access, pending work and maintenance, and marks only states that need attention', () => {
    const info: ServerInfoResult = { version: '1', protocol: 1, pid: 42, startedAt: '', uptimeSec: 5, host: '127.0.0.1', port: 47800,
      activeConversations: 1, busyConversations: 0, connectionCount: 1, memoryRssBytes: 1,
      channels: [{ channelId: 'feishu', state: 'error', error: 'token 过期' }, { channelId: 'slack', state: 'connected' }, { channelId: 'mail', state: 'disconnected' }],
      deferredWork: [{ id: 'delivery', kind: 'delivery', label: '离线消息', count: 4 }], keepAliveWork: [],
      recoveryBackup: { state: 'pending-verification', fullBackupReady: false, nextAction: 'run-backup-verify' }, logPath: 'C:\\Users\\me\\.zhixing\\logs\\host.log' };
    const summary = status('A', { providerId: 'p', model: 'm' }, proxy, info);
    expect(summary.lead).toEqual([[{ text: 'A', tone: 'accent' }]]);
    expect(summary.sections.map(section => section.title)).toEqual(['模型与网络', '服务与接入', '待处理', '运维']);
    expect(rows(summary, '服务与接入')).toEqual([
      { label: '运行服务', value: 'pid 42 · 127.0.0.1:47800' },
      { label: '接入面', value: '当前终端 · slack' },
      { label: '通道 feishu', value: '异常', tone: 'warn', note: 'token 过期' },
      { label: '通道 slack', value: '已连接' },
      { label: '通道 mail', value: '未连接', tone: 'warn' }]);
    expect(rows(summary, '待处理')).toEqual([
      { label: '运行中', value: '无' }, { label: '未送达', value: '4 条待重试', tone: 'warn' }, { label: '定时任务', value: '0 个已启用' }]);
    expect(rows(summary, '运维')).toEqual([
      { label: '恢复备份', value: '待验证（运行 zz backup verify）', tone: 'warn' }, { label: '日志', value: 'C:\\Users\\me\\.zhixing\\logs\\host.log' }]);
    expect(summary.sections.at(-1)!.notes).toEqual(['需要停止知行请输入 /stop。']);
    const calm = status('A', { providerId: 'p', model: 'm' }, proxy, { ...info, channels: [], deferredWork: [], recoveryBackup: { state: 'recoverable', fullBackupReady: true } });
    expect(JSON.stringify(calm)).not.toContain('"warn"');
  });

  it('writes the text session lines from the same projection', () => {
    expect(serverStatusLines('A', { providerId: 'p', model: 'm' }, proxy, null)).toEqual(serverStatusSummary('A', { providerId: 'p', model: 'm' }, proxy, null).flatMap(summaryLines));
  });
  it('pages a long channel list so every channel stays reachable, with the stop note at the end of its section', () => {
    const channels = Array.from({ length: 700 }, (_, index) => ({ channelId: `channel-${index}`, state: 'connected' as const }));
    const info: ServerInfoResult = { version: '1', protocol: 1, pid: 1, startedAt: '', uptimeSec: 1, activeConversations: 0, busyConversations: 0,
      connectionCount: 1, memoryRssBytes: 1, channels, logPath: 'C:\\logs' };
    const pages = serverStatusSummary('A', { providerId: 'p', model: 'm' }, proxy, info);
    expect(pages.length).toBeGreaterThan(1);
    const shown = pages.flatMap(page => page.sections).filter(section => section.title.startsWith('服务与接入')).flatMap(section => section.rows ?? []);
    expect(shown.filter(row => row.label.startsWith('通道 '))).toHaveLength(700);
    expect(pages.flatMap(page => page.sections).some(section => section.notes?.some(note => note.includes('未能显示')))).toBe(false);
    expect(pages.at(-1)!.sections.at(-1)).toMatchObject({ title: '运维', notes: ['需要停止知行请输入 /stop。'] });
  });
});
