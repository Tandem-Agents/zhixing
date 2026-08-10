import {
  MemoryMutationConflictError,
  planJournalLifecycle,
  type JournalAuthorityLifecyclePlan,
  type JournalLifecycleEntry,
  type MemoryLogicalEntry,
} from "@zhixing/core";
import { canonicalize, protocolDigest } from "@zhixing/core/protocol";
import type {
  GlobalControlCallContext,
  GlobalReadCallContext,
  GlobalStatePort,
  SchedulerUserNotice,
} from "@zhixing/core/contracts";
import type {
  JournalMaintenanceNoticePlan,
  JournalMaintenanceNoticeState,
  SchedulerUserNoticeJournal,
} from "@zhixing/owner-kernel";
import { randomUUID } from "node:crypto";

export interface JournalMaintenanceResult {
  condensed: number;
  expired: number;
}

type CallText = (prompt: string, role?: "main" | "light") => Promise<string>;

export interface JournalMaintenance {
  scan(): Promise<JournalAuthorityLifecyclePlan>;
  bind(input: {
    notices: SchedulerUserNoticeJournal | (() => SchedulerUserNoticeJournal);
    callText: CallText;
  }): void;
  start(): Promise<void>;
  wake(): Promise<JournalMaintenanceResult>;
  stop(): Promise<void>;
  latestNotice(): Promise<SchedulerUserNotice | null>;
}

export function createAnchorJournalMaintenance(deps: {
  state: () => GlobalStatePort | undefined;
  anchorEpoch: () => number | undefined;
  clock?: () => Date;
  onError?: (error: Error) => void;
}): JournalMaintenance {
  let notices:
    | SchedulerUserNoticeJournal
    | (() => SchedulerUserNoticeJournal)
    | undefined;
  let callText: CallText | undefined;
  let running: Promise<JournalMaintenanceResult> | undefined;
  let accepting = false;

  const now = () => (deps.clock?.() ?? new Date()).toISOString();
  const authority = (): { state: GlobalStatePort; anchorEpoch: number } => {
    const state = deps.state();
    const anchorEpoch = deps.anchorEpoch();
    if (!state || !Number.isSafeInteger(anchorEpoch) || anchorEpoch! <= 0) {
      throw new Error("Anchor journal authority is not ready");
    }
    return { state, anchorEpoch: anchorEpoch! };
  };

  const readEntries = async (): Promise<JournalLifecycleEntry[]> => {
    const owner = authority();
    const result = await owner.state.read(
      { kind: "memory-list", scope: { kind: "personal" }, domain: "journal" },
      readContext(owner.anchorEpoch),
    );
    if (result.kind !== "memory-list") {
      throw new TypeError("Journal authority returned another result type");
    }
    return result.entries.map(toLifecycleEntry);
  };

  const scan = async (): Promise<JournalAuthorityLifecyclePlan> =>
    planJournalLifecycle(await readEntries(), { now: deps.clock?.() });

  const requireBinding = () => {
    if (!notices || !callText) {
      throw new Error("Journal maintenance lifecycle is not bound");
    }
    return {
      notices: typeof notices === "function" ? notices() : notices,
      callText,
    };
  };

  const record = async (
    journal: SchedulerUserNoticeJournal,
    plan: JournalMaintenanceNoticePlan,
    input: {
      state: SchedulerUserNotice["state"];
      attempt: number;
      completed: number;
      reason: string;
      actions: readonly string[];
    },
  ): Promise<void> => {
    const fileCount = plan.months.reduce((sum, month) => sum + month.sources.length, 0);
    await journal.recordJournalMaintenance({
      noticeId: `journal-maintenance:${plan.planDigest}`,
      kind: "journal-maintenance",
      state: input.state,
      ref: {
        kind: "journal-maintenance",
        planDigest: plan.planDigest,
        monthCount: plan.months.length,
        fileCount,
        attempt: input.attempt,
        completed: input.completed,
      },
      reason: input.reason,
      actions: input.actions,
      at: now(),
      journalPlan: plan,
    });
  };

  const latestForPlan = async (
    journal: SchedulerUserNoticeJournal,
    planDigest: string,
  ): Promise<JournalMaintenanceNoticeState | undefined> =>
    (await journal.journalMaintenanceStates()).find(
      (state) => state.plan.planDigest === planDigest,
    );

  const reconcileOpenPlans = async (): Promise<void> => {
    const binding = requireBinding();
    const entries = await readEntries();
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    for (const state of await binding.notices.journalMaintenanceStates()) {
      if (state.notice.state === "closed") continue;
      const ref = journalRef(state.notice);
      let completed = ref.completed;
      while (completed < state.plan.months.length) {
        const month = state.plan.months[completed]!;
        const applied = month.sources.every((source) => !byId.has(source.id)) &&
          byId.has(month.month);
        if (!applied) break;
        completed++;
        await record(binding.notices, state.plan, {
          state: "updated",
          attempt: ref.attempt,
          completed,
          reason: `${month.month} 的日志已确认凝练（${completed}/${state.plan.months.length}）。`,
          actions: completed < state.plan.months.length
            ? ["系统将继续处理剩余月份"]
            : ["可用 /journal 查看结果"],
        });
      }
      if (completed === state.plan.months.length) {
        await record(binding.notices, state.plan, {
          state: "closed",
          attempt: ref.attempt,
          completed: state.plan.months.length,
          reason: "日志凝练已完成。",
          actions: ["可用 /journal 查看最新状态"],
        });
        continue;
      }
      const remaining = state.plan.months.slice(completed);
      const exactPending = remaining.every((month) =>
        month.sources.every((source) => byId.get(source.id)?.digest === source.expectedDigest) &&
        (month.targetExpectedDigest === undefined
          ? !byId.has(month.month)
          : byId.get(month.month)?.digest === month.targetExpectedDigest),
      );
      if (!exactPending) {
        await record(binding.notices, state.plan, {
          state: "closed",
          attempt: ref.attempt,
          completed,
          reason: "日志内容已经变化，本次凝练计划已安全终止。",
          actions: ["系统将按最新日志重新规划"],
        });
      }
    }
  };

  const execute = async (): Promise<JournalMaintenanceResult> => {
    const binding = requireBinding();
    const owner = authority();
    await reconcileOpenPlans();
    const authorityPlan = await scan();
    const plannedNow = toNoticePlan(authorityPlan);
    const resumable = (await binding.notices.journalMaintenanceStates()).find((state) => {
      if (state.notice.state === "closed") return false;
      const ref = journalRef(state.notice);
      return canonicalize(state.plan.months.slice(ref.completed)) ===
        canonicalize(plannedNow?.months ?? []);
    });
    const plan = resumable?.plan ?? plannedNow;
    let expired = 0;
    let condensed = 0;
    let completed = 0;
    let attempt = 0;

    if (plan) {
      const existing = resumable ?? await latestForPlan(binding.notices, plan.planDigest);
      const alreadyClosed = existing?.notice.state === "closed";
      if (!existing) {
        await record(binding.notices, plan, {
          state: "prepared",
          attempt: 0,
          completed: 0,
          reason: `准备凝练 ${plan.months.length} 个月的日志。`,
          actions: ["凝练会使用轻量模型并产生模型用量", "可用 /journal 查看进度"],
        });
      } else {
        const ref = journalRef(existing.notice);
        completed = ref.completed;
        attempt = ref.attempt;
        if (alreadyClosed) completed = plan.months.length;
      }

      const completedBeforeRun = completed;
      for (let offset = 0; offset < authorityPlan.condense.length; offset++) {
        const index = completedBeforeRun + offset;
        const month = authorityPlan.condense[offset]!;
        const combined = month.sources
          .map((source) => source.content)
          .join("\n\n---\n\n");
        attempt++;
        await record(binding.notices, plan, {
          state: "open",
          attempt,
          completed: index,
          reason: `正在凝练 ${month.month} 的日志（${index + 1}/${plan.months.length}）。`,
          actions: ["系统会在失败后按同一计划重试"],
        });
        let summary: string;
        try {
          summary = await binding.callText(
            `请将以下日志内容凝练为简洁的月度摘要，保留关键事实和决策，去掉冗余细节。\n\n${combined}`,
            "light",
          );
        } catch (error) {
          await record(binding.notices, plan, {
            state: "updated",
            attempt,
            completed: index,
            reason: "日志凝练暂未完成。",
            actions: ["无需重复操作，系统会自动重试", "可用 /journal 查看状态"],
          });
          throw error;
        }
        const mutation = {
          kind: "memory-journal-condense" as const,
          scope: { kind: "personal" as const },
          month: month.month,
          ...(month.target ? { targetExpectedDigest: month.target.digest } : {}),
          sources: month.sources.map((source) => ({
            id: source.id,
            expectedDigest: source.digest,
          })),
          summary,
        };
        try {
          await owner.state.mutate(
            mutation,
            controlContext(owner.anchorEpoch, stableRequestId("condense", mutation)),
          );
          condensed++;
          completed = index + 1;
          await record(binding.notices, plan, {
            state: "updated",
            attempt,
            completed,
            reason: `${month.month} 的日志已凝练（${completed}/${plan.months.length}）。`,
            actions: completed < plan.months.length
              ? ["系统将继续处理剩余月份"]
              : ["可用 /journal 查看结果"],
          });
        } catch (error) {
          await record(binding.notices, plan, {
            state: "updated",
            attempt,
            completed: index,
            reason: error instanceof MemoryMutationConflictError
              ? "日志内容已经变化，本次凝练未覆盖最新内容。"
              : "日志凝练结果暂未保存。",
            actions: ["系统会按最新日志重新规划并重试"],
          });
          throw error;
        }
      }
      if (!alreadyClosed) {
        await record(binding.notices, plan, {
          state: "closed",
          attempt,
          completed: plan.months.length,
          reason: `日志凝练已完成，共处理 ${plan.months.length} 个月。`,
          actions: ["可用 /journal 查看最新状态"],
        });
      }
    }

    for (const entry of authorityPlan.expired) {
      const mutation = {
        kind: "memory-delete" as const,
        scope: { kind: "personal" as const },
        domain: "journal" as const,
        id: entry.id,
        expectedDigest: entry.digest,
      };
      try {
        await owner.state.mutate(
          mutation,
          controlContext(owner.anchorEpoch, stableRequestId("expire", mutation)),
        );
        expired++;
      } catch (error) {
        if (!(error instanceof MemoryMutationConflictError)) throw error;
      }
    }
    return { condensed, expired };
  };

  const wake = (): Promise<JournalMaintenanceResult> => {
    if (!accepting) throw new Error("Journal maintenance lifecycle is not running");
    running ??= execute().finally(() => {
      running = undefined;
    });
    return running;
  };

  return {
    scan,
    bind(input) {
      if ((notices && notices !== input.notices) || (callText && callText !== input.callText)) {
        throw new Error("Journal maintenance lifecycle is already bound");
      }
      notices = input.notices;
      callText = input.callText;
    },
    async start() {
      requireBinding();
      accepting = true;
      void wake().catch((error) => {
        deps.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    },
    wake,
    async stop() {
      accepting = false;
      await running;
    },
    async latestNotice() {
      if (!notices) return null;
      const current = typeof notices === "function" ? notices() : notices;
      return (await current.journalMaintenanceStates()).at(-1)?.notice ?? null;
    },
  };
}

function toNoticePlan(
  plan: JournalAuthorityLifecyclePlan,
): JournalMaintenanceNoticePlan | undefined {
  const months = plan.condense.map((month) => ({
    month: month.month,
    ...(month.target ? { targetExpectedDigest: month.target.digest } : {}),
    sources: month.sources.map((source) => ({
      id: source.id,
      expectedDigest: source.digest,
    })),
  }));
  if (months.length === 0) return undefined;
  return {
    planDigest: protocolDigest("JournalMaintenancePlan", 1, { months }),
    months,
  };
}

function journalRef(notice: SchedulerUserNotice): Extract<
  SchedulerUserNotice["ref"],
  { kind: "journal-maintenance" }
> {
  if (notice.kind !== "journal-maintenance" || notice.ref.kind !== "journal-maintenance") {
    throw new TypeError("Scheduler notice is not journal maintenance");
  }
  return notice.ref;
}

function toLifecycleEntry(entry: MemoryLogicalEntry): JournalLifecycleEntry {
  if (entry.domain !== "journal" || entry.scope.kind !== "personal") {
    throw new TypeError("Journal lifecycle received a non-personal journal entry");
  }
  return {
    id: entry.id,
    meta: structuredClone(entry.meta),
    content: entry.content,
    digest: entry.digest,
  };
}

function readContext(anchorEpoch: number): GlobalReadCallContext {
  return {
    principal: { kind: "host", component: "memory-journal-maintenance" },
    requestId: `journal-read:${randomUUID()}`,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    authority: { domain: "global", anchorEpoch },
  };
}

function controlContext(
  anchorEpoch: number,
  requestId: string,
): GlobalControlCallContext {
  return {
    principal: { kind: "host", component: "memory-journal-maintenance" },
    requestId,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    authority: { domain: "global", anchorEpoch },
  };
}

function stableRequestId(prefix: string, mutation: object): string {
  return `journal-${prefix}:${protocolDigest("JournalMaintenanceRequest", 1, mutation).slice("sha256:".length)}`;
}
