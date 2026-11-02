import type { SchedulerEventMap } from "@zhixing/core/scheduler";
import { countScheduleConsecutiveFailures, type ScheduleOccurrence } from "@zhixing/core/scheduler/application";
import { createEventBus } from "@zhixing/core";
import { currentDeviceCapacityStep, currentMaintenanceAbortSignal, currentMaintenanceUrgency, emptyDeviceCapacityBudget,
  isHoldingMaintenanceExclusion, runHoldingMaintenanceExclusion, runWithMaintenanceUrgency, StorageMaintenanceAdmissionError, withDeviceCapacityStep } from "@zhixing/core/resources";
import type {
  JobOccurrence,
  JobRunState,
  TaskDefinition,
} from "@zhixing/core/contracts";
import { compareJobOccurrences, protocolDigest } from "@zhixing/core/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ControlAdmissionJournal } from "../control-admission.js";
import type { JobJournal, JobLifecycleEvent } from "../job-assignment.js";
import { AnchorScheduler } from "../scheduler-authority.js";

const TERMINAL = new Set<string>(["committed", "failed", "cancelled", "expired", "missed"]);

class MemoryJobJournal {
  definition: TaskDefinition | undefined;
  runs: ScheduleOccurrence[] = [];
  readonly resumeSystemJobs = vi.fn(async () => {});
  readonly statusListeners = new Set<() => void>();
  readonly lifecycleListeners = new Set<
    (event: JobLifecycleEvent) => void | Promise<void>
  >();
  readonly triggerCalls: Array<{
    readonly jobRunId: string;
    readonly scheduledFor: string;
    readonly source: "user" | "system";
  }> = [];
  readonly controlRuns = new Map<string, string>();
  readonly missedNextFireByRun = new Map<string, {
    readonly t: "missed-next-fire";
    readonly jobRunId: string;
    readonly taskRevision: number;
    readonly readyBoundary: string;
    readonly nextFire?: string;
  }>();
  readonly failurePolicyByRun = new Map<string, {
    readonly t: "failure-policy";
    readonly jobRunId: string;
    readonly taskRevision: number;
    readonly statusRevision: number;
    readonly failureCount: number;
    readonly threshold: number;
    readonly nextFire?: string;
    readonly autoDisableRequired: boolean;
  }>();
  readonly settledAutoDisable = new Set<string>();
  readonly runSystem = vi.fn(async (jobRunId: string) => {
    this.setState(jobRunId, "committed");
    return "committed" as const;
  });

  async taskDefinition() {
    return this.definition ? structuredClone(this.definition) : undefined;
  }

  #ordered() {
    return structuredClone(this.runs).sort(compareJobOccurrences);
  }

  async openOccurrences() {
    return this.#ordered().filter((run) => !TERMINAL.has(run.state));
  }

  async pendingMissedOccurrences() {
    return this.#ordered().filter((run) => run.state === "missed");
  }

  async scheduleOccurrence(jobRunId: string) {
    return this.#ordered().find((run) => run.jobRunId === jobRunId);
  }

  async schedulerReadView() {
    const ordered = this.#ordered();
    const last = ordered.at(-1);
    return {
      definition: await this.taskDefinition(),
      runCount: ordered.filter((run) => run.state !== "missed").length,
      consecutiveFailures: countScheduleConsecutiveFailures(ordered),
      ...(last ? { last } : {}),
      open: ordered.filter((run) => !TERMINAL.has(run.state)),
    };
  }

  async define(definition: TaskDefinition) {
    this.definition = structuredClone(definition);
  }

  async trigger(input: {
    readonly jobRunId: string;
    readonly scheduledFor: string;
    readonly source: "user" | "system";
    readonly disposition?: "missed-offline";
    readonly missedNextFire?: {
      readonly readyBoundary: string;
      readonly nextFire?: string;
    };
  }) {
    this.triggerCalls.push(structuredClone(input));
    const existing = this.runs.find((run) => run.jobRunId === input.jobRunId);
    if (existing) return structuredClone(existing);
    const occurrence: JobOccurrence = {
      taskId: this.definition!.taskId,
      jobRunId: input.jobRunId,
      scheduledFor: input.scheduledFor,
      taskRevision: this.definition!.taskRevision,
      deliveryPlan: { delivery: { kind: "none" }, planDigest: "none" },
      state: input.disposition === "missed-offline" ? "missed" : "queued",
    };
    this.runs.push(occurrence);
    if (input.missedNextFire) {
      this.missedNextFireByRun.set(input.jobRunId, {
        t: "missed-next-fire",
        jobRunId: input.jobRunId,
        taskRevision: occurrence.taskRevision,
        readyBoundary: input.missedNextFire.readyBoundary,
        ...(input.missedNextFire.nextFire
          ? { nextFire: input.missedNextFire.nextFire }
          : {}),
      });
    }
    this.emitState(occurrence);
    return structuredClone(occurrence);
  }

  async schedulerPolicy() {
    return {
      missedNextFireByRun: new Map(this.missedNextFireByRun),
      failurePolicyByRun: new Map(this.failurePolicyByRun),
      pendingAutoDisable: [...this.failurePolicyByRun.values()].filter(
        (policy) =>
          policy.autoDisableRequired &&
          !this.settledAutoDisable.has(policy.jobRunId),
      ),
    };
  }

  async settleSchedulerAutoDisable(input: { readonly jobRunId: string }) {
    this.settledAutoDisable.add(input.jobRunId);
  }

  async applyControl(input: {
    readonly envelope: { readonly requestId: string };
  }) {
    let jobRunId = this.controlRuns.get(input.envelope.requestId);
    if (!jobRunId) {
      jobRunId = `job:${input.envelope.requestId}`;
      this.controlRuns.set(input.envelope.requestId, jobRunId);
      await this.trigger({
        jobRunId,
        scheduledFor: "2026-08-02T00:00:00.000Z",
        source: "user",
      });
    }
    return {
      kind: "applied" as const,
      result: {
        status: "ok" as const,
        body: { t: "job-run" as const, jobRunId },
      },
    };
  }

  async occurrence(jobRunId: string) {
    const occurrence = this.runs.find((item) => item.jobRunId === jobRunId);
    return occurrence ? structuredClone(occurrence) : undefined;
  }

  readonly currentState = vi.fn(async (jobRunId: string) =>
    this.runs.find((item) => item.jobRunId === jobRunId)?.state,
  );

  async cancel(input: { readonly jobRunId: string }) {
    const occurrence = this.runs.find(
      (item) => item.jobRunId === input.jobRunId,
    );
    if (!occurrence) throw new Error("unknown occurrence");
    this.setState(input.jobRunId, "cancelled");
    for (const listener of this.statusListeners) listener();
    return { state: "cancelled" as const };
  }

  onStatus(listener: () => void) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onLifecycle(listener: (event: JobLifecycleEvent) => void | Promise<void>) {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  setState(jobRunId: string, state: JobRunState): void {
    const occurrence = this.runs.find((item) => item.jobRunId === jobRunId);
    if (!occurrence) return;
    occurrence.state = state;
    this.emitState(occurrence);
  }

  private emitState(occurrence: JobOccurrence): void {
    const event: JobLifecycleEvent = {
      kind: "job-state-changed",
      ref: {
        execution: "job",
        taskId: occurrence.taskId,
        jobRunId: occurrence.jobRunId,
        anchorEpoch: 3,
      },
      state: occurrence.state,
      statusRevision: occurrence.state === "queued" ? 1 : 2,
      at: "2026-08-02T00:00:00.000Z",
    };
    for (const listener of this.lifecycleListeners) void listener(event);
  }
}

function fixture(input: {
  journals?: Map<string, MemoryJobJournal>;
  systemTasks?: ConstructorParameters<typeof AnchorScheduler>[0]["systemTasks"];
  activateUserJob?: ConstructorParameters<typeof AnchorScheduler>[0]["activateUserJob"];
  schedulerNotices?: ConstructorParameters<typeof AnchorScheduler>[0]["schedulerNotices"];
  recoverUserJobs?: ConstructorParameters<typeof AnchorScheduler>[0]["recoverUserJobs"];
  onError?: (error: Error) => void;
} = {}) {
  const journals = input.journals ?? new Map<string, MemoryJobJournal>();
  const eventBus = createEventBus<SchedulerEventMap>();
  const scheduler = new AnchorScheduler({
    anchorEpoch: 3,
    deviceId: "anchor-device",
    admission: {} as ControlAdmissionJournal,
    eventBus,
    listTaskIds: async () => [...journals.keys()],
    journalFor: (taskId) => {
      let journal = journals.get(taskId);
      if (!journal) {
        journal = new MemoryJobJournal();
        journals.set(taskId, journal);
      }
      return journal as unknown as JobJournal;
    },
    activateUserJob: input.activateUserJob ?? (async () => {}),
    ...(input.recoverUserJobs ? { recoverUserJobs: input.recoverUserJobs } : {}),
    systemTasks: input.systemTasks ?? new Map(),
    ...(input.schedulerNotices ? { schedulerNotices: input.schedulerNotices } : {}),
    ...(input.onError ? { onError: input.onError } : {}),
    pollMs: 60_000,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
  });
  return { scheduler, journals, eventBus };
}

describe("AnchorScheduler authority", () => {
  it.each([
    ['activate', false], ['activate', true],
    ['resumeAfterAuthorityTransfer', false], ['resumeAfterAuthorityTransfer', true],
  ] as const)("%s owns recovery after the previous caller ends (permit=%s)", async (entry, withPermit) => {
    const journal = new MemoryJobJournal();
    journal.definition = {
      taskId: 'task-1', taskRevision: 1, state: 'enabled',
      definition: { kind: 'user', spec: { name: 'daily', enabled: true, priority: 'normal',
        schedule: { kind: 'interval', everyMs: 60_000 }, action: { kind: 'agent-turn', prompt: 'summarize' } } },
    };
    const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const callerAbort = new AbortController(), onError = vi.fn();
    let observing = false, observed: unknown;
    const recoverUserJobs = vi.fn(async () => {
      if (!observing) return;
      reached.resolve();
      await release.promise;
      observed = { capacity: currentDeviceCapacityStep(), exclusion: isHoldingMaintenanceExclusion(),
        urgency: currentMaintenanceUrgency(), aborted: currentMaintenanceAbortSignal().aborted };
    });
    const { scheduler } = fixture({ journals: new Map([['task-1', journal]]), recoverUserJobs, onError });
    try {
      await scheduler.start();
      await scheduler.pauseForAuthorityTransfer();
      observing = true;
      const caller = () => runWithMaintenanceUrgency(() => 'foreground', callerAbort.signal, async () => {
        scheduler[entry]();
        scheduler[entry](); // A repeated resume must not launch a second recovery owner.
      });
      if (withPermit) {
        const bound = emptyDeviceCapacityBudget();
        await withDeviceCapacityStep({ granted: bound, release() {}, tryBegin: () => ({ claim() {}, complete() {} }) },
          bound, () => runHoldingMaintenanceExclusion(caller));
      } else await caller();
      await reached.promise;
      callerAbort.abort(new Error('Previous transfer owner ended'));
      let paused = false;
      const pause = scheduler.pauseForAuthorityTransfer().then(() => { paused = true; });
      await Promise.resolve();
      expect(paused).toBe(false);
      release.resolve();
      await pause;
      expect(onError).not.toHaveBeenCalled();
      expect(observed).toEqual({ capacity: undefined, exclusion: false, urgency: 'background', aborted: false });
      expect(recoverUserJobs).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await scheduler.stop();
    }
  });

  it("detaches timer and queued wakeups from released caller permits and reports background failures", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { scheduler } = fixture({ onError });
    const observed: unknown[] = [];
    const failure = new Error("background failure");
    const tick = vi.spyOn(scheduler, "tick").mockImplementation(async () => {
      observed.push({ capacity: currentDeviceCapacityStep(), excluded: isHoldingMaintenanceExclusion(),
        urgency: currentMaintenanceUrgency() });
      throw failure;
    });
    const bound = emptyDeviceCapacityBudget();
    try {
      await withDeviceCapacityStep({ granted: bound, release() {}, tryBegin: () => ({ claim() {}, complete() {} }) },
        bound, () => runHoldingMaintenanceExclusion(() => scheduler.start()));
      await vi.advanceTimersByTimeAsync(60_000);
      scheduler.wakeQueuedUserJobs();
      await vi.advanceTimersByTimeAsync(1);
      expect(tick).toHaveBeenCalledTimes(2);
      expect(observed).toEqual(Array.from({ length: 2 }, () => ({ capacity: undefined, excluded: false, urgency: "background" })));
      expect(onError).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledWith(failure);
    } finally {
      await scheduler.stop();
      vi.useRealTimers();
    }
  });
  it("freezes the exact active scheduler run before lifecycle settlement", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const journal = new MemoryJobJournal();
    journal.definition = {
      taskId: "task-stop",
      taskRevision: 1,
      state: "enabled",
      definition: {
        kind: "user",
        spec: {
          name: "stop-aware",
          enabled: true,
          priority: "normal",
          schedule: { kind: "interval", everyMs: 60_000 },
          action: { kind: "agent-turn", prompt: "finish me" },
        },
        createdInTurn: "turn-stop",
      },
    };
    const { scheduler } = fixture({
      journals: new Map([["task-stop", journal]]),
      activateUserJob: async ({ occurrence }) => {
        markStarted();
        await gate;
        journal.setState(occurrence.jobRunId, "committed");
      },
    });
    await scheduler.start();
    const run = scheduler.runTask("task-stop", "manual-stop");
    await started;
    await expect(scheduler.acceptedWorkItems()).resolves.toEqual([
      expect.objectContaining({ id: "job:manual-stop" }),
    ]);
    scheduler.closeAdmissionForLifecycle();
    await expect(scheduler.runTask("task-stop", "late-run"))
      .rejects.toThrow("Scheduler is not accepting commands");
    release();
    await scheduler.pauseForAuthorityTransfer();
    await expect(run).resolves.toMatchObject({ status: "ok" });
    await expect(scheduler.acceptedWorkItems()).resolves.toEqual([]);
    await scheduler.stop();
  });

  it("recovers only the exact scheduler generation frozen by lifecycle state", async () => {
    const journal = new MemoryJobJournal();
    journal.definition = {
      taskId: "task-recovery",
      taskRevision: 1,
      state: "enabled",
      definition: {
        kind: "user",
        spec: {
          name: "recovery task",
          enabled: true,
          priority: "normal",
          schedule: { kind: "interval", everyMs: 60_000 },
          action: { kind: "agent-turn", prompt: "resume" },
        },
      },
    };
    const occurrence: JobOccurrence = {
      taskId: "task-recovery",
      jobRunId: "job-recovery",
      scheduledFor: "2026-08-02T00:00:00.000Z",
      taskRevision: 1,
      deliveryPlan: { delivery: { kind: "none" }, planDigest: "none" },
      state: "queued",
    };
    journal.runs.push(occurrence);
    const recoverUserJobs = vi.fn(async () => undefined);
    const { scheduler } = fixture({
      journals: new Map([["task-recovery", journal]]),
      recoverUserJobs,
    });
    const revision = protocolDigest("SchedulerAcceptedWork", 1, {
      taskId: occurrence.taskId,
      jobRunId: occurrence.jobRunId,
      scheduledFor: occurrence.scheduledFor,
      taskRevision: occurrence.taskRevision,
      deliveryPlan: occurrence.deliveryPlan,
    });

    await scheduler.recoverAcceptedWorkForLifecycle([
      { id: occurrence.jobRunId, revision },
    ]);
    expect(recoverUserJobs).toHaveBeenCalledWith(
      expect.anything(),
      new Set([occurrence.jobRunId]),
    );

    await expect(
      scheduler.recoverAcceptedWorkForLifecycle([
        { id: occurrence.jobRunId, revision: `${revision}-successor` },
      ]),
    ).rejects.toThrow("unfrozen accepted-work generation");
    await scheduler.stop();
  });

  describe("停止冻结与启动恢复同源", () => {
    const at = "2026-08-02T00:00:00.000Z";
    const occurrenceOf = (taskId: string, jobRunId: string, state: JobRunState): JobOccurrence => ({
      taskId, jobRunId, scheduledFor: at, taskRevision: 1, deliveryPlan: { delivery: { kind: "none" }, planDigest: "none" }, state,
    });
    const revisionOf = (occurrence: JobOccurrence) => protocolDigest("SchedulerAcceptedWork", 1, {
      taskId: occurrence.taskId, jobRunId: occurrence.jobRunId, scheduledFor: occurrence.scheduledFor,
      taskRevision: occurrence.taskRevision, deliveryPlan: occurrence.deliveryPlan,
    });
    const systemJournal = () => {
      const journal = new MemoryJobJournal();
      journal.definition = { taskId: "__transcript-gc", taskRevision: 1, state: "enabled", definition: { kind: "system", handler: "__transcript-gc" } };
      return journal;
    };
    const userJournal = (taskId: string) => {
      const journal = new MemoryJobJournal();
      journal.definition = { taskId, taskRevision: 1, state: "enabled", definition: { kind: "user", spec: {
        name: taskId, enabled: true, priority: "normal", schedule: { kind: "interval", everyMs: 60_000 }, action: { kind: "agent-turn", prompt: "p" },
      } } };
      return journal;
    };
    const systemTasks = new Map([["__transcript-gc", {
      id: "__transcript-gc", name: "transcript-gc", handler: "__transcript-gc", schedule: { kind: "interval" as const, everyMs: 60_000 },
    }]]);

    it("排队中的系统任务发生随冻结交接：A 停止、B 恢复不再被拒，恢复期间不执行它", async () => {
      const journal = systemJournal();
      journal.runs.push(occurrenceOf("__transcript-gc", "system-open", "queued"));
      const journals = new Map([["__transcript-gc", journal]]);
      const first = fixture({ journals, systemTasks });
      await first.scheduler.prepare();
      first.scheduler.activate();
      await vi.waitFor(() => expect(journal.resumeSystemJobs).toHaveBeenCalledOnce());
      first.scheduler.closeAdmissionForLifecycle();
      const frozen = await first.scheduler.acceptedWorkItems();
      expect(frozen.map((item) => item.id)).toEqual(["system-open"]);
      await first.scheduler.pauseForAuthorityTransfer();
      expect(first.scheduler.inProcessWork()).toEqual([]);
      await first.scheduler.stop();

      const second = fixture({ journals, systemTasks });
      await expect(second.scheduler.recoverAcceptedWorkForLifecycle(frozen)).resolves.toBeUndefined();
      // 系统发生只核对，交给激活后的恢复在后台执行
      expect(journal.resumeSystemJobs).toHaveBeenCalledOnce();
      await second.scheduler.stop();
    });

    it("关准入与在飞的运行控制提交交错：冻结等提交收束并含其发生，关准入后不再激活", async () => {
      const journal = userJournal("task-run");
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      const apply = journal.applyControl.bind(journal);
      journal.applyControl = (async (input: Parameters<typeof apply>[0]) => { entered(); await gate; return apply(input); }) as typeof journal.applyControl;
      const activateUserJob = vi.fn(async () => {});
      const { scheduler } = fixture({ journals: new Map([["task-run", journal]]), activateUserJob });
      await scheduler.prepare();
      scheduler.activate();
      const run = scheduler.runTask("task-run", "req-1");
      await inside;
      scheduler.closeAdmissionForLifecycle();
      let frozenReady = false;
      const capture = scheduler.acceptedWorkItems().then((items) => { frozenReady = true; return items; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(frozenReady).toBe(false);
      release();
      const frozen = await capture;
      expect(frozen.map((item) => item.id)).toEqual(["job:req-1"]);
      expect(activateUserJob).not.toHaveBeenCalled();
      await expect(run).resolves.toMatchObject({ status: "error" });
      await scheduler.stop();
    });

    it("冻结时在跑、冻结后正常终结的发生：B 精确读到已终结即确认已结，不再执行", async () => {
      const system = systemJournal(), user = userJournal("task-user");
      system.runs.push(occurrenceOf("__transcript-gc", "system-running", "running"));
      user.runs.push(occurrenceOf("task-user", "user-running", "running"));
      const journals = new Map<string, MemoryJobJournal>([["__transcript-gc", system], ["task-user", user]]);
      const first = fixture({ journals, systemTasks });
      await first.scheduler.prepare();
      const frozen = await first.scheduler.acceptedWorkItems();
      expect(frozen.map((item) => item.id)).toEqual(["system-running", "user-running"]);
      await first.scheduler.stop();
      system.setState("system-running", "committed");
      user.setState("user-running", "committed");

      const recoverUserJobs = vi.fn(async () => undefined);
      const second = fixture({ journals, systemTasks, recoverUserJobs });
      await expect(second.scheduler.recoverAcceptedWorkForLifecycle(frozen)).resolves.toBeUndefined();
      expect(recoverUserJobs).not.toHaveBeenCalled();
      expect(system.resumeSystemJobs).not.toHaveBeenCalled();
      await second.scheduler.stop();
    });

    it("未冻结的新代际、错修订、找不到、终结修订冲突仍明确拒绝", async () => {
      const journal = userJournal("task-reject");
      const open = occurrenceOf("task-reject", "open-run", "queued");
      journal.runs.push(open, occurrenceOf("task-reject", "done-run", "committed"));
      const journals = new Map([["task-reject", journal]]);
      const recover = async (frozen: readonly { id: string; revision: string }[]) => {
        const { scheduler } = fixture({ journals, recoverUserJobs: vi.fn(async () => undefined) });
        try { await scheduler.recoverAcceptedWorkForLifecycle(frozen); } finally { await scheduler.stop(); }
      };
      await expect(recover([])).rejects.toThrow("unfrozen accepted-work generation");
      await expect(recover([{ id: "open-run", revision: "other" }])).rejects.toThrow("unfrozen accepted-work generation");
      const exact = { id: "open-run", revision: revisionOf(open) };
      await expect(recover([exact, { id: "ghost-run", revision: "r" }])).rejects.toThrow("does not bind current durable work");
      await expect(recover([exact, { id: "done-run", revision: "other" }])).rejects.toThrow("conflicts with current durable work");
      await expect(recover([exact])).resolves.toBeUndefined();
    });

    // 激活恢复在读取调度策略时暂停，用来确定地在“已进入恢复、尚未开始处理器/派发”之间关准入
    const pausePolicy = (journal: MemoryJobJournal) => {
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      const policy = journal.schedulerPolicy.bind(journal);
      // prepare 也会读策略：准备完成后才布防，只拦激活恢复的那一次
      let armed = false;
      journal.schedulerPolicy = (async (...args: Parameters<typeof policy>) => {
        if (armed) { armed = false; entered(); await gate; }
        return policy(...args);
      }) as typeof journal.schedulerPolicy;
      return { arm: () => { armed = true; }, inside, release };
    };

    it.each(["system", "user"] as const)("%s 激活恢复等待中关准入：冻结后放开，不再开始处理器或恢复派发，排队发生交接给下一宿主", async (kind) => {
      const journal = kind === "system" ? systemJournal() : userJournal("task-late");
      const taskId = kind === "system" ? "__transcript-gc" : "task-late";
      journal.runs.push(occurrenceOf(taskId, "late-open", "queued"));
      const paused = pausePolicy(journal);
      const recoverUserJobs = vi.fn(async () => undefined);
      const journals = new Map([[taskId, journal]]);
      const first = fixture({ journals, systemTasks, recoverUserJobs });
      await first.scheduler.prepare();
      paused.arm();
      first.scheduler.activate();
      await paused.inside;
      first.scheduler.closeAdmissionForLifecycle();
      const frozen = await first.scheduler.acceptedWorkItems();
      expect(frozen.map((item) => item.id)).toEqual(["late-open"]);
      paused.release();
      await first.scheduler.pauseForAuthorityTransfer();
      expect(journal.resumeSystemJobs).not.toHaveBeenCalled();
      expect(recoverUserJobs).not.toHaveBeenCalled();
      expect(first.scheduler.inProcessWork()).toEqual([]);
      await first.scheduler.stop();
      const second = fixture({ journals, systemTasks, recoverUserJobs: vi.fn(async () => undefined) });
      await expect(second.scheduler.recoverAcceptedWorkForLifecycle(frozen)).resolves.toBeUndefined();
      await second.scheduler.stop();
    });

    it("关闭后再开放：上一代晚到的续行不重新开工，新一代照常只执行一次", async () => {
      const journal = systemJournal();
      journal.runs.push(occurrenceOf("__transcript-gc", "regen-open", "queued"));
      const paused = pausePolicy(journal);
      const { scheduler } = fixture({ journals: new Map([["__transcript-gc", journal]]), systemTasks });
      await scheduler.prepare();
      paused.arm();
      scheduler.activate();
      await paused.inside;
      scheduler.closeAdmissionForLifecycle();
      scheduler.activate();
      paused.release();
      await vi.waitFor(() => expect(journal.resumeSystemJobs).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(journal.resumeSystemJobs).toHaveBeenCalledOnce();
      await scheduler.stop();
    });

    it.each(["old-first", "new-first"] as const)("换代收束（%s）：迁居暂停与停止等全部激活恢复回合退出，返回后旧回合不再读取", async (order) => {
      const journal = systemJournal();
      journal.runs.push(occurrenceOf("__transcript-gc", "join-open", "queued"));
      const paused = pausePolicy(journal);
      let reads = 0;
      const view = journal.schedulerReadView.bind(journal);
      journal.schedulerReadView = (async (...args: Parameters<typeof view>) => { reads += 1; return view(...args); }) as typeof journal.schedulerReadView;
      const { scheduler } = fixture({ journals: new Map([["__transcript-gc", journal]]), systemTasks });
      await scheduler.prepare();
      paused.arm();
      scheduler.activate();
      await paused.inside;
      scheduler.closeAdmissionForLifecycle();
      scheduler.activate();
      if (order === "old-first") paused.release();
      await vi.waitFor(() => expect(journal.resumeSystemJobs).toHaveBeenCalledOnce());
      let pauseReturned = false;
      const pause = scheduler.pauseForAuthorityTransfer().then(() => { pauseReturned = true; });
      if (order === "new-first") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(pauseReturned).toBe(false);
        expect(scheduler.inProcessWork()).toContain("activation-recovery");
        paused.release();
      }
      await pause;
      expect(scheduler.inProcessWork()).toEqual([]);
      await scheduler.stop();
      const settledReads = reads;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(reads).toBe(settledReads);
      expect(journal.resumeSystemJobs).toHaveBeenCalledOnce();
    });

    it("在飞的取消在关准入后照常收束，冻结等它结束且与结果一致", async () => {
      const journal = userJournal("task-cancel");
      journal.runs.push(occurrenceOf("task-cancel", "cancel-me", "queued"));
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      const cancel = journal.cancel.bind(journal);
      journal.cancel = (async (input: Parameters<typeof cancel>[0]) => { entered(); await gate; return cancel(input); }) as typeof journal.cancel;
      // 这个替身的 applyControl 不区分控制种类；取消控制只需被接纳，不产生新的发生
      journal.applyControl = (async () => ({ kind: "applied" as const, result: { status: "ok" as const, body: { t: "job-cancel" as const } } })) as unknown as typeof journal.applyControl;
      const { scheduler } = fixture({ journals: new Map([["task-cancel", journal]]) });
      await scheduler.prepare();
      scheduler.activate();
      const aborted = scheduler.abortRun("cancel-me", "cancel-1");
      await inside;
      scheduler.closeAdmissionForLifecycle();
      let frozenReady = false;
      const capture = scheduler.acceptedWorkItems().then((items) => { frozenReady = true; return items; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(frozenReady).toBe(false);
      release();
      await expect(aborted).resolves.toBe(true);
      expect((await capture).map((item) => item.id)).toEqual([]);
      await scheduler.stop();
    });

    it("追踪中的用户运行仍按结清收尾：在它到终态前本进程物理工作不空，迁居暂停等它", async () => {
      const journal = userJournal("task-drain");
      journal.runs.push(occurrenceOf("task-drain", "user-active", "queued"));
      const { scheduler } = fixture({ journals: new Map([["task-drain", journal]]) });
      await scheduler.prepare();
      scheduler.activate();
      await vi.waitFor(() => expect(scheduler.inProcessWork()).toContain("user-active"));
      let paused = false;
      const pause = scheduler.pauseForAuthorityTransfer().then(() => { paused = true; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(paused).toBe(false);
      journal.setState("user-active", "committed");
      await pause;
      expect(scheduler.inProcessWork()).toEqual([]);
      await scheduler.stop();
    });
  });

  it("prepares projections without recovery side effects and activates asynchronously", async () => {
    let releaseRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const journal = new MemoryJobJournal();
    journal.definition = {
      taskId: "__transcript-gc",
      taskRevision: 1,
      state: "enabled",
      definition: { kind: "system", handler: "__transcript-gc" },
    };
    journal.resumeSystemJobs.mockImplementation(async () => recoveryGate);
    const systemTasks = new Map([
      [
        "__transcript-gc",
        {
          id: "__transcript-gc",
          name: "transcript-gc",
          handler: "__transcript-gc",
          schedule: { kind: "interval" as const, everyMs: 60_000 },
        },
      ],
    ]);
    const { scheduler } = fixture({
      journals: new Map([["__transcript-gc", journal]]),
      systemTasks,
    });

    await scheduler.prepare();
    expect(journal.resumeSystemJobs).not.toHaveBeenCalled();
    await expect(
      scheduler.runTask("__transcript-gc", "before-ready"),
    ).rejects.toThrow("Scheduler is not accepting commands");

    scheduler.activate();
    await vi.waitFor(() => expect(journal.resumeSystemJobs).toHaveBeenCalledOnce());
    releaseRecovery();
    await scheduler.stop();
  });

  it.each([false, true])("re-drives transient pressure while preparing system tasks outside owner queues (outer exclusion: %s)", async (outerExclusion) => {
    const journal = new MemoryJobJournal();
    const original = journal.define.bind(journal);
    let attempts = 0;
    journal.define = vi.fn(async (definition: TaskDefinition) => {
      attempts += 1;
      if (attempts === 1) throw new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "readBytes", retryAfterMs: 1 }, "projection-scrub");
      return original(definition);
    });
    const systemTasks = new Map([["__transcript-gc", {
      id: "__transcript-gc", name: "transcript-gc", handler: "__transcript-gc",
      schedule: { kind: "interval" as const, everyMs: 60_000 },
    }]]);
    const { scheduler } = fixture({ journals: new Map([["__transcript-gc", journal]]), systemTasks });
    const prepare = outerExclusion
      ? runHoldingMaintenanceExclusion(() => scheduler.prepare())
      : scheduler.prepare();
    if (outerExclusion) {
      // 外层所有者仍持有排他时不在内部等待，背压原样交还给它。
      await expect(prepare).rejects.toBeInstanceOf(StorageMaintenanceAdmissionError);
      expect(attempts).toBe(1);
      expect(journal.definition).toBeUndefined();
    } else {
      await prepare;
      expect(attempts).toBe(2);
      expect(journal.definition?.definition).toEqual({ kind: "system", handler: "__transcript-gc" });
    }
    await scheduler.stop();
  });

  it.each(["completed", "failed"] as const)("publishes the durable identity and actual committed %s result", async (status) => {
    const journal = new MemoryJobJournal();
    let accepted: { taskId: string; jobRunId: string; name: string } | undefined;
    const activateUserJob = vi.fn(async ({ occurrence }: { occurrence: JobOccurrence }) => {
      Object.assign(journal.runs.find(run => run.jobRunId === occurrence.jobRunId)!, {
        outcome: { status, summary: "actual job result" },
      });
      journal.setState(occurrence.jobRunId, "committed");
    });
    const { scheduler, eventBus } = fixture({
      journals: new Map([["task-1", journal]]),
      activateUserJob,
    });
    journal.definition = {
      taskId: "task-1",
      taskRevision: 1,
      state: "enabled",
      definition: {
        kind: "user",
        spec: {
          name: "daily",
          enabled: true,
          priority: "normal",
          schedule: { kind: "interval", everyMs: 60_000 },
          action: { kind: "agent-turn", prompt: "summarize" },
        },
        createdInTurn: "turn-1",
      },
    };
    eventBus.on("scheduler:task-accepted", (event) => {
      accepted = event;
    });
    const observationContext: unknown[] = [];
    const observe = () => { observationContext.push(currentDeviceCapacityStep()); };
    const completed = vi.fn(observe), failed = vi.fn(observe);
    eventBus.on("scheduler:task-completed", completed);
    eventBus.on("scheduler:task-failed", failed);
    await scheduler.start();
    expect(journal.lifecycleListeners.size).toBe(1);
    expect(journal.statusListeners.size).toBe(0);
    const bound = emptyDeviceCapacityBudget();
    const result = await withDeviceCapacityStep({ granted: bound, release() {},
      tryBegin: () => ({ claim() {}, complete() {} }) }, bound,
      () => scheduler.runTask("task-1", "manual-1"));

    expect(accepted).toEqual({
      taskId: "task-1",
      jobRunId: "job:manual-1",
      name: "daily",
    });
    expect(result.status).toBe(status === "completed" ? "ok" : "error");
    expect(status === "completed" ? result.output : result.error).toBe("actual job result");
    await vi.waitFor(() => expect(status === "completed" ? completed : failed).toHaveBeenCalledOnce());
    expect(status === "completed" ? failed : completed).not.toHaveBeenCalled();
    expect(observationContext).toEqual([undefined]);
    expect(scheduler.getTask("task-1")!.state).toMatchObject({
      lastStatus: status === "completed" ? "ok" : "error", consecutiveErrors: status === "completed" ? 0 : 1,
    });
    await expect(scheduler.runTask("task-1", "manual-1")).resolves.toEqual(result);
    expect(journal.controlRuns).toEqual(new Map([["manual-1", "job:manual-1"]]));
    expect(journal.triggerCalls).toHaveLength(1);
    expect(activateUserJob).toHaveBeenCalledOnce();
    const readsAfterCompletion = journal.currentState.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(journal.currentState).toHaveBeenCalledTimes(readsAfterCompletion);
    await scheduler.stop();
  });

  it("derives immutable task source from authenticated ingress", async () => {
    const { scheduler, journals } = fixture();
    await scheduler.start();

    const created = await scheduler.createTask(
      {
        name: "daily",
        enabled: true,
        priority: "normal",
        schedule: { kind: "interval", everyMs: 60_000 },
        action: { kind: "agent-turn", prompt: "summarize" },
      },
      "create-daily",
      {
        connectionId: "connection-1",
        ingress: {
          kind: "channel",
          surfacePrincipal: "surface-1",
          responder: {
            channelId: "feishu",
            platformSubject: "user-1",
          },
          replyTarget: {
            channelId: "feishu",
            to: "chat-1",
            threadId: "thread-1",
          },
          deviceId: "device-1",
          ingressId: "ingress-1",
          receivedAt: "2026-08-02T00:00:00.000Z",
        },
      },
    );

    const definition = journals.get(created.id)!.definition!;
    expect(definition).toMatchObject({
      definition: {
        kind: "user",
        origin: { channelId: "feishu", to: "chat-1", threadId: "thread-1" },
        interactionResponder: {
          channelId: "feishu",
          platformSubject: "user-1",
        },
        createdInTurn: "ingress-1",
      },
    });
    await scheduler.stop();
  });

  it("seeds host-only tasks before opening and restores their host registration", async () => {
    const systemTasks = new Map([
      [
        "__transcript-gc",
        {
          id: "__transcript-gc",
          name: "transcript-gc",
          handler: "__transcript-gc",
          schedule: { kind: "cron" as const, expr: "0 3 * * *" },
        },
      ],
    ]);
    const first = fixture({ systemTasks });
    await first.scheduler.start();
    expect(first.scheduler.getTask("__transcript-gc")).toMatchObject({
      id: "__transcript-gc",
      system: true,
      schedule: { kind: "cron", expr: "0 3 * * *" },
    });
    expect(first.scheduler.listTasks()).toEqual([]);
    expect(first.scheduler.listTaskProjections()).toEqual([
      expect.objectContaining({ id: "__transcript-gc", system: true }),
    ]);
    await first.scheduler.stop();

    const restarted = fixture({ journals: first.journals, systemTasks });
    const definitionRead = vi.spyOn(first.journals.get('__transcript-gc')!, 'taskDefinition');
    await restarted.scheduler.prepare();
    // Existing system tasks get the new Host registration in the first pass;
    // preparation must not restore the same journal twice.
    expect(definitionRead).toHaveBeenCalledTimes(1);
    await restarted.scheduler.start();
    expect(restarted.scheduler.getTask("__transcript-gc")).toMatchObject({
      system: true,
      name: "transcript-gc",
    });
    expect(first.journals.get("__transcript-gc")!.resumeSystemJobs).toHaveBeenCalled();
    await restarted.scheduler.stop();
  });

  it("coalesces an offline system interval into one ready-boundary catch-up", async () => {
    const journal = new MemoryJobJournal();
    journal.definition = {
      taskId: "__transcript-gc",
      taskRevision: 1,
      state: "enabled",
      definition: { kind: "system", handler: "__transcript-gc" },
    };
    journal.runs.push({
      taskId: "__transcript-gc",
      jobRunId: "previous",
      scheduledFor: "2026-08-01T00:00:00.000Z",
      taskRevision: 1,
      deliveryPlan: { delivery: { kind: "none" }, planDigest: "none" },
      state: "committed",
    });
    const systemTasks = new Map([
      [
        "__transcript-gc",
        {
          id: "__transcript-gc",
          name: "transcript-gc",
          handler: "__transcript-gc",
          schedule: { kind: "interval" as const, everyMs: 60_000 },
        },
      ],
    ]);
    const { scheduler } = fixture({
      journals: new Map([["__transcript-gc", journal]]),
      systemTasks,
    });

    await scheduler.start();
    await scheduler.tick();
    await scheduler.tick();

    expect(journal.triggerCalls).toHaveLength(1);
    expect(journal.triggerCalls[0]?.scheduledFor).toBe(
      "2026-08-02T00:00:00.000Z",
    );
    expect(journal.runSystem).toHaveBeenCalledTimes(1);
    await scheduler.stop();
  });

  it("freezes one offline user miss and advances directly beyond the ready boundary", async () => {
    const journal = new MemoryJobJournal();
    journal.definition = {
      taskId: "task-1",
      taskRevision: 1,
      state: "enabled",
      definition: {
        kind: "user",
        spec: {
          name: "daily",
          enabled: true,
          priority: "normal",
          schedule: { kind: "interval", everyMs: 60_000 },
          action: { kind: "agent-turn", prompt: "summarize" },
        },
      },
    };
    journal.runs.push({
      taskId: "task-1",
      jobRunId: "previous",
      scheduledFor: "2026-08-01T00:00:00.000Z",
      taskRevision: 1,
      deliveryPlan: { delivery: { kind: "none" }, planDigest: "none" },
      state: "committed",
    });
    const { scheduler } = fixture({
      journals: new Map([["task-1", journal]]),
    });

    await scheduler.start();
    await scheduler.tick();
    await scheduler.tick();

    expect(journal.triggerCalls).toHaveLength(1);
    const policy = [...journal.missedNextFireByRun.values()][0];
    expect(policy?.readyBoundary).toBe("2026-08-02T00:00:00.000Z");
    expect(Date.parse(policy?.nextFire ?? "")).toBeGreaterThan(
      Date.parse(policy!.readyBoundary),
    );
    await scheduler.stop();
  });

  it("redrives a missed summary only after a durable miss hint", async () => {
    vi.useFakeTimers();
    try {
      const journal = new MemoryJobJournal();
      journal.definition = {
        taskId: "task-1",
        taskRevision: 1,
        state: "enabled",
        definition: {
          kind: "user",
          spec: {
            name: "daily",
            enabled: true,
            priority: "normal",
            schedule: { kind: "interval", everyMs: 60_000 },
            action: { kind: "agent-turn", prompt: "summarize" },
          },
        },
      };
      journal.runs.push({
        taskId: "task-1",
        jobRunId: "previous",
        scheduledFor: "2026-08-01T00:00:00.000Z",
        taskRevision: 1,
        deliveryPlan: { delivery: { kind: "none" }, planDigest: "none" },
        state: "committed",
      });
      const prepareMissedSummaries = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("notice projection unavailable"))
        .mockResolvedValue(undefined);
      const onError = vi.fn();
      const { scheduler } = fixture({
        journals: new Map([["task-1", journal]]),
        schedulerNotices: {
          prepareMissedSummaries,
        } as unknown as NonNullable<
          ConstructorParameters<typeof AnchorScheduler>[0]["schedulerNotices"]
        >,
        onError,
      });

      await scheduler.start();
      expect(prepareMissedSummaries).toHaveBeenCalledTimes(1);

      await scheduler.tick();
      expect(prepareMissedSummaries).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "notice projection unavailable" }),
      );

      await scheduler.tick();
      expect(prepareMissedSummaries).toHaveBeenCalledTimes(3);
      await scheduler.tick();
      expect(prepareMissedSummaries).toHaveBeenCalledTimes(3);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("redrives a committed auto-disable obligation to one disabled definition", async () => {
    const journal = new MemoryJobJournal();
    journal.definition = {
      taskId: "task-1",
      taskRevision: 1,
      state: "enabled",
      definition: {
        kind: "user",
        spec: {
          name: "daily",
          enabled: true,
          priority: "normal",
          schedule: { kind: "interval", everyMs: 60_000 },
          action: { kind: "agent-turn", prompt: "summarize" },
        },
      },
    };
    journal.runs.push({
      taskId: "task-1",
      jobRunId: "failed-1",
      scheduledFor: "2026-08-01T00:00:00.000Z",
      taskRevision: 1,
      deliveryPlan: { delivery: { kind: "none" }, planDigest: "none" },
      state: "failed",
    });
    journal.failurePolicyByRun.set("failed-1", {
      t: "failure-policy",
      jobRunId: "failed-1",
      taskRevision: 1,
      statusRevision: 2,
      failureCount: 3,
      threshold: 3,
      autoDisableRequired: true,
    });
    const { scheduler } = fixture({
      journals: new Map([["task-1", journal]]),
    });

    await scheduler.start();

    expect(journal.definition).toMatchObject({
      taskRevision: 2,
      state: "disabled",
    });
    expect(journal.settledAutoDisable).toEqual(new Set(["failed-1"]));
    await scheduler.stop();
  });

  it("deletes the definition before cancelling every in-flight occurrence", async () => {
    const journal = new MemoryJobJournal();
    journal.definition = {
      taskId: "task-1",
      taskRevision: 1,
      state: "enabled",
      definition: {
        kind: "user",
        spec: {
          name: "daily",
          enabled: true,
          priority: "normal",
          schedule: { kind: "interval", everyMs: 60_000 },
          action: { kind: "agent-turn", prompt: "summarize" },
        },
      },
    };
    journal.runs.push(
      {
        taskId: "task-1",
        jobRunId: "queued",
        scheduledFor: "2026-08-02T00:00:00.000Z",
        taskRevision: 1,
        deliveryPlan: { delivery: { kind: "none" }, planDigest: "none" },
        state: "queued",
      },
      {
        taskId: "task-1",
        jobRunId: "running",
        scheduledFor: "2026-08-02T00:01:00.000Z",
        taskRevision: 1,
        deliveryPlan: { delivery: { kind: "none" }, planDigest: "none" },
        state: "running",
      },
    );
    const cancelUserJob = vi.fn(async (input: { jobRunId: string }) => {
      expect(journal.definition?.state).toBe("deleted");
      const occurrence = journal.runs.find(
        (item) => item.jobRunId === input.jobRunId,
      );
      if (occurrence) occurrence.state = "cancelled";
      return { state: "cancelled" };
    });
    const journals = new Map([["task-1", journal]]);
    const eventBus = createEventBus<SchedulerEventMap>();
    const scheduler = new AnchorScheduler({
      anchorEpoch: 3,
      deviceId: "anchor-device",
      admission: {} as ControlAdmissionJournal,
      eventBus,
      listTaskIds: async () => ["task-1"],
      journalFor: () => journal as unknown as JobJournal,
      activateUserJob: async () => {},
      cancelUserJob: cancelUserJob as never,
      pollMs: 60_000,
      now: () => new Date("2026-08-02T00:00:00.000Z"),
    });

    await scheduler.start();
    await scheduler.deleteTask("task-1", "delete-task-1");

    expect(cancelUserJob.mock.calls.map(([input]) => input.jobRunId).sort()).toEqual([
      "queued",
      "running",
    ]);
    expect(scheduler.getTask("task-1")).toBeUndefined();
    await scheduler.stop();
  });

  it("immediately retries a durable queued job when executor readiness is published", async () => {
    const journal = new MemoryJobJournal();
    journal.definition = {
      taskId: "task-ready",
      taskRevision: 1,
      state: "enabled",
      definition: {
        kind: "user",
        spec: {
          name: "ready task",
          enabled: true,
          priority: "normal",
          schedule: { kind: "interval", everyMs: 60_000 },
          action: { kind: "agent-turn", prompt: "continue" },
        },
      },
    };
    const activate = vi.fn(async ({ occurrence }: { occurrence: JobOccurrence }) => {
      journal.setState(occurrence.jobRunId, "committed");
    });
    const { scheduler } = fixture({
      journals: new Map([["task-ready", journal]]),
      activateUserJob: activate as never,
    });
    await scheduler.start();
    journal.runs.push({
      taskId: "task-ready",
      jobRunId: "queued-ready",
      scheduledFor: "2026-08-02T00:00:00.000Z",
      taskRevision: 1,
      deliveryPlan: { delivery: { kind: "none" }, planDigest: "none" },
      state: "queued",
    });
    await scheduler.refreshCommittedDefinitions(["task-ready"]);
    scheduler.wakeQueuedUserJobs();
    await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce());
    expect(activate.mock.calls[0]?.[0].occurrence.jobRunId).toBe("queued-ready");
    await scheduler.stop();
  });
});
