import type { AdvancementExecutionMaterial } from "@zhixing-ai/core/advancement/execution-context";
import type {
  ConversationInvocation,
  ExplicitEnvironmentSelection,
  IngressContext,
} from "@zhixing-ai/core/contracts";
import type { ForegroundObligation } from "@zhixing-ai/core/resources";
import type { TurnOriginAdvancementExecution } from "@zhixing-ai/core/types";
import type {
  ConversationRunJournal,
  PendingConversationInput,
} from "@zhixing-ai/owner-kernel/conversation-assignment";
import type {
  ConversationManager,
  TurnCommittedInfo,
} from "@zhixing-ai/owner-kernel/conversation-manager";
import type { ConversationTransferPublication } from "@zhixing-ai/owner-kernel/conversation-transfer";
import type {
  ConversationChannelSessionInput,
  FirstPartySurfaceSession,
  FirstPartySurfaceSessionInput,
  LosslessDataPlaneSession,
} from "../lossless-data-plane-runtime.js";

export interface ConversationAdvancementExecutionPort {
  prepare(input: Readonly<{
    conversationId: string;
    turnId: string;
    binding: TurnOriginAdvancementExecution;
  }>): Promise<AdvancementExecutionMaterial>;
}

export interface AppliedConversationAdmission {
  readonly runId: string;
  readonly ingress: IngressContext;
  readonly attachments: PendingConversationInput["attachments"];
  readonly environment?: ExplicitEnvironmentSelection;
  readonly replayed: boolean;
}

export interface PreparedConversationAdmission {
  readonly conversationId: string;
  readonly surfacePrincipal: string;
  readonly admission: AppliedConversationAdmission;
  readonly input: PendingConversationInput["input"];
  readonly attachments: PendingConversationInput["attachments"];
  readonly invocation: ConversationInvocation;
  readonly environment?: ExplicitEnvironmentSelection;
  readonly foreground?: ForegroundObligation;
  readonly admissionId: string;
}

export interface ConversationLosslessDataPlanePort {
  openConversationChannel(
    input: ConversationChannelSessionInput,
  ): Promise<LosslessDataPlaneSession>;
  openFirstPartySurfaceSession(
    input: FirstPartySurfaceSessionInput,
  ): Promise<FirstPartySurfaceSession>;
  recoverConversationChannels(journal: ConversationRunJournal): Promise<number>;
}

export type ConversationLosslessDataPlaneTopology =
  | Readonly<{
      readonly kind: "available";
      readonly port: ConversationLosslessDataPlanePort;
    }>
  | Readonly<{
      readonly kind: "absent";
      readonly reason: "executor-only";
    }>;

export interface CommittedConversationTransferPort {
  readonly committedFor: (conversationId: string) => Promise<readonly string[]>;
  readonly conversations: () => Promise<readonly string[]>;
  readonly load: (transferId: string) => Promise<ConversationTransferPublication>;
}

export function createConversationManagerAssemblyHandle(): Readonly<{
  readonly resolve: () => ConversationManager;
  complete(manager: ConversationManager): void;
}> {
  let manager: ConversationManager | undefined;
  let completed = false;
  const resolve = (): ConversationManager => {
    if (!completed || !manager) {
      throw new Error("Conversation protocol manager is not assembled");
    }
    return manager;
  };
  return Object.freeze({
    resolve,
    complete(candidate: ConversationManager) {
      if (completed) {
        throw new Error("Conversation protocol manager is already assembled");
      }
      manager = candidate;
      completed = true;
    },
  });
}

export function createConversationAuxiliaryRecoveryAssemblyHandle(): Readonly<{
  readonly resolve: (conversationId: string) => Promise<void>;
  complete(recover: (conversationId: string) => Promise<void>): void;
}> {
  let recovery: ((conversationId: string) => Promise<void>) | undefined;
  let completed = false;
  const resolve = (conversationId: string): Promise<void> => {
    if (!completed || !recovery) {
      throw new Error("Conversation auxiliary recovery is not assembled");
    }
    return recovery(conversationId);
  };
  return Object.freeze({
    resolve,
    complete(candidate: (conversationId: string) => Promise<void>) {
      if (completed) {
        throw new Error("Conversation auxiliary recovery is already assembled");
      }
      recovery = candidate;
      completed = true;
    },
  });
}

export function createConversationCommittedTurnListenerAssemblyHandle(): Readonly<{
  readonly notify: (info: TurnCommittedInfo) => void;
  complete(listener: (info: TurnCommittedInfo) => void): void;
}> {
  let listener: ((info: TurnCommittedInfo) => void) | undefined;
  let completed = false;
  const notify = (info: TurnCommittedInfo): void => {
    if (!completed || !listener) {
      throw new Error("Conversation committed-turn listener is not assembled");
    }
    listener(info);
  };
  return Object.freeze({
    notify,
    complete(candidate: (info: TurnCommittedInfo) => void) {
      if (completed) {
        throw new Error("Conversation committed-turn listener is already assembled");
      }
      listener = candidate;
      completed = true;
    },
  });
}

/**
 * Generation-isolated AuthorityScope: replaced ONLY during recoverInstalledAuthority,
 * never during releaseConversation or stopRecoveryLoop.
 */
export interface AuthorityScope {
  readonly scopeId: number;
  retired: boolean;
}

/**
 * Immutable per-attempt handle passed into TurnExecution & TerminalSettlement
 * so stale attempts after authority swap clean up their own physical/stream/plan
 * obligations while never erasing newScope claims or prepared admissions.
 */
export interface RunAttemptHandle {
  readonly scope: AuthorityScope;
  readonly conversationId: string;
  readonly runId: string;
  readonly claimToken: symbol;
  readonly admissionId?: string;
}

export type ConversationProtocolUnitOwner =
  | "conversation-access"
  | "admission-lifecycle"
  | "turn-execution"
  | "terminal-settlement"
  | "recovery-scheduler"
  | "runtime-obligation-scope";

export const CONVERSATION_PROTOCOL_OBLIGATION_OWNERS = {
  authorityScopeGeneration: "runtime-obligation-scope",
  preparedAdmissionMap: "admission-lifecycle",
  activeRunClaimRegistry: "runtime-obligation-scope",
  settledRouteRevisions: "terminal-settlement",
  deferFirstSendRecovery: "recovery-scheduler",
  monotonicRecoveryMarkSeq: "recovery-scheduler",
  firstTouchAdoptionInstall: "conversation-access",
  executorPlanAndForegroundLease: "turn-execution",
} as const satisfies Record<string, ConversationProtocolUnitOwner>;
