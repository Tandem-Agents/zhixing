import type {
  DurableToolExecutionAuthorizer,
  Message,
  RunRecordAdvancementMetadata,
  ScheduleMutationStager,
  SessionEventProjection,
  ToolSideEffectObserver,
  TurnContext,
  TurnSource,
  WatchdogPolicy,
} from "@zhixing/core";
import type {
  AssignmentGlobalQueryPort,
  AssignmentMutationPort,
  AuthorityCallContext,
  ModelCallResourceMeter,
  ResourceLease,
  ResourceReservationPort,
} from "@zhixing/core/contracts";
import type { KernelRunEvent } from "./kernel-run-event.js";

/**
 * The one immutable input contract for a main Intelligence Kernel run.
 *
 * Product callers decide Conversation, Schedule, Advancement and Assignment
 * semantics before constructing this envelope. The Kernel receives only the
 * resulting model input, stable run identity, execution controls, bounded
 * Correctness ports and observation callbacks.
 */
export interface KernelRunEnvelope {
  readonly modelInput: {
    readonly messages: readonly Message[];
  };
  readonly identity: {
    readonly turnIndex: number;
    readonly conversationId?: string;
    readonly source?: TurnSource;
    readonly advancement?: RunRecordAdvancementMetadata;
    readonly turnContext?: TurnContext;
  };
  readonly control: {
    readonly abortSignal?: AbortSignal;
    readonly watchdog?: WatchdogPolicy;
    readonly modelCallResourceMeter?: ModelCallResourceMeter;
  };
  readonly correctness: {
    readonly toolSideEffectObserver?: ToolSideEffectObserver;
    readonly authorizeToolExecution?: DurableToolExecutionAuthorizer;
    readonly stageScheduleMutation?: ScheduleMutationStager;
    readonly assignmentMutations?: AssignmentMutationPort;
    readonly globalQuery?: AssignmentGlobalQueryPort;
    readonly assignmentIssuedAt?: string;
    readonly resourceReservation?: {
      readonly port: ResourceReservationPort;
      readonly parentLease: ResourceLease;
      readonly contextFor: (requestId: string) => AuthorityCallContext;
    };
  };
  readonly observation: {
    readonly onEvent?: (event: KernelRunEvent) => void | Promise<void>;
    readonly onProtocolEvent?: (
      event: SessionEventProjection,
      meta: { readonly lineage?: string },
    ) => void | Promise<void>;
  };
}

function cloneAndFreezePlainValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndFreezePlainValue(item))) as T;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const clone = Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          cloneAndFreezePlainValue(child),
        ]),
      );
      return Object.freeze(clone) as T;
    }
  }
  return value;
}

/**
 * Captures the caller-owned envelope before the first asynchronous boundary.
 * Ports, signals and callbacks retain identity; every mutable container owned
 * by the envelope is copied and frozen so later caller mutation cannot alter
 * an in-flight run.
 */
export function captureKernelRunEnvelope(
  input: KernelRunEnvelope,
): KernelRunEnvelope {
  const turnContext = input.identity.turnContext
    ? cloneAndFreezePlainValue(input.identity.turnContext)
    : undefined;
  const advancement = input.identity.advancement
    ? cloneAndFreezePlainValue(input.identity.advancement)
    : undefined;
  const resourceReservation = input.correctness.resourceReservation
    ? Object.freeze({ ...input.correctness.resourceReservation })
    : undefined;

  return Object.freeze({
    modelInput: Object.freeze({
      messages: Object.freeze(
        input.modelInput.messages.map((message) =>
          cloneAndFreezePlainValue(message),
        ),
      ),
    }),
    identity: Object.freeze({
      turnIndex: input.identity.turnIndex,
      conversationId: input.identity.conversationId,
      source: input.identity.source,
      advancement,
      turnContext,
    }),
    control: Object.freeze({
      abortSignal: input.control.abortSignal,
      watchdog: input.control.watchdog
        ? cloneAndFreezePlainValue(input.control.watchdog)
        : undefined,
      modelCallResourceMeter: input.control.modelCallResourceMeter,
    }),
    correctness: Object.freeze({
      toolSideEffectObserver: input.correctness.toolSideEffectObserver,
      authorizeToolExecution: input.correctness.authorizeToolExecution,
      stageScheduleMutation: input.correctness.stageScheduleMutation,
      assignmentMutations: input.correctness.assignmentMutations,
      globalQuery: input.correctness.globalQuery,
      assignmentIssuedAt: input.correctness.assignmentIssuedAt,
      resourceReservation,
    }),
    observation: Object.freeze({
      onEvent: input.observation.onEvent,
      onProtocolEvent: input.observation.onProtocolEvent,
    }),
  });
}
