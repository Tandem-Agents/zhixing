import type {
  AgentEventMap,
  EventBus,
  Message,
  OrchestrationContextSnapshotV1,
  OrchestrationExecutableV1,
  OrchestrationRunResultV1,
  OrchestrationSystemCapsV1,
  TokenUsage,
  TurnContext,
  TurnSource,
  UserTurnInputLike,
} from "@zhixing/core";
import type {
  ConversationManager,
  ManagedSession,
} from "@zhixing/owner-kernel/conversation-manager";

export interface PerspectiveSpec {
  readonly name: string;
  readonly charge: string;
}

export interface PerspectiveAllocation {
  readonly perspectives: readonly PerspectiveSpec[];
  readonly usage?: TokenUsage;
}

export interface PerspectiveAllocationInput {
  readonly managed?: ManagedSession;
  readonly question: string;
  readonly contextText: string;
  readonly defaultPerspectiveCount: number;
  readonly maxPerspectiveCount: number;
  readonly abortSignal?: AbortSignal;
}

export interface PerspectiveAllocationStrategy {
  allocate(input: PerspectiveAllocationInput): Promise<PerspectiveAllocation>;
}

export interface PerspectivesOrchestrationRunInput {
  readonly managed: ManagedSession;
  readonly executable: OrchestrationExecutableV1;
  readonly runInput: string;
  readonly contextSnapshot: OrchestrationContextSnapshotV1;
  readonly abortSignal?: AbortSignal;
  readonly eventBus: EventBus<AgentEventMap>;
}

export interface PerspectivesOrchestrationExecutor {
  run(input: PerspectivesOrchestrationRunInput): Promise<OrchestrationRunResultV1>;
}

export interface PerspectivesControllerOptions {
  readonly allocationStrategy: PerspectiveAllocationStrategy;
  readonly orchestrationExecutor: PerspectivesOrchestrationExecutor;
  readonly caps?: OrchestrationSystemCapsV1;
  readonly now?: () => Date;
  readonly createRunEventBus?: () => EventBus<AgentEventMap>;
  readonly decorateRunBus?: (input: {
    readonly bus: EventBus<AgentEventMap>;
    readonly conversationId: string;
    readonly turnContext?: TurnContext;
  }) => () => void;
}

export interface PerspectivesTurnInput {
  readonly manager: ConversationManager;
  readonly managed: ManagedSession;
  readonly originalInput: UserTurnInputLike;
  readonly question: string;
  readonly abortSignal?: AbortSignal;
  readonly turnContext?: TurnContext;
  readonly source?: TurnSource;
}

export interface PerspectivesPendingTaskInput {
  readonly manager: ConversationManager;
  readonly managed: ManagedSession;
  readonly originalInput: UserTurnInputLike;
  readonly question: string;
  readonly turnContext?: TurnContext;
  readonly source?: TurnSource;
  readonly onResult?: (result: PerspectivesTurnResult) => void | Promise<void>;
}

export type PerspectivesFailureStage =
  | "snapshot"
  | "allocation"
  | "template"
  | "orchestration"
  | "convergence"
  | "commit";

export type PerspectivesTurnResult =
  | {
      readonly status: "completed";
      readonly finalText: string;
      readonly recordMessages: readonly Message[];
      readonly allocation: PerspectiveAllocation;
      readonly orchestration: OrchestrationRunResultV1;
      readonly usage: TokenUsage;
    }
  | {
      readonly status: "failed";
      readonly stage: PerspectivesFailureStage;
      readonly message: string;
      readonly usage?: TokenUsage;
    }
  | {
      readonly status: "aborted";
      readonly stage: PerspectivesFailureStage;
      readonly message: string;
      readonly usage?: TokenUsage;
    };
