/**
 * 持久投影归约装不齐工作集时的出口：真实作业日志与提交日志，归约是真实的 JobReduction，只在持久投影一侧
 * 注入逐行缺读（失败终态的记录逐个读 80 个不存在的行）。撞上装入轮数上限后，提交以 JobStateExhausted 失败，
 * 不再交回准备循环原样重开整笔事务；交给外层却始终装不到的缺行，外层装入 64 轮后同样以它结束。
 * 两种情况下候选都不追加，同一实例与全新实例的已发布状态都不受影响，之后照常操作。
 */
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AuthorityCacheIntegrity, FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import type { AuthorityCallContext, Signature, TaskDefinition } from "@zhixing/core/contracts";
import { DeliveryAuthority } from "@zhixing/core/delivery";
import { protocolBytes, type ProtocolSignatureVerifier, type ProtocolSigner } from "@zhixing/core/protocol";
import { createOwnerDeliveryParticipant } from "@zhixing/owner-kernel/delivery";
import { JobJournal, JobReduction } from "@zhixing/owner-kernel/job-assignment";
import {
  JOB_RUN_STATE_PROJECTION_ID,
  JobStateExhausted,
  JobStateRequired,
  registerJobRunStateProjection,
} from "@zhixing/owner-kernel/job-run-state-index";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";

const TASK_ID = "task-round-limit";
const NOW = "2026-07-15T00:00:00.000Z";

class TestIdentity implements ProtocolSigner, ProtocolSignatureVerifier {
  readonly #key = Buffer.from("job-state-round-limit", "utf8");
  #nonce = 0;
  sign(schemaId: string, version: number, payload: unknown): Signature {
    const nonce = String(++this.#nonce);
    const mac = createHmac("sha256", this.#key).update(protocolBytes(schemaId, version, payload)).update("\0").update(nonce).digest("base64url");
    return { alg: "test-hmac-sha256", keyId: "test-owner", sig: `${nonce}.${mac}` };
  }
  verify(schemaId: string, version: number, payload: unknown, signature: Signature): void {
    const [nonce, encoded] = signature.sig.split(".");
    if (!nonce || !encoded) throw new Error("test signature invalid");
    const expected = createHmac("sha256", this.#key).update(protocolBytes(schemaId, version, payload)).update("\0").update(nonce).digest();
    const actual = Buffer.from(encoded, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("test signature invalid");
  }
}

const surface = (requestId: string): AuthorityCallContext => ({
  principal: { kind: "surface", surfacePrincipal: "surface:user-1", connectionId: "connection-1" },
  requestId, deadlineAt: "2030-01-01T00:00:00.000Z",
});

const definition: TaskDefinition = {
  taskId: TASK_ID,
  taskRevision: 1,
  state: "enabled",
  definition: {
    kind: "user",
    spec: {
      name: "round limit",
      enabled: true,
      priority: "normal",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "do work" },
      delivery: { kind: "none" },
    },
  },
};

type Reduce = JobReduction["reduce"];

/**
 * 作业投影先由包了一层的归约登记（第一个登记者决定持久投影的归约），作业日志自己的候选归约不受影响。
 * trap 只在开启时、对失败终态的记录、在持久归约里运行。
 */
async function harness(name: string, trap: (state: Parameters<Reduce>[0]) => void) {
  const root = await createTempDir(name);
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), { lockWaitMs: 2_000 });
  const logRoot = path.join(root, "authority");
  const identity = new TestIdentity();
  const settings = { clock: () => NOW, lockWaitMs: 2_000, integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 7)) };
  const participantFor = (log: FileAuthorityCommitLog) =>
    createOwnerDeliveryParticipant({ authority: new DeliveryAuthority({ log, anchorEpoch: 3 }) });
  const journalFor = (log: FileAuthorityCommitLog, delivery = participantFor(log)) => new JobJournal({
    taskId: TASK_ID, anchorEpoch: 3, log, artifacts, signer: identity, verifier: identity, delivery,
    submission: { authenticate() {}, authorize() {} }, ingress: { authorize() {} }, snapshotFor: () => undefined, clock: () => NOW,
  });
  const log = new FileAuthorityCommitLog(logRoot, artifacts, settings);
  const delivery = participantFor(log);
  const control = { armed: false };
  registerJobRunStateProjection(log, (taskId) => {
    const real = new JobReduction({ taskId, anchorEpoch: 3, artifacts, verifier: identity, delivery });
    return {
      reduceSubmissionGuard: real.reduceSubmissionGuard,
      reduce: async (state: Parameters<Reduce>[0], record: Parameters<Reduce>[1], envelope: Parameters<Reduce>[2]) => {
        const body = record.body as { readonly t?: string; readonly state?: string };
        if (control.armed && body.t === "state" && body.state === "failed") trap(state);
        return real.reduce(state, record, envelope);
      },
    } as unknown as JobReduction;
  });
  const journal = journalFor(log, delivery);
  await journal.define(definition, surface("define"));
  await journal.trigger({ jobRunId: "run-1", scheduledFor: NOW, context: surface("trigger-1"), source: "user" });
  const before = await journal.schedulerReadView();
  const head = (await log.readAll()).length;

  /** 失败之后：候选未追加，同一实例与全新实例（正常归约）都读到失败前的状态，之后照常失败与触发。 */
  const expectUntouchedAndUsable = async () => {
    expect((await log.readAll()).length).toBe(head);
    control.armed = false;
    expect(await journal.schedulerReadView()).toEqual(before);
    await log.stopStorageMaintenance();
    const cold = new FileAuthorityCommitLog(logRoot, artifacts, settings);
    const restarted = journalFor(cold);
    await cold.prepareProjections([JOB_RUN_STATE_PROJECTION_ID]);
    expect(await restarted.schedulerReadView()).toEqual(before);
    await restarted.failQueued("run-1");
    expect((await restarted.schedulerReadView()).consecutiveFailures).toBe(1);
    await restarted.trigger({ jobRunId: "run-2", scheduledFor: NOW, context: surface("trigger-2"), source: "user" });
    await restarted.failQueued("run-2");
    expect((await restarted.schedulerReadView()).consecutiveFailures).toBe(2);
    expect((await cold.readAll()).length).toBeGreaterThan(head);
    await cold.stopStorageMaintenance();
  };
  return { journal, control, expectUntouchedAndUsable };
}

describe("job state round limit on the persistent reducer", () => {
  it("fails the commit with JobStateExhausted instead of reopening the whole transaction, appending nothing", async () => {
    let freshAttempts = 0;
    // 逐个读 80 个不存在的行：每轮只缺一行
    const { journal, control, expectUntouchedAndUsable } = await harness("job-state-round-limit", (state) => {
      const rows = state.failureFlagByRun;
      // 每次持久归约都从新工作集开始：第一行未装入即一次新的整轮
      if (!rows.binding.store.isLoaded(rows.binding.store.storageKey(rows.field, "trap-0"))) freshAttempts += 1;
      for (let index = 0; index < 80; index++) rows.get(`trap-${index}`);
    });
    control.armed = true;
    const failure = await journal.failQueued("run-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JobStateExhausted);
    expect(failure).toMatchObject({ reason: "rounds", rounds: 65, missing: { "m:failureFlagByRun": 1 } });
    expect((failure as JobStateExhausted).loaded["m:failureFlagByRun"]).toBe(64);
    // 只撞一次：上层没有原样重开整笔事务
    expect(freshAttempts).toBe(1);
    await expectUntouchedAndUsable();
  }, 120_000);

  it("stops reopening the transaction once the rows the reducer hands outward never become loadable", async () => {
    let attempts = 0;
    // 缺行不属于持久归约的工作集：原样交给外层，外层每次准备后仍然缺
    const { journal, control, expectUntouchedAndUsable } = await harness("job-state-no-progress", () => {
      attempts += 1;
      throw new JobStateRequired([{ key: "job/unrelated/m/rows/never" }]);
    });
    control.armed = true;
    const failure = await journal.failQueued("run-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JobStateExhausted);
    expect(failure).toMatchObject({ reason: "rounds", rounds: 65, missing: { "m:rows": 1 } });
    // 外层的装入轮数有上限：64 次准备之后不再重开
    expect(attempts).toBe(65);
    await expectUntouchedAndUsable();
  }, 120_000);
});
