import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactRef } from "../../contracts/index.js";
import { byteDigest } from "../../protocol/index.js";
import { SerialTaskQueue } from "../../persistence/index.js";
import {
  claimDeviceCapacity,
  runInMaintenanceContext,
  runStorageMaintenanceStep,
  storageMaintenanceRequest,
  storageMaintenanceWorkKey,
  StorageMaintenanceTaskRunner,
  type DeviceCapacityAdmission,
  type DeviceCapacityDimension,
  type StorageMaintenanceGovernorPort,
  type StorageMaintenanceKind,
  type StorageMaintenanceRequest,
  type StorageMaintenanceUrgency,
} from "../../resources/index.js";
import { FileResumableArtifactReceiver } from "../assignment-artifacts.js";
import { FileArtifactStore } from "../artifact-store.js";
import { FileArtifactTemporaryPresenceStore } from "../artifact-temporary-presence.js";
import { FileDurableProjectionIndex } from "../durable-projection-index.js";
import { FileAuthorityCommitLog } from "../commit-log.js";
import type { DurableLogCheckpoint } from "../interfaces.js";

/**
 * “处于互斥区就必须零等待”这条合同的全执行点对账。
 *
 * U23-53 的教训是:合同只在改到的那个执行点上被核对过,其余建立互斥的区段
 * 各自分叉。这里改为对账两件事——谓词由建立互斥的原语单点给出,以及每个真实
 * 互斥区段发出的维护请求确实带着零等待。断言落在请求本身的 `maxWaitMs` 与
 * `urgency` 上,而不是落在“能不能跑通”,因为等待是隐性的、跑得通并不说明没等。
 */
function recordingGovernor(): {
  readonly port: StorageMaintenanceGovernorPort;
  readonly requests: StorageMaintenanceRequest[];
  readonly claims: DeviceCapacityDimension[];
} {
  const requests: StorageMaintenanceRequest[] = [];
  const claims: DeviceCapacityDimension[] = [];
  const permit = {
    granted: {
      memoryReservationBytes: 0,
      temporaryBytes: 0,
      slots: 0,
      readBytes: Number.MAX_SAFE_INTEGER,
      writeBytes: Number.MAX_SAFE_INTEGER,
      ioOperations: Number.MAX_SAFE_INTEGER,
    },
    tryBegin: () => ({
      claim: (dimension: DeviceCapacityDimension) => {
        claims.push(dimension);
      },
      complete: () => undefined,
    }),
    release: () => undefined,
  };
  return {
    requests,
    claims,
    port: {
      acquire: async (request): Promise<DeviceCapacityAdmission> => {
        requests.push(request);
        return { kind: "granted", permit };
      },
      snapshot: () => ({ queued: {}, inFlight: {} }),
    },
  };
}

const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

function checkpoint(lsn: number): DurableLogCheckpoint {
  return {
    logId: "maintenance-exclusion-log",
    lsn,
    frameEndOffset: 64 + lsn,
    prefixDigest: `sha256:${lsn.toString(16).padStart(64, "0")}`,
  };
}

function probeRequest(resource: string): StorageMaintenanceRequest {
  return storageMaintenanceRequest("asset-gc", resource, { probe: resource }, {
    obligation: "committed",
  });
}

describe("maintenance admission inside exclusion regions", () => {
  it("derives zero wait from the primitive that establishes the exclusion", async () => {
    // 段外:允许排队等待,背压不必立刻升级成失败。
    expect(probeRequest("outside").maxWaitMs).toBeGreaterThan(0);

    // 段内:由 SerialTaskQueue 单点标记,调用点不再各自声明。
    const queue = new SerialTaskQueue();
    const inside = await queue.run(async () => probeRequest("inside"));
    expect(inside.maxWaitMs).toBe(0);

    // 段外重试必须真的回到段外,否则等待又落回互斥区里。
    const afterSection = probeRequest("outside-again");
    expect(afterSection.maxWaitMs).toBeGreaterThan(0);
  });

  it("keeps the urgency of the declaring owner across the exclusion mark", async () => {
    const queue = new SerialTaskQueue();
    const seen: StorageMaintenanceUrgency[] = [];
    for (const urgency of ["foreground", "recovery", "background"] as const) {
      await runInMaintenanceContext(urgency, async () => {
        seen.push((await queue.run(async () => probeRequest("u"))).urgency);
      });
    }
    // 三档都必须能真正到达准入点:少一档,对应的 class 与保留份额就不可达。
    expect(seen).toEqual(["foreground", "recovery", "background"]);
    // 未声明所有者时取可观测的一侧,不得冒充前台。
    expect(probeRequest("unowned").urgency).toBe("background");
  });

  it(
    "inherits the urgency of the declaring owner when a projection flushes",
    async () => {
      // 投影 flush 是被生命周期提交调用的设施,不是维护任务的所有者:
      // 它自报紧急度就会把前台请求触发的提交降级成后台。三档各驱动一次真实
      // flush,断言落在准入请求的 urgency 上。
      const seen: string[] = [];
      for (const urgency of ["foreground", "recovery", "background"] as const) {
        const root = await createTempDir(`maintenance-inherit-${urgency}`);
        const governor = recordingGovernor();
        const index = new FileDurableProjectionIndex({
          rootDir: root,
          projectionId: "test.maintenance-inherit",
          reducerVersion: 1,
          storageMaintenance: governor.port,
        });
        await runInMaintenanceContext(urgency, async () => {
          await index.initialize({ source: checkpoint(0) });
          const prepared = await index.prepare([
            { kind: "put", key: "k", value: { key: "k" } },
          ]);
          index.publish(prepared, { source: checkpoint(1) });
          await index.flush();
        });
        const flushes = governor.requests.filter((request) =>
          request.kind === "projection-flush"
        );
        expect(flushes.length).toBeGreaterThan(0);
        seen.push(...new Set(flushes.map((request) => request.urgency)));
      }
      expect(seen).toEqual(["foreground", "recovery", "background"]);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "coalesces an identical projection obligation before physical admission",
    async () => {
      const root = await createTempDir("maintenance-projection-owner");
      const base = recordingGovernor();
      const gate = deferred<void>();
      let scrubAdmissions = 0;
      const storageMaintenance: StorageMaintenanceGovernorPort = {
        acquire: async (request, abort) => {
          if (request.kind === "projection-scrub") {
            scrubAdmissions += 1;
            await gate.promise;
          }
          return base.port.acquire(request, abort);
        },
        snapshot: () => base.port.snapshot(),
      };
      const index = new FileDurableProjectionIndex({
        rootDir: root,
        projectionId: "test.projection-owner",
        reducerVersion: 1,
        storageMaintenance,
      });

      const first = index.initialize({ source: checkpoint(0) });
      await vi.waitFor(() => expect(scrubAdmissions).toBe(1));
      const second = index.initialize({ source: checkpoint(0) });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(scrubAdmissions).toBe(1);
      gate.resolve();
      await expect(Promise.all([first, second])).resolves.toEqual([
        undefined,
        undefined,
      ]);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "issues zero-wait admissions from the authority log lock",
    async () => {
      const root = await createTempDir("maintenance-exclusion-log");
      const governor = recordingGovernor();
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const log = new FileAuthorityCommitLog(
        path.join(root, "authority-log"),
        artifacts,
        {
          clock: () => "2026-07-27T00:00:00.000Z",
          storageMaintenance: governor.port,
        },
      );
      await log.append([{ stream: "control", body: { t: "probe" } }]);

      expect(governor.requests.length).toBeGreaterThan(0);
      for (const request of governor.requests) {
        expect({ kind: request.kind, maxWaitMs: request.maxWaitMs }).toEqual({
          kind: request.kind,
          maxWaitMs: 0,
        });
      }
      // 日志锁段恒有权威写在等,紧急度必须是前台。
      expect(governor.requests.map((request) => request.urgency)).toEqual(
        governor.requests.map(() => "foreground"),
      );
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "routes legacy log identity creation through the log task owner",
    async () => {
      const root = await createTempDir("maintenance-log-owner");
      const logRoot = path.join(root, "authority-log");
      await mkdir(logRoot, { recursive: true });
      await writeFile(path.join(logRoot, "authority.log"), Buffer.alloc(0));
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const run = vi.spyOn(StorageMaintenanceTaskRunner.prototype, "run");
      try {
        const log = new FileAuthorityCommitLog(logRoot, artifacts);
        await log.checkpoint();
        expect(
          run.mock.calls.some(
            ([request]) =>
              request.kind === "log-migration" &&
              request.owner === "authority-commit-log",
          ),
        ).toBe(true);
      } finally {
        run.mockRestore();
      }
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "never retries the log lock on a capacity gap",
    async () => {
      // 段外重试只对"现在没份额"成立。设备根本装不下是不可自愈的,重试只会
      // 把失败推迟五秒;判据放宽到认所有准入错误,这条就会看到不止一次准入。
      const root = await createTempDir("maintenance-exclusion-gap");
      let acquires = 0;
      const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
      const log = new FileAuthorityCommitLog(
        path.join(root, "authority-log"),
        artifacts,
        {
          clock: () => "2026-07-27T00:00:00.000Z",
          storageMaintenance: {
            acquire: async (): Promise<DeviceCapacityAdmission> => {
              acquires += 1;
              return {
                kind: "capacity-gap",
                blockedBy: "temporaryBytes",
                required: 1024,
                available: 0,
              };
            },
            snapshot: () => ({ queued: {}, inFlight: {} }),
          },
        },
      );

      await expect(
        log.append([{ stream: "control", body: { t: "probe" } }]),
      ).rejects.toThrow(/capacity-gap/);
      expect(acquires).toBe(1);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "issues zero-wait admissions from the artifact store exclusive section",
    async () => {
      const root = await createTempDir("maintenance-exclusion-store");
      const governor = recordingGovernor();
      const store = new FileArtifactStore(path.join(root, "artifacts"));
      const ref = await store.put(Buffer.from("garbage", "utf8"));

      await store.deleteIfUnreferencedBatch(
        [ref],
        async () => ({ status: "current", retained: [] }),
        (operation) =>
          runStorageMaintenanceStep(
            governor.port,
            // 请求在独占段之内构造,零等待必须由语境给出而不是由调用方硬编码。
            storageMaintenanceRequest("asset-gc", root, { step: "unlink" }, {
              obligation: "committed",
            }),
            operation,
          ),
      );

      expect(governor.requests).toHaveLength(1);
      expect(governor.requests[0]?.maxWaitMs).toBe(0);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );
});

/**
 * 叶级物理副作用的容量语境完整性对账。
 *
 * `claimDeviceCapacity` 是 `capacityStepContext.getStore()?.claim(...)`:没有语境
 * 时静默什么也不做。因此"叶里写了记账调用"证明不了这次副作用被记进账——是否生效
 * 取决于调用栈上有没有人开了语境,而这在叶级不可见,漏了也不会有任何出口。
 *
 * 每行因此断言两件事,缺一即判旁路:该生产入口确实向 governor 取得了准入,且记账
 * 确实落在这次 permit 的 step 上。按叶枚举而不是按已知治理点枚举——按已知点核对
 * 正是这条合同两次漏掉整类执行路径的原因。
 */
interface GovernedLeafCase {
  readonly name: string;
  readonly kind: StorageMaintenanceKind;
  /** 该叶步骤的规范身份;对账按它算出的 workKey 精确匹配。 */
  readonly identity: (
    presence: FileArtifactTemporaryPresenceStore,
  ) => unknown;
  readonly drive: (
    presence: FileArtifactTemporaryPresenceStore,
  ) => Promise<void>;
}

const LEAF_REF: ArtifactRef = {
  digest: `sha256:${"a1".repeat(32)}`,
  bytes: 13,
};

async function seedStagingFile(
  presence: FileArtifactTemporaryPresenceStore,
): Promise<void> {
  const directory = path.join(
    presence.rootDir,
    LEAF_REF.digest.slice("sha256:".length),
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, ".legacy-migration.json.tmp"),
    "{}",
    "utf8",
  );
}

const GOVERNED_PRESENCE_LEAVES: readonly GovernedLeafCase[] = [
  {
    name: "marker install",
    kind: "lifecycle-reconcile",
    identity: () => ({
      step: "mark",
      digest: LEAF_REF.digest,
      scopeIdentity: "scope-leaf",
    }),
    drive: (presence) => presence.mark(LEAF_REF, "scope-leaf"),
  },
  {
    name: "scoped marker removal",
    kind: "lifecycle-reconcile",
    identity: () => ({
      step: "remove-scopes",
      digest: LEAF_REF.digest,
      scopes: ["scope-leaf"],
    }),
    drive: async (presence) => {
      await presence.mark(LEAF_REF, "scope-leaf");
      await presence.remove(LEAF_REF, "scope-leaf");
    },
  },
  {
    name: "digest tree removal",
    kind: "lifecycle-reconcile",
    identity: () => ({ step: "remove-all", digest: LEAF_REF.digest }),
    drive: async (presence) => {
      await presence.mark(LEAF_REF, "scope-leaf");
      await presence.remove(LEAF_REF);
    },
  },
  {
    // 驱动的是生产路径:staging 清理在生产上由对账游标的回调触发,
    // `removeStagingFiles` 零生产消费者(依据见 X23-21),拿它驱动等于对着一条
    // 到不了的路径取证。
    name: "reconciliation cursor staging cleanup",
    kind: "lifecycle-reconcile",
    identity: () => ({
      step: "reconciliation-page",
      cursor: 1,
      page: 0,
    }),
    drive: async (presence) => {
      await seedStagingFile(presence);
      const cursor = presence.openReconciliationCursor();
      try {
        await cursor.next(64);
      } finally {
        await cursor.close();
      }
    },
  },
  {
    name: "legacy migration begin",
    kind: "lifecycle-reconcile",
    identity: () => ({
      step: "begin-legacy-migration",
      digest: LEAF_REF.digest,
    }),
    drive: (presence) => presence.beginLegacyMigration(LEAF_REF),
  },
  {
    name: "legacy migration finish",
    kind: "lifecycle-reconcile",
    identity: () => ({
      step: "finish-legacy-migration",
      digest: LEAF_REF.digest,
    }),
    drive: async (presence) => {
      await presence.beginLegacyMigration(LEAF_REF);
      await presence.finishLegacyMigration(LEAF_REF);
    },
  },
];

describe("device capacity context at physical leaves", () => {
  it.each(GOVERNED_PRESENCE_LEAVES.map((leaf) => [leaf.name, leaf] as const))(
    "admits and accounts the %s leaf",
    async (_name, leaf) => {
      const root = await createTempDir("maintenance-leaf");
      const governor = recordingGovernor();
      const presence = new FileArtifactTemporaryPresenceStore(
        path.join(root, "presence"),
        { storageMaintenance: governor.port },
      );

      await leaf.drive(presence);

      // 按规范 workKey 精确匹配,不只看"有没有 lifecycle-reconcile 请求":这些
      // 叶步骤彼此嵌套,只断言 kind 会被内层叶的 permit 满足,去掉外层的治理也照样
      // 绿——那样的用例名实不符,防不住它声称要防的东西。
      const expected = storageMaintenanceWorkKey(
        leaf.kind,
        presence.rootDir,
        leaf.identity(presence),
      );
      expect(governor.requests.map((request) => request.workKey)).toContain(
        expected,
      );
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it("preserves nested step identities instead of silently inheriting", async () => {
    // 嵌套步骤若静默继承外层 permit,内层的 kind、workKey、预算与记账会全部
    // 消失。生产调用图必须消除嵌套,准入原语本身不得掩盖它。
    const governor = recordingGovernor();
    const outer = probeRequest("outer");
    const inner = probeRequest("inner");

    await runStorageMaintenanceStep(governor.port, outer, async () => {
      await runStorageMaintenanceStep(governor.port, inner, async () => {
        claimDeviceCapacity("ioOperations", 1);
      });
    });

    expect(governor.requests.map((request) => request.kind)).toEqual([
      outer.kind,
      inner.kind,
    ]);
    expect(governor.claims).toEqual(["ioOperations"]);
  });
});

/**
 * discard 准入位置对账:先拿锁/串行权、后取容量,顺序不可反。
 *
 * 先取容量再等锁是 U23-47 的形态:单槽设备上"占着容量等锁、持锁者等容量"
 * 就构成自锁。断言落在准入包装的执行时点上——设施串行区被占住期间,
 * 准入包装绝不能执行;串行权释放后才允许出现。
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("capacity admission placement on discard paths", () => {
  it(
    "admits only after the receiver's per-digest serial section is acquired",
    async () => {
      const root = await createTempDir("discard-order-receiver");
      const store = new FileArtifactStore(path.join(root, "artifacts"));
      const receiver = new FileResumableArtifactReceiver(
        store,
        path.join(root, "partials"),
        { maxArtifactBytes: 1_024 },
      );
      const bytes = Buffer.from("discard-order", "utf8");
      const ref: ArtifactRef = {
        digest: byteDigest(bytes),
        bytes: bytes.byteLength,
      };
      const gate = deferred<void>();
      const order: string[] = [];
      // 占住 digest 串行段:progress 先进入串行段,再执行注入的步骤包装。
      const held = receiver.progress(ref, async (_identity, operation) => {
        order.push("serial-held");
        await gate.promise;
        return operation();
      });
      await vi.waitFor(() => expect(order).toEqual(["serial-held"]));
      const discarded = receiver.discard(ref, async (operation) => {
        order.push("admitted");
        return operation();
      });
      // 串行段被占期间准入包装绝不能执行——先取容量等段就是从这里漏出来的。
      await new Promise((resolve) => setImmediate(resolve));
      expect(order).toEqual(["serial-held"]);
      gate.resolve();
      await expect(discarded).resolves.toBe(false);
      await expect(held).resolves.toEqual({
        receivedBytes: 0,
        complete: false,
      });
      expect(order).toEqual(["serial-held", "admitted"]);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );

  it(
    "admits only after the artifact store's exclusive section is acquired",
    async () => {
      const root = await createTempDir("discard-order-store");
      const store = new FileArtifactStore(path.join(root, "artifacts"));
      const ref = await store.put(Buffer.from("garbage", "utf8"));
      const gate = deferred<void>();
      const order: string[] = [];
      // 占住排他段:withPresentReferences 先进入排他段,再执行操作体。
      const held = store.withPresentReferences([ref], async () => {
        order.push("exclusive-held");
        await gate.promise;
      });
      await vi.waitFor(() => expect(order).toEqual(["exclusive-held"]));
      const discarded = store.discard(ref, async (operation) => {
        order.push("admitted");
        return operation();
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(order).toEqual(["exclusive-held"]);
      gate.resolve();
      await expect(discarded).resolves.toBe(true);
      await held;
      expect(order).toEqual(["exclusive-held", "admitted"]);
    },
    DURABLE_IO_TEST_TIMEOUT_MS,
  );
});
