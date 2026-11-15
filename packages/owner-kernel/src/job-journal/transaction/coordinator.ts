import { Buffer } from "node:buffer";
import {
  AuthorityPreparationRequired,
  awaitAuthorityPreparation,
  type ArtifactStore,
  type AuthorityCommitLog,
  type DurableProjectionReadContext,
  type ProjectionCursor,
  type ProjectionTransactionContext,
  type ProjectionTransactionDecision,
  type RebuildableDurableProjectionIndex,
} from "@zhixing-ai/core/authority";
import type {
  ArtifactRef,
  AuthorityCallContext,
  CommitEnvelope,
  ControlResult,
  JobStatusNotice,
  LogicalRecord,
  SealedBundle,
} from "@zhixing-ai/core/contracts";
import {
  DELIVERY_AUTHORITY_PROJECTION_ID,
  registerDeliveryAuthorityProjection,
} from "@zhixing-ai/core/delivery";
import { SerialTaskQueue } from "@zhixing-ai/core/persistence";
import {
  requiresFormalResourceCoordination,
  validateJobSealedBundle,
  verifyProtocolStep,
  type ProtocolSignatureVerifier,
} from "@zhixing-ai/core/protocol";
import {
  currentMaintenanceAbortSignal,
  isHoldingMaintenanceExclusion,
  maintenanceRetryDelayMs,
  StorageMaintenanceCancelledError,
  waitForMaintenanceRetry,
} from "@zhixing-ai/core/resources";
import {
  DEFAULT_SCHEDULE_FAILURE_THRESHOLD,
  decideScheduleCapabilityGapClosure,
  scheduleFailurePolicyForCount,
  ScheduleRuntimePolicyError,
  type ScheduleFailurePolicyDecision,
} from "@zhixing-ai/core/scheduler/application";
import type {
  AtomicControlApplicationContext,
  ControlAdmissionJournal,
  ControlAdmissionOutcome,
  JobControlEnvelope,
  TrustedControlSource,
} from "../../control-admission.js";
import type { ConversationAbortTicketAuthorizer } from "../../conversation-journal/contracts.js";
import type { JobDeliveryParticipant } from "../../delivery-participant.js";
import {
  failuresBefore,
  requireFailureSummaryPaths,
} from "../../job-failure-summary.js";
import {
  corruptJobJournal,
  type JobJournalRecord,
} from "../../job-run-contracts.js";
import {
  JobStateBinding,
  JobStateExhausted,
  JobStateRequired,
  JobStateSet,
  loadJobState,
  MAX_JOB_STATE_ROUNDS,
  runWithJobState,
  tallyJobStateNeeds,
} from "../../job-run-state.js";
import {
  JOB_RUN_STATE_PROJECTION_ID,
  jobStateHeadKey,
  registerJobRunStateProjection,
} from "../../job-run-state-index.js";
import type { AssignmentResourceCoordinator } from "../../resource-governor.js";
import {
  SCHEDULER_NOTICE_STREAM,
  type SchedulerUserNoticeJournal,
} from "../../scheduler-user-notices.js";
import type {
  AssignmentSubmissionAuthorization,
  AssignmentSubmissionAuthorizer,
  AssignmentSubmissionIdentity,
} from "../../shared-protocol/contracts.js";
import {
  assertSubmissionContextIdentity,
  assertSubmissionGuardActivatedCapability,
  authenticateAssignmentSubmission,
  authorizeAssignmentSubmissionCapability,
  hasCurrentSubmissionAuthority,
  type SubmissionAuthorityTarget,
} from "../../shared-protocol/submission-authorization.js";
import {
  createJobGuardState,
  createJobMainState,
  failureSummaryCandidates,
  JOB_MAIN_SUBJECTS,
  jobProjectionView,
  jobScopeOf,
  jobSubmissionGuardView,
  MAX_JOB_SESSION_ROWS,
  preloadJobScope,
  scopeKeys,
  type JobJournalSession,
  type JobLifecycleEvent,
  type JobProjection,
  type JobScope,
  type SystemJobResourceCoordinator,
} from "../contracts.js";
import {
  jobLifecycleEventsForCommit,
  jobStatusDeliveryInputs,
  jobStatusNoticesForCommit,
} from "../replay/bundle-closure.js";
import { JobReduction } from "../replay/reduction.js";
import {
  assertPositive,
  isTaggedJobRecord,
  isTerminal,
  jobRecord,
  jobStream,
  revokedCapabilityKey,
} from "../state/common.js";
import {
  candidateStateNeeds,
  jobStreamBodies,
} from "../state/directories-failure-summary.js";
import {
  readJobDecisionFacts,
  readJobGuardDecisionFacts,
  type JobDecisionFacts,
  type JobGuardDecisionFacts,
} from "../state/views.js";

export interface JobTransactionCoordinatorOptions {
  readonly taskId: string;
  readonly anchorEpoch: number;
  readonly log: AuthorityCommitLog;
  readonly artifacts: ArtifactStore;
  readonly verifier: ProtocolSignatureVerifier;
  readonly submission: AssignmentSubmissionAuthorizer;
  readonly legacyAbortTickets?: ConversationAbortTicketAuthorizer;
  readonly delivery: JobDeliveryParticipant;
  readonly resources?: AssignmentResourceCoordinator;
  readonly systemResources?: SystemJobResourceCoordinator;
  readonly clock: () => string;
  readonly schedulerFailureThreshold?: number;
  readonly schedulerNotices?: SchedulerUserNoticeJournal;
  readonly localExecutorId?: string;
}

export class JobTransactionCoordinator {
  readonly #taskId: string;
  readonly #anchorEpoch: number;
  readonly #log: AuthorityCommitLog;
  readonly #artifacts: ArtifactStore;
  readonly #verifier: ProtocolSignatureVerifier;
  readonly #submission: AssignmentSubmissionAuthorizer;
  readonly #delivery: JobDeliveryParticipant;
  readonly #resources: AssignmentResourceCoordinator | undefined;
  readonly #systemResources: SystemJobResourceCoordinator | undefined;
  readonly #clock: () => string;
  readonly #schedulerFailureThreshold: number;
  readonly #schedulerNotices: SchedulerUserNoticeJournal | undefined;
  readonly #reduction: JobReduction;
  readonly #operations = new SerialTaskQueue();
  readonly #statusListeners = new Set<
    (notice: JobStatusNotice) => void | Promise<void>
  >();
  readonly #lifecycleListeners = new Set<
    (event: JobLifecycleEvent) => void | Promise<void>
  >();
  readonly #index: RebuildableDurableProjectionIndex;
  readonly #authorityTarget: SubmissionAuthorityTarget;
  #session: JobJournalSession | undefined;

  constructor(options: JobTransactionCoordinatorOptions) {
    this.#taskId = options.taskId;
    this.#anchorEpoch = options.anchorEpoch;
    this.#log = options.log;
    this.#artifacts = options.artifacts;
    this.#verifier = options.verifier;
    this.#submission = options.submission;
    this.#delivery = options.delivery;
    // 入队在本日志的源事务里按同一前缀读投递投影：本日志实例上须登记它（同定义重复登记即复用）
    registerDeliveryAuthorityProjection(options.log);
    this.#resources = options.resources;
    this.#systemResources = options.systemResources;
    this.#clock = options.clock;
    this.#schedulerFailureThreshold =
      options.schedulerFailureThreshold ?? DEFAULT_SCHEDULE_FAILURE_THRESHOLD;
    this.#schedulerNotices = options.schedulerNotices;
    this.#reduction = new JobReduction({
      taskId: this.#taskId,
      anchorEpoch: this.#anchorEpoch,
      artifacts: this.#artifacts,
      verifier: this.#verifier,
      delivery: this.#delivery,
      ...(options.legacyAbortTickets
        ? { legacyAbortTickets: options.legacyAbortTickets }
        : {}),
      ...(this.#resources ? { resources: this.#resources } : {}),
      ...(this.#systemResources
        ? { systemResources: this.#systemResources }
        : {}),
      ...(options.localExecutorId
        ? { localExecutorId: options.localExecutorId }
        : {}),
    });
    const services = this.#reduction;
    this.#index = registerJobRunStateProjection(this.#log, (taskId) =>
      services.forTask(taskId),
    );
    assertPositive(
      this.#schedulerFailureThreshold,
      "Scheduler failure threshold",
    );
    this.#authorityTarget = {
      domain: "job",
      taskId: this.#taskId,
      currentAnchorEpoch: this.#anchorEpoch,
    };
  }

  get taskId(): string {
    return this.#taskId;
  }

  onStatus(
    listener: (notice: JobStatusNotice) => void | Promise<void>,
  ): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onLifecycle(
    listener: (event: JobLifecycleEvent) => void | Promise<void>,
  ): () => void {
    this.#lifecycleListeners.add(listener);
    return () => this.#lifecycleListeners.delete(listener);
  }

  assertAssignmentUsageFinal(
    assigned: Extract<JobJournalRecord, { t: "assigned" }>,
    usageFinal: { readonly reportDigest: string; readonly upToUsageSeq: number },
  ): void {
    this.#reduction.assertAssignmentUsageFinal(assigned, usageFinal);
  }

  authenticateSubmission(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): void {
    authenticateAssignmentSubmission(
      this.#submission,
      context,
      identity,
      "job",
    );
  }

  hasCurrentSubmissionAuthority(context: AuthorityCallContext): boolean {
    return hasCurrentSubmissionAuthority(context, this.#authorityTarget);
  }

  authorizeGuardSubmission(
    guard: JobGuardDecisionFacts,
    context: AuthorityCallContext,
    authorization: AssignmentSubmissionAuthorization,
  ): void {
    const assigned = guard.getAssigned(authorization.assignmentId);
    authorizeAssignmentSubmissionCapability({
      submission: this.#submission,
      target: this.#authorityTarget,
      context,
      authorization,
      assigned: assigned
        ? {
            assignmentId: assigned.record.assignmentId,
            executorId: assigned.record.executorId,
            capIds: assigned.capIds,
            epoch: assigned.record.anchorEpoch,
          }
        : undefined,
      isCapabilityRevoked: (capId) =>
        guard.isCapabilityRevoked(authorization.assignmentId, capId),
      verifier: this.#verifier,
      now: this.#clock(),
      checkEnvelopeMatch: false,
    });
  }

  authorizeSubmission(
    facts: Pick<JobDecisionFacts, "assignment">,
    context: AuthorityCallContext,
    authorization: AssignmentSubmissionAuthorization,
  ): void {
    const assigned = facts.assignment.getAssigned(authorization.assignmentId);
    authorizeAssignmentSubmissionCapability({
      submission: this.#submission,
      target: this.#authorityTarget,
      context,
      authorization,
      assigned: assigned
        ? {
            assignmentId: assigned.record.assignmentId,
            executorId: assigned.record.executorId,
            capIds: assigned.record.capIds,
            epoch: assigned.record.anchorEpoch,
            envelope: assigned.envelope as {
              readonly capabilities: readonly { readonly capId: string }[];
            },
          }
        : undefined,
      isCapabilityRevoked: (capId) =>
        facts.assignment.isCapabilityRevoked(
          authorization.assignmentId,
          capId,
        ),
      verifier: this.#verifier,
      now: this.#clock(),
      checkEnvelopeMatch: true,
    });
  }

  async loadSubmissionGuard(
    context: AuthorityCallContext,
    identity: AssignmentSubmissionIdentity,
  ): Promise<JobGuardDecisionFacts> {
    assertSubmissionContextIdentity(context, identity, "job");
    return this.repeatState(() =>
      this.#operations.run(async () => {
        const read = () =>
          this.#log.transactDurableProjection<never, JobStateSet>(
            JOB_RUN_STATE_PROJECTION_ID,
            async (view) => {
              const session = await this.#sessionAt(view);
              // 提交守卫只按这一派发与它的 run 读取，不重放作业流
              await preloadJobScope(
                { guard: session.guard },
                jobScopeOf({ assignmentId: identity.assignmentId }),
                view,
              );
              const binding = new JobStateBinding(session.guard);
              // 守卫的使用者会读的行一并在锁内装入：派发、它的 run、提交与冲突、本能力的撤销
              await runWithJobState(
                [[binding, session.guard]],
                view,
                () => {
                  const guard = jobSubmissionGuardView(binding);
                  const assigned = guard.assignedById.get(identity.assignmentId);
                  guard.committedByAssignment.has(identity.assignmentId);
                  guard.openConflictAssignments.has(identity.assignmentId);
                  if (context.principal.kind === "assignment") {
                    guard.revokedCapabilities.has(
                      revokedCapabilityKey(
                        identity.assignmentId,
                        context.principal.capability.capId,
                      ),
                    );
                  }
                  if (!assigned) return;
                  guard.occurrences.has(assigned.record.jobRunId);
                  guard.states.get(assigned.record.jobRunId);
                  guard.assignmentByJob.get(assigned.record.jobRunId);
                },
              );
              return { kind: "return", value: session.guard };
            },
          );
        const transaction = await (this.#resources
          ? this.#resources.coordinate(read, { readOnly: true })
          : read());
        // 守卫是只读视图：之后读到未装入的行时抛出待装入，由调用方在锁外装入后重来
        const guard = jobSubmissionGuardView(
          new JobStateBinding(transaction.value),
        );
        const guardFacts = readJobGuardDecisionFacts(guard);
        if (context.principal.kind !== "assignment") return guardFacts;
        const assigned = guard.assignedById.get(identity.assignmentId);
        await verifyProtocolStep(() =>
          assertSubmissionGuardActivatedCapability({
            target: this.#authorityTarget,
            context,
            identity,
            assigned: assigned
              ? {
                  assignmentId: assigned.record.assignmentId,
                  executorId: assigned.record.executorId,
                  capIds: assigned.record.capIds,
                  epoch: assigned.record.anchorEpoch,
                }
              : undefined,
            verifier: this.#verifier,
            now: this.#clock(),
            checkEnvelopeMatch: false,
          }),
        );
        return guardFacts;
      }),
    );
  }

  /**
   * 在本作业的串行队列之外重做：工作集缺的行装入后重来；持久投影仍在准备时等它完成；
   * 暂时的容量背压在有限窗口内重试。持有别的互斥区时不在这里等待，交给外层所有者重驱。
   */
  async repeatState<Value>(operation: () => Promise<Value>): Promise<Value> {
    const abort = currentMaintenanceAbortSignal();
    let deadline: number | undefined;
    // 缺键装入的轮数单独计：准备等待与背压重试不占用它
    let loads = 0;
    const loaded: Record<string, number> = {};
    for (;;) {
      if (abort.aborted) throw new StorageMaintenanceCancelledError();
      try {
        return await operation();
      } catch (error) {
        if (error instanceof JobStateRequired && error.prepareOutside) {
          // 装了上限轮仍缺即耗尽：不再交给外层准备循环原样重开
          if (loads >= MAX_JOB_STATE_ROUNDS) {
            throw new JobStateExhausted(
              "rounds",
              loads + 1,
              loaded,
              error.needs,
            );
          }
          loads += 1;
          tallyJobStateNeeds(error.needs, loaded);
          await error.prepareOutside();
          continue;
        }
        if (await awaitAuthorityPreparation(error)) continue;
        const delay = maintenanceRetryDelayMs(error);
        if (
          delay === undefined ||
          isHoldingMaintenanceExclusion() ||
          abort.aborted
        ) {
          throw error;
        }
        deadline ??= performance.now() + 5_000;
        if (performance.now() >= deadline) throw error;
        await waitForMaintenanceRetry(
          Math.min(delay, deadline - performance.now()),
        );
      }
    }
  }

  async select<Value>(
    decide: (facts: JobDecisionFacts) => Value,
    scope?: JobScope,
  ): Promise<Value> {
    return this.repeatState(() =>
      this.#operations.run(async () => {
        const read = () =>
          this.#log.transactDurableProjection<never, Value>(
            JOB_RUN_STATE_PROJECTION_ID,
            async (view) => {
              const session = await this.#sessionAt(view);
              if (scope) {
                await preloadJobScope({ main: session.main }, scope, view);
              }
              const binding = new JobStateBinding(session.main);
              // 读取不改动工作集：成功后已装入的行留在会话里，尝试用的复制直接丢弃
              const value = await runWithJobState(
                [[binding, session.main]],
                view,
                () => decide(readJobDecisionFacts(jobProjectionView(binding))),
              );
              return { kind: "return", value };
            },
          );
        const result = await (this.#resources
          ? this.#resources.coordinate(read, { readOnly: true })
          : read());
        return result.value;
      }),
    );
  }

  async transact<Value>(
    decide: (
      facts: JobDecisionFacts,
      prefix: ProjectionTransactionContext,
    ) =>
      | ProjectionTransactionDecision<unknown, Value>
      | Promise<ProjectionTransactionDecision<unknown, Value>>,
    candidateReferences: readonly ArtifactRef[] = [],
    readProjectionIds: readonly string[] = [],
    scope?: JobScope,
  ): Promise<{ readonly value: Value; readonly facts: JobDecisionFacts }> {
    const transaction = await this.repeatState(() =>
      this.#operations.run(async () => {
        const cursor = await this.#headCursor();
        const binding = new JobStateBinding(createJobMainState(this.#taskId));
        const state = jobProjectionView(binding);
        const facts = readJobDecisionFacts(state);
        let session: JobJournalSession | undefined;
        let candidateLsn: number | undefined;
        const transact = () =>
          this.#delivery.coordinate(() =>
            this.#log.transactProjection<JobProjection, unknown, Value>(
              state,
              // 工作集取自同一锁内的持久投影：游标之后的尾部不再重放，只归约本次候选
              (current, record, envelope) =>
                envelope.lsn === candidateLsn
                  ? this.#reduce(current, record, envelope)
                  : current,
              async (_current, context) => {
                const view = context.readProjection(
                  JOB_RUN_STATE_PROJECTION_ID,
                );
                const active = (session = await this.#sessionAt(view));
                await preloadJobScope(
                  { main: active.main },
                  scope ?? jobScopeOf(),
                  view,
                );
                candidateLsn = context.nextLsn;
                return runWithJobState(
                  [[binding, active.main]],
                  view,
                  async () => {
                    const decision = await decide(facts, context);
                    if (decision.kind !== "append") return decision;
                    const resourceRecords =
                      this.#prepareAssignmentResourceTerminalRecords(
                        state,
                        decision.entries,
                      );
                    const policyRecords =
                      await this.#prepareSchedulerPolicyRecords(
                        state,
                        decision.entries,
                        context.at,
                        context,
                      );
                    const statuses = jobStatusDeliveryInputs(
                      this.#taskId,
                      state,
                      decision.entries,
                      context.at,
                    );
                    const prepared = await this.#delivery.prepareJobStatuses(
                      statuses,
                      context,
                      [...decision.entries, ...policyRecords],
                    );
                    if (!prepared.accepted) {
                      throw corruptJobJournal(prepared.error.message);
                    }
                    const entries = [
                      ...resourceRecords,
                      ...decision.entries,
                      ...policyRecords,
                      ...prepared.records,
                    ];
                    // 候选归约要读的行在锁内一并装入，免得归约时才缺而整笔事务重来
                    const needs = candidateStateNeeds(
                      active.main,
                      entries,
                      this.#taskId,
                    );
                    if (needs.length) throw new JobStateRequired(needs);
                    // 候选会改动连续失败摘要时，它的定位路径也在锁内按层装入
                    requireFailureSummaryPaths(
                      state,
                      failureSummaryCandidates(
                        state,
                        jobStreamBodies(entries, this.#taskId),
                      ),
                    );
                    return { ...decision, entries };
                  },
                );
              },
              {
                stream: jobStream(this.#taskId),
                cursor,
                candidateReferences,
                readProjectionIds: [
                  ...new Set([
                    JOB_RUN_STATE_PROJECTION_ID,
                    DELIVERY_AUTHORITY_PROJECTION_ID,
                    ...readProjectionIds,
                  ]),
                ],
                createState: () => {
                  candidateLsn = undefined;
                  return state;
                },
              },
            ),
          );
        const coordinateSystem = () =>
          this.#systemResources
            ? this.#systemResources.coordinate(transact)
            : transact();
        const sameCoordinator =
          this.#resources !== undefined &&
          (this.#resources as unknown) === (this.#systemResources as unknown);
        const committed = await (sameCoordinator
          ? this.#resources!.coordinate(transact)
          : this.#resources
            ? this.#resources.coordinate(coordinateSystem)
            : coordinateSystem());
        if (session && this.#session === session) {
          if (committed.commit) {
            // 提交后的主投影工作集正是持久归约写下的行：采纳并作为新的基准；守卫另由持久投影更新，换新
            session.main.adopt(binding.store);
            session.main.settle();
            session.guard = this.#loadableSet("guard");
            session.head = committed.commit.lsn;
          }
          session.cursor = committed.cursor;
        }
        return committed;
      }),
    );
    // 提交已持久：通知只读候选归约装入过的行，不再重做事务
    if (transaction.commit) {
      this.#publishStatusNotices(
        jobStatusNoticesForCommit(
          transaction.state,
          transaction.commit,
          this.#taskId,
          this.#anchorEpoch,
        ),
      );
      this.#publishLifecycleEvents(
        jobLifecycleEventsForCommit(
          transaction.state,
          transaction.commit,
          this.#taskId,
          this.#anchorEpoch,
        ),
      );
      await this.#schedulerNotices?.publishNew();
    }
    return {
      value: transaction.value,
      facts: readJobDecisionFacts(transaction.state),
    };
  }

  async applyControlTransaction(input: {
    readonly admission: ControlAdmissionJournal;
    readonly envelope: JobControlEnvelope;
    readonly source: TrustedControlSource;
    readonly decide: (
      facts: JobDecisionFacts,
      context: AtomicControlApplicationContext<JobControlEnvelope>,
    ) => {
      readonly result: ControlResult;
      readonly authorityEntries?: readonly LogicalRecord<unknown>[];
    };
  }): Promise<ControlAdmissionOutcome> {
    // 控制目标的工作集取自同一锁内的持久投影：只归约本次候选，不重放作业流；
    // 锁外装入的行在重做之间保留
    const base = createJobMainState(this.#taskId);
    base.bindLoader((needs) => loadJobState(base, needs, this.#index));
    const binding = new JobStateBinding(base);
    const target = jobProjectionView(binding);
    const facts = readJobDecisionFacts(target);
    const scope = jobScopeOf(input.envelope.body);
    const outcome = await this.repeatState(async () => {
      await input.admission.prepareRecovery();
      const cursor = await this.#headCursor();
      return this.#delivery.coordinate(() =>
        input.admission.applyAuthority<JobProjection, JobControlEnvelope>({
          envelope: input.envelope,
          source: input.source,
          stream: jobStream(this.#taskId),
          initial: target,
          onProjected: () => undefined,
          targetBase: {
            state: target,
            cursor,
            createState: () => target,
            readProjectionIds: [
              JOB_RUN_STATE_PROJECTION_ID,
              DELIVERY_AUTHORITY_PROJECTION_ID,
            ],
            validateAtPrefix: async (context) => {
              await preloadJobScope(
                { main: base },
                scope,
                context.readProjection(JOB_RUN_STATE_PROJECTION_ID),
              );
            },
          },
          reducer: (state, record, commit) =>
            this.#reduce(state, record, commit),
          companionStreams: [
            "delivery",
            "governor",
            ...(this.#schedulerNotices ? [SCHEDULER_NOTICE_STREAM] : []),
          ],
          prepareCompanions: async (state, context, plan) => {
            const statuses = jobStatusDeliveryInputs(
              this.#taskId,
              state,
              plan.authorityEntries ?? [],
              context.authorityPrefix.at,
            );
            const prepared = await this.#delivery.prepareJobStatuses(
              statuses,
              context.authorityPrefix,
              plan.authorityEntries ?? [],
            );
            if (!prepared.accepted) {
              throw corruptJobJournal(prepared.error.message);
            }
            return [
              ...(await this.#prepareCapabilityGapClosureRecords(
                state,
                plan.authorityEntries ?? [],
                context.authorityPrefix.at,
                context.authorityPrefix,
                [...(plan.authorityEntries ?? []), ...prepared.records],
              )),
              ...prepared.records,
            ];
          },
          onCommitted: (state, commit) => {
            this.#publishStatusNotices(
              jobStatusNoticesForCommit(
                state,
                commit,
                this.#taskId,
                this.#anchorEpoch,
              ),
            );
            this.#publishLifecycleEvents(
              jobLifecycleEventsForCommit(
                state,
                commit,
                this.#taskId,
                this.#anchorEpoch,
              ),
            );
          },
          decide: (_state, context) =>
            runWithJobState(
              [[binding, base]],
              context.authorityPrefix.readProjection(
                JOB_RUN_STATE_PROJECTION_ID,
              ),
              () => input.decide(facts, context),
            ),
        }),
      );
    });
    await this.#schedulerNotices?.publishNew();
    return outcome;
  }

  readonly #reduce = (
    state: JobProjection,
    raw: LogicalRecord<unknown>,
    envelope: CommitEnvelope<unknown>,
  ): Promise<JobProjection> => this.#reduction.reduce(state, raw, envelope);

  async #sessionAt(
    view: DurableProjectionReadContext,
  ): Promise<JobJournalSession> {
    const head = (await view.get(jobStateHeadKey(this.#taskId))) as
      | number
      | undefined;
    const current = this.#session;
    if (
      current &&
      current.head === head &&
      current.main.loadedRows + current.guard.loadedRows < MAX_JOB_SESSION_ROWS
    ) {
      return current;
    }
    const session: JobJournalSession = {
      main: this.#loadableSet("main"),
      guard: this.#loadableSet("guard"),
      head,
      cursor: current?.cursor,
    };
    this.#session = session;
    return session;
  }

  #loadableSet(kind: "main" | "guard"): JobStateSet {
    const set =
      kind === "main"
        ? createJobMainState(this.#taskId)
        : createJobGuardState(this.#taskId);
    set.bindLoader((needs) => loadJobState(set, needs, this.#index));
    return set;
  }

  async #headCursor(): Promise<ProjectionCursor> {
    const cursor = this.#session?.cursor;
    if (cursor) return cursor;
    return (
      await this.#log.transactDurableProjection<never, undefined>(
        JOB_RUN_STATE_PROJECTION_ID,
        async () => ({ kind: "return", value: undefined }),
      )
    ).cursor;
  }

  #prepareAssignmentResourceTerminalRecords(
    state: JobProjection,
    entries: readonly LogicalRecord<unknown>[],
  ): readonly LogicalRecord<unknown>[] {
    const bodies = entries
      .filter((entry) => entry.stream === jobStream(this.#taskId))
      .map((entry) => entry.body)
      .filter(isTaggedJobRecord);
    const committed = bodies.find((body) => body.t === "committed");
    const cancelled = bodies.find((body) => body.t === "cancel-proof-accepted");
    const superseded = bodies.find(
      (body) => body.t === "assignment-superseded",
    );
    const closedResolution = bodies.find(
      (body) => body.t === "resolution" && body.fact.resolution !== undefined,
    );
    const failed = bodies.find(
      (body) =>
        body.t === "state" &&
        body.state === "failed" &&
        body.assignmentId !== undefined,
    );
    const assignmentId =
      (committed?.t === "committed" ? committed.assignmentId : undefined) ??
      (cancelled?.t === "cancel-proof-accepted"
        ? cancelled.assignmentId
        : undefined) ??
      (superseded?.t === "assignment-superseded"
        ? superseded.assignmentId
        : undefined) ??
      (closedResolution?.t === "resolution"
        ? closedResolution.fact.subject.assignmentId
        : undefined) ??
      (failed?.t === "state" ? failed.assignmentId : undefined);
    if (!assignmentId) return [];
    const assigned = state.assignedById.get(assignmentId);
    if (!assigned) {
      throw corruptJobJournal("Resource terminal has no durable assignment");
    }
    if (!requiresFormalResourceCoordination(assigned.envelope.resourceLease)) {
      return [];
    }
    if (!this.#resources) {
      throw corruptJobJournal("Job assignment has no resource coordinator");
    }
    const mode = committed
      ? "settle-release"
      : cancelled?.t === "cancel-proof-accepted"
        ? cancelled.proof.decision === "not-started"
          ? "release"
          : "settle-release"
        : superseded
          ? "release"
          : failed?.t === "state" && failed.usageFinal
            ? "settle-release"
            : "reclaim";
    return this.#resources.prepareTerminal({
      lease: assigned.envelope.resourceLease,
      mode,
    });
  }

  async #prepareSchedulerPolicyRecords(
    state: JobProjection,
    entries: readonly LogicalRecord<unknown>[],
    at: string,
    transaction: ProjectionTransactionContext,
  ): Promise<readonly LogicalRecord<unknown>[]> {
    const definition = state.definition;
    if (!definition || definition.definition.kind !== "user") return [];
    const result: LogicalRecord<unknown>[] = [];
    // 一批里可能有多条失败终态（例如较新的触发让多条排队者过期）：先把它们的定位路径按层一并装入
    requireFailureSummaryPaths(
      state,
      failureSummaryCandidates(state, jobStreamBodies(entries, this.#taskId)),
    );
    for (const entry of entries) {
      if (entry.stream !== jobStream(this.#taskId)) continue;
      const body = entry.body as Partial<JobJournalRecord>;
      if (
        body.t !== "state" ||
        (body.state !== "failed" &&
          body.state !== "expired" &&
          body.state !== "committed") ||
        typeof body.jobRunId !== "string" ||
        typeof body.statusRevision !== "number"
      ) {
        continue;
      }
      if (body.state === "committed") {
        const committed = entries.find(
          (item) =>
            item.stream === jobStream(this.#taskId) &&
            (item.body as Partial<JobJournalRecord>).t === "committed" &&
            (item.body as { jobRunId?: string }).jobRunId === body.jobRunId,
        )?.body as Extract<JobJournalRecord, { t: "committed" }> | undefined;
        if (!committed) continue; // System jobs have their own terminal state.
        const bundle = validateJobSealedBundle(
          JSON.parse(
            Buffer.from(
              await this.#artifacts.get(committed.bundle.ref),
            ).toString("utf8"),
          ) as SealedBundle,
        );
        if (bundle.body.outcome.status !== "failed") continue;
      }
      const occurrence = state.occurrences.get(body.jobRunId);
      if (!occurrence) {
        throw corruptJobJournal("Scheduler failure policy has no occurrence");
      }
      let policy: ScheduleFailurePolicyDecision;
      try {
        // 连续失败数 = 这一次 + 完整次序里它之前的连续失败数（由摘要的定位路径合成，不倒扫失败历史）
        policy = scheduleFailurePolicyForCount({
          taskId: this.#taskId,
          jobRunId: occurrence.jobRunId,
          schedule: definition.definition.spec.schedule,
          scheduledFor: occurrence.scheduledFor,
          failureCount: 1 + failuresBefore(state, occurrence),
          threshold: this.#schedulerFailureThreshold,
          decidedAt: at,
        });
      } catch (error) {
        if (error instanceof AuthorityPreparationRequired) throw error;
        if (error instanceof ScheduleRuntimePolicyError) {
          throw corruptJobJournal(error.message);
        }
        throw error;
      }
      result.push(
        jobRecord(this.#taskId, {
          t: "failure-policy",
          jobRunId: occurrence.jobRunId,
          taskRevision: occurrence.taskRevision,
          statusRevision: body.statusRevision,
          failureCount: policy.failureCount,
          threshold: policy.threshold,
          ...(policy.nextFire ? { nextFire: policy.nextFire } : {}),
          autoDisableRequired: policy.autoDisableRequired,
        }),
      );
    }
    return [
      ...result,
      ...(await this.#prepareCapabilityGapClosureRecords(
        state,
        entries,
        at,
        transaction,
        entries,
      )),
    ];
  }

  /** candidates 是同一 envelope 里已计划的条目，其中的投递入队一并计入。 */
  async #prepareCapabilityGapClosureRecords(
    state: JobProjection,
    entries: readonly LogicalRecord<unknown>[],
    at: string,
    transaction: ProjectionTransactionContext,
    candidates: readonly LogicalRecord<unknown>[],
  ): Promise<readonly LogicalRecord<unknown>[]> {
    const result: LogicalRecord<unknown>[] = [];
    if (this.#schedulerNotices) {
      const decision = decideScheduleCapabilityGapClosure({
        taskId: this.#taskId,
        events: entries
          .filter((entry) => entry.stream === jobStream(this.#taskId))
          .flatMap(
            (
              entry,
            ): { kind: "assigned" | "terminal"; jobRunId: string }[] => {
              const body = entry.body as Partial<JobJournalRecord>;
              if (body.t !== "assigned" && body.t !== "state") return [];
              if (typeof body.jobRunId !== "string") return [];
              if (body.t === "assigned") {
                return [{ kind: "assigned", jobRunId: body.jobRunId }];
              }
              if (
                body.t === "state" &&
                body.state !== undefined &&
                isTerminal(body.state)
              ) {
                return [{ kind: "terminal", jobRunId: body.jobRunId }];
              }
              return [];
            },
          ),
        gaps: state.capabilityGapByRun,
        at,
      });
      if (decision) {
        result.push(
          jobRecord(this.#taskId, {
            t: "capability-gap-closed",
            jobRunId: decision.jobRunId,
            round: decision.round,
            noticeId: decision.noticeId,
          }),
        );
        result.push(
          ...(await this.#schedulerNotices.prepareRecords(
            decision.notice,
            transaction,
            candidates,
          )),
        );
      }
    }
    return result;
  }

  #publishStatusNotices(notices: readonly JobStatusNotice[]): void {
    for (const notice of notices) {
      for (const listener of this.#statusListeners) {
        void Promise.resolve()
          .then(() => listener(notice))
          .catch(() => undefined);
      }
    }
  }

  #publishLifecycleEvents(events: readonly JobLifecycleEvent[]): void {
    for (const event of events) {
      for (const listener of this.#lifecycleListeners) {
        void Promise.resolve()
          .then(() => listener(event))
          .catch(() => undefined);
      }
    }
  }
}

export { JOB_MAIN_SUBJECTS, scopeKeys };
