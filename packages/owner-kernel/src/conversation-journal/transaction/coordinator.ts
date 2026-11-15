import {
  AuthorityPreparationRequired,
  awaitAuthorityPreparation,
  type ArtifactStore,
  type AuthorityCommitLog,
  type AuthorityLogSnapshot,
  type DurableProjectionReadContext,
  type ProjectionCursor,
  type ProjectionTransactionContext,
  type ProjectionTransactionDecision,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  CommitEnvelope,
  ConversationStatusNotice,
  FinalFrame,
  FinalOutboxRecord,
  LogicalRecord,
  PublishRecord,
} from "@zhixing-ai/core/contracts";
import { DELIVERY_AUTHORITY_PROJECTION_ID } from "@zhixing-ai/core/delivery";
import { SerialTaskQueue } from "@zhixing-ai/core/persistence";
import {
  requiresFormalResourceCoordination,
  verifyProtocolStep,
  type ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";
import {
  currentMaintenanceAbortSignal,
  isHoldingMaintenanceExclusion,
  maintenanceRetryDelayMs,
  StorageMaintenanceAdmissionError,
  StorageMaintenanceCancelledError,
  waitForMaintenanceRetry,
} from "@zhixing-ai/core/resources";
import type { ConversationBaseSource } from "../../conversation-base-source.js";
import { conversationViewAt } from "../../conversation-base-registry.js";
import { createConversationProjectionDraft } from "../../conversation-projection-draft.js";
import {
  CONVERSATION_RECOVERY_PROJECTION_ID,
  conversationRecoveryVersion,
  prepareConversationEffects,
  type ConversationEffectSelection,
} from "../../conversation-recovery-index.js";
import {
  corruptRunJournal,
  type ConversationRunJournalRecord,
} from "../../conversation-run-contracts.js";
import {
  CONVERSATION_RUN_STATE_PROJECTION_ID,
  conversationWorkingVersion,
} from "../../conversation-run-state-index.js";
import {
  conversationDecisionScope,
  prepareConversationRunView,
  type ConversationDecisionScope,
} from "../../conversation-run-state-view.js";
import {
  assertConversationTransferWriteAuthority,
  CONVERSATION_TRANSFER_PROJECTION_ID,
  conversationAnchorAtPrefix,
  conversationAnchorProjectionIds,
} from "../../conversation-transfer.js";
import type { ConversationDeliveryParticipant } from "../../delivery-participant.js";
import type {
  AssignmentResourceCoordinator,
  CoordinationOptions,
} from "../../resource-governor.js";
import { buildSemanticProjectionCheckpointPrefix } from "../../shared-protocol/contracts.js";
import {
  emptyConversationRunProjection,
  emptySubmissionGuardProjection,
  type ConversationAbortTicketAuthorizer,
  type ConversationCommitLogRecord,
  type ConversationFactGroup,
  type RunProjection,
  type SubmissionGuardProjection,
} from "../contracts.js";
import {
  conversationStatusDeliveryInputs,
  loadCommittedBundleBinding,
} from "../replay/bundle-binding.js";
import {
  CONVERSATION_GUARD_FINGERPRINT_FNS,
  reduceConversationSubmissionGuard,
} from "../replay/guard-reducer.js";
import {
  compactLegacyRunProjection,
  CONVERSATION_RUN_FINGERPRINT_FNS,
  reduceConversationRunState,
  reduceRunProjectionWithCompaction,
} from "../replay/run-reducer.js";
import { requireAssignedEnvelope } from "../state/assignment-control.js";
import {
  canonicalTime,
  isTaggedRecord,
  runStream,
} from "../state/common.js";
import {
  applyFinalRecord,
  emptyFinalProjection,
  emptyPublishProjection,
  finalKey,
  reducePublishRecord,
} from "../state/commit-publish.js";
import {
  readConversationDecisionFacts,
  readFinalOutboxFacts,
  readPublishFacts,
  type ConversationDecisionFacts,
  type FinalOutboxFacts,
  type PublishFacts,
} from "../state/views.js";
import { conversationStatusNoticesForCommit } from "./publish-outbox.js";

type JournalProjectionKind = "run" | "submission";
const journalCheckpointPrefixes = new Map<JournalProjectionKind, string>();

/** Owner-side durable run facts and deterministic dispatch outbox for one conversation. */
export class ConversationWorkingSetChanged extends StorageMaintenanceAdmissionError {
  constructor() {
    super({
      kind: "backpressured",
      blockedBy: "derived-preparation",
      retryAfterMs: 1,
    });
    // 只供观测：推迟事件据此区分“工作集在准备期间被改动后重做”与派生投影准备
    (this as { observed?: unknown }).observed = {
      reason: "conversation-working-set-changed",
      positions: [],
    };
    this.name = "ConversationWorkingSetChanged";
    this.message = "Conversation working set changed during preparation";
  }
}

export interface ConversationProjectionCoordinatorOptions {
  readonly conversationId: string;
  readonly ownerEpoch: number;
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly verifier: ProtocolSignatureVerifier;
  readonly legacyAbortTickets: ConversationAbortTicketAuthorizer | undefined;
  readonly delivery: ConversationDeliveryParticipant | undefined;
  readonly resources: AssignmentResourceCoordinator | undefined;
  readonly currentAuthority:
    | {
        readonly deviceId: string;
        readonly executorId?: string;
      }
    | undefined;
  readonly publishStatusNotices: (
    notices: readonly ConversationStatusNotice[],
  ) => void;
}

export class ConversationProjectionCoordinator {
  readonly #conversationId: string;
  readonly #ownerEpoch: number;
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #legacyAbortTickets: ConversationAbortTicketAuthorizer | undefined;
  readonly #delivery: ConversationDeliveryParticipant | undefined;
  readonly #resources: AssignmentResourceCoordinator | undefined;
  readonly #currentAuthority:
    | {
        readonly deviceId: string;
        readonly executorId?: string;
      }
    | undefined;
  readonly #publishStatusNotices: (
    notices: readonly ConversationStatusNotice[],
  ) => void;

  readonly #operations = new SerialTaskQueue();
  readonly #checkpointedThrough = new Map<JournalProjectionKind, number>();
  #unregisterCheckpointFlush: (() => void) | undefined;
  #readBaseGeneration = 0;
  #importedBaseSource: ConversationBaseSource | undefined;
  #runProjection:
    | { readonly state: RunProjection; readonly cursor: ProjectionCursor }
    | undefined;
  #submissionGuardProjection:
    | {
        readonly state: SubmissionGuardProjection;
        readonly cursor: ProjectionCursor;
      }
    | undefined;

  constructor(options: ConversationProjectionCoordinatorOptions) {
    this.#conversationId = options.conversationId;
    this.#ownerEpoch = options.ownerEpoch;
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#verifier = options.verifier;
    this.#legacyAbortTickets = options.legacyAbortTickets;
    this.#delivery = options.delivery;
    this.#resources = options.resources;
    this.#currentAuthority = options.currentAuthority;
    this.#publishStatusNotices = options.publishStatusNotices;
  }

  get readBaseGeneration(): number {
    return this.#readBaseGeneration;
  }

  get importedBaseSource(): ConversationBaseSource | undefined {
    return this.#importedBaseSource;
  }

  get hasRecoveredInputProjection(): boolean {
    return this.#runProjection !== undefined;
  }

  readBase(): {
    readonly generation: number;
    readonly source: ConversationBaseSource | undefined;
  } {
    return {
      generation: this.#readBaseGeneration,
      source: this.#importedBaseSource,
    };
  }

  sameReadBase(base: {
    readonly generation: number;
    readonly source: ConversationBaseSource | undefined;
  }): boolean {
    return (
      base.generation === this.#readBaseGeneration &&
      base.source === this.#importedBaseSource
    );
  }

  bumpReadBaseGeneration(): void {
    this.#readBaseGeneration += 1;
  }

  setImportedBaseSource(source: ConversationBaseSource): void {
    this.#importedBaseSource = source;
  }

  runSerial<Value>(task: () => Promise<Value>): Promise<Value> {
    return this.#operations.run(task);
  }

  deliveryProjectionIds(): readonly string[] {
    return this.#delivery ? [DELIVERY_AUTHORITY_PROJECTION_ID] : [];
  }

  /** Only commands whose decision, reducer and status effects have explicit subjects use this scope. */
  exactCommandScope(input: unknown): ConversationDecisionScope {
    return conversationDecisionScope(
      input,
      this.#readBaseGeneration === 0 && !this.#importedBaseSource
        ? { current: false }
        : {},
    );
  }

  /** A query owns one synchronized source prefix; it never publishes a partial
   * execution working set or retains mutable rows after releasing that prefix. */
  async readCurrentIndexed<Value>(
    select: (view: DurableProjectionReadContext) => Promise<Value>,
  ): Promise<Value> {
    return this.repeatWorkingSet(() =>
      this.#operations.run(async () => {
        const result = await this.#log.transactDurableProjection<never, Value>(
          CONVERSATION_RUN_STATE_PROJECTION_ID,
          async (current) => ({
            kind: "return",
            value: await select(
              await conversationViewAt(this.#log, current, this.#conversationId),
            ),
          }),
        );
        return result.value;
      }),
    );
  }

  async repeatWorkingSet<Value>(operation: () => Promise<Value>): Promise<Value> {
    const abort = currentMaintenanceAbortSignal();
    let deadline: number | undefined;
    for (;;) {
      if (abort.aborted) throw new StorageMaintenanceCancelledError();
      try {
        return await operation();
      } catch (error) {
        const delay =
          error instanceof ConversationWorkingSetChanged
            ? 0
            : maintenanceRetryDelayMs(error);
        if (
          delay === undefined ||
          isHoldingMaintenanceExclusion() ||
          abort.aborted
        ) {
          throw error;
        }
        if (await awaitAuthorityPreparation(error)) continue;
        deadline ??= performance.now() + 5_000;
        if (performance.now() >= deadline) throw error;
        if (delay) {
          await waitForMaintenanceRetry(
            Math.min(delay, deadline - performance.now()),
          );
        } else {
          await new Promise<void>(setImmediate);
        }
      }
    }
  }

  async select<Value>(
    select: (facts: ConversationDecisionFacts) => Value,
    scope: ConversationDecisionScope = {},
  ): Promise<Value> {
    if (this.#readBaseGeneration !== 0) {
      return this.#selectLegacy((state) =>
        select(readConversationDecisionFacts(state)),
      );
    }
    return this.repeatWorkingSet(() =>
      this.#operations.run(async () => {
        const prepared = await this.#prepareWorkingSet(scope);
        const result = await this.#log.transactDurableProjection<never, Value>(
          CONVERSATION_RUN_STATE_PROJECTION_ID,
          async (_current, context) => {
            await this.#checkWorkingSet(context, prepared.version);
            return {
              kind: "return",
              value: select(readConversationDecisionFacts(prepared.state)),
            };
          },
        );
        if (prepared.completeCurrentView) {
          this.#runProjection = { state: prepared.state, cursor: result.cursor };
        }
        return result.value;
      }),
    );
  }

  async transact<Value>(
    decide: (
      facts: ConversationDecisionFacts,
      prefix: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<unknown, Value>
      | Promise<ProjectionTransactionDecision<unknown, Value>>,
    candidateReferences: readonly ArtifactRef[] = [],
    readProjectionIds: readonly string[] = [],
    scope: ConversationDecisionScope = {},
    options: {
      readonly resourcePreparation?: NonNullable<CoordinationOptions["prepare"]>;
    } = {},
  ) {
    if (this.#readBaseGeneration !== 0) {
      return this.#transactLegacy(
        (state, prefix) =>
          decide(readConversationDecisionFacts(state), prefix),
        candidateReferences,
        readProjectionIds,
      );
    }
    return this.repeatWorkingSet(async () => {
      return this.#operations.run(async () => {
        const prepared = await this.#prepareWorkingSet({
          ...scope,
          hydrate: true,
        });
        let candidateLsn: number | undefined;
        const run = () =>
          this.#log.transactProjection<RunProjection, unknown, Value>(
            prepared.state,
            (state, record, envelope) =>
              envelope.lsn === candidateLsn
                ? this.reduceRunProjection(state, record, envelope)
                : state,
            async (state, context) => {
              await this.#checkWorkingSet(context, prepared.version);
              if (this.#currentAuthority) {
                await assertConversationTransferWriteAuthority(
                  context.readProjection(CONVERSATION_TRANSFER_PROJECTION_ID),
                  this.#conversationId,
                  {
                    deviceId: this.#currentAuthority.deviceId,
                    ownerEpoch: this.#ownerEpoch,
                  },
                  await conversationAnchorAtPrefix(this.#log, context),
                );
              }
              candidateLsn = context.nextLsn;
              const decision = await decide(
                readConversationDecisionFacts(state),
                context,
              );
              if (decision.kind !== "append") return decision;
              const statuses = conversationStatusDeliveryInputs(
                this.#conversationId,
                state,
                decision.entries,
                context.at,
              );
              const delivery =
                (await this.#delivery?.prepareConversationStatuses(
                  statuses,
                  context,
                  decision.entries,
                )) ?? { accepted: true as const, records: [] };
              if (!delivery.accepted) {
                throw corruptRunJournal(delivery.error.message);
              }
              return {
                ...decision,
                entries: [
                  ...this.prepareResourceTerminalRecords(
                    state,
                    decision.entries,
                  ),
                  ...decision.entries,
                  ...delivery.records,
                ],
              };
            },
            {
              stream: runStream(this.#conversationId),
              cursor: prepared.cursor,
              candidateReferences,
              readProjectionIds: [
                ...new Set([
                  CONVERSATION_RUN_STATE_PROJECTION_ID,
                  ...this.deliveryProjectionIds(),
                  ...readProjectionIds,
                  ...(this.#currentAuthority
                    ? [
                        CONVERSATION_TRANSFER_PROJECTION_ID,
                        ...conversationAnchorProjectionIds(this.#log),
                      ]
                    : []),
                ]),
              ],
              createState: () => {
                candidateLsn = undefined;
                return createConversationProjectionDraft(prepared.state).state;
              },
            },
          );
        const coordinate = () =>
          this.#delivery ? this.#delivery.coordinate(run) : run();
        const result = await (this.#resources
          ? this.#resources.coordinate(coordinate, {
              caller: "conversation-journal",
              ...(options.resourcePreparation
                ? { prepare: options.resourcePreparation }
                : {}),
            })
          : coordinate());
        if (prepared.completeCurrentView) {
          this.#runProjection = { state: result.state, cursor: result.cursor };
        }
        if (result.commit) {
          this.#publishStatusNotices(
            conversationStatusNoticesForCommit(
              readConversationDecisionFacts(result.state).assignment,
              result.commit,
              this.#conversationId,
              this.#ownerEpoch,
            ),
          );
        }
        return result;
      });
    });
  }

  async withRunProjection<Value>(
    operation: (
      basis:
        | {
            readonly state: RunProjection;
            readonly cursor: ProjectionCursor;
            readonly createState: () => RunProjection;
            readonly readProjectionIds?: readonly string[];
            readonly validateAtPrefix?: (
              context: ProjectionTransactionContext,
            ) => Promise<void>;
          }
        | undefined,
      publish: (state: RunProjection, cursor: ProjectionCursor) => void,
    ) => Promise<Value>,
    scope: ConversationDecisionScope = {},
  ): Promise<Value> {
    if (this.#readBaseGeneration !== 0) {
      return this.#withRunProjectionLegacy(operation);
    }
    return this.repeatWorkingSet(async () => {
      return this.#operations.run(async () => {
        const prepared = await this.#prepareWorkingSet({
          ...scope,
          hydrate: true,
        });
        const createState = () =>
          createConversationProjectionDraft(prepared.state).state;
        return operation(
          {
            state: createState(),
            cursor: prepared.cursor,
            createState,
            readProjectionIds: [CONVERSATION_RUN_STATE_PROJECTION_ID],
            validateAtPrefix: (context) =>
              this.#checkWorkingSet(context, prepared.version),
          },
          (state, cursor) => {
            if (prepared.completeCurrentView) {
              this.#runProjection = { state, cursor };
            }
          },
        );
      });
    });
  }

  async restoreRecoveryCheckpoint(): Promise<boolean> {
    if (this.#readBaseGeneration === 0) {
      const prepared = await prepareConversationRunView({
        log: this.#log,
        artifacts: this.#artifacts,
        verifier: this.#verifier,
        conversationId: this.#conversationId,
        scope: {},
        previous: this.#runProjection?.state,
        legacy: this.#legacyAbortTickets,
      });
      this.#runProjection = { state: prepared.state, cursor: prepared.cursor };
      return true;
    }
    await this.#operations.run(() => this.#restoreProjection("run"));
    return this.hasRecoveredInputProjection;
  }

  discardProjectionCheckpoints(): void {
    this.#unregisterCheckpointFlush?.();
    this.#unregisterCheckpointFlush = undefined;
    for (const kind of ["run", "submission"] as const) {
      const key = this.#projectionCheckpointKey(kind);
      if (key) void this.#log.deleteProjectionCheckpoint?.(key);
      if (kind === "run") {
        void this.#log.deleteProjectionCheckpoint?.(
          `${buildSemanticProjectionCheckpointPrefix("conversation-run-projection", 1, [this.#reduce, ...CONVERSATION_RUN_FINGERPRINT_FNS])}:${this.#conversationId}:${this.#ownerEpoch}`,
        );
      }
    }
  }

  async primeRecoverySnapshot(
    snapshotValue: AuthorityLogSnapshot<unknown>,
  ): Promise<void> {
    const baseGeneration = this.#readBaseGeneration;
    const abort = currentMaintenanceAbortSignal();
    let run = emptyConversationRunProjection(this.#conversationId);
    let submission = emptySubmissionGuardProjection();
    const records = (function* () {
      for (const envelope of snapshotValue.commits) {
        for (const record of envelope.entries) {
          yield { envelope, record };
        }
      }
    })();
    let next = records.next();
    const checks: Array<() => void> = [];
    for (;;) {
      if (abort.aborted) throw new StorageMaintenanceCancelledError();
      if (this.#readBaseGeneration !== baseGeneration) {
        throw new Error("Conversation recovery read base changed");
      }
      const yieldAt = performance.now() + 8;
      let processed = 0;
      while (
        !next.done &&
        (processed === 0 ||
          (processed < 64 &&
            checks.length < 64 &&
            performance.now() < yieldAt))
      ) {
        const { envelope, record } = next.value;
        if (record.stream === runStream(this.#conversationId)) {
          run = await this.reduceRunProjection(run, record, envelope, checks);
          submission = await this.#reduceSubmissionGuard(
            submission,
            record as LogicalRecord<ConversationCommitLogRecord>,
            envelope as CommitEnvelope<ConversationCommitLogRecord>,
            checks,
          );
        }
        next = records.next();
        processed++;
      }

      if (!next.done && checks.length < 64) {
        await new Promise<void>(setImmediate);
        continue;
      }

      let retryDeadline: number | undefined;
      for (;;) {
        try {
          await this.#operations.run(async () => {
            if (abort.aborted) throw new StorageMaintenanceCancelledError();
            if (this.#readBaseGeneration !== baseGeneration) {
              throw new Error("Conversation recovery read base changed");
            }
            const validate = async () => {
              for (const check of checks) await verifyProtocolStep(check);
            };
            if (checks.length && this.#resources) {
              await this.#resources.coordinate(validate, {
                caller: "conversation-journal.recovery-validate",
              });
            } else {
              await validate();
            }
            if (abort.aborted) throw new StorageMaintenanceCancelledError();
            if (this.#readBaseGeneration !== baseGeneration) {
              throw new Error("Conversation recovery read base changed");
            }
            if (!next.done) return;
            if (
              !this.#runProjection ||
              this.#runProjection.cursor.lsn <= snapshotValue.cursor.lsn
            ) {
              this.#runProjection = {
                state: run,
                cursor: snapshotValue.cursor,
              };
            }
            if (
              !this.#submissionGuardProjection ||
              this.#submissionGuardProjection.cursor.lsn <=
                snapshotValue.cursor.lsn
            ) {
              this.#submissionGuardProjection = {
                state: submission,
                cursor: snapshotValue.cursor,
              };
            }
            for (const kind of ["run", "submission"] as const) {
              this.#saveProjection(kind);
            }
          });
          checks.length = 0;
          break;
        } catch (error) {
          const delay = maintenanceRetryDelayMs(error);
          if (
            delay === undefined ||
            isHoldingMaintenanceExclusion() ||
            abort.aborted
          ) {
            throw error;
          }
          if (await awaitAuthorityPreparation(error)) continue;
          retryDeadline ??= performance.now() + 5_000;
          const remaining = retryDeadline - performance.now();
          if (remaining <= 0) throw error;
          await waitForMaintenanceRetry(Math.min(delay, remaining));
        }
      }
      if (next.done) return;
      await new Promise<void>(setImmediate);
    }
  }

  readonly reduceRunProjection = async (
    state: RunProjection,
    record: LogicalRecord<unknown>,
    envelope: CommitEnvelope<unknown>,
    checks?: Array<() => void>,
  ): Promise<RunProjection> =>
    reduceRunProjectionWithCompaction(
      {
        conversationId: this.#conversationId,
        artifacts: this.#artifacts,
        verifier: this.#verifier,
        legacyAbortTickets: this.#legacyAbortTickets,
        resources: this.#resources,
        delivery: this.#delivery,
        currentAuthority: this.#currentAuthority,
        assertResourceUsageFinal: (assigned, usage) =>
          this.assertResourceUsageFinal(assigned, usage),
        assertResourceTerminalRecords: (assigned, mode, entries) =>
          this.assertResourceTerminalRecords(assigned, mode, entries),
      },
      state,
      record,
      envelope,
      checks,
    );

  readonly #reduce = (
    state: RunProjection,
    record: LogicalRecord<unknown>,
    envelope: CommitEnvelope<unknown>,
    checks?: Array<() => void>,
  ) =>
    reduceConversationRunState(
      {
        conversationId: this.#conversationId,
        artifacts: this.#artifacts,
        verifier: this.#verifier,
        legacyAbortTickets: this.#legacyAbortTickets,
        resources: this.#resources,
        delivery: this.#delivery,
        currentAuthority: this.#currentAuthority,
        assertResourceUsageFinal: (assigned, usage) =>
          this.assertResourceUsageFinal(assigned, usage),
        assertResourceTerminalRecords: (assigned, mode, entries) =>
          this.assertResourceTerminalRecords(assigned, mode, entries),
      },
      state,
      record,
      envelope,
      checks,
    );

  readonly #reduceSubmissionGuard = async (
    state: SubmissionGuardProjection,
    record: LogicalRecord<ConversationCommitLogRecord>,
    envelope: CommitEnvelope<ConversationCommitLogRecord>,
    checks?: Array<() => void>,
  ): Promise<SubmissionGuardProjection> =>
    reduceConversationSubmissionGuard(
      {
        conversationId: this.#conversationId,
        verifier: this.#verifier,
        legacyAbortTickets: this.#legacyAbortTickets,
        assertResourceUsageFinal: (assigned, usage) =>
          this.assertResourceUsageFinal(assigned, usage),
        assertResourceTerminalRecords: (assigned, mode, records) =>
          this.assertResourceTerminalRecords(assigned, mode, records),
      },
      state,
      record,
      envelope,
      checks,
    );

  prepareResourceTerminalRecords(
    state: Pick<RunProjection, "assignedById">,
    entries: readonly LogicalRecord<unknown>[],
  ): readonly LogicalRecord<unknown>[] {
    const bodies: readonly unknown[] = entries
      .filter((entry) => entry.stream === runStream(this.#conversationId))
      .map((entry) => entry.body);
    const committed = bodies.find(
      (body): body is Extract<ConversationRunJournalRecord, { t: "committed" }> =>
        isTaggedRecord(body, "committed"),
    );
    const cancelled = bodies.find(
      (
        body,
      ): body is Extract<
        ConversationRunJournalRecord,
        { t: "cancel-proof-accepted" }
      > => isTaggedRecord(body, "cancel-proof-accepted"),
    );
    const superseded = bodies.find(
      (
        body,
      ): body is Extract<
        ConversationRunJournalRecord,
        { t: "assignment-superseded" }
      > => isTaggedRecord(body, "assignment-superseded"),
    );
    const closedResolution = bodies.find(
      (
        body,
      ): body is Extract<ConversationRunJournalRecord, { t: "resolution" }> =>
        isTaggedRecord(body, "resolution") && body.fact.resolution !== undefined,
    );
    const failed = bodies.find(
      (body): body is Extract<ConversationRunJournalRecord, { t: "state" }> =>
        isTaggedRecord(body, "state") &&
        body.state === "failed" &&
        body.assignmentId !== undefined,
    );
    const assignmentId =
      committed?.assignmentId ??
      cancelled?.assignmentId ??
      superseded?.assignmentId ??
      closedResolution?.fact.subject.assignmentId ??
      failed?.assignmentId;
    if (!assignmentId) return [];
    const assigned = state.assignedById.get(assignmentId);
    if (!assigned) {
      throw corruptRunJournal("Resource terminal has no durable assignment");
    }
    const lease = requireAssignedEnvelope(assigned).resourceLease;
    if (!requiresFormalResourceCoordination(lease)) return [];
    if (!this.#resources) {
      throw corruptRunJournal(
        "Governed assignment has no resource coordinator",
      );
    }
    const mode = committed
      ? "settle-release"
      : cancelled
        ? cancelled.proof.decision === "not-started"
          ? "release"
          : "settle-release"
        : superseded
          ? "release"
          : failed?.usageFinal
            ? "settle-release"
            : "reclaim";
    return this.#resources.prepareTerminal({ lease, mode });
  }

  assertResourceTerminalRecords(
    assigned: {
      readonly assignmentId: string;
      readonly reservation: { readonly reservationId: string };
    },
    mode: "settle-release" | "release" | "reclaim",
    records: readonly LogicalRecord<unknown>[],
  ): void {
    if (
      !requiresFormalResourceCoordination({
        reservationId: assigned.reservation.reservationId,
        assignmentId: assigned.assignmentId,
      })
    ) {
      return;
    }
    if (!this.#resources) {
      throw corruptRunJournal(
        "Governed assignment has no resource coordinator",
      );
    }
    try {
      this.#resources.assertTerminalRecords({
        reservationId: assigned.reservation.reservationId,
        mode,
        records,
      });
    } catch (error) {
      throw corruptRunJournal(
        error instanceof Error
          ? `Assignment resource terminal is invalid: ${error.message}`
          : "Assignment resource terminal is invalid",
      );
    }
  }

  assertResourceUsageFinal(
    assigned: {
      readonly assignmentId: string;
      readonly executorId: string;
      readonly reservation: { readonly reservationId: string };
    },
    usageFinal: { readonly reportDigest: string; readonly upToUsageSeq: number },
  ): void {
    if (
      !requiresFormalResourceCoordination({
        reservationId: assigned.reservation.reservationId,
        assignmentId: assigned.assignmentId,
      })
    ) {
      return;
    }
    if (!this.#resources) {
      throw corruptRunJournal(
        "Governed assignment has no resource coordinator",
      );
    }
    try {
      this.#resources.assertUsageFinal({
        reservationId: assigned.reservation.reservationId,
        assignmentId: assigned.assignmentId,
        executorId: assigned.executorId,
        usageFinal,
      });
    } catch (error) {
      if (error instanceof AuthorityPreparationRequired) throw error;
      throw corruptRunJournal(
        error instanceof Error
          ? `Assignment final usage is invalid: ${error.message}`
          : "Assignment final usage is invalid",
      );
    }
  }

  async withPreparedState(check: () => void): Promise<void> {
    for (let rounds = 0; ; rounds++) {
      try {
        check();
        return;
      } catch (error) {
        if (rounds >= 64 || !(await awaitAuthorityPreparation(error))) {
          throw error;
        }
      }
    }
  }

  async appendPublishProgress(
    progress: Extract<PublishRecord, { t: "publish-progress" }>,
  ): Promise<void> {
    await this.#effectTransaction(
      { kind: "publish", assignments: [progress.assignmentId] },
      emptyPublishProjection,
      (state, record: LogicalRecord<PublishRecord>, envelope) =>
        reducePublishRecord(
          state,
          record,
          envelope,
          this.#artifacts,
          loadCommittedBundleBinding,
        ),
      (state) => {
        const current = state.progress.get(
          `${progress.assignmentId}\0${progress.domain}`,
        );
        if (
          state.completedAssignments.has(progress.assignmentId) ||
          (current &&
            (current.upToSeq > progress.upToSeq ||
              current.state === "settled" ||
              (current.upToSeq === progress.upToSeq &&
                current.state === progress.state)))
        ) {
          return { kind: "return", value: undefined };
        }
        return {
          kind: "append",
          entries: [{ stream: "publish", body: progress }],
          value: undefined,
        };
      },
    );
  }

  async selectPublish<Value>(
    select: (facts: PublishFacts) => Value,
    assignments?: readonly string[],
  ): Promise<Value> {
    return (
      await this.#effectTransaction(
        { kind: "publish", assignments },
        emptyPublishProjection,
        (state, record: LogicalRecord<PublishRecord>, envelope) =>
          reducePublishRecord(
            state,
            record,
            envelope,
            this.#artifacts,
            loadCommittedBundleBinding,
          ),
        (state) => ({ kind: "return", value: select(readPublishFacts(state)) }),
      )
    ).value;
  }

  async selectFinal<Value>(
    select: (facts: FinalOutboxFacts) => Value,
    publishedBefore?: number,
  ): Promise<Value> {
    return (
      await this.#effectTransaction(
        { kind: "final", publishedBefore },
        emptyFinalProjection,
        async (state, record: LogicalRecord<FinalOutboxRecord>, envelope) => {
          await applyFinalRecord(
            state,
            record.body,
            envelope.at,
            envelope,
            this.#artifacts,
            loadCommittedBundleBinding,
          );
          return state;
        },
        (state) => ({
          kind: "return",
          value: select(readFinalOutboxFacts(state)),
        }),
      )
    ).value;
  }

  async transitionFinal(
    frame: FinalFrame,
    expectedState: "pending" | "published",
    state: "published" | "expired",
    notAfter?: number,
  ): Promise<boolean> {
    return (
      await this.#effectTransaction(
        { kind: "final", frames: [frame] },
        emptyFinalProjection,
        async (
          projection,
          record: LogicalRecord<FinalOutboxRecord>,
          envelope,
        ) => {
          await applyFinalRecord(
            projection,
            record.body,
            envelope.at,
            envelope,
            this.#artifacts,
            loadCommittedBundleBinding,
          );
          return projection;
        },
        (projection) => {
          const current = projection.entries.get(finalKey(frame));
          if (
            !current ||
            current.record.state !== expectedState ||
            current.record.digest !== frame.digest ||
            (notAfter !== undefined &&
              canonicalTime(current.at, "Final outbox record time") > notAfter)
          ) {
            return { kind: "return", value: false };
          }
          return {
            kind: "append",
            entries: [
              { stream: "final-outbox", body: { ...current.record, state } },
            ],
            value: true,
          };
        },
      )
    ).value;
  }

  async #prepareWorkingSet(scope: ConversationDecisionScope) {
    if (
      scope.current === false &&
      (this.#readBaseGeneration !== 0 || this.#importedBaseSource)
    ) {
      scope = { ...scope, current: true };
    }
    return prepareConversationRunView({
      log: this.#log,
      artifacts: this.#artifacts,
      verifier: this.#verifier,
      conversationId: this.#conversationId,
      scope,
      previous: this.#runProjection?.state,
      legacy: this.#legacyAbortTickets,
      ...(this.#importedBaseSource
        ? { baseSource: this.#importedBaseSource }
        : {}),
    });
  }

  async #checkWorkingSet(
    context: ProjectionTransactionContext,
    version: string,
  ): Promise<void> {
    if (
      (await conversationWorkingVersion(
        context.readProjection(CONVERSATION_RUN_STATE_PROJECTION_ID),
        this.#conversationId,
      )) !== version
    ) {
      throw new ConversationWorkingSetChanged();
    }
  }

  async #restoreProjection(kind: JournalProjectionKind): Promise<void> {
    const key = this.#projectionCheckpointKey(kind);
    if (!key || this.#projectionOf(kind) || !this.#log.loadProjectionCheckpoint) {
      return;
    }
    const generation = this.#readBaseGeneration;
    let restored = await this.#log.loadProjectionCheckpoint<never>(key);
    let migrated = false;
    if (!restored && kind === "run") {
      const legacy = `${buildSemanticProjectionCheckpointPrefix("conversation-run-projection", 1, [this.#reduce, ...CONVERSATION_RUN_FINGERPRINT_FNS])}:${this.#conversationId}:${this.#ownerEpoch}`;
      restored = await this.#log.loadProjectionCheckpoint<never>(legacy);
      migrated = restored !== undefined;
      if (restored) {
        restored = {
          ...restored,
          state: compactLegacyRunProjection(
            restored.state as RunProjection,
          ) as never,
        };
      }
    }
    if (
      !restored ||
      this.#projectionOf(kind) ||
      this.#readBaseGeneration !== generation
    ) {
      return;
    }
    this.#setProjection(kind, restored);
    this.#checkpointedThrough.set(kind, migrated ? 0 : restored.cursor.lsn);
    if (migrated) await this.#saveProjection(kind, true);
  }

  #saveProjection(_kind: JournalProjectionKind, _force = false): undefined {
    return undefined;
  }

  #projectionCheckpointKey(kind: JournalProjectionKind): string | undefined {
    if (this.#readBaseGeneration !== 0) return undefined;
    let prefix = journalCheckpointPrefixes.get(kind);
    if (!prefix) {
      const reducers = {
        run: [this.#reduce, ...CONVERSATION_RUN_FINGERPRINT_FNS],
        submission: [
          this.#reduceSubmissionGuard,
          ...CONVERSATION_GUARD_FINGERPRINT_FNS,
        ],
      }[kind];
      prefix = buildSemanticProjectionCheckpointPrefix(
        `conversation-${kind}-projection`,
        kind === "run" ? 2 : 1,
        reducers,
      );
      journalCheckpointPrefixes.set(kind, prefix);
    }
    return `${prefix}:${this.#conversationId}:${this.#ownerEpoch}`;
  }

  #projectionOf(
    kind: JournalProjectionKind,
  ): { readonly state: unknown; readonly cursor: ProjectionCursor } | undefined {
    switch (kind) {
      case "run":
        return this.#runProjection;
      case "submission":
        return this.#submissionGuardProjection;
    }
  }

  #setProjection(
    kind: JournalProjectionKind,
    value: { readonly state: never; readonly cursor: ProjectionCursor },
  ): void {
    switch (kind) {
      case "run":
        this.#runProjection = value;
        return;
      case "submission":
        this.#submissionGuardProjection = value;
        return;
    }
  }

  async #selectLegacy<Value>(
    select: (state: RunProjection) => Value,
  ): Promise<Value> {
    const abort = currentMaintenanceAbortSignal();
    let retryDeadline: number | undefined;
    for (;;) {
      if (abort.aborted) throw new StorageMaintenanceCancelledError();
      let selecting = false;
      try {
        return await this.#operations.run(async () => {
          await this.#restoreProjection("run");
          const cached = this.#runProjection;
          let draft = cached
            ? createConversationProjectionDraft(cached.state)
            : undefined;
          const replay = async () =>
            this.#log.readProjection<RunProjection, unknown>(
              draft?.state ?? emptyConversationRunProjection(this.#conversationId),
              this.reduceRunProjection,
              {
                stream: runStream(this.#conversationId),
                createState: () => {
                  draft = cached
                    ? createConversationProjectionDraft(cached.state)
                    : undefined;
                  return (
                    draft?.state ??
                    emptyConversationRunProjection(this.#conversationId)
                  );
                },
                ...(cached ? { cursor: cached.cursor } : {}),
              },
            );
          const transaction = await (this.#resources
            ? this.#resources.coordinate(replay, {
                readOnly: true,
                caller: "conversation-journal.legacy-read",
              })
            : replay());
          if (abort.aborted) throw new StorageMaintenanceCancelledError();
          this.#runProjection = {
            state:
              draft && transaction.state === draft.state
                ? draft.finish()
                : transaction.state,
            cursor: transaction.cursor,
          };
          this.#saveProjection("run");
          selecting = true;
          return select(transaction.state);
        });
      } catch (error) {
        const delay = maintenanceRetryDelayMs(error);
        if (
          selecting ||
          delay === undefined ||
          isHoldingMaintenanceExclusion() ||
          abort.aborted
        ) {
          throw error;
        }
        if (await awaitAuthorityPreparation(error)) continue;
        retryDeadline ??= performance.now() + 5_000;
        const remaining = retryDeadline - performance.now();
        if (remaining <= 0) throw error;
        await waitForMaintenanceRetry(Math.min(delay, remaining));
      }
    }
  }

  async #withRunProjectionLegacy<Value>(
    operation: (
      basis:
        | {
            readonly state: RunProjection;
            readonly cursor: ProjectionCursor;
            readonly createState: () => RunProjection;
          }
        | undefined,
      publish: (state: RunProjection, cursor: ProjectionCursor) => void,
    ) => Promise<Value>,
  ): Promise<Value> {
    return this.#operations.run(async () => {
      await this.#restoreProjection("run");
      const cached = this.#runProjection;
      let draft = cached
        ? createConversationProjectionDraft(cached.state)
        : undefined;
      let candidate =
        cached && draft
          ? { state: draft.state, cursor: cached.cursor }
          : undefined;
      const basis = candidate && {
        ...candidate,
        createState: () => {
          draft = cached
            ? createConversationProjectionDraft(cached.state)
            : undefined;
          return (
            draft?.state ?? emptyConversationRunProjection(this.#conversationId)
          );
        },
      };
      const value = await operation(basis, (state, cursor) => {
        candidate = { state, cursor };
      });
      if (candidate && draft && candidate.state === draft.state) {
        candidate = { ...candidate, state: draft.finish() };
      }
      this.#runProjection = candidate;
      this.#saveProjection("run");
      return value;
    });
  }

  async #transactLegacy<Value>(
    decide: (
      state: RunProjection,
      authorityPrefix: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<unknown, Value>
      | Promise<ProjectionTransactionDecision<unknown, Value>>,
    candidateReferences: readonly ArtifactRef[] = [],
    readProjectionIds: readonly string[] = [],
  ) {
    return this.#operations.run(async () => {
      await this.#restoreProjection("run");
      const cached = this.#runProjection;
      let draft = cached
        ? createConversationProjectionDraft(cached.state)
        : undefined;
      try {
        const runTransaction = () =>
          this.#log.transactProjection<RunProjection, unknown, Value>(
            draft?.state ?? emptyConversationRunProjection(this.#conversationId),
            this.reduceRunProjection,
            async (state, context) => {
              if (this.#currentAuthority) {
                await assertConversationTransferWriteAuthority(
                  context.readProjection(CONVERSATION_TRANSFER_PROJECTION_ID),
                  this.#conversationId,
                  {
                    deviceId: this.#currentAuthority.deviceId,
                    ownerEpoch: this.#ownerEpoch,
                  },
                  await conversationAnchorAtPrefix(this.#log, context),
                );
              }
              const decision = await decide(state, context);
              if (decision.kind !== "append") return decision;
              const statuses = conversationStatusDeliveryInputs(
                this.#conversationId,
                state,
                decision.entries,
                context.at,
              );
              const prepared =
                (await this.#delivery?.prepareConversationStatuses(
                  statuses,
                  context,
                  decision.entries,
                )) ?? {
                  accepted: true as const,
                  records: [],
                  stagedRevisions: new Map(),
                  stagedConflicts: new Map(),
                };
              if (!prepared.accepted) {
                throw corruptRunJournal(prepared.error.message);
              }
              const resourceRecords = this.prepareResourceTerminalRecords(
                state,
                decision.entries,
              );
              return {
                ...decision,
                entries: [
                  ...resourceRecords,
                  ...decision.entries,
                  ...prepared.records,
                ],
              };
            },
            {
              stream: runStream(this.#conversationId),
              createState: () => {
                draft = cached
                  ? createConversationProjectionDraft(cached.state)
                  : undefined;
                return (
                  draft?.state ??
                  emptyConversationRunProjection(this.#conversationId)
                );
              },
              ...(cached ? { cursor: cached.cursor } : {}),
              candidateReferences,
              readProjectionIds: [
                ...new Set([
                  ...this.deliveryProjectionIds(),
                  ...readProjectionIds,
                  ...(this.#currentAuthority
                    ? [
                        CONVERSATION_TRANSFER_PROJECTION_ID,
                        ...conversationAnchorProjectionIds(this.#log),
                      ]
                    : []),
                ]),
              ],
            },
          );
        const transact = () =>
          this.#delivery
            ? this.#delivery.coordinate(runTransaction)
            : runTransaction();
        const transaction = await (this.#resources
          ? this.#resources.coordinate(transact, {
              caller: "conversation-journal.legacy",
            })
          : transact());
        this.#runProjection = {
          state:
            draft && transaction.state === draft.state
              ? draft.finish()
              : transaction.state,
          cursor: transaction.cursor,
        };
        this.#saveProjection("run");
        if (transaction.commit) {
          this.#publishStatusNotices(
            conversationStatusNoticesForCommit(
              readConversationDecisionFacts(transaction.state).assignment,
              transaction.commit,
              this.#conversationId,
              this.#ownerEpoch,
            ),
          );
        }
        return transaction;
      } catch (error) {
        this.#runProjection = cached;
        throw error;
      }
    });
  }

  async #effectTransaction<State extends object, Body, Value>(
    selection: ConversationEffectSelection,
    create: () => State,
    reduce: (
      state: State,
      record: LogicalRecord<Body>,
      envelope: ConversationFactGroup<Body>,
    ) => State | Promise<State>,
    decide: (
      state: State,
      context: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<Body, Value>
      | Promise<ProjectionTransactionDecision<Body, Value>>,
  ) {
    const abort = currentMaintenanceAbortSignal();
    let retryDeadline: number | undefined;
    for (;;) {
      if (abort.aborted) throw new StorageMaintenanceCancelledError();
      try {
        const prepared = await prepareConversationEffects(
          this.#log,
          this.#artifacts,
          this.#conversationId,
          selection,
        );
        let initial = create();
        for (const envelope of prepared.groups) {
          for (const record of envelope.entries) {
            if (abort.aborted) throw new StorageMaintenanceCancelledError();
            if (prepared.includes(record.stream, record.body)) {
              initial = await reduce(
                initial,
                record as LogicalRecord<Body>,
                envelope as ConversationFactGroup<Body>,
              );
            }
          }
        }
        return await this.#operations.run(async () => {
          let candidateLsn: number | undefined;
          return this.#log.transactProjection<State, Body, Value>(
            initial,
            (state, record, envelope) => {
              if (envelope.lsn !== candidateLsn) return state;
              if (!prepared.includes(record.stream, record.body)) {
                throw corruptRunJournal(
                  "Effect decision changed its prepared subject",
                );
              }
              return reduce(state, record, envelope);
            },
            async (state, context) => {
              if (
                (await conversationRecoveryVersion(
                  context.readProjection(CONVERSATION_RECOVERY_PROJECTION_ID),
                  this.#conversationId,
                )) !== prepared.version
              ) {
                throw new ConversationWorkingSetChanged();
              }
              candidateLsn = context.nextLsn;
              return decide(state, context);
            },
            {
              cursor: prepared.cursor,
              stream: selection.kind === "publish" ? "publish" : "final-outbox",
              readProjectionIds: [CONVERSATION_RECOVERY_PROJECTION_ID],
              createState: () => {
                candidateLsn = undefined;
                return createConversationProjectionDraft(initial).state;
              },
            },
          );
        });
      } catch (error) {
        const delay =
          error instanceof ConversationWorkingSetChanged
            ? 0
            : maintenanceRetryDelayMs(error);
        if (
          delay === undefined ||
          isHoldingMaintenanceExclusion() ||
          abort.aborted
        ) {
          throw error;
        }
        if (await awaitAuthorityPreparation(error)) continue;
        retryDeadline ??= performance.now() + 5_000;
        if (performance.now() >= retryDeadline) throw error;
        if (delay) {
          await waitForMaintenanceRetry(
            Math.min(delay, retryDeadline - performance.now()),
          );
        } else {
          await new Promise<void>(setImmediate);
        }
      }
    }
  }
}
