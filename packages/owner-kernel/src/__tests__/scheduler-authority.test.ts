import type { SchedulerEventMap } from "@zhixing/core";
import { createEventBus } from "@zhixing/core";
import type {
  JobOccurrence,
  JobRunState,
  TaskDefinition,
} from "@zhixing/core/contracts";
import { protocolDigest } from "@zhixing/core/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ControlAdmissionJournal } from "../control-admission.js";
import type { JobJournal, JobLifecycleEvent } from "../job-assignment.js";
import { AnchorScheduler } from "../scheduler-authority.js";

class MemoryJobJournal {
  definition: TaskDefinition | undefined;
  runs: JobOccurrence[] = [];
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

  async occurrences() {
    return structuredClone(this.runs);
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

  it("publishes the durable manual job identity before returning its result", async () => {
    const journal = new MemoryJobJournal();
    let accepted: { taskId: string; jobRunId: string; name: string } | undefined;
    const { scheduler, eventBus } = fixture({
      journals: new Map([["task-1", journal]]),
      activateUserJob: async ({ occurrence }) => {
        journal.setState(occurrence.jobRunId, "committed");
      },
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
    await scheduler.start();
    expect(journal.lifecycleListeners.size).toBe(1);
    expect(journal.statusListeners.size).toBe(0);
    const result = await scheduler.runTask(
      "task-1",
      "manual-1",
    );

    expect(accepted).toEqual({
      taskId: "task-1",
      jobRunId: "job:manual-1",
      name: "daily",
    });
    expect(result.status).toBe("ok");
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
    await first.scheduler.stop();

    const restarted = fixture({ journals: first.journals, systemTasks });
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
