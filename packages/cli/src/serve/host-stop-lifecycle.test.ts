import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { DeviceLifecycleJournal, FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import { protocolDigest } from "@zhixing/core/protocol";
import { describe, expect, it, vi } from "vitest";
import { HostStopCoordinator, type HostStopRuntime } from "./host-stop-lifecycle.js";

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
      expect(fixture.order).toContain(strategy === "cancel" ? "cancel" : strategy);
      expect(fixture.order.slice(-2)).toEqual(["flush", "physical"]);
      const active = await fixture.journal.active();
      expect(active).toHaveLength(1);
      expect(active[0]?.phase).toBe("ready-to-stop");
    },
  );

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
    expect(fixture.order.filter((item) => item === "immediate")).toHaveLength(1);
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
  });
});

async function createFixture(options: { failFlushOnce?: boolean } = {}) {
  const root = await createTempDir("host-stop-lifecycle");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => "2026-08-12T00:00:00.000Z",
  });
  const journal = new DeviceLifecycleJournal(log);
  const order: string[] = [];
  let failFlush = options.failFlushOnce ?? false;
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
    settlePhysicalSteps: vi.fn(async () => { order.push("physical"); }),
  };
  const homeId = (await log.originCheckpoint()).logId;
  return {
    order,
    runtime,
    homeId,
    journal,
    coordinator: new HostStopCoordinator({
      journal,
      homeId,
      host: {
        kind: "foreground",
        processId: 42,
        startedAt: "2026-08-12T00:00:00.000Z",
      },
      runtime,
    }),
  };
}
