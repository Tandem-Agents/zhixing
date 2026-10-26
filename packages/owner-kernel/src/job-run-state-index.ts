import type {
  AuthorityCommitLog,
  DurableProjectionMutation,
  DurableProjectionReadContext,
  RebuildableDurableProjectionIndex,
} from "@zhixing/core/authority";
import type { CommitEnvelope, JsonValue, LogicalRecord } from "@zhixing/core/contracts";
import { SCHEDULER_USER_NOTICE_STREAM } from "@zhixing/core/delivery";
import {
  createJobGuardState,
  createJobMainState,
  jobProjectionView,
  jobScopeOf,
  jobSubmissionGuardView,
  preloadFailureSummaryPaths,
  preloadJobScope,
  type JobReduction,
} from "./job-assignment.js";
import {
  JobStateBinding,
  jobStateSubject,
  jobStateTaskBase,
  runWithJobState,
  type JobStateSet,
} from "./job-run-state.js";

export { JobStateBinding, JobStateExhausted, JobStateRequired } from "./job-run-state.js";

/**
 * 作业域按键持久投影：每个作业的主投影与提交守卫逐条落键，由作业日志的同一份归约在提交时维护；
 * 另记每个作业的最后写入位置、未完义务计数，以及全局“有未完义务的作业”目录。
 * 启动、第一次活动与后续决定都读这里，不再从日志起点重放作业流。
 */
export const JOB_RUN_STATE_PROJECTION_ID = "job-run-state-v1";

const MATERIALIZATION_STREAM = "job:schedule-materialization";
const OPEN_TASK_PREFIX = "open-task/";
const RUN_TASK_PREFIX = "run-task/";

/** 最后一封触及该作业的信封位置：会话据此判断已装入的行是否仍是最新。 */
export function jobStateHeadKey(taskId: string): string { return `${jobStateTaskBase(taskId)}head`; }
const openWorkKey = (taskId: string) => `${jobStateTaskBase(taskId)}open`;
const openTaskKey = (taskId: string) => `${OPEN_TASK_PREFIX}${jobStateSubject(taskId)}`;
const runTaskKey = (jobRunId: string) => `${RUN_TASK_PREFIX}${jobStateSubject(jobRunId)}`;

/** 主投影里只含当前义务的目录与集合：它们非空的作业在启动时要恢复。 */
const OPEN_WORK_FIELDS = [
  "recoveryAssignments", "bundleAcknowledgementOutbox", "openRuns", "openAssignments", "pendingSettlements",
  "openChallenges", "pendingGrants", "pendingAutoDisable", "pendingMissed",
] as const;

interface JobRunStateBinding {
  readonly index: RebuildableDurableProjectionIndex;
  readonly reductionFor: (taskId: string) => JobReduction;
}

const bindings = new WeakMap<AuthorityCommitLog, JobRunStateBinding>();

/**
 * 登记作业域持久投影。归约所需的协议与资源服务由第一个登记者给出（同一运行时的作业日志共用）。
 */
export function registerJobRunStateProjection(
  log: AuthorityCommitLog,
  reductionFor: (taskId: string) => JobReduction,
): RebuildableDurableProjectionIndex {
  const found = bindings.get(log);
  if (found) return found.index;
  const reductions = new Map<string, JobReduction>();
  const cached = (taskId: string) => {
    let reduction = reductions.get(taskId);
    if (!reduction) {
      reduction = reductionFor(taskId);
      reductions.set(taskId, reduction);
    }
    return reduction;
  };
  const index = log.durableProjection({
    projectionId: JOB_RUN_STATE_PROJECTION_ID,
    reducerVersion: 5,
    authenticated: true,
    inputs: { families: ["job:"], streams: [SCHEDULER_USER_NOTICE_STREAM] },
    reduce: (envelope, current) => reduceJobRunState(cached, envelope as CommitEnvelope<unknown>, current),
  });
  bindings.set(log, { index, reductionFor: cached });
  return index;
}

async function reduceJobRunState(
  reductionFor: (taskId: string) => JobReduction,
  envelope: CommitEnvelope<unknown>,
  current: DurableProjectionReadContext,
): Promise<readonly DurableProjectionMutation[]> {
  const records = new Map<string, LogicalRecord<unknown>[]>();
  const summarized = new Map<string, Set<string>>();
  for (const entry of envelope.entries) {
    if (entry.stream.startsWith("job:") && entry.stream !== MATERIALIZATION_STREAM) {
      const taskId = entry.stream.slice(4);
      const list = records.get(taskId) ?? [];
      list.push(entry);
      records.set(taskId, list);
      continue;
    }
    if (entry.stream !== SCHEDULER_USER_NOTICE_STREAM) continue;
    // 错过汇总通知：其成员不再待汇总
    const body = entry.body as { readonly kind?: unknown; readonly missedMembers?: unknown } | undefined;
    if (body?.kind !== "missed-summary" || !Array.isArray(body.missedMembers)) continue;
    for (const member of body.missedMembers) {
      if (typeof member !== "string") continue;
      const separator = member.indexOf("\u0000");
      if (separator <= 0) continue;
      const taskId = member.slice(0, separator);
      const runs = summarized.get(taskId) ?? new Set<string>();
      runs.add(member.slice(separator + 1));
      summarized.set(taskId, runs);
    }
  }
  const mutations: DurableProjectionMutation[] = [];
  for (const taskId of new Set([...records.keys(), ...summarized.keys()])) {
    mutations.push(...await reduceTask(
      reductionFor, taskId, records.get(taskId) ?? [], summarized.get(taskId), envelope, current,
    ));
  }
  return mutations;
}

async function reduceTask(
  reductionFor: (taskId: string) => JobReduction,
  taskId: string,
  records: readonly LogicalRecord<unknown>[],
  summarized: ReadonlySet<string> | undefined,
  envelope: CommitEnvelope<unknown>,
  current: DurableProjectionReadContext,
): Promise<DurableProjectionMutation[]> {
  const main = createJobMainState(taskId);
  const guard = createJobGuardState(taskId);
  const scope = jobScopeOf(records.map((record) => record.body));
  for (const jobRunId of summarized ?? []) scope.runs.add(jobRunId);
  await preloadJobScope({ main, guard }, scope, current);
  await preloadFailureSummaryPaths(main, records.map((record) => record.body), current);
  const mainBinding = new JobStateBinding(main);
  const guardBinding = new JobStateBinding(guard);
  await runWithJobState([[mainBinding, main], [guardBinding, guard]], current, async () => {
    const reduction = reductionFor(taskId);
    let mainState = jobProjectionView(mainBinding);
    let guardState = jobSubmissionGuardView(guardBinding);
    for (const record of records) {
      mainState = await reduction.reduce(mainState, record, envelope);
      guardState = await reduction.reduceSubmissionGuard(guardState, record, envelope);
    }
    for (const jobRunId of summarized ?? []) {
      if (mainState.pendingMissed.has(jobRunId)) mainState.pendingMissed.delete(jobRunId);
    }
  });
  const result = [...mainBinding.store.mutations(), ...guardBinding.store.mutations()];
  result.push({ kind: "put", key: jobStateHeadKey(taskId), value: envelope.lsn });
  // 新 occurrence 记下所属作业：按 run 精确找到任务，不必装入任何作业
  for (const jobRunId of mainBinding.store.changedSubjects("occurrences")) {
    if (mainBinding.store.baseOf("occurrences", jobRunId)?.present === false) {
      result.push({ kind: "put", key: runTaskKey(String(jobRunId)), value: { k: String(jobRunId), task: taskId } });
    }
  }
  const delta = openWorkDelta(mainBinding.store);
  if (delta !== 0) {
    const before = await current.get(openWorkKey(taskId)) as number | undefined ?? 0;
    const after = before + delta;
    if (after < 0) throw new TypeError("Job open work count is negative");
    result.push(after === 0
      ? { kind: "tombstone", key: openWorkKey(taskId) }
      : { kind: "put", key: openWorkKey(taskId), value: after });
    if ((before > 0) !== (after > 0)) {
      result.push(after > 0
        ? { kind: "put", key: openTaskKey(taskId), value: taskId as JsonValue }
        : { kind: "tombstone", key: openTaskKey(taskId) });
    }
  }
  return result;
}

/** 当前义务目录成员数的变化：改动过的主体，现在在而原先不在记 +1，反之记 −1。 */
function openWorkDelta(store: JobStateSet): number {
  let delta = 0;
  for (const field of OPEN_WORK_FIELDS) {
    for (const subject of store.changedSubjects(field)) {
      const now = store.peek(field, subject)?.present === true;
      const before = store.baseOf(field, subject)?.present === true;
      delta += Number(now) - Number(before);
    }
  }
  return delta;
}

/** 有未完义务的作业：启动时与当前定义一起恢复。按页列出。 */
export async function listOpenJobTaskIds(index: Pick<DurableProjectionReadContext, "scan">): Promise<readonly string[]> {
  const taskIds: string[] = [];
  let continuation: string | undefined;
  do {
    const page = await index.scan({ gte: OPEN_TASK_PREFIX, lt: `${OPEN_TASK_PREFIX}￿` }, 256, continuation);
    for (const entry of page.entries) {
      if (typeof entry.value !== "string" || openTaskKey(entry.value) !== entry.key) {
        throw new TypeError("Open job task directory is invalid");
      }
      taskIds.push(entry.value);
    }
    continuation = page.continuation;
  } while (continuation);
  return taskIds;
}

function registered(log: AuthorityCommitLog): RebuildableDurableProjectionIndex {
  const binding = bindings.get(log);
  if (!binding) throw new TypeError("Job run state projection is not registered");
  return binding.index;
}

/** 已登记的作业域持久投影（只读用）。 */
export function jobRunStateIndex(log: AuthorityCommitLog): RebuildableDurableProjectionIndex {
  return registered(log);
}

/** 持久投影为该作业使用的归约（同一组服务）。 */
export function jobReductionFor(log: AuthorityCommitLog, taskId: string): JobReduction {
  const binding = bindings.get(log);
  if (!binding) throw new TypeError("Job run state projection is not registered");
  return binding.reductionFor(taskId);
}

/** 有未完义务的作业 id（已登记作业域持久投影的日志）。 */
export function openJobTaskIds(log: AuthorityCommitLog): Promise<readonly string[]> {
  return listOpenJobTaskIds(registered(log));
}

/** 一个 run 所属的作业，精确读取一行。 */
export async function findJobTaskForRun(log: AuthorityCommitLog, jobRunId: string): Promise<string | undefined> {
  const row = await registered(log).get(runTaskKey(jobRunId)) as { readonly k?: unknown; readonly task?: unknown } | undefined;
  if (row === undefined) return undefined;
  if (row.k !== jobRunId || typeof row.task !== "string") throw new TypeError("Job run task directory is invalid");
  return row.task;
}
