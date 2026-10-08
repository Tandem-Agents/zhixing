import type { ServerInfoResult } from './rpc-management-facade.js';
import type { RuntimeNetworkProxyDisplayProjection, RuntimePrimaryModelDisplayProjection } from './runtime-configuration-provider.js';
import { activeWork, countWork, formatWorkItems, liveChannels, otherRpcConnections } from './stop-selection.js';

/** Shared, read-only status projection. Neither surface reads backup credentials. */
export function serverStatusLines(name: string, model: RuntimePrimaryModelDisplayProjection,
  proxy: RuntimeNetworkProxyDisplayProjection, info: ServerInfoResult | null): string[] {
  const lines = [`对话：${name}`, `模型：${model.model || '(未配置)'}`, `提供方：${model.providerId || '(未配置)'}`, `网络代理：${proxy.display}`];
  if (!info) return [...lines, '宿主状态暂不可用。'];
  const work = activeWork(info), other = otherRpcConnections(info), live = liveChannels(info);
  lines.push(`运行服务：pid ${info.pid} · ${info.host ?? '127.0.0.1'}:${info.port ?? '?'}`,
    `接入面：当前终端${other ? ` · 其他终端 ${other}` : ''}${live.length ? ` · ${live.map(item => item.channelId).join('、')}` : ''}`,
    `运行中：${work.count ? `可取消 ${work.cancellableCount} · 等待投递 ${work.drainOnlyCount}` : '无'}`);
  if (work.count) lines.push(`可取消：${formatWorkItems(work.cancellableWork)}`, `仅等待：${formatWorkItems(work.drainOnlyWork)}`);
  lines.push(`未送达：${countWork(info.deferredWork)} 条待重试`, `定时任务：${countWork(info.keepAliveWork)} 个已启用`);
  for (const channel of info.channels ?? []) {
    const state = { connected: '已连接', connecting: '连接中', error: '异常', disconnected: '未连接' }[channel.state];
    lines.push(`通道 ${channel.channelId}：${state}${channel.error ? `（${channel.error}）` : ''}`);
  }
  if (info.recoveryBackup) lines.push(`恢复备份：${formatRecoveryBackupState(info.recoveryBackup)}`);
  if (info.logPath) lines.push(`日志：${info.logPath}`);
  lines.push('需要停止知行请输入 /stop。');
  return lines;
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
