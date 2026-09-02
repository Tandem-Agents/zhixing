import type {
  AgentYield,
  IConfirmationBroker,
  RunResult,
  ScheduleMutationStager,
} from "@zhixing/core";
import type {
  AssignmentMutationPort,
  AuthorityCallContext,
  DispatchEnvelope,
  DispatchResult,
  ExecutionAssetBundle,
  ExecutionManifest,
  SealedBundle,
  RunDispatchArguments,
  RunExecutorPort,
  SupersedeProof,
  TrustRuleSnapshot,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  MAX_CONTROL_LEASE_TTL_MS,
  StreamDigestChain,
  type ExecutorCapabilitySnapshot,
  type StreamFrameProducer,
} from "@zhixing/core/protocol";
import {
  ConversationRunJournal,
  InProcessConversationDispatcher,
  type InProcessDispatchContextFactory,
  type InProcessBundleSubmission,
  type RuntimeFactory,
  type SessionRuntime,
} from "@zhixing/owner-kernel";
import {
  ConversationAssignmentLedger,
  InProcessAssignmentSubmission,
} from "@zhixing/executor";
import type { ConversationOwnerRuntimeStack } from "./conversation-owner-runtime.js";
import type { ConversationRuntimeBinding } from "../setup-delivery.js";
import {
  ASSIGNMENT_RECORD_V2_WRITES_ENABLED,
  createConversationExecutorLedger,
} from "./conversation-executor-ledger.js";
import {
  createAssignmentMutationPort,
  createAssignmentScheduleStager,
} from "./assignment-schedule-stager.js";
import type {
  DurableConversationInteractionObserver,
  DurableInteractionBinding,
} from "./durable-conversation-interactions.js";
import { isRetryableMeshFailure } from "./remote-obligation-failure.js";

const CONTROL_RENEWAL_INTERVAL_MS = Math.floor(MAX_CONTROL_LEASE_TTL_MS / 3);

export type ConversationExecutorRequirement =
  | { readonly placement: "current-device" }
  | { readonly placement: "authorized-device" };

export interface ConversationExecutorTopologyTarget {
  readonly executorId: string;
  readonly deviceId: string;
  readonly executor: RunExecutorPort;
  synchronizePermission(
    snapshot: TrustRuleSnapshot,
    executionAssets?: ExecutionAssetBundle,
  ): Promise<ExecutorCapabilitySnapshot>;
}

export interface ConversationExecutorTopologyDirectory {
  candidates(): Promise<readonly ConversationExecutorTopologyTarget[]>;
  forExecutor(executorId: string): ConversationExecutorTopologyTarget | undefined;
}

export interface ConversationExecutorApplicationPlanInput {
  readonly conversationId: string;
  readonly requirement: ConversationExecutorRequirement;
  readonly executionProfile: Parameters<
    ConversationOwnerRuntimeStack["prepareConversationAssignment"]
  >[0]["executionProfile"];
  readonly permissionRules: Parameters<
    ConversationOwnerRuntimeStack["prepareConversationAssignment"]
  >[0]["permissionRules"];
  readonly recentExecutorId?: string;
  readonly environment?: Parameters<
    ConversationOwnerRuntimeStack["prepareConversationAssignment"]
  >[0]["environment"];
}

type PreparedAssignment = Awaited<
  ReturnType<ConversationOwnerRuntimeStack["prepareConversationAssignment"]>
>;

export interface ConversationExecutorExecutionEffect {
  readonly runtime: SessionRuntime;
  startAndReport(context: AuthorityCallContext): Promise<void>;
  createStream(input: {
    readonly assignmentId: string;
    readonly ref: import("@zhixing/core/contracts").ExecutionRef;
  }): Promise<ConversationExecutorAssignmentRunStream>;
  startHeartbeat(): { stop(): Promise<void> };
  createInteractionScope(input: {
    readonly interactions: DurableConversationInteractionObserver;
    readonly context: AuthorityCallContext;
    readonly surfacePrincipal: string;
    readonly broker?: IConfirmationBroker;
    readonly stream: import("@zhixing/core/protocol").StreamFrameAppender;
    readonly streamMeta: {
      readonly turnOrigin?: NonNullable<
        import("@zhixing/core/contracts").IngressContext["turnOrigin"]
      >;
    };
  }): ConversationExecutorInteractionScope;
  assignmentMutations(input: {
    readonly execution: "conversation";
    readonly anchorEpoch: number;
    readonly allowGlobal: boolean;
    readonly capability?: import("@zhixing/core/contracts").AuthorityCapability;
  }): AssignmentMutationPort;
  scheduleMutations(input: {
    readonly anchorEpoch: number;
    readonly capability: import("@zhixing/core/contracts").AuthorityCapability;
  }): ScheduleMutationStager;
  authorizeToolExecution(
    lease: Extract<
      DispatchEnvelope,
      { readonly execution: "conversation" }
    >["permissionLease"],
  ): Promise<readonly import("@zhixing/core").PermissionRule[]>;
  hasOpenSideEffects(): Promise<boolean>;
  failExecution(input: {
    readonly reason: string;
    readonly usageFinal: {
      readonly reportDigest: string;
      readonly upToUsageSeq: number;
    };
  }): Promise<
    | {
        readonly reason: string;
        readonly usageFinal: {
          readonly reportDigest: string;
          readonly upToUsageSeq: number;
        };
      }
    | undefined
  >;
  sealConversationBundle(input: {
    readonly runRecord:
      | import("@zhixing/core/contracts").TranscriptRunRecord
      | { readonly ref: import("@zhixing/core/contracts").ArtifactRef };
    readonly windowCompact?: import("@zhixing/core/contracts").WindowCompactInstruction;
    readonly contentAssets: readonly import("@zhixing/core/contracts").ContentAssetRef[];
    readonly streamFinal: { readonly finalSeq: number; readonly streamDigest: string };
    readonly usage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly toolCalls: number;
    };
    readonly usageFinal: {
      readonly reportDigest: string;
      readonly upToUsageSeq: number;
    };
  }): Promise<SealedBundle>;
  prepareForRunEnd(context: AuthorityCallContext): Promise<void>;
  submitSealedBundle(context: AuthorityCallContext): ReturnType<
    InProcessBundleSubmission["submitSealedBundle"]
  >;
}

export interface ConversationExecutorInteractionScope {
  run<T>(operation: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
}

export interface ConversationExecutorAssignmentRunStream extends StreamFrameProducer {
  markTerminal?(): Promise<unknown>;
}

export interface ConversationExecutorDispatchPlan {
  readonly assignment: PreparedAssignment;
  readonly executorId: string;
  prepare(input: {
    readonly assignmentId: string;
    readonly manifest: ExecutionManifest<"conversation">;
    readonly adaptRuntime?: (runtime: SessionRuntime) => SessionRuntime;
  }): Promise<void>;
  bindRuntime(binding: ConversationRuntimeBinding): void;
  markPromoted(): void;
  dispatch(input: {
    readonly journal: ConversationRunJournal;
    readonly envelope: Extract<DispatchEnvelope, { execution: "conversation" }>;
    readonly contexts: InProcessDispatchContextFactory;
    readonly submissionContext: AuthorityCallContext;
  }): Promise<void>;
  run(input: {
    readonly execute: (
      effect: ConversationExecutorExecutionEffect,
    ) => AsyncGenerator<AgentYield, RunResult>;
    readonly onCommitted: (
      committed: NonNullable<Awaited<ReturnType<ConversationRunJournal["committedRun"]>>>,
    ) => RunResult;
    readonly onRemoteSettled: () => void;
  }): AsyncGenerator<AgentYield, RunResult>;
  dispose(): Promise<void>;
}

export interface ConversationExecutorDispatchApplication {
  plan(input: ConversationExecutorApplicationPlanInput): Promise<ConversationExecutorDispatchPlan>;
  recoveryDispatcher(input: {
    readonly journal: ConversationRunJournal;
    readonly contexts: InProcessDispatchContextFactory;
    readonly executorIdForAssignment: (assignmentId: string) => string;
    readonly submissionContext: (assignmentId: string) => AuthorityCallContext;
  }): {
    readonly dispatcher: InProcessConversationDispatcher;
    readonly executor: RunExecutorPort;
  };
}

export interface ConversationAssignmentStagingPort {
  stageSession(
    assignmentId: string,
    input: {
      readonly mutation: import("@zhixing/core/contracts").SessionStagedMutation;
      readonly requestId: string;
    },
  ): Promise<import("@zhixing/core/contracts").AssignmentStagedReceipt>;
}

export interface ConversationExecutorHostBoundaryOptions {
  readonly authority: ConversationOwnerRuntimeStack;
  readonly clock: () => string;
  readonly maxPendingInteractions?: number;
  readonly local?: {
    readonly ledger?: ConversationAssignmentLedger;
    readonly ConversationAssignmentLedger: typeof ConversationAssignmentLedger;
    readonly InProcessAssignmentSubmission: typeof InProcessAssignmentSubmission;
    readonly runtimeFactory: RuntimeFactory;
    readonly dataPlaneTickets?: ConstructorParameters<
      typeof ConversationAssignmentLedger
    >[0]["dataPlaneTickets"];
    readonly createStream?: (input: {
      readonly assignmentId: string;
      readonly ref: import("@zhixing/core/contracts").ExecutionRef;
    }) => Promise<ConversationExecutorAssignmentRunStream>;
  };
}

interface LocalConversationExecutorMechanism {
  readonly executor: RunExecutorPort;
  prepare(input: {
    readonly conversationId: string;
    readonly assignmentId: string;
    readonly manifest: ExecutionManifest<"conversation">;
    readonly binding: ConversationRuntimeBinding;
    readonly adaptRuntime?: (runtime: SessionRuntime) => SessionRuntime;
  }): Promise<PreparedLocalConversationExecution>;
  createSubmission(journal: ConversationRunJournal): LocalConversationSubmission;
}

interface PreparedLocalConversationExecution {
  readonly runtime: SessionRuntime;
  bindRuntime(binding: ConversationRuntimeBinding): void;
  effect(input: {
    readonly journal: ConversationRunJournal;
    readonly assignmentId: string;
    readonly contexts: InProcessDispatchContextFactory;
    readonly submission: LocalConversationSubmission;
  }): ConversationExecutorExecutionEffect;
  dispose(reason: "assignment-dispose" | "assembly-rollback"): Promise<void>;
}

interface LocalConversationSubmission {
  startAndReport(
    assignmentId: string,
    context: AuthorityCallContext,
  ): Promise<void>;
  createInteractionScope(input: {
    readonly assignmentId: string;
    readonly interactions: DurableConversationInteractionObserver;
    readonly context: AuthorityCallContext;
    readonly surfacePrincipal: string;
    readonly broker?: IConfirmationBroker;
    readonly stream: import("@zhixing/core/protocol").StreamFrameAppender;
    readonly streamMeta: {
      readonly turnOrigin?: NonNullable<
        import("@zhixing/core/contracts").IngressContext["turnOrigin"]
      >;
    };
  }): ConversationExecutorInteractionScope;
  prepareForRunEnd(
    assignmentId: string,
    context: AuthorityCallContext,
  ): Promise<void>;
  readonly cancellation: {
    submitCancellation(
      assignmentId: string,
      context: AuthorityCallContext,
    ): Promise<boolean>;
  };
  readonly bundle: {
    submitSealedBundle(
      assignmentId: string,
      context: AuthorityCallContext,
    ): ReturnType<InProcessBundleSubmission["submitSealedBundle"]>;
  };
}

type ResolvedConversationExecutorTarget =
  | {
      readonly kind: "local";
      readonly executorId: string;
      readonly mechanism: LocalConversationExecutorMechanism;
    }
  | {
      readonly kind: "remote";
      readonly executorId: string;
      readonly target: ConversationExecutorTopologyTarget;
    };

/** Host-owned mechanism selector. It contains no Conversation product policy or Authority decision. */
export class ConversationExecutorTopologyAdapter {
  readonly #local: LocalConversationExecutorMechanism | undefined;
  #directory: ConversationExecutorTopologyDirectory | undefined;

  constructor(local?: LocalConversationExecutorMechanism) {
    this.#local = local;
  }

  bindDirectory(directory: ConversationExecutorTopologyDirectory): void {
    if (this.#directory && this.#directory !== directory) {
      throw new Error("Conversation executor topology directory is already bound");
    }
    this.#directory = directory;
  }

  async candidates(
    requirement: ConversationExecutorRequirement,
  ): Promise<readonly ConversationExecutorTopologyTarget[]> {
    return requirement.placement === "authorized-device"
      ? await this.#directory?.candidates() ?? []
      : [];
  }

  hasLocal(): boolean {
    return this.#local !== undefined;
  }

  resolve(
    executorId: string,
    localExecutorId: string,
  ): ResolvedConversationExecutorTarget {
    if (executorId === localExecutorId) {
      if (!this.#local) throw new Error("Local executor role is not enabled on this device");
      return { kind: "local", executorId, mechanism: this.#local };
    }
    const target = this.#directory?.forExecutor(executorId);
    if (!target) throw new Error(`Remote conversation executor is unavailable: ${executorId}`);
    return { kind: "remote", executorId, target };
  }
}

export interface ConversationExecutorHostBoundary {
  readonly application: ConversationExecutorDispatchApplication;
  readonly topology: ConversationExecutorTopologyAdapter;
  readonly staging?: ConversationAssignmentStagingPort;
  readonly localLedger?: ConversationAssignmentLedger;
}

/** Host composition publishes separate role-specific outputs; demand consumers cannot query dispatch for concrete mechanisms. */
export function createConversationExecutorHostBoundary(
  options: ConversationExecutorHostBoundaryOptions,
): ConversationExecutorHostBoundary {
  const local = options.local
    ? createLocalConversationExecutorMechanism(options, options.local)
    : undefined;
  const topology = new ConversationExecutorTopologyAdapter(local?.mechanism);
  return {
    topology,
    application: new DefaultConversationExecutorDispatchApplication({
      authority: options.authority,
      topology,
    }),
    ...(local
      ? {
          localLedger: local.ledger,
          staging: {
            stageSession: (assignmentId, input) => local.ledger.stageMutation(
              assignmentId,
              { domain: "session", ...input },
            ),
          },
        }
      : {}),
  };
}

class DefaultConversationExecutorDispatchApplication
  implements ConversationExecutorDispatchApplication {
  readonly #authority: ConversationOwnerRuntimeStack;
  readonly #topology: ConversationExecutorTopologyAdapter;

  constructor(options: {
    readonly authority: ConversationOwnerRuntimeStack;
    readonly topology: ConversationExecutorTopologyAdapter;
  }) {
    this.#authority = options.authority;
    this.#topology = options.topology;
  }

  async plan(
    input: ConversationExecutorApplicationPlanInput,
  ): Promise<ConversationExecutorDispatchPlan> {
    const candidates = await this.#topology.candidates(input.requirement);
    if (candidates.length === 0 && !this.#topology.hasLocal()) {
      throw new Error("No authorized conversation executor is currently available");
    }
    const assignment = await this.#authority.prepareConversationAssignment({
      conversationId: input.conversationId,
      executionProfile: input.executionProfile,
      permissionRules: input.permissionRules,
      ...(input.recentExecutorId ? { recentExecutorId: input.recentExecutorId } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      targets: candidates.map((target) => ({
        executorId: target.executorId,
        deviceId: target.deviceId,
        synchronizePermission: (snapshot, executionAssets) =>
          target.synchronizePermission(snapshot, executionAssets),
      })),
    });
    const candidate = assignment.executorId === this.#authority.executorId
      ? undefined
      : candidates.find((item) => item.executorId === assignment.executorId);
    if (!candidate && assignment.executorId !== this.#authority.executorId) {
      throw new Error("Selected remote executor disappeared from the candidate set");
    }
    return new PlannedConversationExecutorDispatch({
      conversationId: input.conversationId,
      assignment,
      target: this.#topology.resolve(
        assignment.executorId,
        this.#authority.executorId,
      ),
    });
  }

  recoveryDispatcher(input: {
    readonly journal: ConversationRunJournal;
    readonly contexts: InProcessDispatchContextFactory;
    readonly executorIdForAssignment: (assignmentId: string) => string;
    readonly submissionContext: (assignmentId: string) => AuthorityCallContext;
  }): {
    readonly dispatcher: InProcessConversationDispatcher;
    readonly executor: RunExecutorPort;
  } {
    const resolve = (executorId: string) =>
      this.#topology.resolve(executorId, this.#authority.executorId);
    const executor = new RoutedRunExecutorPort(
      (executorId) => executorPort(resolve(executorId)),
      (assignmentId) => executorPort(resolve(input.executorIdForAssignment(assignmentId))),
    );
    const local = this.#topology.hasLocal()
      ? this.#topology.resolve(this.#authority.executorId, this.#authority.executorId)
      : undefined;
    const submission = local?.kind === "local"
      ? local.mechanism.createSubmission(input.journal)
      : undefined;
    const dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: input.journal,
      executor,
      contexts: input.contexts,
      cancellationSubmission: {
        submitCancellation: async (assignmentId) => {
          if (input.executorIdForAssignment(assignmentId) === this.#authority.executorId) {
            if (!submission) return false;
            return submission.cancellation.submitCancellation(
              assignmentId,
              input.submissionContext(assignmentId),
            );
          }
          const snapshot = await executor.queryLedger(
            assignmentId,
            input.contexts.create(assignmentId, "executor.queryLedger", {
              requestId: `ledger:${assignmentId}:cancel-proof`,
              body: { range: null },
            }),
          );
          if (!("phase" in snapshot) || !snapshot.cancelProof) return false;
          await input.journal.submitCancelProof(
            assignmentId,
            snapshot.cancelProof,
            input.submissionContext(assignmentId),
          );
          return true;
        },
      },
      bundleSubmission: {
        submitSealedBundle: (assignmentId) => {
          if (input.executorIdForAssignment(assignmentId) !== this.#authority.executorId) {
            return Promise.resolve(remoteBundleSubmissionDeferred());
          }
          if (!submission) throw new Error("Local assignment submission is unavailable");
          return submission.bundle.submitSealedBundle(
            assignmentId,
            input.submissionContext(assignmentId),
          );
        },
      },
    });
    return { dispatcher, executor };
  }

}

class PlannedConversationExecutorDispatch implements ConversationExecutorDispatchPlan {
  readonly assignment: PreparedAssignment;
  readonly executorId: string;
  readonly #conversationId: string;
  readonly #target: ResolvedConversationExecutorTarget;
  #assignmentId: string | undefined;
  #localExecution: PreparedLocalConversationExecution | undefined;
  #promoted = false;
  #journal: ConversationRunJournal | undefined;
  #dispatcher: InProcessConversationDispatcher | undefined;
  #submission: LocalConversationSubmission | undefined;
  #contexts: InProcessDispatchContextFactory | undefined;
  #runId: string | undefined;

  constructor(input: {
    readonly conversationId: string;
    readonly assignment: PreparedAssignment;
    readonly target: ResolvedConversationExecutorTarget;
  }) {
    this.#conversationId = input.conversationId;
    this.assignment = input.assignment;
    this.executorId = input.assignment.executorId;
    this.#target = input.target;
  }

  async prepare(input: {
    readonly assignmentId: string;
    readonly manifest: ExecutionManifest<"conversation">;
    readonly adaptRuntime?: (runtime: SessionRuntime) => SessionRuntime;
  }): Promise<void> {
    this.#assignmentId = input.assignmentId;
    if (this.#target.kind === "remote") {
      if (input.adaptRuntime) {
        throw new Error("A local invocation runtime adapter cannot execute remotely");
      }
      return;
    }
    this.#localExecution = await this.#target.mechanism.prepare({
      conversationId: this.#conversationId,
      assignmentId: input.assignmentId,
      manifest: input.manifest,
      binding: this.assignment.binding,
      ...(input.adaptRuntime ? { adaptRuntime: input.adaptRuntime } : {}),
    });
  }

  bindRuntime(binding: ConversationRuntimeBinding): void {
    this.#localExecution?.bindRuntime(binding);
  }

  markPromoted(): void {
    this.#promoted = true;
  }

  async dispatch(input: {
    readonly journal: ConversationRunJournal;
    readonly envelope: Extract<DispatchEnvelope, { execution: "conversation" }>;
    readonly contexts: InProcessDispatchContextFactory;
    readonly submissionContext: AuthorityCallContext;
  }): Promise<void> {
    this.#journal = input.journal;
    this.#contexts = input.contexts;
    this.#runId = input.envelope.work.runId;
    this.#submission = this.#target.kind === "local"
      ? this.#target.mechanism.createSubmission(input.journal)
      : undefined;
    const executor = executorPort(this.#target);
    this.#dispatcher = new InProcessConversationDispatcher({
      enabled: true,
      journal: input.journal,
      executor,
      contexts: input.contexts,
      cancellationSubmission: {
        submitCancellation: this.#submission
          ? (id) => this.#submission!.cancellation.submitCancellation(
              id,
              input.submissionContext,
            )
          : async (id) => {
              const snapshot = await executor.queryLedger(
                id,
                input.contexts.create(id, "executor.queryLedger", {
                  requestId: `ledger:${id}:cancel-proof`,
                  body: { range: null },
                }),
              );
              if (!("phase" in snapshot) || !snapshot.cancelProof) return false;
              await input.journal.submitCancelProof(
                id,
                snapshot.cancelProof,
                input.submissionContext,
              );
              return true;
            },
      },
      bundleSubmission: {
        submitSealedBundle: this.#submission
          ? (id) => this.#submission!.bundle.submitSealedBundle(
              id,
              input.submissionContext,
            )
          : async () => remoteBundleSubmissionDeferred(),
      },
    });
    let results: readonly DispatchResult[] | undefined;
    try {
      results = await this.#dispatcher.dispatchPending();
    } catch (error) {
      if (this.#target.kind !== "remote" || !isRetryableMeshFailure(error)) throw error;
    }
    if (results && (results.length !== 1 || !results[0]!.accepted)) {
      const rejection = results[0];
      const topology = this.#target.kind === "remote" ? "Remote" : "Local";
      throw new Error(
        rejection && !rejection.accepted
          ? `${topology} executor rejected a freshly issued assignment: ${rejection.error.message}`
          : `${topology} executor did not return exactly one dispatch result`,
      );
    }
  }

  async *run(input: {
    readonly execute: (
      effect: ConversationExecutorExecutionEffect,
    ) => AsyncGenerator<AgentYield, RunResult>;
    readonly onCommitted: (
      committed: NonNullable<Awaited<ReturnType<ConversationRunJournal["committedRun"]>>>,
    ) => RunResult;
    readonly onRemoteSettled: () => void;
  }): AsyncGenerator<AgentYield, RunResult> {
    const assignmentId = this.#assignmentId!;
    const journal = this.#journal!;
    const dispatcher = this.#dispatcher!;
    const contexts = this.#contexts!;
    const executor = executorPort(this.#target);
    if (this.#target.kind === "local") {
      if (!this.#localExecution) throw new Error("Local execution was not prepared");
      return yield* input.execute(this.#localExecution.effect({
        journal,
        assignmentId,
        contexts,
        submission: this.#submission!,
      }));
    }
    const heartbeat = startControlHeartbeat(assignmentId, executor, contexts);
    try {
      while (true) {
        const committed = await journal.committedRun(
          this.#runId!,
        );
        if (committed) {
          input.onRemoteSettled();
          return input.onCommitted(committed);
        }
        const state = await journal.runState(
          this.#runId!,
        );
        if (state === "failed" || state === "cancelled") {
          throw new Error(`Remote conversation run terminated in state ${state}`);
        }
        try {
          await dispatcher.recoverStarted();
          await dispatcher.recoverAssignments();
        } catch (error) {
          if (!isRetryableMeshFailure(error)) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await heartbeat.stop();
    }
  }

  async dispose(): Promise<void> {
    const reason = this.#promoted ? "assignment-dispose" : "assembly-rollback";
    await this.#localExecution?.dispose(reason);
  }
}

function createLocalConversationExecutorMechanism(
  options: ConversationExecutorHostBoundaryOptions,
  local: NonNullable<ConversationExecutorHostBoundaryOptions["local"]>,
): {
  readonly ledger: ConversationAssignmentLedger;
  readonly mechanism: LocalConversationExecutorMechanism;
} {
  const bindings = new Map<string, ConversationRuntimeBinding>();
  const executorAuthority = options.authority.executorLog && options.authority.assignmentResources
    ? options.authority as ConversationOwnerRuntimeStack & {
        readonly executorLog: NonNullable<ConversationOwnerRuntimeStack["executorLog"]>;
        readonly assignmentResources: NonNullable<
          ConversationOwnerRuntimeStack["assignmentResources"]
        >;
      }
    : undefined;
  if (!local.ledger && !executorAuthority) {
    throw new Error("Local executor ledger requires executor authority log and resources");
  }
  const ledger = local.ledger ?? createConversationExecutorLedger({
    Constructor: local.ConversationAssignmentLedger,
    authority: executorAuthority!,
    assignmentRecordV2Writes: ASSIGNMENT_RECORD_V2_WRITES_ENABLED,
    usageFinal: (assignmentId) =>
      options.authority.finalizeUsage(
        assignmentId,
        (report) => usageReporterContext(report.reporterId, report.digest, options.clock()),
      ),
    runtimeBindingGuard: ({ assignmentId, manifest }) => {
      const binding = bindings.get(assignmentId);
      return binding === undefined
        ? options.authority.validateLocalConversationManifest(manifest)
        : options.authority.validateConversationRuntimeBinding({
            assignmentId,
            manifest,
            binding,
          });
    },
    clock: options.clock,
    ...(local.dataPlaneTickets === undefined
      ? {}
      : { dataPlaneTickets: local.dataPlaneTickets }),
    ...(options.maxPendingInteractions === undefined
      ? {}
      : { maxPendingInteractions: options.maxPendingInteractions }),
  });
  const createStream = local.createStream ?? ((input: {
    readonly assignmentId: string;
    readonly ref: import("@zhixing/core/contracts").ExecutionRef;
  }) => Promise.resolve(new StreamDigestChain(input.assignmentId)));

  return {
    ledger,
    mechanism: {
      executor: ledger,
      createSubmission(journal) {
        const implementation = new local.InProcessAssignmentSubmission({
          ledger,
          owner: journal,
        });
        return {
          startAndReport: async (assignmentId, context) => {
            await implementation.startAndReport(assignmentId, context);
          },
          createInteractionScope(input) {
            const binding: DurableInteractionBinding = {
              assignmentId: input.assignmentId,
              ledger,
              submission: implementation,
              context: input.context,
              surfacePrincipal: input.surfacePrincipal,
              ...(input.broker ? { broker: input.broker } : {}),
              stream: input.stream,
              streamMeta: input.streamMeta,
            };
            return {
              run: (operation) => input.interactions.withBinding(binding, operation),
              drain: () => input.interactions.drainAssignment(binding),
            };
          },
          prepareForRunEnd: async (assignmentId, context) => {
            await implementation.prepareForRunEnd(assignmentId, context);
          },
          cancellation: {
            submitCancellation: (assignmentId, context) =>
              implementation.submitCancellation(assignmentId, context),
          },
          bundle: {
            submitSealedBundle: (assignmentId, context) =>
              implementation.submitSealedBundle(assignmentId, context),
          },
        };
      },
      async prepare(input) {
        const preflight = await options.authority.preflightLocalConversationEnvironment(
          input.manifest,
          input.assignmentId,
        );
        if (preflight.error) throw new Error(preflight.error.message);
        let baseRuntime: SessionRuntime | undefined;
        let runtime: SessionRuntime | undefined;
        let actual: ReturnType<NonNullable<SessionRuntime["executionProfile"]>>;
        try {
          baseRuntime = await local.runtimeFactory.create(
            input.conversationId,
            { workspaceRoot: preflight.workspaceRoot },
          );
          runtime = input.adaptRuntime?.(baseRuntime) ?? baseRuntime;
          const projected = runtime.executionProfile?.();
          if (!projected) {
            throw new Error("Local assignment runtime lacks an execution profile");
          }
          actual = projected;
          if (canonicalize(actual) !== canonicalize(input.binding.executionProfile)) {
            throw new Error("Local assignment runtime does not match the frozen execution profile");
          }
        } catch (error) {
          await runtime?.dispose("assembly-rollback");
          if (baseRuntime && baseRuntime !== runtime) {
            await baseRuntime.dispose("assembly-rollback");
          }
          options.authority.releaseLocalConversationEnvironmentPreflight(
            input.manifest,
            input.assignmentId,
          );
          throw error;
        }
        return {
          runtime: runtime!,
          bindRuntime(binding) {
            bindings.set(input.assignmentId, {
              ...binding,
              executionProfile: actual,
            });
          },
          effect(effectInput) {
            const submission = effectInput.submission;
            return {
              runtime: runtime!,
              startAndReport: async (context) => {
                await submission.startAndReport(input.assignmentId, context);
              },
              createStream,
              startHeartbeat: () =>
                startControlHeartbeat(
                  effectInput.assignmentId,
                  ledger,
                  effectInput.contexts,
                ),
              createInteractionScope(scopeInput) {
                return submission.createInteractionScope({
                  assignmentId: effectInput.assignmentId,
                  interactions: scopeInput.interactions,
                  context: scopeInput.context,
                  surfacePrincipal: scopeInput.surfacePrincipal,
                  ...(scopeInput.broker ? { broker: scopeInput.broker } : {}),
                  stream: scopeInput.stream,
                  streamMeta: scopeInput.streamMeta,
                });
              },
              assignmentMutations(mutationInput) {
                return createAssignmentMutationPort({
                  ledger,
                  assignmentId: effectInput.assignmentId,
                  execution: mutationInput.execution,
                  anchorEpoch: mutationInput.anchorEpoch,
                  allowGlobal: mutationInput.allowGlobal,
                  ...(mutationInput.capability
                    ? { capability: mutationInput.capability }
                    : {}),
                });
              },
              scheduleMutations(scheduleInput) {
                return createAssignmentScheduleStager(
                  ledger,
                  effectInput.assignmentId,
                  scheduleInput.anchorEpoch,
                  "conversation",
                  scheduleInput.capability,
                );
              },
              authorizeToolExecution: (lease) =>
                ledger.authorizeToolExecution(effectInput.assignmentId, lease),
              hasOpenSideEffects: () =>
                ledger.hasOpenSideEffects(effectInput.assignmentId),
              failExecution: (failure) =>
                ledger.failExecution(effectInput.assignmentId, failure),
              sealConversationBundle: (bundle) =>
                ledger.sealConversationBundle(effectInput.assignmentId, bundle),
              prepareForRunEnd: async (context) => {
                await submission.prepareForRunEnd(effectInput.assignmentId, context);
              },
              submitSealedBundle: (context) =>
                submission.bundle.submitSealedBundle(effectInput.assignmentId, context),
            };
          },
          async dispose(reason) {
            bindings.delete(input.assignmentId);
            await runtime!.dispose(reason);
            if (baseRuntime !== runtime) await baseRuntime!.dispose(reason);
            options.authority.releaseLocalConversationEnvironmentPreflight(
              input.manifest,
              input.assignmentId,
            );
          },
        };
      },
    },
  };
}

function executorPort(target: ResolvedConversationExecutorTarget): RunExecutorPort {
  return target.kind === "local" ? target.mechanism.executor : target.target.executor;
}

class RoutedRunExecutorPort implements RunExecutorPort {
  constructor(
    private readonly forExecutor: (executorId: string) => RunExecutorPort,
    private readonly forAssignment: (assignmentId: string) => RunExecutorPort,
  ) {}

  dispatch(...args: RunDispatchArguments): Promise<DispatchResult> {
    return this.forExecutor(args[0].executorId).dispatch(...args);
  }

  cancel(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    context: AuthorityCallContext,
  ): Promise<void> {
    return this.forAssignment(assignmentId).cancel(assignmentId, fence, context);
  }

  supersede(
    assignmentId: string,
    fence: { fenceSeq: number; requestId: string },
    context: AuthorityCallContext,
  ): Promise<SupersedeProof> {
    return this.forAssignment(assignmentId).supersede(assignmentId, fence, context);
  }

  queryLedger(
    assignmentId: string,
    context: AuthorityCallContext,
    range?: { fromSeq: number; limit: number },
  ) {
    return this.forAssignment(assignmentId).queryLedger(assignmentId, context, range);
  }
}

function startControlHeartbeat(
  assignmentId: string,
  executor: RunExecutorPort,
  contexts: InProcessDispatchContextFactory,
): { stop(): Promise<void> } {
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = executor.queryLedger(
      assignmentId,
      contexts.create(assignmentId, "executor.queryLedger", {
        requestId: `ledger:${assignmentId}:snapshot`,
        body: { range: null },
      }),
    ).then(() => undefined).catch(() => undefined).finally(() => {
      inFlight = undefined;
    });
  }, CONTROL_RENEWAL_INTERVAL_MS);
  timer.unref?.();
  return {
    async stop() {
      clearInterval(timer);
      await inFlight;
    },
  };
}

function remoteBundleSubmissionDeferred(): {
  readonly committed: false;
  readonly error: import("@zhixing/core/contracts").AuthorityError;
} {
  return {
    committed: false,
    error: {
      code: "unavailable-offline",
      message: "Remote executor owns durable bundle redelivery",
      retryable: true,
    },
  };
}

function usageReporterContext(
  reporterId: string,
  digest: string,
  at: string,
): AuthorityCallContext {
  return {
    principal: { kind: "usage-reporter", executorId: reporterId },
    requestId: `usage-report:${digest}`,
    deadlineAt: new Date(Date.parse(at) + 60_000).toISOString(),
  };
}
