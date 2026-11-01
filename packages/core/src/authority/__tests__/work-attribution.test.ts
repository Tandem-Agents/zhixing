/**
 * 存储工作汇总的归属只观测、不改业务：阶段取操作开始那一刻（不取刷出时刻），汇总带桶内操作的真实执行边界，
 * 阶段结束后的续跑记来源阶段，发起方固定标签与后台续跑的触发来源可区分。
 */
import { expect, it } from "vitest";
import { AUTHORITY_LOG_SOURCE, AuthorityWorkObserver } from "../logging.js";
import type { LogDraft, LogRecordPort } from "../../logging/contracts.js";
import { bindLogSource, captureLog } from "../../logging/capture.js";
import { DEFAULT_LOG_POLICY } from "../../logging/policy.js";
import { beginLogPhase, currentLogPhaseRefs, runWithLogAttribution } from "../../logging/phase.js";
import { runDetachedMaintenanceContext } from "../../resources/index.js";

// 与 LogRecorder.bind 同一合并规则：显式引用之外补上写出时刻的当前阶段引用
function mergingCollector() {
  const entries: LogDraft[] = [];
  const records: LogRecordPort = { record: (value) => {
    const draft = typeof value === "function" ? value() : value;
    entries.push({ ...draft, refs: [...(draft.refs ?? []), ...currentLogPhaseRefs().filter(ref => !draft.refs?.some(explicit => explicit.kind === ref.kind))] });
  } };
  return { records, entries };
}
const work = (entries: readonly LogDraft[], operation: string) => entries.filter(item => item.event === "work" && (item.data as { operation?: string }).operation === operation);
const phaseIdOf = (entries: readonly LogDraft[], name: string) =>
  entries.find(item => item.event === "phaseStarted" && (item.data as { phase?: string }).phase === name)!.refs!.find(ref => ref.kind === "phase")!.id;

it("keeps a bucket's phase from where its operations began, not from where it was flushed", async () => {
  const { records, entries } = mergingCollector();
  const observer = new AuthorityWorkObserver(records, () => "authority-1");
  observer.begin("projection.get").finish();
  const phase = beginLogPhase(records, "first-send");
  await phase.run(async () => { observer.flush(); });
  phase.finish();
  const [row] = work(entries, "projection.get");
  expect(row!.refs!.map(ref => ref.kind)).not.toContain("phase");
});

it("bounds each bucket by the actual start and finish of its operations", async () => {
  const { records, entries } = mergingCollector();
  const observer = new AuthorityWorkObserver(records, () => "authority-1");
  const before = Date.now();
  const first = observer.begin("projection.getMany");
  await new Promise(resolve => setTimeout(resolve, 25));
  const second = observer.begin("projection.getMany");
  first.finish();
  await new Promise(resolve => setTimeout(resolve, 25));
  second.finish();
  const after = Date.now();
  observer.flush();
  const [row] = work(entries, "projection.getMany");
  const data = row!.data as { operations: number; firstStartedAt: number; lastFinishedAt: number };
  expect(data.operations).toBe(2);
  expect(data.firstStartedAt).toBeGreaterThanOrEqual(before);
  expect(data.lastFinishedAt).toBeLessThanOrEqual(after);
  expect(data.lastFinishedAt - data.firstStartedAt).toBeGreaterThanOrEqual(40);
});

it("labels a continuation that outlives its phase with that phase as origin", async () => {
  const { records, entries } = mergingCollector();
  const observer = new AuthorityWorkObserver(records, () => "authority-1");
  const phase = beginLogPhase(records, "run.first-party-surface");
  let resume!: () => void;
  const continuation = phase.run(async () => {
    await new Promise<void>(resolve => { resume = resolve; });
    observer.begin("transactProjection").finish();
  });
  phase.finish();
  resume();
  await continuation;
  observer.flush();
  const [row] = work(entries, "transactProjection");
  expect(row!.refs).toContainEqual({ kind: "originPhase", id: phaseIdOf(entries, "run.first-party-surface") });
  expect(row!.refs!.map(ref => ref.kind)).not.toContain("phase");
});

it("groups work by a fixed caller label and records what handed it to a detached continuation", async () => {
  const { records, entries } = mergingCollector();
  const observer = new AuthorityWorkObserver(records, () => "authority-1");
  const phase = beginLogPhase(records, "run.dispatch");
  await phase.run(() => runWithLogAttribution("product:conversation.send", async () => {
    observer.begin("projection.get").finish();
    await runDetachedMaintenanceContext("background", async () => { observer.begin("transactDurableProjection").finish(); });
  }));
  phase.finish();
  observer.flush();
  const phaseId = phaseIdOf(entries, "run.dispatch");
  const [foreground] = work(entries, "projection.get");
  expect(foreground!.refs).toContainEqual({ kind: "caller", id: "product:conversation.send" });
  expect(foreground!.refs).toContainEqual({ kind: "phase", id: phaseId });
  const [detached] = work(entries, "transactDurableProjection");
  expect(detached!.refs).toContainEqual({ kind: "caller", id: "detached:background" });
  expect(detached!.refs).toContainEqual({ kind: "trigger", id: "product:conversation.send" });
  expect(detached!.refs).toContainEqual({ kind: "triggerPhase", id: phaseId });
  expect(detached!.refs!.map(ref => ref.kind)).not.toContain("phase");
});

it("the production log source keeps the boundary fields, attribution refs and maintenance steps", async () => {
  const { records, entries } = mergingCollector();
  const observer = new AuthorityWorkObserver(records, () => "authority-1");
  await runWithLogAttribution("product:conversation.send", async () => { observer.begin("projection.get").finish(); });
  observer.flush();
  const [row] = work(entries, "projection.get");
  const source = bindLogSource(AUTHORITY_LOG_SOURCE);
  const { record: captured } = captureLog(source, { scope: "storage" }, row!, DEFAULT_LOG_POLICY, "process", 1);
  expect(captured.data).toMatchObject({ firstStartedAt: expect.any(Number), lastFinishedAt: expect.any(Number) });
  expect(captured.refs).toContainEqual({ kind: "caller", id: "product:conversation.send" });
  const step = "1793465000000+5 conversation-run-state-v1";
  const { record: maintained } = captureLog(source, { scope: "storage" },
    { event: "maintained", data: { count: 1, durationMs: 5, slowest: ["5ms conversation-run-state-v1"], steps: [step] } }, DEFAULT_LOG_POLICY, "process", 2);
  expect(maintained.data).toMatchObject({ steps: [step] });
});
