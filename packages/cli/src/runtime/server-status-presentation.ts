import type { ServerInfoResult } from './rpc-management-facade.js';
import type { RuntimeNetworkProxyDisplayProjection, RuntimePrimaryModelDisplayProjection } from './runtime-configuration-provider.js';
import type { TerminalSummary, TerminalSummaryRow, TerminalSummarySection, TerminalSummaryText } from '@zhixing/terminal-ui/protocol';
import { activeWork, countWork, formatWorkItems, liveChannels, otherRpcConnections } from './stop-selection.js';
import { paginateSummary, summaryLines, summaryText } from '../summary-projection.js';

const CHANNEL_STATE = { connected: '已连接', connecting: '连接中', error: '异常', disconnected: '未连接' } as const;

/**
 * 运行状态的语义投影，终端信息页与文本会话共用。本机已知的模型与网络任何时候都陈述；
 * 宿主不可用时只省略依赖宿主的区块，不把未知写成零。需要留意的状态用警示，文字照写。
 * 不读取备份凭据。
 */
export function serverStatusSummary(name: string, model: RuntimePrimaryModelDisplayProjection,
  proxy: RuntimeNetworkProxyDisplayProjection, info: ServerInfoResult | null): TerminalSummary[] {
  const lead: TerminalSummaryText[][] = [[{ text: summaryText(name), tone: 'accent' }]];
  if (!info) lead.push([{ text: '宿主状态暂不可用。', tone: 'warn' }]);
  const sections: TerminalSummarySection[] = [{ title: '模型与网络', rows: [
    { label: '模型', value: summaryText(model.model || '(未配置)') },
    { label: '服务商', value: summaryText(model.providerId || '(未配置)') },
    { label: '网络代理', value: summaryText(proxy.display) },
  ] }];
  if (info) {
    const work = activeWork(info), other = otherRpcConnections(info), live = liveChannels(info);
    const channels: TerminalSummaryRow[] = (info.channels ?? []).map(channel => ({
      label: `通道 ${summaryText(channel.channelId)}`, value: CHANNEL_STATE[channel.state] ?? summaryText(channel.state),
      ...(channel.state === 'error' || channel.state === 'disconnected' ? { tone: 'warn' as const } : {}),
      ...(channel.error ? { note: summaryText(channel.error) } : {}),
    }));
    const deferred = countWork(info.deferredWork);
    const maintenance: TerminalSummaryRow[] = [
      ...(info.recoveryBackup ? [{ label: '恢复备份', value: formatRecoveryBackupState(info.recoveryBackup),
        ...(info.recoveryBackup.state === 'recoverable' ? {} : { tone: 'warn' as const }) }] : []),
      ...(info.logPath ? [{ label: '日志', value: summaryText(info.logPath) }] : []),
    ];
    sections.push(
      { title: '服务与接入', rows: [
        { label: '运行服务', value: summaryText(`pid ${info.pid} · ${info.host ?? '127.0.0.1'}:${info.port ?? '?'}`) },
        { label: '接入面', value: summaryText(`当前终端${other ? ` · 其他终端 ${other}` : ''}${live.length ? ` · ${live.map(item => item.channelId).join('、')}` : ''}`) },
        ...channels,
      ] },
      { title: '待处理', rows: [
        { label: '运行中', value: work.count ? `可取消 ${work.cancellableCount} · 等待投递 ${work.drainOnlyCount}` : '无' },
        ...(work.count ? [{ label: '可取消', value: summaryText(formatWorkItems(work.cancellableWork)) },
          { label: '仅等待', value: summaryText(formatWorkItems(work.drainOnlyWork)) }] : []),
        { label: '未送达', value: `${deferred} 条待重试`, ...(deferred > 0 ? { tone: 'warn' as const } : {}) },
        { label: '定时任务', value: `${countWork(info.keepAliveWork)} 个已启用` },
      ] },
      { title: '运维', rows: maintenance, notes: ['需要停止知行请输入 /stop。'] },
    );
  }
  // 通道等列表随环境增长：按页拆分，整体容量内全部可达
  return paginateSummary(lead, sections);
}

/** 文本会话的出口：与终端信息页同一份投影，逐页逐行输出 */
export function serverStatusLines(name: string, model: RuntimePrimaryModelDisplayProjection,
  proxy: RuntimeNetworkProxyDisplayProjection, info: ServerInfoResult | null): string[] {
  return serverStatusSummary(name, model, proxy, info).flatMap(summaryLines);
}

export function formatRecoveryBackupState(status: NonNullable<ServerInfoResult['recoveryBackup']>): string {
  if (status.state === 'recoverable') return '可恢复';
  if (status.state === 'pending-verification') return '待验证（运行 zz backup verify）';
  if (status.state === 'not-configured') return '未配置（运行 zz backup setup）';
  switch (status.nextAction) {
    case 'repair-backup-configuration': return '配置需要修复（重新运行 zz backup setup）';
    case 'restore-backup-connection': return '连接暂不可用（恢复连接后重试）';
    case 'check-backup-target': return '目标暂不可用（检查备份目标后重试）';
  }
}
