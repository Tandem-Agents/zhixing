/**
 * 后台宿主的空闲退出判定 —— "无人且无事"才退。
 *
 * - 有人:活跃 RPC 连接(cli 等接入面),或活跃远程接入面(渠道真实连接状态
 *   connected / connecting——以状态而非 registry 对象存在性判定:配了渠道但
 *   全部连接失败 = 不在场,废宿主退出胜过空挂;connecting 算在场,断线重连
 *   窗口里杀进程会让恢复机制随进程消失)。
 * - 有事:enabled 的非内部任务——定时任务的语义就是"我不在它也跑";内部
 *   维护任务(retention 等)不算待办,否则宿主永不退。
 *
 * 纯函数:command 装配层每 tick 取快照传入,判定逻辑独立可测。
 */

import type { ChannelState } from "@zhixing/core/channels";

export interface IdleSnapshot {
  /** 活跃 RPC 连接数 */
  connectionCount: number;
  /** 全部渠道的连接状态(未装配渠道 = 空数组) */
  channelStates: readonly ChannelState[];
  /** 是否存在 enabled 的非内部任务 */
  hasUserPendingWork: boolean;
}

export function shouldIdleExit(snapshot: IdleSnapshot): boolean {
  if (snapshot.connectionCount > 0) return false;
  const hasLiveRemoteSurface = snapshot.channelStates.some(
    (state) => state === "connected" || state === "connecting",
  );
  if (hasLiveRemoteSurface) return false;
  return !snapshot.hasUserPendingWork;
}

/**
 * 空闲须跨过一个完整检查周期才退出：本次与上一次检查都判定空闲，且两次之间连接变动计数未变（期间没有任何连接进出）。
 * 只看单次快照时，上一个终端刚断开、下一个终端尚未连上的空档也会被判为空闲，宿主在新终端启动途中停机。
 * 返回的判定函数有状态，每个空闲检查责任各持一个。
 */
export function createIdleExitGate(): (idle: boolean, connectionChanges: number) => boolean {
  let idleAt: number | undefined;
  return (idle, connectionChanges) => {
    const confirmed = idle && idleAt === connectionChanges;
    idleAt = idle ? connectionChanges : undefined;
    return confirmed;
  };
}
