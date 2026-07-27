import { Buffer } from "node:buffer";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "../../persistence/index.js";
import {
  runInMaintenanceContext,
  runStorageMaintenanceTask,
  storageMaintenanceRequest,
  StorageMaintenanceTaskRunner,
  type DeviceCapacityAdmission,
  type StorageMaintenanceGovernorPort,
  type StorageMaintenanceRequest,
  type StorageMaintenanceUrgency,
} from "../../resources/index.js";
import { FileArtifactStore } from "../artifact-store.js";
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
} {
  const requests: StorageMaintenanceRequest[] = [];
  const permit = {
    granted: {
      memoryReservationBytes: 0,
      temporaryBytes: 0,
      slots: 0,
      readBytes: Number.MAX_SAFE_INTEGER,
      writeBytes: Number.MAX_SAFE_INTEGER,
      ioOperations: Number.MAX_SAFE_INTEGER,
    },
    tryBegin: () => ({ claim: () => undefined, complete: () => undefined }),
    release: () => undefined,
  };
  return {
    requests,
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
      const runner = new StorageMaintenanceTaskRunner(governor.port);
      const store = new FileArtifactStore(path.join(root, "artifacts"));
      const ref = await store.put(Buffer.from("garbage", "utf8"));

      await store.deleteIfUnreferencedBatch(
        [ref],
        async () => ({ status: "current", retained: [] }),
        (operation) =>
          runStorageMaintenanceTask(
            runner,
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
