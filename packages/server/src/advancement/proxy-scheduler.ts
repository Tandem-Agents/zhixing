import type { ConversationManager } from "@zhixing/owner-kernel";
import {
  ProxyMessageScheduler as OwnerProxyMessageScheduler,
  type ScheduleProxyMessageInput,
  type ScheduleProxyMessageResult,
} from "@zhixing/owner-services/advancement/proxy-scheduler";
import type { SessionBroadcast } from "@zhixing/rpc/session-broadcast";
import { createAdvancementProxyTurnPort } from "./adapters.js";

export interface ProxyMessageSchedulerOptions {
  readonly manager: ConversationManager;
  readonly sessionBroadcast?: () => SessionBroadcast | null;
  readonly conversationExists?: (conversationId: string) => Promise<boolean>;
}

export class ProxyMessageScheduler extends OwnerProxyMessageScheduler {
  constructor(options: ProxyMessageSchedulerOptions) {
    super({
      proxyTurns: createAdvancementProxyTurnPort(options),
    });
  }
}

export type { ScheduleProxyMessageInput, ScheduleProxyMessageResult };
