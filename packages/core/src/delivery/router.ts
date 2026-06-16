import type {
  ChannelState,
  ChannelStatus,
  DeliveryTarget,
} from "../channels/types.js";

// ─── 路由请求 ───

export interface RouteRequest {
  /** 显式指定的投递目标（来自 task.delivery） */
  explicit?: DeliveryTarget;
}

// ─── 路由上下文（每次路由决策时构建） ───

export interface RoutingContext {
  /** 触发来源通道（如任务由飞书消息触发，则为 "feishu"） */
  triggerChannel?: string;
  /** 各通道最后活跃时间。路由器不据此猜测通知目标，仅保留为状态事实。 */
  channelActivity: Map<string, Date>;
  /** 各通道当前连接状态 */
  channelStatus: Map<string, ChannelState>;
  /** 用户配置的默认投递通道。自动通知不以此隐式群发或猜测。 */
  defaultChannel?: string;
  /** 各通道默认投递目标。仅触发来源明确时用于回源补全。 */
  channelDefaults: Map<string, DeliveryTarget>;
}

// ─── 路由器接口 ───

export interface DeliveryRouter {
  resolve(request: RouteRequest, context: RoutingContext): DeliveryTarget | null;
}

// ─── 默认实现 ───

export class DefaultDeliveryRouter implements DeliveryRouter {
  resolve(
    request: RouteRequest,
    context: RoutingContext,
  ): DeliveryTarget | null {
    // 1. 显式指定 → 直接使用（Pipeline 负责 channel-not-ready 重试）
    if (request.explicit) {
      return request.explicit;
    }

    // 2. 触发来源通道可达 → 回到触发通道
    if (context.triggerChannel) {
      const target = this.resolveChannel(context.triggerChannel, context);
      if (target) return target;
    }

    // 3. 无明确目标 → 不投递。通知必须有来源或用户显式指定目标。
    return null;
  }

  private isConnected(
    channelId: string,
    context: RoutingContext,
  ): boolean {
    return context.channelStatus.get(channelId) === "connected";
  }

  private resolveChannel(
    channelId: string,
    context: RoutingContext,
  ): DeliveryTarget | null {
    if (!this.isConnected(channelId, context)) return null;
    return context.channelDefaults.get(channelId) ?? null;
  }

}

// ─── 工具函数 ───

export function buildRoutingContext(
  statuses: ChannelStatus[],
  options?: {
    triggerChannel?: string;
    defaultChannel?: string;
    channelDefaults?: Map<string, DeliveryTarget>;
  },
): RoutingContext {
  const channelStatus = new Map<string, ChannelState>();
  const channelActivity = new Map<string, Date>();

  for (const s of statuses) {
    channelStatus.set(s.channelId, s.state);
    if (s.lastMessageAt) {
      channelActivity.set(s.channelId, new Date(s.lastMessageAt));
    }
  }

  return {
    triggerChannel: options?.triggerChannel,
    channelActivity,
    channelStatus,
    defaultChannel: options?.defaultChannel,
    channelDefaults: options?.channelDefaults ?? new Map(),
  };
}
