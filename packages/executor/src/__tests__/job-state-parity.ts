/**
 * 作业域按键持久投影的新旧对照：把同一日志从起点用同一份归约在完整内存状态上重放一遍，
 * 逐行比较持久投影写下的行；再按原先遍历全集的判定重算各当前义务目录与索引，核对它们一致。
 */
import { AuthorityPreparationRequired, type FileAuthorityCommitLog } from "@zhixing/core/authority";
import type { DataPlaneTicket, JobOccurrence, JsonValue } from "@zhixing/core/contracts";
import { SCHEDULER_USER_NOTICE_STREAM } from "@zhixing/core/delivery";
import { canonicalize, MAX_CLOCK_SKEW_MS } from "@zhixing/core/protocol";
import {
  createJobGuardState,
  createJobMainState,
  jobMainStatePrefix,
  jobGuardStatePrefix,
  jobProjectionView,
  jobSubmissionGuardView,
  occurrenceOrderKey,
} from "@zhixing/owner-kernel/job-assignment";
import { compareJobOccurrences } from "@zhixing/core/protocol";
import { isScheduleFailure } from "@zhixing/core/scheduler/application";
import { JobStateBinding, jobReductionFor, jobRunStateIndex } from "@zhixing/owner-kernel/job-run-state-index";
import { expect } from "vitest";

const TERMINAL = new Set(["committed", "failed", "cancelled", "expired", "missed"]);

type SummaryNode =
  | { readonly entries: readonly { readonly scheduledFor: string; readonly jobRunId: string; readonly failed: boolean }[] }
  | { readonly children: readonly { readonly node: number; readonly first: unknown; readonly summary: unknown }[] };

/** 一段是否失败的序列的摘要：条数、是否全部失败、从最早一端与最新一端起的连续失败数（按定义直接数）。 */
function summaryOf(failures: readonly boolean[]) {
  let leading = 0;
  while (leading < failures.length && failures[leading]) leading += 1;
  let trailing = 0;
  while (trailing < failures.length && failures[failures.length - 1 - trailing]) trailing += 1;
  return { count: failures.length, allFailed: leading === failures.length, leading, trailing };
}

export async function expectJobStateParity(log: FileAuthorityCommitLog, taskId: string): Promise<void> {
  const reduction = jobReductionFor(log, taskId);
  // 归约里的同步调控判断可能要先装入调控状态：装入后整遍重放
  const replay = async () => {
    const main = createJobMainState(taskId, true);
    const guard = createJobGuardState(taskId, true);
    const mainBinding = new JobStateBinding(main);
    const guardBinding = new JobStateBinding(guard);
    let mainState = jobProjectionView(mainBinding);
    let guardState = jobSubmissionGuardView(guardBinding);
    for (const envelope of await log.readAll()) {
      for (const record of envelope.entries) {
        if (record.stream === `job:${taskId}`) {
          mainState = await reduction.reduce(mainState, record, envelope);
          guardState = await reduction.reduceSubmissionGuard(guardState, record, envelope);
          continue;
        }
        if (record.stream !== SCHEDULER_USER_NOTICE_STREAM) continue;
        const body = record.body as { readonly kind?: string; readonly missedMembers?: readonly string[] };
        if (body.kind !== "missed-summary") continue;
        for (const member of body.missedMembers ?? []) {
          const [memberTask, jobRunId] = member.split("\u0000");
          if (memberTask === taskId && jobRunId && mainState.pendingMissed.has(jobRunId)) mainState.pendingMissed.delete(jobRunId);
        }
      }
    }
    return { main, guard, mainState };
  };
  let replayed: Awaited<ReturnType<typeof replay>> | undefined;
  for (let rounds = 0; !replayed; rounds++) {
    try {
      replayed = await replay();
    } catch (error) {
      if (!(error instanceof AuthorityPreparationRequired) || !error.prepareOutside || rounds >= 64) throw error;
      await error.prepareOutside();
    }
  }
  const { main, guard, mainState } = replayed;

  // 一、持久投影的行与从零重放的完整状态逐行相同
  const expected = new Map<string, string>();
  for (const mutation of [...main.mutations(), ...guard.mutations()]) {
    if (mutation.kind === "put") expected.set(mutation.key, canonicalize(mutation.value));
  }
  const actual = new Map<string, string>();
  const index = jobRunStateIndex(log);
  for (const prefix of [jobMainStatePrefix(taskId), jobGuardStatePrefix(taskId)]) {
    let continuation: string | undefined;
    do {
      const page = await index.scan({ gte: prefix, lt: `${prefix}￿` }, 256, continuation);
      for (const entry of page.entries) actual.set(entry.key, canonicalize(entry.value as JsonValue));
      continuation = page.continuation;
    } while (continuation);
  }
  expect([...actual].sort()).toEqual([...expected].sort());

  // 二、各当前义务目录与按原先遍历全集的判定一致
  const values = <V>(field: string) => main.allEntries(field).map((entry) => [String(entry.subject), entry.value as V] as const);
  const members = (field: string) => main.allEntries(field).map((entry) => String(entry.subject)).sort();
  const states = new Map(values<{ readonly state: string }>("states"));
  const open = (jobRunId: string) => {
    const current = states.get(jobRunId);
    return current !== undefined && !TERMINAL.has(current.state);
  };
  expect(members("openRuns")).toEqual([...states.keys()].filter(open).sort());
  const assignmentByJob = new Map(values<string>("assignmentByJob"));
  expect(members("openAssignments")).toEqual(values<{ readonly record: { readonly jobRunId: string } }>("assignedById")
    .filter(([assignmentId, assigned]) =>
      assignmentByJob.get(assigned.record.jobRunId) === assignmentId && open(assigned.record.jobRunId))
    .map(([assignmentId]) => assignmentId).sort());
  const completed = new Set(members("completedInteractionSettlements"));
  expect(members("pendingSettlements")).toEqual(members("interactionSettlementFences").filter((id) => !completed.has(id)));
  const closed = new Set(members("chClosed"));
  expect(members("openChallenges")).toEqual(values<{ readonly ref: { readonly execution: string } }>("chPrepared")
    .filter(([challengeId, prepared]) => prepared.ref.execution === "job" && !closed.has(challengeId))
    .map(([challengeId]) => challengeId).sort());
  const mirrors = new Map(values<{ readonly outcomes: ReadonlyMap<string, unknown> }>("interactionMirrors"));
  expect(members("pendingGrants")).toEqual(values<{ readonly grant: { readonly ref: { readonly execution: string };
    readonly assignmentId: string; readonly interactionRequestId: string } }>("chGranted")
    .filter(([, granted]) => granted.grant.ref.execution === "job" &&
      !mirrors.get(granted.grant.assignmentId)?.outcomes.get(granted.grant.interactionRequestId))
    .map(([challengeId]) => challengeId).sort());
  const settled = new Set(members("autoDisableSettledRuns"));
  expect(members("pendingAutoDisable")).toEqual(values<{ readonly autoDisableRequired: boolean }>("failurePolicyByRun")
    .filter(([jobRunId, policy]) => policy.autoDisableRequired && !settled.has(jobRunId))
    .map(([jobRunId]) => jobRunId).sort());

  // 三、有序索引、派发尝试号与运行次数与全集一致
  const occurrences = values<JobOccurrence>("occurrences");
  expect(main.allEntries("occurrenceOrder").map((entry) => `${entry.sortKey}/${String(entry.subject)}`).sort())
    .toEqual(occurrences.map(([jobRunId, occurrence]) => `${occurrenceOrderKey(occurrence)}/${jobRunId}`).sort());
  // 次序键的正向次序恰为完整次序的逆序（倒扫逐条读的前提）
  const byKey = main.allEntries("occurrenceOrder")
    .sort((left, right) => (left.sortKey! < right.sortKey! ? -1 : left.sortKey! > right.sortKey! ? 1 : 0))
    .map((entry) => String(entry.subject));
  expect(byKey).toEqual(occurrences.map(([, occurrence]) => occurrence).sort(compareJobOccurrences).reverse()
    .map((occurrence) => occurrence.jobRunId));
  // 连续失败摘要：叶子按完整次序恰为全部非错过 occurrence 及其是否失败（错过的不在其中）；每个子项的 first 与摘要
  // 等于由子树重算，叶子同深；没有不可达的节点；按 run 记下的失败与否与叶子一致
  const runStates = new Map(values<{ readonly state: JobOccurrence["state"] }>("states"));
  const outcomes = new Map(values<{ readonly status: string }>("outcomeByRun"));
  const expectedEntries = occurrences.map(([, value]) => value).filter((occurrence) => occurrence.state !== "missed")
    .sort(compareJobOccurrences)
    .map((occurrence) => ({
      scheduledFor: occurrence.scheduledFor,
      jobRunId: occurrence.jobRunId,
      failed: isScheduleFailure({
        state: runStates.get(occurrence.jobRunId)?.state ?? occurrence.state,
        outcome: outcomes.get(occurrence.jobRunId) as Parameters<typeof isScheduleFailure>[0]["outcome"],
      }),
    }));
  const nodes = new Map(values<SummaryNode>("failureSummaryNodes").map(([id, node]) => [Number(id), node]));
  const leaves: { readonly scheduledFor: string; readonly jobRunId: string; readonly failed: boolean }[] = [];
  const reachable = new Set<number>();
  const leafDepths = new Set<number>();
  const visit = (id: number, depth: number): boolean[] => {
    reachable.add(id);
    const node = nodes.get(id);
    expect(node, `failure summary node ${id}`).toBeDefined();
    if ("entries" in node!) {
      leafDepths.add(depth);
      leaves.push(...node.entries);
      return node.entries.map((entry) => entry.failed);
    }
    const failures: boolean[] = [];
    for (const child of node!.children) {
      const start = leaves.length;
      const below = visit(child.node, depth + 1);
      expect(child.first).toEqual({ scheduledFor: leaves[start]!.scheduledFor, jobRunId: leaves[start]!.jobRunId });
      expect(child.summary).toEqual(summaryOf(below));
      failures.push(...below);
    }
    return failures;
  };
  if (mainState.failureSummaryRoot !== undefined) visit(mainState.failureSummaryRoot, 1);
  expect(leaves).toEqual(expectedEntries);
  expect(leafDepths.size).toBeLessThanOrEqual(1);
  expect([...nodes.keys()].sort((left, right) => left - right)).toEqual([...reachable].sort((left, right) => left - right));
  expect(new Map(values<boolean>("failureFlagByRun"))).toEqual(new Map(expectedEntries.map((entry) => [entry.jobRunId, entry.failed])));
  expect(mainState.runCount).toBe(occurrences.filter(([, occurrence]) => occurrence.state !== "missed").length);
  const attempts = new Map<string, number>();
  for (const [, assigned] of values<{ readonly record: { readonly jobRunId: string; readonly reservation: { readonly attempt: number } } }>("assignedById")) {
    attempts.set(assigned.record.jobRunId, Math.max(attempts.get(assigned.record.jobRunId) ?? 0, assigned.record.reservation.attempt));
  }
  expect(values<number>("assignmentAttemptByRun").sort()).toEqual([...attempts].sort());
  const frontier = mainState.ticketSyncFrontier;
  const boundary = (ticket: DataPlaneTicket) => new Date(Date.parse(ticket.expiry) + MAX_CLOCK_SKEW_MS).toISOString();
  expect(main.allEntries("ticketExpiry").map((entry) => String(entry.subject)).sort())
    .toEqual(values<DataPlaneTicket>("ticketsById")
      .filter(([, ticket]) => frontier === undefined || boundary(ticket) > frontier)
      .map(([ticketId]) => ticketId).sort());
}
