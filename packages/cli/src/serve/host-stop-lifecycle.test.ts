import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { DeviceLifecycleJournal, FileArtifactStore, FileAuthorityCommitLog, registerDeviceLifecycleProjection } from "@zhixing/core/authority";
import { protocolDigest } from "@zhixing/core/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  HOST_STOP_ACCEPTED_WORK_OWNERS,
  HostStopCoordinator,
  hostStopAlreadySettled,
  type HostStopAcceptedWorkPorts,
  type HostStopRuntime,
} from "./host-stop-lifecycle.js";

describe("HostStopCoordinator", () => {
  it.each(["immediate", "drain", "cancel"] as const)(
    "durably reaches ready-to-stop for %s in the required order",
    async (strategy) => {
      const fixture = await createFixture();
      const result = await fixture.coordinator.prepare({
        requestId: `request-${strategy}`,
        reason: "test",
        strategy,
        timeoutMs: 2_000,
      });
      expect(result.phase).toBe("ready-to-stop");
      expect(fixture.order[0]).toBe("close");
      for (const owner of HOST_STOP_ACCEPTED_WORK_OWNERS) {
        expect(fixture.order).toContain(`settle:${owner}:${strategy}`);
        expect(fixture.order).toContain(`read-back:${owner}`);
        expect(fixture.settled.get(owner)).toEqual({
          operationId: protocolDigest("HostStopOperation", 1, {
            requestId: `request-${strategy}`,
            homeId: fixture.homeId,
          }),
          frozen: [{ id: `${owner}:item`, revision: `${owner}:revision` }],
        });
        expect(fixture.readBack.get(owner)).toEqual(fixture.settled.get(owner));
      }
      expect(fixture.order.slice(-2)).toEqual(["flush", "physical"]);
      const active = await fixture.journal.active();
      expect(active).toHaveLength(1);
      expect(active[0]?.phase).toBe("ready-to-stop");
    },
    120_000,
  );

  it("joins a stop already in progress for the same host instead of admitting a conflicting one", async () => {
    const fixture = await createFixture();
    // 空闲回收的内部停止先进入，外部 zz stop 在其推进过程中到达。
    const internal = fixture.coordinator.prepare({ requestId: "anchor-internal-stop:test", reason: "idle", strategy: "drain", timeoutMs: 2_000 });
    const external = fixture.coordinator.prepare({ requestId: "user-stop", reason: "rpc", strategy: "cancel", timeoutMs: 2_000 });
    await expect(internal).resolves.toMatchObject({ phase: "ready-to-stop", strategy: "drain" });
    // 接续已有停止并如实报告它的策略，不声称按新请求的策略处理。
    await expect(external).resolves.toMatchObject({ requestId: "user-stop", phase: "ready-to-stop", strategy: "drain" });
    const active = await fixture.journal.active();
    expect(active).toHaveLength(1);
    expect(active[0]?.identity.kind === "stop" && active[0].identity.requestId).toBe("anchor-internal-stop:test");
    expect(fixture.order.filter((item) => item === "close")).toHaveLength(1);
    expect(fixture.order.filter((item) => item === "flush")).toHaveLength(1);
    // 已到安全点后再到达的停止同样接续，不再推进或报错。
    await expect(fixture.coordinator.prepare({ requestId: "user-stop-late", reason: "rpc", strategy: "cancel", timeoutMs: 2_000 }))
      .resolves.toMatchObject({ phase: "ready-to-stop", strategy: "drain" });
    expect(fixture.order.filter((item) => item === "flush")).toHaveLength(1);
  }, 120_000);

  it("exactly replays response loss without repeating completed effects", async () => {
    const fixture = await createFixture();
    const request = {
      requestId: "request-replay",
      reason: "test",
      strategy: "drain" as const,
      timeoutMs: 2_000,
    };
    await fixture.coordinator.prepare(request);
    const completedOrder = [...fixture.order];
    await fixture.coordinator.prepare(request);
    expect(fixture.order).toEqual(completedOrder);
  });

  it("keeps the gate closed on flush failure and resumes from that durable phase", async () => {
    const fixture = await createFixture({ failFlushOnce: true });
    const request = {
      requestId: "request-failure",
      reason: "test",
      strategy: "immediate" as const,
      timeoutMs: 2_000,
    };
    await expect(fixture.coordinator.prepare(request)).rejects.toThrow("disk full");
    const [blocked] = await fixture.journal.active();
    expect(blocked?.phase).toBe("work-settled");
    await expect(fixture.coordinator.prepare(request)).resolves.toMatchObject({ phase: "ready-to-stop" });
    expect(fixture.order.filter((item) => item === "close")).toHaveLength(1);
    expect(fixture.order.filter((item) => item === "settle:conversation:immediate")).toHaveLength(1);
    expect(fixture.order.filter((item) => item === "flush")).toHaveLength(2);
  });

  it("appends terminal only after an exact old host is independently read back stopped", async () => {
    const fixture = await createFixture();
    await fixture.coordinator.prepare({
      requestId: "request-old-host",
      reason: "test",
      strategy: "drain",
      timeoutMs: 2_000,
    });
    const restarted = new HostStopCoordinator({
      localDeviceId: "device-local",
      journal: fixture.journal,
      homeId: fixture.homeId,
      host: {
        kind: "foreground",
        processId: 43,
        startedAt: "2026-08-12T00:01:00.000Z",
      },
      runtime: fixture.runtime,
      isHostStopped: async (host) => host.kind === "foreground" && host.processId === 42,
    });
    await restarted.resumeActive();
    await expect(fixture.journal.active()).resolves.toHaveLength(0);
    await expect(fixture.journal.state(protocolDigest("HostStopOperation", 1, {
      requestId: "request-old-host",
      homeId: fixture.homeId,
    }))).resolves.toMatchObject({ phase: "terminal" });
  }, 120_000);

  it.each([
    ["accepted", false],
    ["gate-closed", false],
    ["work-settled", true],
    ["flushed", true],
    ["ready-to-stop", true],
  ] as const)(
    "projects durable %s settlement state",
    (phase, alreadySettled) => {
      expect(hostStopAlreadySettled(phase)).toBe(alreadySettled);
    },
  );

  it("resumes an old-host gate-closed operation before terminalizing it", async () => {
    const fixture = await createFixture({ failSettleOnce: true });
    const request = {
      requestId: "request-successor-gate-closed",
      reason: "test",
      strategy: "immediate" as const,
      timeoutMs: 2_000,
    };
    await expect(fixture.coordinator.prepare(request)).rejects.toThrow("successor boundary");
    await expect(fixture.journal.active()).resolves.toEqual([
      expect.objectContaining({ phase: "gate-closed" }),
    ]);

    const successor = new HostStopCoordinator({
      localDeviceId: "device-local",
      journal: fixture.journal,
      homeId: fixture.homeId,
      host: {
        kind: "foreground",
        processId: 43,
        startedAt: "2026-08-12T00:01:00.000Z",
      },
      runtime: fixture.runtime,
      acceptedWork: fixture.acceptedWork,
      artifactStore: fixture.artifacts,
      isHostStopped: async () => true,
    });
    const [result] = await successor.resumeActive();
    expect(result?.phase).toBe("terminal");
    expect(fixture.order.filter((item) => item === "close")).toHaveLength(1);
    expect(fixture.order).toContain("settle:conversation:immediate");
    expect(fixture.order.slice(-2)).toEqual(["flush", "physical"]);
  }, 120_000);

  it("keeps every owner effect closed when old-host proof is unavailable", async () => {
    const fixture = await createFixture({ failSettleOnce: true });
    const request = {
      requestId: "request-unproven-old-host",
      reason: "test",
      strategy: "drain" as const,
      timeoutMs: 2_000,
    };
    await expect(fixture.coordinator.prepare(request)).rejects.toThrow("successor boundary");
    const completed = [...fixture.order];
    const successor = new HostStopCoordinator({
      localDeviceId: "device-local",
      journal: fixture.journal,
      homeId: fixture.homeId,
      host: {
        kind: "foreground",
        processId: 44,
        startedAt: "2026-08-12T00:02:00.000Z",
      },
      runtime: fixture.runtime,
      acceptedWork: fixture.acceptedWork,
      artifactStore: fixture.artifacts,
      isHostStopped: async () => false,
    });
    await expect(successor.resumeActive()).resolves.toEqual([]);
    expect(fixture.order).toEqual(completed);
    await expect(fixture.journal.state(protocolDigest("HostStopOperation", 1, {
      requestId: request.requestId,
      homeId: fixture.homeId,
    }))).resolves.toMatchObject({ phase: "gate-closed" });
  }, 120_000);

  it.each([
    ["work-settled", { failFlushOnce: true }],
    ["flushed", { failPhysicalOnce: true }],
  ] as const)(
    "successor resumes %s without repeating settlement or prior phases",
    async (phase, options) => {
      const fixture = await createFixture(options);
      const request = {
        requestId: `request-successor-${phase}`,
        reason: "test",
        strategy: "immediate" as const,
        timeoutMs: 2_000,
      };
      await expect(fixture.coordinator.prepare(request)).rejects.toThrow();
      await expect(fixture.journal.active()).resolves.toEqual([
        expect.objectContaining({ phase }),
      ]);
      const settledBefore = fixture.order.filter((item) => item.startsWith("settle:")).length;
      const successor = new HostStopCoordinator({
        localDeviceId: "device-local",
        journal: fixture.journal,
        homeId: fixture.homeId,
        host: {
          kind: "foreground",
          processId: 45,
          startedAt: "2026-08-12T00:03:00.000Z",
        },
        runtime: fixture.runtime,
        acceptedWork: fixture.acceptedWork,
        artifactStore: fixture.artifacts,
        isHostStopped: async () => true,
      });
      await expect(successor.resumeActive()).resolves.toEqual([
        expect.objectContaining({ phase: "terminal" }),
      ]);
      expect(fixture.order.filter((item) => item.startsWith("settle:"))).toHaveLength(
        settledBefore,
      );
      expect(fixture.order.filter((item) => item === "close")).toHaveLength(1);
    },
    120_000,
  );
});

async function createFixture(options: {
  failFlushOnce?: boolean;
  failSettleOnce?: boolean;
  failPhysicalOnce?: boolean;
} = {}) {
  const root = await createTempDir("host-stop-lifecycle");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => "2026-08-12T00:00:00.000Z",
  });
  // 与宿主相同：投影先由其所有者登记再打开日志；主机停止记录不经签名校验，校验器被调用即视为错误。
  registerDeviceLifecycleProjection(log, { verify() { throw new Error("host stop records are not signature-verified"); } });
  const journal = new DeviceLifecycleJournal(log);
  const order: string[] = [];
  const settled = new Map<string, unknown>();
  const readBack = new Map<string, unknown>();
  let failSettle = options.failSettleOnce ?? false;
  const acceptedWork = Object.fromEntries(HOST_STOP_ACCEPTED_WORK_OWNERS.map((owner) => [owner, {
    freeze: async () => [{ id: `${owner}:item`, revision: `${owner}:revision` }],
    settle: async (input: {
      readonly operationId: string;
      readonly strategy: "immediate" | "drain" | "cancel";
      readonly frozen: readonly { readonly id: string; readonly revision: string }[];
    }) => {
      if (owner === "conversation" && failSettle) {
        failSettle = false;
        throw new Error("successor boundary");
      }
      order.push(`settle:${owner}:${input.strategy}`);
      settled.set(owner, { operationId: input.operationId, frozen: input.frozen });
    },
    readBack: async (input: {
      readonly operationId: string;
      readonly frozen: readonly { readonly id: string; readonly revision: string }[];
    }) => {
      order.push(`read-back:${owner}`);
      readBack.set(owner, { operationId: input.operationId, frozen: input.frozen });
    },
  }])) as unknown as HostStopAcceptedWorkPorts;
  let failFlush = options.failFlushOnce ?? false;
  let failPhysical = options.failPhysicalOnce ?? false;
  const runtime: HostStopRuntime = {
    closeAdmission: vi.fn(async () => { order.push("close"); }),
    settleImmediate: vi.fn(async () => { order.push("immediate"); }),
    drainAcceptedWork: vi.fn(async () => { order.push("drain"); }),
    cancelAcceptedWork: vi.fn(async () => { order.push("cancel"); }),
    flushDurableState: vi.fn(async () => {
      order.push("flush");
      if (failFlush) {
        failFlush = false;
        throw new Error("disk full");
      }
      const checkpoint = await log.checkpoint();
      return [{ kind: "accepted-work" as const, digest: checkpoint.prefixDigest }];
    }),
    settlePhysicalSteps: vi.fn(async () => {
      order.push("physical");
      if (failPhysical) {
        failPhysical = false;
        throw new Error("physical response lost");
      }
    }),
  };
  const homeId = (await log.originCheckpoint()).logId;
  return {
    order,
    settled,
    readBack,
    runtime,
    homeId,
    journal,
    artifacts,
    acceptedWork,
    coordinator: new HostStopCoordinator({
      localDeviceId: "device-local",
      journal,
      homeId,
      host: {
        kind: "foreground",
        processId: 42,
        startedAt: "2026-08-12T00:00:00.000Z",
      },
      runtime,
      acceptedWork,
      artifactStore: artifacts,
    }),
  };
}
