import type { ChannelStatus } from '@zhixing/core/channels';
import type { RuntimeControlWorkItem, ServerActiveWork, ServerInfoResult } from './rpc-management-facade.js';
import type { SelectionOption, SelectionRequest } from '../tui/selection/types.js';

export function countWork(items: readonly RuntimeControlWorkItem[] | undefined): number {
  return (items ?? []).reduce((sum, item) => sum + Math.max(0, item.count), 0);
}

export function formatWorkItems(items: readonly RuntimeControlWorkItem[] | undefined): string {
  const list = items ?? [];
  if (list.length === 0) return "无";
  return list.map((item) => `${item.label} x${item.count}`).join("、");
}

export function liveChannels(hostInfo: ServerInfoResult | null): ChannelStatus[] {
  const fromSnapshot = hostInfo?.accessSurfaces?.liveChannels;
  if (fromSnapshot) return fromSnapshot;
  return (hostInfo?.channels ?? []).filter(
    (s) => s.state === "connected" || s.state === "connecting",
  );
}

export function activeWork(hostInfo: ServerInfoResult | null): ServerActiveWork {
  return (
    hostInfo?.activeWork ?? {
      count: hostInfo?.busyConversations ?? 0,
      cancellableCount: hostInfo?.busyConversations ?? 0,
      drainOnlyCount: 0,
      cancellableWork: [],
      drainOnlyWork: [],
    }
  );
}

export function otherRpcConnections(hostInfo: ServerInfoResult | null): number {
  const projected = hostInfo?.accessSurfaces?.otherRpcConnections;
  if (typeof projected === "number") return Math.max(0, projected);
  return Math.max(0, (hostInfo?.connectionCount ?? 1) - 1);
}

export type StopChoice = "stop" | "wait" | "cancel-work-stop" | "cancel";

export function buildStopBody(hostInfo: ServerInfoResult | null): string[] {
  if (!hostInfo) {
    return ["当前无法读取宿主状态。为避免误停，先取消并稍后重试。"];
  }
  const body: string[] = [];
  const otherRpc = otherRpcConnections(hostInfo);
  const live = liveChannels(hostInfo);
  const work = activeWork(hostInfo);
  const deferredCount = countWork(hostInfo.deferredWork);
  const keepAliveCount = countWork(hostInfo.keepAliveWork);

  if (otherRpc > 0 || live.length > 0) {
    const surfaces = [
      otherRpc > 0 ? `其他终端 ${otherRpc}` : "",
      live.length > 0 ? live.map((s) => s.channelId).join("、") : "",
    ].filter(Boolean);
    body.push(`停止后会断开其他接入面：${surfaces.join("；")}`);
  }
  if (work.count > 0) {
    body.push(
      `当前有运行中的工作：可取消 ${work.cancellableCount}，等待投递 ${work.drainOnlyCount}。`,
    );
  }
  if (deferredCount > 0) {
    body.push(`还有 ${deferredCount} 条未送达消息，会保留并在下次启动后重试。`);
  }
  if (keepAliveCount > 0) {
    body.push(`有 ${keepAliveCount} 个已启用定时任务，停止后不会继续触发。`);
  }
  if (body.length === 0) body.push("当前没有其他接入面或运行中的工作。");
  return body;
}

export function buildStopOptions(
  hostInfo: ServerInfoResult | null,
): SelectionOption<StopChoice>[] {
  const work = activeWork(hostInfo);
  if (!hostInfo) {
    return [{ value: "cancel", label: "取消", hotkey: "c", tone: "primary" }];
  }
  if (work.count > 0) {
    const options: SelectionOption<StopChoice>[] = [
      {
        value: "wait",
        label: "等待完成后停止",
        description: "先 flush 可投递消息，再请求宿主退出",
        hotkey: "w",
        tone: "primary",
      },
    ];
    if (work.cancellableCount > 0) {
      options.push({
        value: "cancel-work-stop",
        label: "取消工作并停止",
        description: "中断当前对话/任务后退出宿主",
        hotkey: "x",
        tone: "danger",
        confirm: { title: '取消工作并停止知行', body: ['将中断当前可取消的对话和任务，然后停止宿主。', '已发生的文件修改或外部操作不会回滚。'], confirmLabel: '确认取消工作并停止', cancelLabel: '返回' },
      });
    }
    options.push({ value: "cancel", label: "返回", hotkey: "c", tone: "muted" });
    return options;
  }
  return [
    {
      value: "stop",
      label: "停止知行",
      description: "关闭宿主，当前终端也会退出",
      hotkey: "s",
      tone: "danger",
    },
    { value: "cancel", label: "返回", hotkey: "c", tone: "muted" },
  ];
}

export function shutdownStrategyForChoice(choice: StopChoice): "immediate" | "drain" | "cancel" {
  if (choice === "wait") return "drain";
  if (choice === "cancel-work-stop") return "cancel";
  return "immediate";
}

export function createStopSelectionRequest(hostInfo: ServerInfoResult | null): SelectionRequest<StopChoice> {
  return { id: 'server-stop', title: '停止知行', body: buildStopBody(hostInfo), options: buildStopOptions(hostInfo),
    initialValue: activeWork(hostInfo).count > 0 ? 'wait' : hostInfo ? 'stop' : 'cancel', submitLabel: '确认', cancelLabel: '返回' };
}
