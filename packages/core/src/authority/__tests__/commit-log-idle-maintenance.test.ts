import { expect, it, onTestFinished, vi } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { FileArtifactStore } from "../artifact-store.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import { AuthorityCacheIntegrity } from "../startup-proofs.js";

const PROJECTION = "idle-maintenance";

async function fixture() {
  const root = await createTempDir("commit-log-idle-maintenance");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 41));
  const open = () => {
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, { startupProofs: true, integrity });
    onTestFinished(() => log.stopStorageMaintenance());
    const reduce = vi.fn((envelope: { lsn: number }) => [{ kind: "put" as const, key: "last", value: envelope.lsn }]);
    const index = log.durableProjection({ projectionId: PROJECTION, reducerVersion: 1, authenticated: true,
      inputs: { streams: ["control"] }, reduce });
    return { log, reduce, index };
  };
  return { open };
}

/** 第一个实例写入后不停止；第二个实例按已发布位置打开，回放了多少尾部由 reduce 次数体现。 */
async function writeThenReopen(maintain: (log: FileAuthorityCommitLog) => Promise<void>) {
  const { open } = await fixture();
  const first = open();
  for (let n = 0; n < 3; n++) await first.log.append([{ stream: "control", body: { value: n } }]);
  expect(await first.index.get("last")).toBe(3);
  await maintain(first.log);
  const second = open();
  await second.log.prepareProjections([PROJECTION]);
  expect(await second.index.get("last")).toBe(3);
  return second.reduce.mock.calls.length;
}

it("发布已打开投影的未落盘进度：重开只需续算尾部，不再回放这次会话的写入", async () => {
  const replayedWithout = await writeThenReopen(async () => undefined);
  expect(replayedWithout).toBeGreaterThan(0);
  const replayedWith = await writeThenReopen((log) =>
    log.maintainIdleProjections(async () => undefined, new AbortController().signal));
  expect(replayedWith).toBe(0);
});

it("闸门拒绝时停在边界、不改已发布状态，之后再调用续做", async () => {
  let attempts = 0;
  const replayed = await writeThenReopen(async (log) => {
    const refused = new Error("foreground arrived");
    await expect(log.maintainIdleProjections(async () => { attempts++; throw refused; }, new AbortController().signal))
      .rejects.toBe(refused);
    await log.maintainIdleProjections(async () => undefined, new AbortController().signal);
  });
  expect(attempts).toBe(1);
  expect(replayed).toBe(0);
});

it("维护期间新到的写入留给之后：段整理照常完成，这一轮不追着新写入一段接一段地落盘", async () => {
  const { open } = await fixture();
  const first = open();
  const idle = (gate: () => Promise<void>) => first.log.maintainIdleProjections(gate, new AbortController().signal);
  // 先积累四个增量段（每轮写入后空闲维护落一段）；第五轮落盘之后挂上段整理
  for (let round = 0; round < 4; round++) {
    await first.log.append([{ stream: "control", body: { round } }]);
    await idle(async () => undefined);
  }
  await first.log.append([{ stream: "control", body: { round: 4 } }]);
  // 前台写入由测试自己的调用链发起（真实前台请求不在空闲维护的调用链里）：每到一个闸门就写入一条
  const requests: (() => void)[] = [];
  let wake: (() => void) | undefined;
  let stopped = false;
  const foreground = (async () => {
    for (;;) {
      while (requests.length === 0 && !stopped) await new Promise<void>((resolve) => { wake = resolve; });
      const done = requests.shift();
      if (!done) return;
      await first.log.append([{ stream: "control", body: { arrived: true } }]);
      done();
    }
  })();
  let gates = 0;
  await idle(() => new Promise<void>((resolve) => { gates++; requests.push(resolve); wake?.(); }));
  stopped = true;
  wake?.();
  await foreground;
  expect(gates).toBeGreaterThan(1);
  const second = open();
  await second.log.prepareProjections([PROJECTION]);
  expect(await second.index.get("last")).toBe(5 + gates);
  // 段整理之后到达的写入未在这一轮落盘，重开时由尾部回放
  expect(second.reduce.mock.calls.length).toBeGreaterThan(0);
});

it("已中止时不等待闸门、不做任何维护", async () => {
  const gate = vi.fn(async () => undefined);
  const abort = new AbortController();
  abort.abort();
  const replayed = await writeThenReopen((log) => log.maintainIdleProjections(gate, abort.signal));
  expect(gate).not.toHaveBeenCalled();
  expect(replayed).toBeGreaterThan(0);
});
