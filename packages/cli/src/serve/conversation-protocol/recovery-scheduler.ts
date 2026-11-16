import { userMessageFromTurnInput } from "@zhixing-ai/core";
import type {
  ConversationInvocation,
  RunExecutorPort,
} from "@zhixing-ai/core/contracts";
import { admittedConversationRunLifecycleSource } from "@zhixing-ai/core/delivery";
import type { AgentYield, RunResult } from "@zhixing-ai/core/loop";
import {
  dispatchEnvelopeDigest,
  protocolDigest,
} from "@zhixing-ai/core/protocol";
import {
  conversationRecoveryPage,
  conversationRecoveryPending,
  prioritizeConversationDecisionMigration,
  type ConversationRunJournal,
  type InProcessConversationDispatcher,
  type InProcessDispatchContextFactory,
  type PendingConversationInput,
} from "@zhixing-ai/owner-kernel/conversation-assignment";
import type {
  ConversationManager,
  ManagedSession,
} from "@zhixing-ai/owner-kernel/conversation-manager";
import {
  isConversationSourceEvidenceError,
  loadCommittedConversationBase,
  type ConversationTransferPublication,
} from "@zhixing-ai/owner-kernel/conversation-transfer";
import {
  runTurnWithCommit,
  type DurableConversationTurnInput,
} from "@zhixing-ai/owner-kernel/run-turn";
import type {
  RunTurnOptions,
  SessionRuntime,
  SessionRuntimeModelCallMetering,
} from "@zhixing-ai/owner-kernel/types";
import type {
  ConversationAssignmentArtifactAuthorityIndex,
  ConversationExecutorDispatchApplication,
} from "../conversation-executor-dispatch.js";
import type { ConversationOwnerRuntimeStack } from "../conversation-owner-runtime.js";
import type { DurableConversationInteractionObserver } from "../durable-conversation-interactions.js";
import type { AdmissionAndLifecycle } from "./admission-lifecycle.js";
import type { ConversationLosslessDataPlaneTopology } from "./contracts.js";
import type { ConversationAccess } from "./conversation-access.js";
import {
  requireRuntimeExecutionPermissionRules,
  requireRuntimeExecutionProfile,
  requireRuntimeSecuritySnapshot,
  runOptionsForPending,
  type AuthorityScopeState,
  type RuntimeObligationScope,
} from "./runtime-obligation-scope.js";
import type { TerminalSettlement } from "./terminal-settlement.js";

export type ExecuteRecoveredPerspectivePort = (input: {
  readonly manager: ConversationManager;
  readonly managed: ManagedSession;
  readonly originalInput: PendingConversationInput["input"];
  readonly question: string;
  readonly source: "interactive" | "channel";
  readonly abortSignal?: AbortSignal;
  readonly turnContext: NonNullable<RunTurnOptions["turnContext"]>;
  readonly authorizeToolExecution?: NonNullable<
    RunTurnOptions["authorizeToolExecution"]
  >;
  readonly modelCallMetering?: SessionRuntimeModelCallMetering;
}) => Promise<RunResult>;

export interface RecoverySchedulerHost {
  stopRecoveryLoop(): Promise<void>;
  startRecoveryLoop(intervalMs?: number): void;
  recoverReadinessProjections(): Promise<number>;
  recover(periodic?: boolean, first?: string): Promise<number>;
  prepareConversationReadiness(conversationId: string): Promise<void>;
  cancelAdmitted(conversationId: string, runId: string): Promise<void>;
  publishPendingFinals(conversationId: string): Promise<number>;
  listSessions(): Promise<readonly string[]>;
  isWorksceneContinuationCurrent(source: {
    conversationId: string;
    runId: string;
  }): Promise<boolean>;
  run(input: DurableConversationTurnInput): AsyncGenerator<AgentYield, RunResult>;
  installCommittedConversationTransfer(input: {
    readonly manifest: ConversationTransferPublication["manifest"];
    readonly source: ConversationTransferPublication["source"];
  }): Promise<void>;
}

export interface RecoverySchedulerOptions {
  readonly authority: ConversationOwnerRuntimeStack;
  readonly scope: RuntimeObligationScope;
  readonly access: ConversationAccess;
  readonly admission: AdmissionAndLifecycle;
  readonly settlement: TerminalSettlement;
  readonly host: RecoverySchedulerHost;
  readonly requiredManager: () => ConversationManager;
  readonly executorDispatch: ConversationExecutorDispatchApplication;
  readonly assignmentArtifactAuthority: ConversationAssignmentArtifactAuthorityIndex;
  readonly interactions: DurableConversationInteractionObserver;
  readonly losslessDataPlane: ConversationLosslessDataPlaneTopology;
  readonly recoverAuxiliary: (conversationId: string) => Promise<void>;
  readonly executeRecoveredPerspective?: ExecuteRecoveredPerspectivePort;
  readonly observeFailure: (
    error: unknown,
    context: {
      readonly phase: "run" | "recovery";
      readonly conversationId: string;
      readonly runId?: string;
    },
  ) => void;
}

/**
 * Owns periodic and explicit recovery rounds, `deferFirstSendRecovery`,
 * `markSeq`-guarded recovery mark compare-and-clear, readiness/basis preparation,
 * `recoverInstalledAuthority` scope swap, queued-input resumption, and closure audit.
 */
export class RecoveryScheduler {
  readonly #authority: ConversationOwnerRuntimeStack;
  readonly #scope: RuntimeObligationScope;
  readonly #access: ConversationAccess;
  readonly #admission: AdmissionAndLifecycle;
  readonly #settlement: TerminalSettlement;
  readonly #host: RecoverySchedulerHost;
  readonly #requiredManager: () => ConversationManager;
  readonly #executorDispatch: ConversationExecutorDispatchApplication;
  readonly #assignmentArtifactAuthority: ConversationAssignmentArtifactAuthorityIndex;
  readonly #interactions: DurableConversationInteractionObserver;
  readonly #losslessDataPlane: ConversationLosslessDataPlaneTopology;
  readonly #recoverAuxiliary: (conversationId: string) => Promise<void>;
  readonly #executeRecoveredPerspective: ExecuteRecoveredPerspectivePort | undefined;
  readonly #observeFailure: RecoverySchedulerOptions["observeFailure"];
  readonly #contexts: InProcessDispatchContextFactory;
  #recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  #afterUsable:
    | {
        readonly conversationId: string;
        readonly abort: AbortController;
        readonly done: Promise<void>;
      }
    | undefined;
  readonly #afterUsableUnfinished = new Set<{
    readonly abort: AbortController;
    readonly done: Promise<void>;
  }>();
  #controlBasis: Promise<void> | undefined;
  #recoveryRunning: Promise<number> | undefined;
  #recoveryLoopRound: Promise<number> | undefined;
  #periodicRecoveryRound = 0;
  #recoveryRoundsStarted = 0;
  #readinessRecovery: Promise<number> | undefined;
  #recoveryStopped = false;
  #recoveryPauses = 0;
  #recoveryDeferred = false;
  #recoveryRun: (() => void) | undefined;
  #shutdownDraining = false;

  constructor(options: RecoverySchedulerOptions) {
    this.#authority = options.authority;
    this.#scope = options.scope;
    this.#access = options.access;
    this.#admission = options.admission;
    this.#settlement = options.settlement;
    this.#host = options.host;
    this.#requiredManager = options.requiredManager;
    this.#executorDispatch = options.executorDispatch;
    this.#assignmentArtifactAuthority = options.assignmentArtifactAuthority;
    this.#interactions = options.interactions;
    this.#losslessDataPlane = options.losslessDataPlane;
    this.#recoverAuxiliary = options.recoverAuxiliary;
    this.#executeRecoveredPerspective = options.executeRecoveredPerspective;
    this.#observeFailure = options.observeFailure;
    this.#contexts = this.#access.createDefaultDispatchContexts();
  }

  isRecoveryStopped(): boolean {
    return this.#recoveryStopped;
  }

  beginShutdownDrain(): void {
    this.#shutdownDraining = true;
  }

  resumeAfterShutdownDrain(): void {
    this.#shutdownDraining = false;
  }

  startRecoveryLoop(intervalMs = 5_000): void {
    if (this.#recoveryTimer || this.#recoveryLoopRound) return;
    this.#recoveryStopped = false;
    const run = () => {
      if (this.#recoveryStopped) return;
      if (this.#recoveryPauses > 0) {
        this.#recoveryDeferred = true;
        return;
      }
      const active = this.#host.recover(true);
      this.#recoveryLoopRound = active;
      void active
        .catch(() => 0)
        .finally(() => {
          if (this.#recoveryLoopRound === active) this.#recoveryLoopRound = undefined;
          if (!this.#recoveryStopped) {
            this.#recoveryTimer = setTimeout(() => {
              this.#recoveryTimer = undefined;
              run();
            }, intervalMs);
            this.#recoveryTimer.unref?.();
          }
        });
    };
    this.#recoveryRun = run;
    run();
  }

  async whileRecoveryPaused<Value>(operation: () => Promise<Value>): Promise<Value> {
    this.#recoveryPauses += 1;
    try {
      await Promise.all(
        [this.#recoveryRunning, this.#recoveryLoopRound].map((round) =>
          round?.catch(() => 0),
        ),
      );
      return await operation();
    } finally {
      this.#recoveryPauses -= 1;
      if (this.#recoveryPauses === 0 && this.#recoveryDeferred) {
        this.#recoveryDeferred = false;
        if (!this.#recoveryStopped && !this.#recoveryTimer && !this.#recoveryLoopRound) {
          this.#recoveryRun?.();
        }
      }
    }
  }

  async stopRecoveryLoop(): Promise<void> {
    this.#recoveryStopped = true;
    if (this.#recoveryTimer) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
    // First-send windows do not cross loop stop; AuthorityScope itself is NEVER replaced here.
    this.#scope.current.firstSendWindows.clear();
    const unfinished = [...this.#afterUsableUnfinished];
    for (const preparation of unfinished) {
      try {
        preparation.abort.abort();
      } catch {
        // Isolate abort listener failures so every unfinished preparation settles.
      }
    }
    await Promise.allSettled(unfinished.map((preparation) => preparation.done));
    await Promise.all(
      [this.#recoveryRunning, this.#recoveryLoopRound].map((round) =>
        round?.catch(() => 0),
      ),
    );
    await this.#controlBasis?.catch(() => undefined);
  }

  async recoverReadinessProjections(): Promise<number> {
    if (this.#readinessRecovery) return this.#readinessRecovery;
    const active = this.#recoverReadinessProjections();
    this.#readinessRecovery = active;
    try {
      return await active;
    } catch (error) {
      if (this.#readinessRecovery === active) this.#readinessRecovery = undefined;
      throw error;
    }
  }

  async recoverInstalledAuthority(): Promise<number> {
    await this.#host.stopRecoveryLoop();
    await this.#readinessRecovery?.catch(() => 0);
    await Promise.all(
      [...this.#scope.lifecycleProjectionClaims.values()].map((claim) =>
        claim.catch(() => 0),
      ),
    );
    if (this.#scope.activeRecoveryClaims.size > 0) {
      throw new Error(
        "Installed authority recovery still has active prior-generation claims",
      );
    }

    this.#scope.swapAuthorityScope(
      this.#assignmentArtifactAuthority,
      this.#interactions,
    );
    this.#readinessRecovery = undefined;
    this.#shutdownDraining = false;
    this.#recoveryStopped = false;

    const discovered = await this.#host.recoverReadinessProjections();
    const recovered = await this.#host.recover();
    this.#host.startRecoveryLoop();
    return discovered + recovered;
  }

  recover(periodic = false, first?: string): Promise<number> {
    return this.#recoverRound(periodic, first);
  }

  #recoverRound(periodic: boolean, first?: string): Promise<number> {
    if (this.#recoveryRunning) return this.#recoveryRunning;
    const active: Promise<number> = this.#recoverOnce(periodic, first).finally(() => {
      if (this.#recoveryRunning === active) this.#recoveryRunning = undefined;
    });
    this.#recoveryRunning = active;
    return active;
  }

  async #recoverOnce(periodic: boolean, first: string | undefined): Promise<number> {
    this.#recoveryRoundsStarted += 1;
    await this.#host.recoverReadinessProjections();
    if (this.#recoveryStopped) return 0;
    const scopeState = this.#scope.current;
    if (!this.#scope.isCurrent(scopeState)) return 0;
    if (scopeState.recoveryDiscoveryAfter) {
      const page = await conversationRecoveryPage(
        this.#authority.authorityLog,
        this.#authority.artifacts,
        scopeState.recoveryDiscoveryAfter,
      );
      if (!this.#scope.isCurrent(scopeState)) return 0;
      for (const id of page.conversationIds) {
        await this.#access.adopt(id);
        if (this.#access.acceptsConversationId(id, scopeState)) {
          this.#scope.markRecoveryInScope(scopeState, id);
        }
      }
      if (this.#scope.isCurrent(scopeState)) {
        scopeState.recoveryDiscoveryAfter = page.after;
      }
    }
    const pending = [...scopeState.recoveryConversations.entries()];
    const head =
      first === undefined ? -1 : pending.findIndex(([id]) => id === first);
    if (head > 0) pending.unshift(...pending.splice(head, 1));
    const queue = pending.slice(0, 32);
    const round = periodic ? ++this.#periodicRecoveryRound : undefined;

    let recovered = await this.#settlement.recoverReceivedCancellations(
      () => this.#recoveryStopped,
      scopeState,
    );
    recovered += await this.#executorDispatch.reconcileLocalReceipts();
    recovered += await this.#authority.resourceRecovery.reclaimExpired();

    const recoverConversation = async (conversationId: string): Promise<number> =>
      this.#settlement.withRecoveryClaim(
        conversationId,
        async () => {
          let count = 0;
          await this.prepareConversationBasis(conversationId, scopeState);
          const journal = this.#access.journal(conversationId, scopeState);
          if (this.#losslessDataPlane.kind === "available") {
            count += await this.#losslessDataPlane.port.recoverConversationChannels(
              journal,
            );
          }
          count += await this.#admission.resumeLifecycleProjections(
            conversationId,
            journal,
            scopeState,
          );
          const authority = await journal.authorityState();
          if (authority.deleted && authority.pendingLifecycleProjections === 0) {
            this.#scope.retireConversationInScope(
              scopeState,
              conversationId,
              this.#assignmentArtifactAuthority,
              this.#interactions,
            );
            return 0;
          }
          await this.#access.primeAssignmentRouting(journal, scopeState);
          const recovery = this.#access.createRecoveryDispatcher(
            journal,
            scopeState,
          );
          const {
            dispatcher,
            executor: routedExecutor,
            cancellationContinuationPending,
          } = recovery;
          if (this.#recoveryStopped || !this.#scope.isCurrent(scopeState)) return count;
          count += await journal.resumeCommittedProjections();
          if (this.#recoveryStopped || !this.#scope.isCurrent(scopeState)) return count;
          count += await journal.resumePendingPublishing();
          if (this.#recoveryStopped || !this.#scope.isCurrent(scopeState)) return count;
          count += await dispatcher.recoverCancellations();
          if (this.#recoveryStopped || !this.#scope.isCurrent(scopeState)) return count;
          if (!this.#shutdownDraining) {
            let ready = true;
            for (const pendingDispatch of await journal.pendingDispatches()) {
              if (
                !(await this.#settlement.settleTargetCancellations(
                  conversationId,
                  pendingDispatch.envelope.work.runId,
                  scopeState,
                  () => this.#recoveryStopped,
                ))
              ) {
                ready = false;
              }
            }
            if (ready) {
              count += await dispatcher
                .dispatchPending()
                .then((items) => items.length);
            }
            if (this.#recoveryStopped || !this.#scope.isCurrent(scopeState)) return count;
          }
          count += await dispatcher.recoverAssignments();
          if (this.#recoveryStopped || !this.#scope.isCurrent(scopeState)) return count;
          count += await dispatcher.recoverSupersedes();
          if (this.#recoveryStopped || !this.#scope.isCurrent(scopeState)) return count;
          count += await this.#reconcileAbandonedAssignments(
            journal,
            dispatcher,
            routedExecutor,
            cancellationContinuationPending,
            scopeState,
          );
          if (this.#recoveryStopped || !this.#scope.isCurrent(scopeState)) return count;
          if (!this.#shutdownDraining) {
            count += await this.#resumeQueuedInputs(
              conversationId,
              journal,
              scopeState,
            );
          }
          if (this.#recoveryStopped || !this.#scope.isCurrent(scopeState)) return count;
          count += await this.#host.publishPendingFinals(conversationId);
          await this.#settlement.retireSettledAssignments(
            conversationId,
            journal,
            scopeState,
          );
          await this.#recoverAuxiliary(conversationId);
          return count;
        },
        scopeState,
      );

    const workers = Array.from(
      { length: Math.min(4, queue.length) },
      async () => {
        while (queue.length > 0) {
          if (this.#recoveryStopped || !this.#scope.isCurrent(scopeState)) return;
          const entry = queue.shift();
          if (!entry) return;
          const [conversationId, claimedMarkSeq] = entry;
          if (
            round !== undefined &&
            this.#deferFirstSendRecovery(scopeState, conversationId, round)
          ) {
            continue;
          }
          try {
            recovered += await recoverConversation(conversationId);
            if (
              !this.#recoveryStopped &&
              this.#scope.isCurrent(scopeState) &&
              (await conversationRecoveryPending(
                this.#authority.authorityLog,
                this.#authority.artifacts,
                conversationId,
              ))
            ) {
              this.#scope.markRecoveryInScope(scopeState, conversationId);
            }
            if (
              !this.#recoveryStopped &&
              this.#scope.isCurrent(scopeState) &&
              scopeState.recoveryConversations.get(conversationId) === claimedMarkSeq
            ) {
              scopeState.recoveryConversations.delete(conversationId);
              scopeState.recoveryMarkLedger.delete(conversationId);
            }
          } catch (error) {
            this.#observeFailure(error, { phase: "recovery", conversationId });
          } finally {
            if (scopeState.recoveryConversations.get(conversationId) === claimedMarkSeq) {
              scopeState.recoveryConversations.delete(conversationId);
              scopeState.recoveryConversations.set(conversationId, claimedMarkSeq);
            }
            scopeState.recoveryDeferredRounds.delete(conversationId);
            if (!scopeState.recoveryConversations.has(conversationId)) {
              scopeState.recoveryAttempted.delete(conversationId);
            } else {
              scopeState.recoveryAttempted.set(
                conversationId,
                Math.max(
                  scopeState.recoveryAttempted.get(conversationId) ?? 0,
                  claimedMarkSeq,
                ),
              );
            }
          }
        }
      },
    );
    await Promise.all(workers);
    return recovered;
  }

  #deferFirstSendRecovery(
    scopeState: AuthorityScopeState,
    conversationId: string,
    round: number,
  ): boolean {
    const window = scopeState.firstSendWindows.get(conversationId);
    const pending = scopeState.recoveryConversations.get(conversationId);
    if (!window || window.deferred || pending === undefined) return false;
    if (scopeState.recoveryMarkLedger.get(conversationId) !== window.runId) {
      return false;
    }
    if (scopeState.recoveryDeferredRounds.has(conversationId)) return false;
    window.deferred = true;
    scopeState.recoveryDeferredRounds.set(conversationId, round);
    scopeState.recoveryConversations.delete(conversationId);
    scopeState.recoveryConversations.set(conversationId, pending);
    return true;
  }

  async recoverConversation(conversationId: string): Promise<number> {
    const scopeState = this.#scope.current;
    const requested = this.#scope.markRecoveryInScope(scopeState, conversationId);
    await this.#host.prepareConversationReadiness(conversationId);
    let recovered = 0;
    for (;;) {
      const joining = this.#recoveryRunning !== undefined;
      const started = this.#recoveryRoundsStarted;
      recovered += await this.#host.recover(false, conversationId);
      if (
        this.#recoveryStopped ||
        !this.#scope.isCurrent(scopeState) ||
        !scopeState.recoveryConversations.has(conversationId) ||
        (scopeState.recoveryAttempted.get(conversationId) ?? 0) >= requested
      ) {
        break;
      }
      if (!joining && this.#recoveryRoundsStarted === started) break;
    }
    return recovered;
  }

  prepareAfterUsable(conversationId: string): Promise<void> {
    if (this.#recoveryStopped) return Promise.resolve();
    const current = this.#afterUsable;
    if (
      current &&
      current.conversationId === conversationId &&
      !current.abort.signal.aborted
    ) {
      return current.done;
    }
    current?.abort.abort();
    const abort = new AbortController();
    const scopeState = this.#scope.current;
    const steps = [
      () => this.#access.journal(conversationId, scopeState).dataPlaneTicketFacts(),
      () => this.#access.journal(conversationId, scopeState).recentExecutorAffinity(),
      () => this.#executorDispatch.reconcileLocalReceipts(),
    ];
    const done = (async () => {
      for (const step of steps) {
        if (
          abort.signal.aborted ||
          this.#recoveryStopped ||
          !this.#scope.isCurrent(scopeState)
        ) {
          return;
        }
        await step();
      }
    })().finally(() => {
      this.#afterUsableUnfinished.delete(entry);
      if (this.#afterUsable?.abort === abort) this.#afterUsable = undefined;
    });
    const entry = { abort, done };
    this.#afterUsableUnfinished.add(entry);
    this.#afterUsable = { conversationId, abort, done };
    return done;
  }

  async prepareConversationReadiness(conversationId: string): Promise<void> {
    await this.prepareControlBasis();
    prioritizeConversationDecisionMigration(
      this.#authority.authorityLog,
      conversationId,
    );
    await this.prepareConversationBasis(conversationId);
  }

  prepareControlBasis(): Promise<void> {
    if (this.#authority.controlAdmission.hasRecoveredProjection) {
      return Promise.resolve();
    }
    if (this.#controlBasis) return this.#controlBasis;
    const preparing = this.#authority.controlAdmission
      .prepareRecovery()
      .finally(() => {
        if (this.#controlBasis === preparing) this.#controlBasis = undefined;
      });
    this.#controlBasis = preparing;
    return preparing;
  }

  async prepareConversationBasis(
    conversationId: string,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<void> {
    await this.#access.adopt(conversationId);
    const unavailable = scopeState.unavailableTransfers.get(conversationId);
    if (unavailable) {
      const publication = await loadCommittedConversationBase(
        this.#authority.authorityLog,
        this.#authority.artifacts,
        this.#authority.verifier,
        unavailable.transferId,
      );
      await this.#host.installCommittedConversationTransfer({
        manifest: publication.manifest,
        source: publication.source,
      });
    }
    const journal = this.#access.journal(conversationId, scopeState);
    if (journal.hasRecoveredInputProjection) return;
    await journal.restoreRecoveryCheckpoint();
  }

  async #recoverReadinessProjections(): Promise<number> {
    const scopeState = this.#scope.current;
    if (scopeState.recoveryDiscovered) return 0;
    await this.prepareControlBasis();
    const page = await conversationRecoveryPage(
      this.#authority.authorityLog,
      this.#authority.artifacts,
    );
    if (!this.#scope.isCurrent(scopeState)) return 0;
    for (const conversationId of page.conversationIds) {
      await this.#access.adopt(conversationId);
    }
    const conversationIds = new Set(
      page.conversationIds.filter((conversationId) =>
        this.#access.acceptsConversationId(conversationId, scopeState),
      ),
    );
    if (conversationIds.size > 0) {
      for (const conversationId of conversationIds) {
        this.#scope.markRecoveryInScope(scopeState, conversationId);
        try {
          await this.prepareConversationBasis(conversationId, scopeState);
        } catch (error) {
          if (
            !scopeState.adoptedConversations.has(conversationId) ||
            !isConversationSourceEvidenceError(error)
          ) {
            throw error;
          }
          this.#observeFailure(error, { phase: "recovery", conversationId });
          conversationIds.delete(conversationId);
        }
      }
    }

    let resumed = 0;
    const queue = [...conversationIds];
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          const conversationId = queue.shift();
          if (!conversationId) return;
          if (!this.#scope.isCurrent(scopeState)) return;
          resumed += await this.#settlement.withRecoveryClaim(
            conversationId,
            async () => {
              const journal = this.#access.journal(conversationId, scopeState);
              let count = await this.#admission.resumeLifecycleProjections(
                conversationId,
                journal,
                scopeState,
              );
              const authority = await journal.authorityState();
              if (authority.deleted && authority.pendingLifecycleProjections === 0) {
                this.#scope.retireConversationInScope(
                  scopeState,
                  conversationId,
                  this.#assignmentArtifactAuthority,
                  this.#interactions,
                );
                return count;
              }
              count += await journal.resumeCommittedProjections();
              return count;
            },
            scopeState,
          );
        }
      }),
    );
    if (this.#scope.isCurrent(scopeState)) {
      scopeState.recoveryDiscovered = true;
      scopeState.recoveryDiscoveryAfter = page.after;
    }
    return resumed;
  }

  async #reconcileAbandonedAssignments(
    journal: ConversationRunJournal,
    dispatcher: InProcessConversationDispatcher,
    executor: RunExecutorPort,
    cancellationContinuationPending: (assignmentId: string) => boolean,
    scopeState: AuthorityScopeState,
  ): Promise<number> {
    let reconciled = 0;
    for (const candidate of await journal.assignmentsAwaitingRecovery()) {
      if (
        !this.#scope.isCurrent(scopeState) ||
        scopeState.scheduledRuns.has(candidate.dispatch.envelope.work.runId) ||
        scopeState.activeAssignmentClaims.has(candidate.assignmentId) ||
        cancellationContinuationPending(candidate.assignmentId)
      ) {
        continue;
      }
      this.#scope.rememberAssignmentInScope(
        scopeState,
        candidate.dispatch.envelope,
        candidate.dispatch.activation,
        this.#assignmentArtifactAuthority,
      );
      const snapshot = await journal.validateExecutorLedgerSnapshot(
        await executor.queryLedger(
          candidate.assignmentId,
          this.#contexts.create(candidate.assignmentId, "executor.queryLedger", {
            requestId: `ledger:${candidate.assignmentId}:snapshot`,
            body: { range: null },
          }),
        ),
      );
      if (
        !this.#scope.isCurrent(scopeState) ||
        scopeState.scheduledRuns.has(candidate.dispatch.envelope.work.runId) ||
        scopeState.activeAssignmentClaims.has(candidate.assignmentId) ||
        cancellationContinuationPending(candidate.assignmentId)
      ) {
        continue;
      }
      if (snapshot.phase === "received" && candidate.state === "dispatched") {
        await dispatcher.supersede(
          candidate.assignmentId,
          `local-recovery:${candidate.assignmentId}`,
        );
        reconciled += 1;
        continue;
      }
      if (snapshot.phase === "started") {
        await journal.markAssignmentUncertain(
          candidate.assignmentId,
          "ledger-unknown",
        );
        reconciled += 1;
      }
    }
    return reconciled;
  }

  async #resumeQueuedInputs(
    conversationId: string,
    journal: ConversationRunJournal,
    scopeState: AuthorityScopeState,
  ): Promise<number> {
    let resumed = 0;
    for (const pending of await journal.pendingInputs()) {
      await this.schedulePendingInput(conversationId, pending, scopeState);
      resumed += 1;
    }
    return resumed;
  }

  async schedulePendingInput(
    conversationId: string,
    pending: PendingConversationInput,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<void> {
    if (this.#shutdownDraining) return;
    if (!this.#scope.isCurrent(scopeState)) return;
    if (scopeState.scheduledRuns.has(pending.runId)) return;
    if (
      !(await this.#admission.mayScheduleInput(
        conversationId,
        pending.runId,
        scopeState,
      ))
    ) {
      return;
    }
    if (!this.#scope.isCurrent(scopeState)) return;
    if (scopeState.schedulingRuns.has(pending.runId)) {
      throw new Error(
        `Conversation run ${pending.runId} is still entering the scheduler`,
      );
    }
    const manager = this.#requiredManager();
    const options = runOptionsForPending(pending);
    const retryAbort = new AbortController();
    const claimToken = Symbol(pending.runId);
    scopeState.schedulingRuns.set(pending.runId, claimToken);
    try {
      const admission = await manager.admitTurn({
        conversationId,
        source: options.source,
        capacityReserved: true,
        makeTask: (managed) => ({
          source: options.source,
          durableRunId: pending.runId,
          execute: async () => {
            try {
              await this.#executePendingInput(
                conversationId,
                pending,
                manager,
                managed,
                scopeState,
                retryAbort.signal,
              );
            } catch (error) {
              this.#scope.markRecoveryInScope(scopeState, conversationId);
              throw error;
            } finally {
              manager.setBusy(conversationId, false);
            }
          },
          cancel: () => {},
          cancelLocally: () => {},
          cancelDurably: () =>
            this.#host.cancelAdmitted(conversationId, pending.runId),
          abort: (reason) => {
            const newlyAborted = !retryAbort.signal.aborted;
            if (newlyAborted) retryAbort.abort(reason);
            return managed.runtime.abort(reason) || newlyAborted;
          },
        }),
      });
      if (admission.status === "immediate") {
        if (scopeState.schedulingRuns.get(pending.runId) === claimToken) {
          scopeState.schedulingRuns.delete(pending.runId);
        }
        scopeState.scheduledRuns.set(pending.runId, claimToken);
        void admission.task.execute().catch(() => {});
      } else if (admission.status === "queued") {
        if (scopeState.schedulingRuns.get(pending.runId) === claimToken) {
          scopeState.schedulingRuns.delete(pending.runId);
        }
        scopeState.scheduledRuns.set(pending.runId, claimToken);
      } else if (
        admission.status === "full" ||
        admission.status === "not-found"
      ) {
        throw new Error(
          `Recovered conversation run ${pending.runId} could not enter the scheduler`,
        );
      } else {
        throw new Error(
          `Recovered conversation run ${pending.runId} did not acquire a scheduler slot`,
        );
      }
    } catch (error) {
      if (scopeState.schedulingRuns.get(pending.runId) === claimToken) {
        scopeState.schedulingRuns.delete(pending.runId);
      }
      this.#scope.markRecoveryInScope(scopeState, conversationId);
      throw error;
    }
  }

  async scheduleResolvedRetry(
    conversationId: string,
    runId: string,
    journal: ConversationRunJournal,
    scopeState: AuthorityScopeState = this.#scope.current,
  ): Promise<void> {
    const pending = (await journal.pendingInputs()).find(
      (candidate) => candidate.runId === runId,
    );
    if (!pending) {
      throw new Error(`Resolved conversation run ${runId} has no durable input`);
    }
    await this.schedulePendingInput(conversationId, pending, scopeState);
  }

  async #executePendingInput(
    conversationId: string,
    pending: PendingConversationInput,
    manager: ConversationManager,
    managed: ManagedSession,
    scopeState: AuthorityScopeState,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (!this.#scope.isCurrent(scopeState)) return;
    const continuation = pending.ingress.turnOrigin?.worksceneContinuation;
    if (
      continuation &&
      !(await this.#host.isWorksceneContinuationCurrent({
        conversationId,
        runId: pending.runId,
      }))
    ) {
      await this.#host.cancelAdmitted(conversationId, pending.runId);
      return;
    }
    const options = runOptionsForPending(pending, abortSignal, true);
    const invocation: ConversationInvocation = pending.invocation;
    if (invocation.kind === "perspectives") {
      if (!this.#executeRecoveredPerspective) {
        throw new Error(
          "Durable perspective recovery has no perspective execution adapter",
        );
      }
      const execute = this.#executeRecoveredPerspective;
      const createRuntime = (baseRuntime: SessionRuntime): SessionRuntime => ({
        sessionId: `recovered-perspectives:${conversationId}`,
        async *run(
          _messages,
          runtimeOptions,
        ): AsyncGenerator<AgentYield, RunResult> {
          const meter = runtimeOptions?.modelCallResourceMeter;
          let callIndex = 0;
          return await execute({
            manager,
            managed: { ...managed, runtime: baseRuntime },
            originalInput: pending.input,
            question: invocation.question,
            source: invocation.source,
            ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
            turnContext: options.turnContext,
            authorizeToolExecution: runtimeOptions?.authorizeToolExecution,
            ...(meter
              ? {
                  modelCallMetering: {
                    meter,
                    nextCallIndex: () => ++callIndex,
                  },
                }
              : {}),
          });
        },
        abort: (reason) => baseRuntime.abort(reason),
        async dispose() {},
        securitySnapshot: () => requireRuntimeSecuritySnapshot(baseRuntime),
        executionPermissionRules: (scope) =>
          requireRuntimeExecutionPermissionRules(baseRuntime, scope),
        executionProfile: () => requireRuntimeExecutionProfile(baseRuntime),
      });
      const runtime = createRuntime(managed.runtime);
      const generator = this.#host.run({
        conversationId,
        input: pending.input,
        attachments: pending.attachments,
        messages: [
          ...managed.window.getRunInputMessages(),
          userMessageFromTurnInput(pending.input),
        ],
        baseRevision: managed.turnCount,
        runtime,
        adaptLocalRuntime: createRuntime,
        invocation,
        options: { ...options, turnIndex: managed.turnCount },
      });
      while (!(await generator.next()).done) {
        // Perspective orchestration publishes provisional events through its own bus.
      }
    } else {
      const generator = runTurnWithCommit(
        manager,
        conversationId,
        pending.input,
        {
          ...options,
          attachments: pending.attachments,
          turnIndex: managed.turnCount,
        },
        undefined,
        pending.environment,
      );
      while (!(await generator.next()).done) {
        // Provisional observers do not survive restart.
      }
    }
    try {
      await this.#host.publishPendingFinals(conversationId);
    } catch {
      // Runtime-owned recovery queue redrives durable finals independently.
    }
  }

  async pendingClosureWork(conversationId?: string): Promise<{
    readonly pendingAdmittedRuns: number;
    readonly pendingFinals: number;
    readonly pendingAssignments: number;
    readonly recoveryBacklog: number;
    readonly activeLocalLeases: number;
    readonly items: {
      readonly admittedRuns: readonly { readonly id: string; readonly revision: string }[];
      readonly finals: readonly { readonly id: string; readonly revision: string }[];
      readonly assignments: readonly { readonly id: string; readonly revision: string }[];
      readonly recovery: readonly { readonly id: string; readonly revision: string }[];
      readonly leases: readonly { readonly id: string; readonly revision: string }[];
    };
  }> {
    const scopeState = this.#scope.current;
    const admittedRuns: Array<{ id: string; revision: string }> = [];
    const finals: Array<{ id: string; revision: string }> = [];
    const assignments: Array<{ id: string; revision: string }> = [];
    const conversations =
      conversationId === undefined
        ? await this.#host.listSessions()
        : [conversationId];
    for (const currentConversationId of conversations) {
      await this.#access.adopt(currentConversationId);
      const journal = this.#access.journal(currentConversationId, scopeState);
      for (const run of await journal.unsettledAdmittedRuns()) {
        const source = admittedConversationRunLifecycleSource({
          conversationId: currentConversationId,
          runId: run.runId,
          queuedPosition: run.queuedPosition,
        });
        admittedRuns.push({
          id: source.id,
          revision: source.revision,
        });
      }
      for (const final of await journal.pendingFinalFrames()) {
        finals.push({
          id: `${final.conversationId}:${final.runId}`,
          revision: String(final.commitRevision),
        });
      }
      for (const assignment of await journal.assignmentsAwaitingRecovery()) {
        assignments.push({
          id: `${
            assignment.dispatch.envelope.executorId === this.#authority.executorId
              ? "local"
              : "relay"
          }:${assignment.assignmentId}`,
          revision: dispatchEnvelopeDigest(assignment.dispatch.envelope),
        });
      }
    }
    const leases: Array<{ id: string; revision: string }> = [];
    for (const reservation of await this.#authority.resourceRecovery.activeConversationReservations()) {
      await this.#access.adopt(reservation.conversationId);
      if (
        reservation.ownerEpoch ===
          this.#access.ownerEpochFor(reservation.conversationId, scopeState) &&
        this.#access.acceptsConversationId(reservation.conversationId, scopeState) &&
        (conversationId === undefined ||
          reservation.conversationId === conversationId)
      ) {
        leases.push({
          id: reservation.reservationId,
          revision: reservation.revision,
        });
      }
    }
    const recoveryIds = new Set<string>();
    for (const id of scopeState.recoveryConversations.keys()) {
      if (conversationId === undefined || conversationId === id) {
        recoveryIds.add(`queued:${id}`);
      }
    }
    for (const id of this.#scope.activeRecoveryClaims.keys()) {
      if (conversationId === undefined || conversationId === id) {
        recoveryIds.add(`claimed:${id}`);
      }
    }
    if (this.#recoveryRunning) {
      recoveryIds.add(`worker:${conversationId ?? "all"}`);
    }
    const recovery = [...recoveryIds].sort().map((id) => ({
      id,
      revision: protocolDigest("ConversationRecoveryClosure", 1, { id }),
    }));
    const sortItems = <T extends { readonly id: string }>(items: T[]) =>
      Object.freeze(
        items.sort((left, right) => left.id.localeCompare(right.id, "en-US")),
      );
    return {
      pendingAdmittedRuns: admittedRuns.length,
      pendingFinals: finals.length,
      pendingAssignments: assignments.length,
      recoveryBacklog: recovery.length,
      activeLocalLeases: leases.length,
      items: Object.freeze({
        admittedRuns: sortItems(admittedRuns),
        finals: sortItems(finals),
        assignments: sortItems(assignments),
        recovery: sortItems(recovery),
        leases: sortItems(leases),
      }),
    };
  }
}
