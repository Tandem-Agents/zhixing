import type { ConversationManager } from "@zhixing/owner-kernel";
import {
  createAdvancementRecoveryMaintenance as createOwnerAdvancementRecoveryMaintenance,
  type AdvancementController,
  type AdvancementRecoveryMaintenance,
  type AdvancementRecoveryOptions,
  type AdvancementRecoveryResult,
} from "@zhixing/owner-services";
import type { SessionBroadcast } from "@zhixing/rpc/session-broadcast";
import type { ConversationDirectory } from "../runtime/conversation-directory.js";
import {
  createAdvancementEventSink,
  createAdvancementProxyTurnPort,
} from "./adapters.js";

export interface AdvancementRecoveryMaintenanceOptions {
  readonly advancement: AdvancementController;
  readonly manager: ConversationManager;
  readonly directory: ConversationDirectory;
  readonly sessionBroadcast?: () => SessionBroadcast | null;
  readonly logger?: Pick<Console, "warn">;
}

export function createAdvancementRecoveryMaintenance(
  options: AdvancementRecoveryMaintenanceOptions,
): AdvancementRecoveryMaintenance {
  const sessionBroadcast = options.sessionBroadcast ?? (() => null);
  return createOwnerAdvancementRecoveryMaintenance({
    advancement: options.advancement,
    directory: options.directory,
    proxyTurns: createAdvancementProxyTurnPort({
      manager: options.manager,
      sessionBroadcast,
      conversationExists: (conversationId) =>
        options.directory.exists(conversationId),
    }),
    events: createAdvancementEventSink(sessionBroadcast),
    logger: options.logger,
  });
}

export type {
  AdvancementRecoveryMaintenance,
  AdvancementRecoveryOptions,
  AdvancementRecoveryResult,
};
