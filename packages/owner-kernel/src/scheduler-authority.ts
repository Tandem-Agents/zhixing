import { createHash, randomUUID } from "node:crypto";
import {
  currentMaintenanceAbortSignal,
  isHoldingMaintenanceExclusion,
  maintenanceRetryDelayMs,
  runDetachedDeviceCapacity,
  runDetachedMaintenanceContext,
  waitForMaintenanceRetry,
} from "@zhixing/core/resources";
import type { AgentTurnResult, ScheduledTask, SchedulerEventMap, SchedulerControlSource, SystemHandler, TaskPatch, TaskSpec, TaskPriority, TaskSchedule } from "@zhixing/core/scheduler";
import type { IEventBus } from "@zhixing/core";
import {
  isScheduleFailure,
  decideScheduleTrigger,
  deriveScheduleNextRun,
  scheduleAutoDisableOperationId,
  scheduleTimerDelay,
  selectDueScheduleEntries,
  schedulerNoticeGroupKey,
  type MissedSummaryGroup,
  type ScheduleOccurrence,
} from "@zhixing/core/scheduler/application";
import type {
  AuthorityCallContext,
  IngressContext,
  JobOccurrence,
  JobRunState,
  JsonValue,
  TaskDefinition,
} from "@zhixing/core/contracts";
import { protocolDigest } from "@zhixing/core/protocol";
import { createJobControlEnvelope } from "./control-admission.js";
import type { ControlAdmissionJournal, TrustedControlSource } from "./control-admission.js";
import type { JobJournal, JobLifecycleEvent } from "./job-assignment.js";
import type { SchedulerUserNoticeJournal } from "./scheduler-user-notices.js";

const TERMINAL_STATES = new Set([
  "committed",
  "cancelled",
  "failed",
  "expired",
  "missed",
] as const);
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_MISSED_GRACE_MS = 30_000;

export interface AnchorSchedulerOptions {
  readonly anchorEpoch: number;
  readonly deviceId: string;
  readonly admission: ControlAdmissionJournal;
  readonly eventBus: IEventBus<SchedulerEventMap>;
  /** 启动要恢复的任务：当前（未删除）定义，以及仍有未完义务的任务。 */
  readonly listTaskIds: () => Promise<readonly string[]>;
  /** 本进程没见过的 run 按持久索引精确找所属任务。 */
  readonly findTaskForRun?: (jobRunId: string) => Promise<string | undefined>;
  readonly journalFor: (taskId: string) => JobJournal;
  readonly activateUserJob: (input: {
    readonly journal: JobJournal;
    readonly definition: TaskDefinition & {
      readonly definition: Extract<TaskDefinition["definition"], { kind: "user" }>;
    };
    readonly occurrence: JobOccurrence;
  }) => Promise<void>;
  readonly recoverUserJobs?: (
    journal: JobJournal,
    acceptedJobRunIds?: ReadonlySet<string>,
  ) => Promise<void>;
  readonly cancelUserJob?: (input: {
    readonly journal: JobJournal;
    readonly jobRunId: string;
    readonly requestId: string;
    readonly context: AuthorityCallContext;
  }) => Promise<{ readonly state: string }>;
  readonly systemHandlers?: ReadonlyMap<string, SystemHandler>;
  readonly systemTasks?: ReadonlyMap<string, AnchorSystemTaskSpec>;
  readonly onError?: (error: Error) => void;
  readonly now?: () => Date;
  readonly pollMs?: number;
  readonly missedGraceMs?: number;
  readonly schedulerNotices?: SchedulerUserNoticeJournal;
}

export interface AnchorSystemTaskSpec {
  readonly id: string;
  readonly name: string;
  readonly handler: string;
  readonly schedule: TaskSchedule;
  readonly priority?: TaskPriority;
  readonly description?: string;
  readonly params?: JsonValue;
}

interface TaskRuntimeProjection {
  readonly definition: TaskDefinition;
  /** 非错过 occurrence 的总数。 */
  readonly runCount: number;
  /** 最近一次起向前的连续失败次数。 */
  readonly consecutiveFailures: number;
  readonly last?: ScheduleOccurrence;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface JobStateWaiter {
  readonly resolve: (state: JobRunState | undefined) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Anchor-owned scheduler product service.
 *
 * TaskDefinition and JobJournal are the only authoritative facts.  The
 * in-memory maps below are disposable query/timer projections and are rebuilt
 * from those facts on every start.
 */
export class AnchorScheduler {
  readonly #options: AnchorSchedulerOptions;
  readonly #journals = new Map<string, JobJournal>();
  readonly #views = new Map<string, ScheduledTask>();
  readonly #definitions = new Map<string, TaskDefinition>();
  readonly #nextRunByTask = new Map<string, string>();
  readonly #activeRunCountByTask = new Map<string, number>();
  readonly #queuedRunsByTask = new Map<string, readonly JobOccurrence[]>();
  readonly #completionTrackers = new Map<string, Promise<void>>();
  /** 进行中的接纳决定：触发提交、用户激活与恢复派发、运行控制提交、取消。关准入后冻结前先等它们收束 */
  readonly #decisions = new Set<Promise<unknown>>();
  /** 准入代际：每次开放与关闭都换代；开始新工作的入口按开始时的代际核准，关闭后的晚到续行不能重新开工 */
  #generation = 0;
  /** 本进程正在执行的系统处理器（物理工作）：结清时等它跑完，不随冻结交接 */
  readonly #systemRuns = new Map<string, Promise<unknown>>();
  readonly #taskByRun = new Map<string, string>();
  readonly #lifecycleUnsubscribers = new Map<string, () => void>();
  readonly #stateWaiters = new Map<string, Set<JobStateWaiter>>();
  readonly #now: () => Date;
  readonly #pollMs: number;
  readonly #missedGraceMs: number;
  #onlineSince: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #accepting = false;
  #prepared = false;
  #activationRecovery: Promise<void> | undefined;
  /** 全部尚未结束的激活恢复回合（含已关闭的旧代）：停止与迁居暂停都要等它们确实退出 */
  readonly #activationRecoveries = new Set<Promise<void>>();
  readonly #recoveringTaskIds = new Set<string>();
  #tickRunning = false;
  #queuedWakeRequested = false;
  #missedSummaryPending = false;

  constructor(options: AnchorSchedulerOptions) {
    if (!Number.isSafeInteger(options.anchorEpoch) || options.anchorEpoch <= 0) {
      throw new TypeError("Scheduler anchor epoch must be a positive safe integer");
    }
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#pollMs = boundedPositive(options.pollMs ?? DEFAULT_POLL_MS, "Scheduler pollMs");
    this.#missedGraceMs = boundedPositive(
      options.missedGraceMs ?? DEFAULT_MISSED_GRACE_MS,
      "Scheduler missed grace",
    );
  }

  async start(): Promise<void> {
    await this.prepare();
    this.activate();
    await this.#activationRecovery;
  }

  async prepare(): Promise<void> {
    if (this.#prepared) return;
    this.#onlineSince = this.#now().getTime();
    for (const taskId of await this.#retryTransientPressure(() => this.#options.listTaskIds())) {
      const registeredSystem = this.#options.systemTasks?.get(taskId);
      await this.#retryTransientPressure(() => this.#refreshTask(
        taskId,
        registeredSystem ? { systemView: systemView(registeredSystem) } : {},
      ));
    }
    await this.#ensureConfiguredSystemTasks();
    this.#prepared = true;
  }

  /**
   * 准备阶段由 Host 启动直接调用，不持有任何串行排他；各层日志/投影队列在
   * 持有排他时零等待并把暂时容量背压交还给这里。只在退出全部队列后有限重驱
   * 幂等的读取与系统任务定义，避免一次暂时读背压让整个 Host 启动失败。
   */
  async #retryTransientPressure<T>(operation: () => Promise<T>): Promise<T> {
    let deadline: number | undefined;
    for (;;) {
      try {
        return await operation();
      } catch (error) {
        const delay = maintenanceRetryDelayMs(error);
        if (delay === undefined || isHoldingMaintenanceExclusion() || currentMaintenanceAbortSignal().aborted) throw error;
        deadline ??= performance.now() + 5_000;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw error;
        await waitForMaintenanceRetry(Math.min(delay, remaining));
      }
    }
  }

  activate(): void {
    if (!this.#prepared) throw new Error("Scheduler must be prepared before activation");
    if (this.#accepting) return;
    this.#accepting = true;
    const generation = ++this.#generation;
    this.#arm();
    const recovery = this.#background(() => this.#recoverAfterActivation(generation));
    this.#activationRecoveries.add(recovery);
    void recovery.finally(() => this.#activationRecoveries.delete(recovery));
    this.#activationRecovery = recovery;
  }

  async #recoverAfterActivation(generation: number): Promise<void> {
    const pending = [...this.#definitions];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (this.#startsAllowed(generation)) {
        const entry = pending[cursor++];
        if (!entry) return;
        const [taskId, definition] = entry;
        const journal = this.#journal(taskId);
        this.#recoveringTaskIds.add(taskId);
        try {
          await this.#disableAfterRepeatedFailure(taskId);
          // 上面的等待期间可能已关准入：开始处理器或恢复派发前在入口重新核准，未开始的留给下一宿主
          const started = definition.definition.kind === "system"
            ? this.#startSystem(generation, `resume-system-${taskId}`, () => journal.resumeSystemJobs(
              this.#hostContext(`resume-system-${taskId}`),
            ))
            : this.#startDecision(generation, async () => { await this.#options.recoverUserJobs?.(journal); });
          if (!started) return;
          await started;
        } catch (error) {
          this.#options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        } finally {
          try {
            await this.#refreshTask(
              taskId,
              definition.definition.kind === "system"
                ? { systemView: this.#systemView(taskId) }
                : {},
            );
          } finally {
            this.#recoveringTaskIds.delete(taskId);
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, () => worker()),
    );
    // 这一代已关闭：不再接着排队激活、补发错过摘要或接手追踪，直接退出
    if (!this.#startsAllowed(generation)) return;
    await this.#resumeQueuedUserJobs(generation);
    this.#missedSummaryPending = true;
    try {
      await this.#driveMissedSummaries();
    } catch (error) {
      this.#options.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    for (const [taskId, definition] of this.#definitions) {
      if (definition.definition.kind === "system") continue;
      for (const occurrence of await this.#journal(taskId).openOccurrences()) {
        // 已关闭的这一代不再接手追踪：未激活的发生随冻结交接
        if (!this.#startsAllowed(generation)) return;
        if (!TERMINAL_STATES.has(occurrence.state as never)) {
          this.#trackCompletion(taskId, occurrence.jobRunId);
        }
      }
    }
  }

  async #prepareMissedSummaries(): Promise<void> {
    if (!this.#options.schedulerNotices) return;
    const groups = new Map<string, {
      readonly target?: Extract<TaskDefinition["definition"], { kind: "user" }>["origin"];
      readonly members: Array<MissedSummaryGroup["members"][number]>;
    }>();
    for (const [taskId, definition] of this.#definitions) {
      if (definition.definition.kind !== "user") continue;
      const target = definition.definition.origin;
      const groupKey = schedulerNoticeGroupKey(target);
      let group = groups.get(groupKey);
      if (!group) {
        group = { ...(target ? { target } : {}), members: [] };
        groups.set(groupKey, group);
      }
      for (const occurrence of await this.#journal(taskId).pendingMissedOccurrences()) {
        if (occurrence.state !== "missed") continue;
        group.members.push({
          taskId,
          jobRunId: occurrence.jobRunId,
          taskName: definition.definition.spec.name,
          scheduledFor: occurrence.scheduledFor,
        });
      }
    }
    await this.#options.schedulerNotices.prepareMissedSummaries(
      [...groups].map(([groupKey, group]) => ({
        groupKey,
        members: group.members,
        ...(group.target ? { target: group.target } : {}),
      })),
      this.#now().toISOString(),
    );
  }

  async #driveMissedSummaries(): Promise<void> {
    if (!this.#missedSummaryPending) return;
    this.#missedSummaryPending = false;
    try {
      await this.#prepareMissedSummaries();
    } catch (error) {
      this.#missedSummaryPending = true;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.closeAdmissionForLifecycle();
    for (const waiters of this.#stateWaiters.values()) {
      for (const waiter of waiters) waiter.resolve(undefined);
    }
    this.#stateWaiters.clear();
    await this.#settleDecisions();
    await this.#joinActivationRecoveries();
    await Promise.allSettled([...this.#systemRuns.values()]);
    await Promise.allSettled(this.#completionTrackers.values());
    for (const unsubscribe of this.#lifecycleUnsubscribers.values()) unsubscribe();
    this.#lifecycleUnsubscribers.clear();
    this.#prepared = false;
  }

  /** Closes fresh scheduler triggers without waiting for already-owned runs. */
  closeAdmissionForLifecycle(): void {
    this.#accepting = false;
    this.#generation += 1;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * 冻结集合：权威中全部未终结发生，逐任务由未终结目录派生（不扫全历史），与下一宿主恢复时核对的是同一集合。
   * 关准入之后先等已进入接纳临界区的决定收束再取，集合才一致；排队中的发生随冻结交接，这里不等它执行。
   */
  async acceptedWorkItems(): Promise<readonly { readonly id: string; readonly revision: string }[]> {
    if (!this.#accepting) await this.#settleDecisions();
    const items: Array<{ id: string; revision: string }> = [];
    for (const taskId of this.#definitions.keys()) {
      for (const occurrence of await this.#journal(taskId).openOccurrences()) {
        if (TERMINAL_STATES.has(occurrence.state as never)) continue;
        items.push(Object.freeze({ id: occurrence.jobRunId, revision: acceptedWorkRevision(occurrence) }));
      }
    }
    return Object.freeze(items.sort((left, right) => left.id.localeCompare(right.id, "en-US")));
  }

  /**
   * 本进程仍在执行、必须在本进程收尾的工作：追踪中的用户运行、在飞的系统处理器与接纳决定、激活恢复。
   * 停止读回要求它为空；排队中的发生不在其中，随冻结交接。
   */
  inProcessWork(): readonly string[] {
    return [
      ...this.#completionTrackers.keys(),
      ...this.#systemRuns.keys(),
      ...(this.#decisions.size ? ["accepting-decisions"] : []),
      ...(this.#activationRecoveries.size ? ["activation-recovery"] : []),
    ].sort((left, right) => left.localeCompare(right, "en-US"));
  }

  /**
   * 按冻结身份与修订精确接续：仍未终结且修订一致的接续；冻结之后已正确终结的确认已结，不再执行；
   * 不在冻结集里的未终结发生、修订冲突或找不到的冻结项都拒绝。系统发生只核对，由激活后的恢复在后台执行，
   * 不占启动路径。
   */
  async recoverAcceptedWorkForLifecycle(
    frozen: readonly { readonly id: string; readonly revision: string }[],
  ): Promise<void> {
    await this.prepare();
    const expected = new Map(frozen.map((item) => [item.id, item.revision]));
    const seen = new Set<string>();
    for (const [taskId, definition] of this.#definitions) {
      const journal = this.#journal(taskId);
      const accepted = new Set<string>();
      for (const occurrence of await journal.openOccurrences()) {
        if (TERMINAL_STATES.has(occurrence.state as never)) continue;
        if (expected.get(occurrence.jobRunId) !== acceptedWorkRevision(occurrence)) {
          throw new Error("Scheduler recovery observed an unfrozen accepted-work generation");
        }
        seen.add(occurrence.jobRunId);
        accepted.add(occurrence.jobRunId);
      }
      if (accepted.size === 0 || definition.definition.kind === "system") continue;
      for (const jobRunId of accepted) this.#trackCompletion(taskId, jobRunId);
      await this.#options.recoverUserJobs?.(journal, accepted);
    }
    // 冻结后才终结的项：逐任务精确读取，修订一致且已终结才确认已结
    for (const [jobRunId, revision] of expected) {
      if (seen.has(jobRunId)) continue;
      let confirmed = false;
      for (const taskId of this.#definitions.keys()) {
        const occurrence = await this.#journal(taskId).scheduleOccurrence(jobRunId);
        if (!occurrence) continue;
        if (acceptedWorkRevision(occurrence) !== revision || !TERMINAL_STATES.has(occurrence.state as never)) {
          throw new Error("Scheduler lifecycle artifact conflicts with current durable work");
        }
        confirmed = true;
        break;
      }
      if (!confirmed) throw new Error("Scheduler lifecycle artifact does not bind current durable work");
    }
  }

  /** Closes fresh triggers while preserving every durable schedule fact for pre-commit rollback. */
  async pauseForAuthorityTransfer(): Promise<void> {
    if (this.#accepting) this.closeAdmissionForLifecycle();
    await this.#settleDecisions();
    await this.#joinActivationRecoveries();
    // 本进程已开始的物理工作在本进程收尾：在飞的系统处理器跑完，追踪中的用户运行到终态
    await Promise.allSettled([...this.#systemRuns.values()]);
    await Promise.allSettled(this.#completionTrackers.values());
  }

  /** Reopens the same owner only after the source has durably aborted before commit. */
  resumeAfterAuthorityTransfer(): void {
    if (!this.#prepared) return;
    this.activate();
  }

  /** Rebuilds every disposable scheduler projection after an authority base install. */
  async recoverInstalledAuthority(): Promise<void> {
    await this.pauseForAuthorityTransfer();
    for (const unsubscribe of this.#lifecycleUnsubscribers.values()) unsubscribe();
    this.#lifecycleUnsubscribers.clear();
    this.#journals.clear();
    this.#views.clear();
    this.#definitions.clear();
    this.#nextRunByTask.clear();
    this.#activeRunCountByTask.clear();
    this.#queuedRunsByTask.clear();
    this.#taskByRun.clear();
    this.#recoveringTaskIds.clear();
    this.#prepared = false;
    await this.prepare();
    this.activate();
    await this.#activationRecovery;
  }

  async createTask(
    spec: TaskSpec,
    requestId = `schedule-create-${randomUUID()}`,
    source?: SchedulerControlSource,
    operationDigest = protocolDigest("ScheduleCreateIntent", 1, { spec }),
  ): Promise<ScheduledTask> {
    this.#requireAccepting();
    if (spec.action.kind !== "agent-turn") {
      throw new TypeError("User schedule creation only accepts agent-turn tasks");
    }
    // The caller's idempotency key owns task identity, so a response-loss
    // retry reaches the same journal instead of creating another task.
    const taskId = scheduleTaskIdForRequest(requestId);
    const journal = this.#journal(taskId);
    if (await this.#taskMutationRevisionFor(journal, requestId, operationDigest)) {
      await this.#refreshTask(taskId);
      return this.#requiredView(taskId);
    }
    const definition = await this.#userDefinition(
      taskId,
      1,
      spec,
      source ? definitionSource(source.ingress) : {},
    );
    const applied = await journal.define(
      definition,
      this.#hostContext(requestId),
      undefined,
      { operationId: requestId, operationDigest },
    );
    await this.#refreshTask(taskId);
    if (applied?.replayed) return this.#requiredView(taskId);
    await this.#options.eventBus.emit("scheduler:task-created", {
      taskId,
      name: spec.name,
      schedule: spec.schedule,
      nextRunAt: this.#nextRunByTask.get(taskId),
    });
    this.#arm();
    return this.#requiredView(taskId);
  }

  async updateTask(
    taskId: string,
    patch: TaskPatch,
    requestId = `schedule-update-${randomUUID()}`,
    expectedRevision?: number,
    operationDigest = protocolDigest("ScheduleUpdateIntent", 1, {
      taskId,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      patch,
    }),
  ): Promise<ScheduledTask> {
    this.#requireAccepting();
    const journal = this.#journal(taskId);
    if (await this.#taskMutationRevisionFor(journal, requestId, operationDigest)) {
      await this.#refreshTask(taskId);
      return this.#requiredView(taskId);
    }
    const current = this.#requiredUserDefinition(taskId);
    const view = this.#requiredView(taskId);
    const currentSpec = current.definition.spec;
    const merged = {
      name: patch.name ?? view.name,
      ...(patch.description !== undefined
        ? { description: patch.description }
        : view.description !== undefined
          ? { description: view.description }
          : {}),
      enabled: patch.enabled ?? view.enabled,
      priority: patch.priority ?? view.priority,
      schedule: patch.schedule ?? view.schedule,
      action: patch.action ?? currentSpec.action,
      ...(patch.delivery !== undefined
        ? { delivery: patch.delivery }
        : view.delivery !== undefined
          ? { delivery: view.delivery }
          : {}),
    } satisfies TaskSpec;
    const next = await this.#userDefinition(
      taskId,
      current.taskRevision + 1,
      merged,
      {
        ...(current.definition.origin
          ? { origin: current.definition.origin }
          : {}),
        ...(current.definition.interactionResponder
          ? { interactionResponder: current.definition.interactionResponder }
          : {}),
        ...(current.definition.createdInTurn
          ? { createdInTurn: current.definition.createdInTurn }
          : {}),
      },
    );
    const applied = await journal.define(
      next,
      this.#hostContext(requestId),
      undefined,
      {
        operationId: requestId,
        operationDigest,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      },
    );
    await this.#refreshTask(taskId);
    if (applied?.replayed) return this.#requiredView(taskId);
    await this.#options.eventBus.emit("scheduler:task-updated", {
      taskId,
      name: (next.definition as Extract<TaskDefinition["definition"], { kind: "user" }>).spec.name,
    });
    this.#arm();
    return this.#requiredView(taskId);
  }

  async deleteTask(
    taskId: string,
    requestId = `schedule-delete-${randomUUID()}`,
    expectedRevision?: number,
    operationDigest = protocolDigest("ScheduleDeleteIntent", 1, {
      taskId,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    }),
  ): Promise<void> {
    this.#requireAccepting();
    const journal = this.#journal(taskId);
    if (await this.#taskMutationRevisionFor(journal, requestId, operationDigest)) return;
    const current = this.#requiredUserDefinition(taskId);
    const view = this.#requiredView(taskId);
    const deleted: TaskDefinition = {
      ...structuredClone(current),
      taskRevision: current.taskRevision + 1,
      state: "deleted",
      definition: {
        ...structuredClone(current.definition),
        spec: { ...structuredClone(current.definition.spec), enabled: false },
      },
    };
    const applied = await journal.define(
      deleted,
      this.#hostContext(requestId),
      undefined,
      {
        operationId: requestId,
        operationDigest,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      },
    );
    if (applied?.replayed) return;
    const cancellationFailures: unknown[] = [];
    for (const occurrence of await journal.openOccurrences()) {
      if (TERMINAL_STATES.has(occurrence.state as never)) continue;
      try {
        const cancelRequestId = `schedule-delete-cancel:${protocolDigest(
          "TaskDeleteCancellationIdentity",
          1,
          {
            taskId,
            taskRevision: deleted.taskRevision,
            jobRunId: occurrence.jobRunId,
          },
        )}`;
        if (this.#options.cancelUserJob) {
          await this.#options.cancelUserJob({
            journal,
            jobRunId: occurrence.jobRunId,
            requestId: cancelRequestId,
            context: this.#hostContext(cancelRequestId),
          });
        } else {
          await journal.cancel({
            jobRunId: occurrence.jobRunId,
            requestId: cancelRequestId,
            context: this.#hostContext(cancelRequestId),
          });
        }
      } catch (error) {
        cancellationFailures.push(error);
      }
    }
    await this.#refreshTask(taskId);
    await this.#options.eventBus.emit("scheduler:task-deleted", {
      taskId,
      name: view.name,
    });
    this.#arm();
    if (cancellationFailures.length > 0) {
      throw new AggregateError(
        cancellationFailures,
        "Task was deleted but one or more in-flight jobs could not be cancelled",
      );
    }
  }

  async ensureSystemTask(spec: AnchorSystemTaskSpec): Promise<void> {
    this.#requireAccepting();
    const existing = this.#definitions.get(spec.id);
    if (existing) {
      if (existing.definition.kind !== "system") {
        throw new Error("System task id is already used by a user task");
      }
      await this.#refreshTask(spec.id, {
        systemView: {
          name: spec.name,
          schedule: spec.schedule,
          priority: spec.priority ?? "low",
          ...(spec.description ? { description: spec.description } : {}),
        },
      });
      return;
    }
    const definition: TaskDefinition = {
      taskId: spec.id,
      taskRevision: 1,
      state: "enabled",
      definition: {
        kind: "system",
        handler: spec.handler as Extract<
          TaskDefinition["definition"],
          { kind: "system" }
        >["handler"],
        ...(spec.params ? { params: structuredClone(spec.params) } : {}),
      },
    };
    await this.#journal(spec.id).define(
      definition,
      this.#hostContext(`ensure-system-${spec.id}`),
    );
    await this.#refreshTask(spec.id, {
      systemView: {
        name: spec.name,
        schedule: spec.schedule,
        priority: spec.priority ?? "low",
        ...(spec.description ? { description: spec.description } : {}),
      },
    });
  }

  async #ensureConfiguredSystemTasks(): Promise<void> {
    for (const spec of this.#options.systemTasks?.values() ?? []) {
      const existing = this.#definitions.get(spec.id);
      if (existing) {
        if (
          existing.definition.kind !== "system" ||
          existing.definition.handler !== spec.handler
        ) {
          throw new Error(`System task registration conflicts for ${spec.id}`);
        }
        // prepare() already loaded this task with its registered system view.
        // No task can execute before activation; retain the conflict check,
        // without repeating the same journal/projection recovery here.
        continue;
      }
      const definition: TaskDefinition = {
        taskId: spec.id,
        taskRevision: 1,
        state: "enabled",
        definition: {
          kind: "system",
          handler: spec.handler as Extract<
            TaskDefinition["definition"],
            { kind: "system" }
          >["handler"],
          ...(spec.params ? { params: structuredClone(spec.params) } : {}),
        },
      };
      // 相同定义再次提交按已存在修订返回，提交后发布阶段失败时重驱也不会重复写入。
      await this.#retryTransientPressure(() => this.#journal(spec.id).define(
        definition,
        this.#hostContext(`ensure-system-${spec.id}`),
      ));
      await this.#retryTransientPressure(() => this.#refreshTask(spec.id, { systemView: systemView(spec) }));
    }
  }

  #systemView(taskId: string) {
    const spec = this.#options.systemTasks?.get(taskId);
    if (!spec) throw new Error(`System task ${taskId} has no host registration`);
    return systemView(spec);
  }

  async runTask(
    taskId: string,
    requestId = `schedule-run-${randomUUID()}`,
    controlSource?: SchedulerControlSource,
  ): Promise<AgentTurnResult> {
    this.#requireAccepting();
    const generation = this.#generation;
    const definition = this.#requiredUserDefinition(taskId);
    const now = this.#now();
    const source = this.#manualSource(
      requestId,
      now.toISOString(),
      controlSource,
    );
    const control = this.#startDecision(generation, () => this.#journal(taskId).applyControl({
      admission: this.#options.admission,
      envelope: createJobControlEnvelope({
        requestId,
        source,
        at: now.toISOString(),
        body: {
          t: "job-run",
          taskId,
          anchorEpoch: this.#options.anchorEpoch,
        },
      }),
      source,
    }));
    if (!control) throw new Error("Scheduler is not accepting commands");
    const outcome = await control;
    if (outcome.kind === "rejected" || outcome.result.status !== "ok") {
      throw new Error(
        outcome.kind === "rejected"
          ? outcome.result.error.message
          : "Job run control was not accepted",
      );
    }
    if (outcome.result.body.t !== "job-run") {
      throw new Error("Job run control returned an invalid result");
    }
    const occurrence = await this.#journal(taskId).occurrence(
      outcome.result.body.jobRunId,
    );
    if (!occurrence) throw new Error("Accepted job occurrence is unavailable");
    await this.#options.eventBus.emit("scheduler:task-accepted", {
      taskId,
      jobRunId: occurrence.jobRunId,
      name: definition.definition.spec.name,
    });
    const startedAt = this.#now().getTime();
    if (occurrence.state === "queued") {
      await this.#startDecision(generation, () => this.#activateUser(definition, occurrence));
    }
    return await this.#waitForResult(taskId, occurrence.jobRunId, startedAt);
  }

  async abortRun(
    jobRunId: string,
    requestId = `schedule-cancel-${randomUUID()}`,
    controlSource?: SchedulerControlSource,
  ): Promise<boolean> {
    this.#requireAccepting();
    // 取消只减少工作，关准入后照常收束：从入口起同步登记为决定，冻结等它（含查找所属任务的等待）结束
    return this.#decide(async () => {
      const taskId = this.#taskForRun(jobRunId) ?? await this.#options.findTaskForRun?.(jobRunId);
      if (!taskId) return false;
      const journal = this.#journal(taskId);
      const at = this.#now().toISOString();
      // 只有发起运行的控制带入口上下文；取消沿用同一主体，不带入口上下文（信封校验拒绝非运行控制带它）
      const { ingress: _ingress, ...source } = this.#manualSource(requestId, at, controlSource);
      const outcome = await journal.applyControl({
        admission: this.#options.admission,
        envelope: createJobControlEnvelope({
          requestId,
          source,
          at,
          body: {
            t: "job-cancel",
            taskId,
            jobRunId,
            anchorEpoch: this.#options.anchorEpoch,
          },
        }),
        source,
      });
      if (outcome.kind === "rejected" || outcome.result.status !== "ok") {
        return false;
      }
      const context = this.#controlContext(requestId, controlSource);
      const result = this.#options.cancelUserJob
        ? await this.#options.cancelUserJob({
            journal,
            jobRunId,
            requestId,
            context,
          })
        : await journal.cancel({ jobRunId, requestId, context });
      await this.#refreshTask(taskId);
      return result.state === "cancelled" || result.state === "cancel-requested";
    });
  }

  listTasks(): ScheduledTask[] {
    return this.listTaskProjections()
      .filter((task) => !task.system)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  /** Raw mechanism projection; product visibility and ordering belong to Schedule Domain. */
  listTaskProjections(): ScheduledTask[] {
    return [...this.#views.values()].map((task) => structuredClone(task));
  }

  listDefinitions(includeDisabled = true): TaskDefinition[] {
    return [...this.#definitions.values()]
      .filter(
        (definition) =>
          definition.definition.kind === "user" &&
          definition.state !== "deleted" &&
          (includeDisabled || definition.state === "enabled"),
      )
      .sort((left, right) => left.taskId.localeCompare(right.taskId, "en-US"))
      .map((definition) => structuredClone(definition));
  }

  getDefinition(taskId: string): TaskDefinition | undefined {
    const definition = this.#definitions.get(taskId);
    return definition ? structuredClone(definition) : undefined;
  }

  getTask(taskId: string): ScheduledTask | undefined {
    const task = this.#views.get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  get activeTaskCount(): number {
    return [...this.#activeRunCountByTask.values()].reduce(
      (sum, count) => sum + count,
      0,
    );
  }

  async refreshCommittedDefinitions(taskIds: readonly string[]): Promise<void> {
    for (const taskId of [...new Set(taskIds)].sort((left, right) =>
      left.localeCompare(right, "en-US"),
    )) {
      await this.#refreshTask(taskId);
    }
    this.#arm();
  }

  async tick(): Promise<void> {
    if (!this.#accepting) return;
    if (this.#tickRunning) {
      this.#queuedWakeRequested = true;
      return;
    }
    this.#tickRunning = true;
    const generation = this.#generation;
    try {
      await this.#resumeQueuedUserJobs(generation);
      const now = this.#now();
      const due = selectDueScheduleEntries(this.#nextRunByTask, now);
      for (const [taskId, scheduledFor] of due) {
        try {
          await this.#triggerScheduled(taskId, scheduledFor, generation);
        } catch (error) {
          this.#options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      try {
        await this.#driveMissedSummaries();
      } catch (error) {
        this.#options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    } finally {
      this.#tickRunning = false;
      const wakeAgain = this.#queuedWakeRequested;
      this.#queuedWakeRequested = false;
      this.#arm();
      if (wakeAgain) queueMicrotask(() => void this.#background(() => this.tick()));
    }
  }

  wakeQueuedUserJobs(): void {
    if (!this.#accepting) return;
    if (this.#tickRunning) {
      this.#queuedWakeRequested = true;
      return;
    }
    if (this.#queuedWakeRequested) return;
    this.#queuedWakeRequested = true;
    queueMicrotask(() => {
      this.#queuedWakeRequested = false;
      void this.#background(() => this.tick());
    });
  }

  #arm(): void {
    if (!this.#accepting) return;
    if (this.#timer) clearTimeout(this.#timer);
    const delay = scheduleTimerDelay(
      this.#nextRunByTask.values(),
      this.#now(),
      this.#pollMs,
    );
    this.#timer = setTimeout(() => void this.#background(() => this.tick()), delay);
    this.#timer.unref?.();
  }

  async #triggerScheduled(taskId: string, scheduledFor: string, generation: number): Promise<void> {
    const definition = this.#definitions.get(taskId);
    if (!definition || definition.state !== "enabled") {
      this.#nextRunByTask.delete(taskId);
      return;
    }
    const journal = this.#journal(taskId);
    const decision = decideScheduleTrigger({
      taskId,
      scheduledFor,
      definition,
      ...(this.#onlineSince !== undefined ? { onlineSince: this.#onlineSince } : {}),
      missedGraceMs: this.#missedGraceMs,
    });
    const trigger = this.#startDecision(generation, () => journal.trigger({
      jobRunId: decision.jobRunId,
      scheduledFor: decision.effectiveScheduledFor,
      context: this.#hostContext(`schedule-trigger-${decision.jobRunId}`),
      source: definition.definition.kind,
      ...(decision.disposition ? { disposition: decision.disposition } : {}),
      ...(decision.missedNextFire ? { missedNextFire: decision.missedNextFire } : {}),
    }));
    if (!trigger) return;
    const occurrence = await trigger;
    if (occurrence.state === "missed") {
      this.#missedSummaryPending = true;
    }
    // 关准入后不再开始处理器或激活：排队中的发生留在权威里，随冻结交接给下一宿主
    if (occurrence.state === "queued") {
      if (definition.definition.kind === "system") {
        await this.#startSystem(generation, occurrence.jobRunId, () => journal.runSystem(
          occurrence.jobRunId,
          this.#hostContext(`system-run-${occurrence.jobRunId}`),
        ));
      } else {
        try {
          await this.#startDecision(generation, () => this.#activateUser(
            definition as TaskDefinition & {
              readonly definition: Extract<TaskDefinition["definition"], { kind: "user" }>;
            },
            occurrence,
          ));
        } catch (error) {
          // The durable queued occurrence remains the sole retry input. Its
          // activation gap must not pin this due timestamp forever; the
          // recovery loop retries it and the next due occurrence can expire
          // an unstarted predecessor according to the journal state machine.
          this.#options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    }
    // Consume the due projection before rebuilding it from the durable
    // occurrence. This prevents a status refresh from preserving the already
    // fired timestamp and makes deterministic backoff restart-safe.
    this.#nextRunByTask.delete(taskId);
    await this.#refreshTask(taskId);
  }

  async #activateUser(
    definition: TaskDefinition & {
      readonly definition: Extract<TaskDefinition["definition"], { kind: "user" }>;
    },
    occurrence: JobOccurrence,
  ): Promise<void> {
    this.#trackCompletion(definition.taskId, occurrence.jobRunId);
    await this.#options.activateUserJob({
      journal: this.#journal(definition.taskId),
      definition,
      occurrence,
    });
    await this.#options.eventBus.emit("scheduler:task-started", {
      taskId: definition.taskId,
      name: definition.definition.spec.name,
      actionKind: definition.definition.spec.action.kind,
    });
  }

  async #resumeQueuedUserJobs(generation: number): Promise<void> {
    for (const [taskId, queued] of this.#queuedRunsByTask) {
      if (this.#recoveringTaskIds.has(taskId)) continue;
      const definition = this.#definitions.get(taskId);
      if (!definition || definition.definition.kind !== "user") continue;
      for (const occurrence of queued) {
        try {
          const activation = this.#startDecision(generation, () => this.#activateUser(
            definition as TaskDefinition & {
              readonly definition: Extract<TaskDefinition["definition"], { kind: "user" }>;
            },
            occurrence,
          ));
          if (!activation) return;
          await activation;
        } catch (error) {
          this.#options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
      await this.#refreshTask(taskId);
    }
  }

  /** 登记一个进行中的决定；不核准入（取消这类只减少工作的决定在关准入后照常收束） */
  #decide<T>(operation: () => Promise<T>): Promise<T> {
    const decision = operation();
    const settled = decision.then(() => undefined, () => undefined);
    this.#decisions.add(settled);
    void settled.finally(() => this.#decisions.delete(settled));
    return decision;
  }

  #startsAllowed(generation: number): boolean {
    return this.#accepting && this.#generation === generation;
  }

  /**
   * 开始新工作（触发提交、用户激活、恢复派发）的唯一入口：核准入与登记同步完成，中间没有等待；
   * 准入已关或已换代则不开始，返回 undefined。
   */
  #startDecision<T>(generation: number, operation: () => Promise<T>): Promise<T> | undefined {
    return this.#startsAllowed(generation) ? this.#decide(operation) : undefined;
  }

  /** 开始系统处理器的唯一入口：同上核准入；开始后作为本进程物理工作，结清时等它跑完 */
  #startSystem<T>(generation: number, key: string, operation: () => Promise<T>): Promise<T> | undefined {
    if (!this.#startsAllowed(generation)) return undefined;
    const run = operation();
    const settled = run.then(() => undefined, () => undefined);
    this.#systemRuns.set(key, settled);
    void settled.finally(() => { if (this.#systemRuns.get(key) === settled) this.#systemRuns.delete(key); });
    return run;
  }

  /** 等全部激活恢复回合（新旧各代）确实退出；已关闭的代不再开工，只是走完已在进行的读取后返回 */
  async #joinActivationRecoveries(): Promise<void> {
    while (this.#activationRecoveries.size) await Promise.allSettled([...this.#activationRecoveries]);
    this.#activationRecovery = undefined;
  }

  /** 关准入后，等已进入接纳临界区的决定收束（不等任务执行完） */
  async #settleDecisions(): Promise<void> {
    while (this.#decisions.size) await Promise.allSettled([...this.#decisions]);
  }

  #trackCompletion(taskId: string, jobRunId: string): void {
    if (this.#completionTrackers.has(jobRunId)) return;
    const operation = this.#background(() => this.#observeCompletion(taskId, jobRunId)).finally(() => {
      if (this.#completionTrackers.get(jobRunId) === operation) {
        this.#completionTrackers.delete(jobRunId);
      }
    });
    this.#completionTrackers.set(jobRunId, operation);
  }

  /** Durable scheduler work outlives whichever tool/transaction wakes it. */
  #background(operation: () => Promise<void>): Promise<void> {
    return runDetachedDeviceCapacity(() => runDetachedMaintenanceContext("background", operation))
      .catch((error) => {
        this.#options.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
  }

  async #observeCompletion(taskId: string, jobRunId: string): Promise<void> {
    const state = await this.#waitForTerminalState(taskId, jobRunId);
    if (!state) return;
    await this.#refreshTask(taskId);
    const view = this.#requiredView(taskId);
    const occurrence = await this.#journal(taskId).scheduleOccurrence(jobRunId);
    if (state === "committed" && !isScheduleFailure({ state, outcome: occurrence?.outcome })) {
      await this.#options.eventBus.emit("scheduler:task-completed", {
        taskId,
        name: view.name,
        durationMs: 0,
        summary: occurrence?.outcome?.summary ?? view.state.lastSummary,
      });
    } else if (state !== "missed") {
      await this.#options.eventBus.emit("scheduler:task-failed", {
        taskId,
        name: view.name,
        error: occurrence?.outcome?.summary ?? view.state.lastError ?? `Job ended as ${state}`,
        consecutiveErrors: view.state.consecutiveErrors,
        nextRunAt: view.state.nextRunAt,
      });
      await this.#disableAfterRepeatedFailure(taskId);
    }
  }

  async #waitForResult(
    taskId: string,
    jobRunId: string,
    startedAt: number,
  ): Promise<AgentTurnResult> {
    const state = await this.#waitForTerminalState(taskId, jobRunId);
    const occurrence = state ? await this.#journal(taskId).scheduleOccurrence(jobRunId) : undefined;
    if (state === "committed" && !isScheduleFailure({ state, outcome: occurrence?.outcome })) {
      return {
        status: "ok",
        output: occurrence?.outcome?.summary ?? "Scheduled job completed.",
        durationMs: Math.max(0, this.#now().getTime() - startedAt),
      };
    }
    if (state) {
      return {
        status: "error",
        error: occurrence?.outcome?.summary ?? `Scheduled job ended as ${state}.`,
        durationMs: Math.max(0, this.#now().getTime() - startedAt),
      };
    }
    return {
      status: "error",
      error: "Scheduler stopped while the job remained durable for recovery.",
      durationMs: Math.max(0, this.#now().getTime() - startedAt),
    };
  }

  #waitForTerminalState(
    taskId: string,
    jobRunId: string,
  ): Promise<JobRunState | undefined> {
    const journal = this.#journal(taskId);
    return new Promise<JobRunState | undefined>((resolve, reject) => {
      let settled = false;
      const finish = (state: JobRunState | undefined): void => {
        if (settled) return;
        settled = true;
        const waiters = this.#stateWaiters.get(jobRunId);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.#stateWaiters.delete(jobRunId);
        resolve(state);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        const waiters = this.#stateWaiters.get(jobRunId);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.#stateWaiters.delete(jobRunId);
        reject(error);
      };
      const waiter: JobStateWaiter = { resolve: finish, reject: fail };
      let waiters = this.#stateWaiters.get(jobRunId);
      if (!waiters) {
        waiters = new Set();
        this.#stateWaiters.set(jobRunId, waiters);
      }
      waiters.add(waiter);
      void journal.currentState(jobRunId).then((state) => {
        if (state && TERMINAL_STATES.has(state as never)) finish(state);
        else if (!this.#accepting) finish(undefined);
      }, fail);
    });
  }

  async #disableAfterRepeatedFailure(taskId: string): Promise<void> {
    const journal = this.#journal(taskId);
    const policy = (await this.#schedulerPolicyFor(journal)).pendingAutoDisable.at(0);
    if (!policy) return;
    let definition = await journal.taskDefinition();
    if (!definition || definition.definition.kind !== "user") return;
    const view = this.#requiredView(taskId);
    if (definition.state !== "disabled") {
      await this.updateTask(
        taskId,
        { enabled: false },
        scheduleAutoDisableOperationId({
          taskId,
          jobRunId: policy.jobRunId,
          taskRevision: policy.taskRevision,
          failureCount: policy.failureCount,
        }),
      );
      definition = await journal.taskDefinition();
    }
    if (!definition || definition.state !== "disabled") {
      throw new Error("Scheduler auto-disable did not produce a disabled definition");
    }
    await journal.settleSchedulerAutoDisable({
      jobRunId: policy.jobRunId,
      disabledTaskRevision: definition.taskRevision,
      context: this.#hostContext(`schedule-auto-disable-settled-${policy.jobRunId}`),
    });
    await this.#options.eventBus.emit("scheduler:task-disabled", {
      taskId,
      name: view.name,
      reason: "consecutive-errors",
      lastError: view.state.lastError,
    });
  }

  async #refreshTask(
    taskId: string,
    options: {
      readonly systemView?: {
        readonly name: string;
        readonly schedule: TaskSchedule;
        readonly priority: TaskPriority;
        readonly description?: string;
      };
    } = {},
  ): Promise<void> {
    const journal = this.#journal(taskId);
    // 调度视图只含当前事实：未结束的 occurrence、运行次数、连续失败与最近一次
    const { definition, open, runCount, consecutiveFailures, last } = await journal.schedulerReadView();
    if (!definition) return;
    this.#activeRunCountByTask.set(
      taskId,
      open.filter((item) => !TERMINAL_STATES.has(item.state as never)).length,
    );
    this.#queuedRunsByTask.set(
      taskId,
      open.filter((item) => item.state === "queued"),
    );
    // 本进程见过的 run 一直可按 run 找到所属任务；更早的由持久投影精确查
    for (const occurrence of open) {
      this.#taskByRun.set(occurrence.jobRunId, taskId);
    }
    const previousDefinition = this.#definitions.get(taskId);
    this.#definitions.set(taskId, definition);
    if (!this.#lifecycleUnsubscribers.has(taskId)) {
      this.#lifecycleUnsubscribers.set(
        taskId,
        journal.onLifecycle((event) => {
          void this.#background(() => this.#handleLifecycleEvent(event));
        }),
      );
    }
    if (definition.state === "deleted") {
      this.#views.delete(taskId);
      this.#nextRunByTask.delete(taskId);
      this.#activeRunCountByTask.delete(taskId);
      this.#queuedRunsByTask.delete(taskId);
      return;
    }
    const previous = this.#views.get(taskId);
    const now = this.#now().toISOString();
    const projection: TaskRuntimeProjection = {
      definition,
      runCount,
      consecutiveFailures,
      ...(last ? { last } : {}),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    if (
      definition.definition.kind === "system" &&
      !options.systemView &&
      !previous
    ) {
      this.#nextRunByTask.delete(taskId);
      return;
    }
    const view = definition.definition.kind === "user"
      ? projectUserTask(projection)
      : projectSystemTask(projection, options.systemView, previous);
    this.#views.set(taskId, view);
    const policy = await this.#schedulerPolicyFor(journal, last ? [last.jobRunId] : []);
    const frozen = last?.state === "missed"
      ? policy.missedNextFireByRun.get(last.jobRunId)?.nextFire
      : last && isScheduleFailure(last)
        ? policy.failurePolicyByRun.get(last.jobRunId)?.nextFire
        : undefined;
    const pendingAutoDisable = policy.pendingAutoDisable.length > 0;
    const legacyNext = !last && policy.legacyNextFire?.taskRevision === definition.taskRevision
      ? policy.legacyNextFire.nextFire
      : undefined;
    const unchangedDefinition =
      previousDefinition?.taskRevision === definition.taskRevision &&
      previousDefinition.state === definition.state;
    const next = pendingAutoDisable
      ? undefined
      : frozen ?? legacyNext ??
        (unchangedDefinition ? this.#nextRunByTask.get(taskId) : undefined) ??
        deriveScheduleNextRun(view.schedule, last ? [last] : [], new Date(projection.updatedAt));
    if (definition.state === "enabled" && next) this.#nextRunByTask.set(taskId, next);
    else this.#nextRunByTask.delete(taskId);
    view.state.nextRunAt = this.#nextRunByTask.get(taskId);
  }

  async #handleLifecycleEvent(event: JobLifecycleEvent): Promise<void> {
    if (event.kind !== "job-state-changed") return;
    if (event.state === "missed") this.#missedSummaryPending = true;
    if (TERMINAL_STATES.has(event.state as never)) {
      for (const waiter of this.#stateWaiters.get(event.ref.jobRunId) ?? []) {
        waiter.resolve(event.state);
      }
    }
    await this.#refreshTask(event.ref.taskId);
  }

  async #schedulerPolicyFor(journal: JobJournal, jobRunIds: readonly string[] = []): ReturnType<JobJournal["schedulerPolicy"]> {
    if (typeof journal.schedulerPolicy === "function") return journal.schedulerPolicy(jobRunIds);
    // Test-only legacy journal doubles do not carry scheduler policy facts.
    return Promise.resolve({
      missedNextFireByRun: new Map(),
      failurePolicyByRun: new Map(),
      pendingAutoDisable: [],
    });
  }

  async #taskMutationRevisionFor(
    journal: JobJournal,
    operationId: string,
    operationDigest: string,
  ): Promise<number | undefined> {
    if (typeof journal.taskMutationRevision === "function") {
      return journal.taskMutationRevision(operationId, operationDigest);
    }
    return undefined;
  }

  async #userDefinition(
    taskId: string,
    taskRevision: number,
    input: TaskSpec,
    source: {
      readonly origin?: Extract<
        TaskDefinition["definition"],
        { readonly kind: "user" }
      >["origin"];
      readonly interactionResponder?: Extract<
        TaskDefinition["definition"],
        { readonly kind: "user" }
      >["interactionResponder"];
      readonly createdInTurn?: string;
    } = {},
  ): Promise<TaskDefinition> {
    if (input.action.kind !== "agent-turn") {
      throw new TypeError("User task action must be agent-turn");
    }
    const delivery = taskDeliveryToDefinition(input.delivery);
    return {
      taskId,
      taskRevision,
      state: input.enabled ? "enabled" : "disabled",
      definition: {
        kind: "user",
        spec: {
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
          enabled: input.enabled,
          priority: input.priority,
          schedule: structuredClone(input.schedule),
          action: structuredClone(input.action),
          ...(delivery ? { delivery } : {}),
        },
        ...(source.origin ? { origin: structuredClone(source.origin) } : {}),
        ...(source.interactionResponder
          ? { interactionResponder: structuredClone(source.interactionResponder) }
          : {}),
        ...(source.createdInTurn ? { createdInTurn: source.createdInTurn } : {}),
      },
    };
  }

  #journal(taskId: string): JobJournal {
    let journal = this.#journals.get(taskId);
    if (!journal) {
      journal = this.#options.journalFor(taskId);
      this.#journals.set(taskId, journal);
    }
    return journal;
  }

  #requiredUserDefinition(taskId: string) {
    const definition = this.#definitions.get(taskId);
    if (!definition || definition.state === "deleted") {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (definition.definition.kind !== "user") {
      throw new Error(`Cannot modify system task: ${taskId}`);
    }
    return definition as TaskDefinition & {
      definition: Extract<TaskDefinition["definition"], { kind: "user" }>;
    };
  }

  #requiredView(taskId: string): ScheduledTask {
    const view = this.#views.get(taskId);
    if (!view) throw new Error(`Task not found: ${taskId}`);
    return structuredClone(view);
  }

  #taskForRun(jobRunId: string): string | undefined {
    return this.#taskByRun.get(jobRunId);
  }

  #hostContext(requestId: string): AuthorityCallContext {
    return {
      principal: { kind: "host", component: "anchor-scheduler" },
      requestId,
      deadlineAt: new Date(this.#now().getTime() + 60_000).toISOString(),
    };
  }

  #controlContext(
    requestId: string,
    source: SchedulerControlSource | undefined,
  ): AuthorityCallContext {
    if (!source) return this.#hostContext(requestId);
    return {
      principal: {
        kind: "surface",
        surfacePrincipal: source.ingress.surfacePrincipal,
        connectionId: source.connectionId,
      },
      requestId,
      deadlineAt: new Date(this.#now().getTime() + 60_000).toISOString(),
    };
  }

  #manualSource(
    requestId: string,
    at: string,
    source?: SchedulerControlSource,
  ): TrustedControlSource {
    if (source) {
      return {
        principal: {
          surfacePrincipal: source.ingress.surfacePrincipal,
          deviceId: source.ingress.deviceId,
          connectionId: source.connectionId,
        },
        ingress: structuredClone(source.ingress),
      };
    }
    const surfacePrincipal = "surface:anchor-scheduler";
    const ingress: IngressContext = {
      kind: "first-party",
      surfacePrincipal,
      deviceId: this.#options.deviceId,
      ingressId: requestId,
      receivedAt: at,
    };
    return {
      principal: {
        surfacePrincipal,
        deviceId: this.#options.deviceId,
        connectionId: `connection:${this.#options.deviceId}`,
      },
      ingress,
    };
  }

  #requireAccepting(): void {
    if (!this.#accepting) throw new Error("Scheduler is not accepting commands");
  }

}

/** 已接纳工作的修订：只取身份与派发计划，不含状态，冻结后的状态推进不改变它 */
function acceptedWorkRevision(
  occurrence: Pick<JobOccurrence, "taskId" | "jobRunId" | "scheduledFor" | "taskRevision" | "deliveryPlan">,
): string {
  return protocolDigest("SchedulerAcceptedWork", 1, {
    taskId: occurrence.taskId,
    jobRunId: occurrence.jobRunId,
    scheduledFor: occurrence.scheduledFor,
    taskRevision: occurrence.taskRevision,
    deliveryPlan: occurrence.deliveryPlan,
  });
}

function definitionSource(ingress: IngressContext) {
  const origin =
    ingress.kind === "channel" ? ingress.replyTarget : ingress.turnOrigin?.target;
  return {
    ...(origin ? { origin: structuredClone(origin) } : {}),
    ...(ingress.kind === "channel"
      ? { interactionResponder: structuredClone(ingress.responder) }
      : {}),
    createdInTurn: ingress.ingressId,
  };
}

function projectUserTask(input: TaskRuntimeProjection): ScheduledTask {
  const definition = input.definition as TaskDefinition & {
    definition: Extract<TaskDefinition["definition"], { kind: "user" }>;
  };
  const last = input.last;
  const failures = input.consecutiveFailures;
  return {
    id: definition.taskId,
    taskRevision: definition.taskRevision,
    name: definition.definition.spec.name,
    ...(definition.definition.spec.description
      ? { description: definition.definition.spec.description }
      : {}),
    enabled: definition.state === "enabled",
    priority: definition.definition.spec.priority,
    schedule: structuredClone(definition.definition.spec.schedule),
    action: structuredClone(definition.definition.spec.action),
    ...definitionDeliveryToTask(definition.definition.spec.delivery),
    ...(definition.definition.origin
      ? { origin: structuredClone(definition.definition.origin) }
      : {}),
    ...(definition.definition.createdInTurn
      ? { createdInTurn: definition.definition.createdInTurn }
      : {}),
    state: {
      consecutiveErrors: failures,
      runCount: input.runCount,
      ...(last ? { lastRunAt: last.scheduledFor } : {}),
      ...(last?.state === "committed" && !isScheduleFailure(last)
        ? { lastStatus: "ok" as const, lastSummary: last.outcome?.summary ?? "Scheduled job completed." }
        : last && TERMINAL_STATES.has(last.state as never)
          ? {
              lastStatus: last.state === "missed" ? "skipped" as const : "error" as const,
              lastError: last.outcome?.summary ?? `Scheduled job ended as ${last.state}.`,
              ...(last.state === "missed"
                ? { lastMissed: { scheduledFor: last.scheduledFor, detectedAt: input.updatedAt } }
                : {}),
            }
          : {}),
    },
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function projectSystemTask(
  input: TaskRuntimeProjection,
  supplied: {
    readonly name: string;
    readonly schedule: TaskSchedule;
    readonly priority: TaskPriority;
    readonly description?: string;
  } | undefined,
  previous: ScheduledTask | undefined,
): ScheduledTask {
  const definition = input.definition as TaskDefinition & {
    definition: Extract<TaskDefinition["definition"], { kind: "system" }>;
  };
  const last = input.last;
  const name = supplied?.name ?? previous?.name ?? definition.definition.handler;
  const schedule = supplied?.schedule ?? previous?.schedule;
  if (!schedule) {
    throw new Error(`System task ${definition.taskId} has no registered schedule`);
  }
  return {
    id: definition.taskId,
    taskRevision: definition.taskRevision,
    name,
    ...(supplied?.description ?? previous?.description
      ? { description: supplied?.description ?? previous?.description }
      : {}),
    enabled: definition.state === "enabled",
    priority: supplied?.priority ?? previous?.priority ?? "low",
    schedule: structuredClone(schedule),
    action: {
      kind: "system",
      handler: definition.definition.handler,
      ...(definition.definition.params && typeof definition.definition.params === "object"
        ? { params: structuredClone(definition.definition.params) as Record<string, unknown> }
        : {}),
    },
    system: true,
    state: {
      consecutiveErrors: input.consecutiveFailures,
      runCount: input.runCount,
      ...(last ? { lastRunAt: last.scheduledFor } : {}),
      ...(last?.state === "committed"
        ? { lastStatus: "ok" as const }
        : last && TERMINAL_STATES.has(last.state as never)
          ? { lastStatus: "error" as const, lastError: `System job ended as ${last.state}.` }
          : {}),
    },
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function systemView(spec: AnchorSystemTaskSpec) {
  return {
    name: spec.name,
    schedule: structuredClone(spec.schedule),
    priority: spec.priority ?? ("low" as const),
    ...(spec.description ? { description: spec.description } : {}),
  };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function scheduleTaskIdForRequest(requestId: string): string {
  return `task-${shortHash(requestId)}`;
}

function taskDeliveryToDefinition(
  delivery: ScheduledTask["delivery"],
): Extract<TaskDefinition["definition"], { kind: "user" }>["spec"]["delivery"] {
  if (!delivery) return undefined;
  if (delivery.kind === "none") return { kind: "none" };
  if (delivery.kind === "channel") {
    return {
      kind: "channel",
      channel: delivery.channel,
      to: delivery.to,
      ...(delivery.threadId ? { threadId: delivery.threadId } : {}),
    };
  }
  return { kind: "webhook", endpoint: delivery.endpoint };
}

function definitionDeliveryToTask(
  delivery: Extract<TaskDefinition["definition"], { kind: "user" }>["spec"]["delivery"],
): Pick<ScheduledTask, "delivery"> | Record<string, never> {
  if (!delivery) return {};
  if (delivery.kind === "none") return { delivery: { kind: "none" } };
  if (delivery.kind === "channel") {
    return {
      delivery: {
        kind: "channel",
        channel: delivery.channel,
        to: delivery.to,
        ...(delivery.threadId ? { threadId: delivery.threadId } : {}),
      },
    };
  }
  return { delivery: { kind: "webhook", endpoint: delivery.endpoint } };
}

function boundedPositive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}
