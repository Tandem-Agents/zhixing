import { Buffer } from "node:buffer";
import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type {
  ArtifactRef,
  AssignmentResourceLease,
  AuthorityCapability,
  AuthorityCallContext,
  ResourceUsageIntake,
  Signature,
  UsageReport,
} from "@zhixing/core/contracts";
import { ImmediateRootReplayTerminalError } from "@zhixing/core/contracts";
import {
  canonicalize,
  protocolDigest,
  ResourceAdmissionDeferredError,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  ExecutorResourceBackpressureError,
  ExecutorResourceGovernor,
} from "../resource-governor.js";

const NOW = "2026-07-20T00:00:00.000Z";

const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "device-1",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier = {
  verify(schemaId: string, version: number, payload: unknown, signature: Signature) {
    expect(signature).toEqual(signer.sign(schemaId, version, payload));
  },
};

const context: AuthorityCallContext = {
  principal: { kind: "host", component: "executor-resource-test" },
  requestId: "request-1",
  deadlineAt: "2026-07-20T00:05:00.000Z",
};

describe("ExecutorResourceGovernor", () => {
  it("dequeues a control root precisely when its admission deadline has already passed", async () => {
    let monotonicNow = 0;
    const fixture = await createHarness(
      4,
      () => NOW,
      60_000,
      () => {
        monotonicNow += 10_000;
        return monotonicNow;
      },
    );
    const expired = {
      principal: { kind: "host", component: "executor-resource-test" },
      requestId: "request-expired",
      deadlineAt: "2026-07-19T23:59:59.000Z",
    } as const;
    await expect(fixture.governor.acquireRoot(
      { kind: "control", id: "control-expired", attempt: 1 },
      { maxCalls: 1 },
      { admissionClass: "interactive", entry: "conversation-input" },
      expired,
    )).rejects.toThrow();
    const records = (await fixture.log.readAll())
      .flatMap((envelope) => envelope.entries)
      .map((entry) => (entry.body as { t?: string }).t ?? "")
      .filter((t) => t === "queued" || t === "dequeue");
    expect(records).toEqual(["queued", "dequeue"]);
    const workload = { kind: "control", id: "control-expired", attempt: 1 } as const;
    await expect(fixture.restart().inspectImmediateRoot(workload)).resolves.toMatchObject({
      kind: "dequeued",
      reason: "expired",
    });
    await expect(fixture.restart().acquireRoot(
      workload,
      { maxCalls: 1 },
      { admissionClass: "interactive", entry: "conversation-input" },
      context,
    )).rejects.toBeInstanceOf(ImmediateRootReplayTerminalError);
  });

  it("rejects invalid admission requests before any queue side-effect", async () => {
    const fixture = await createHarness();
    const origin = { admissionClass: "interactive", entry: "conversation-input" } as const;
    const context = {
      principal: { kind: "host", component: "test-resource-governor" },
      requestId: "request-invalid",
      deadlineAt: "2026-07-20T00:05:00.000Z",
    } as const;
    const baseline = (await fixture.log.readAll()).length;
    await expect(fixture.governor.acquireRoot(
      { kind: "evidence", id: "not-a-root", attempt: 1 } as never,
      { maxCalls: 1 },
      origin,
      context,
    )).rejects.toThrow();
    await expect(fixture.governor.acquireRoot(
      { kind: "control", id: "control-bad-budget", attempt: 1 },
      {},
      origin,
      context,
    )).rejects.toThrow();
    await expect(fixture.governor.enqueueRoot(
      "rsv-invalid",
      { kind: "control", id: "control-bad-attempt", attempt: 0 } as never,
      origin,
      context,
    )).rejects.toThrow();
    await expect(fixture.governor.enqueueRoot(
      "rsv-bad-ctx",
      { kind: "control", id: "control-good", attempt: 1 },
      origin,
      { ...context, requestId: "" },
    )).rejects.toThrow();
    await expect(fixture.governor.enqueueRoot(
      "rsv-bad-deadline",
      { kind: "control", id: "control-good", attempt: 1 },
      origin,
      { ...context, deadlineAt: "not-a-time" },
    )).rejects.toThrow();
    expect(await fixture.log.readAll()).toHaveLength(baseline);
  });

  it("returns an activated local root on an exact response-loss retry", async () => {
    const fixture = await createHarness();
    const origin = { admissionClass: "interactive", entry: "conversation-input" } as const;
    const request = {
      assignmentId: "assignment-local-retry",
      executorId: "executor-1",
      workload: { kind: "run" as const, id: "run-local-retry", attempt: 1 },
      scopeBinding: {
        kind: "conversation" as const,
        conversationId: "conversation-1",
        ownerEpoch: 1,
      },
      budget: { maxCalls: 2 },
    };
    await fixture.governor.enqueueRoot(
      "reservation:assignment-local-retry",
      request.workload,
      origin,
      context,
    );
    const lease = await fixture.governor.prepareAssignmentRoot(request, origin, context);
    await fixture.governor.coordinate(async () => {
      await fixture.log.append(fixture.governor.prepareReceipt(lease));
    });

    await expect(fixture.restart().prepareAssignmentRoot(request, origin, context))
      .resolves.toEqual(lease);
    await expect(fixture.restart().prepareAssignmentRoot({
      ...request,
      budget: { maxCalls: 3 },
    }, origin, context)).rejects.toThrow("changed its frozen request");
  });

  it("waits within one class while allowing another class to advance", async () => {
    const fixture = await createHarness();
    const interactive = { admissionClass: "interactive", entry: "conversation-input" } as const;
    const advancement = { admissionClass: "advancement", entry: "advancement-control" } as const;
    const request = (suffix: string) => ({
      assignmentId: `assignment-local-wait-${suffix}`,
      executorId: "executor-1",
      workload: { kind: "run" as const, id: `run-local-wait-${suffix}`, attempt: 1 },
      scopeBinding: {
        kind: "conversation" as const,
        conversationId: "conversation-1",
        ownerEpoch: 1,
      },
      budget: { maxCalls: 1 },
    });
    const first = request("1");
    await fixture.governor.enqueueRoot(
      `reservation:${first.assignmentId}`,
      first.workload,
      interactive,
      context,
    );
    await fixture.governor.prepareAssignmentRoot(first, interactive, context);

    const second = request("2");
    await fixture.governor.enqueueRoot(
      `reservation:${second.assignmentId}`,
      second.workload,
      interactive,
      context,
    );
    await expect(fixture.governor.prepareAssignmentRoot(
      second,
      interactive,
      { ...context, deadlineAt: NOW },
    )).rejects.toBeInstanceOf(ResourceAdmissionDeferredError);
    expect((await fixture.governor.snapshot()).queued.has(`reservation:${second.assignmentId}`))
      .toBe(true);

    const otherClass = request("3");
    await fixture.governor.enqueueRoot(
      `reservation:${otherClass.assignmentId}`,
      otherClass.workload,
      advancement,
      context,
    );
    await expect(fixture.governor.prepareAssignmentRoot(otherClass, advancement, context))
      .resolves.toMatchObject({ reservationId: `reservation:${otherClass.assignmentId}` });
  });

  it("atomically activates control roots without a candidate window", async () => {
    let monotonicNow = 0;
    const fixture = await createHarness(
      1,
      () => NOW,
      60_000,
      () => {
        monotonicNow += 10_000;
        return monotonicNow;
      },
    );
    const workload = { kind: "control", id: "local-control-atomic", attempt: 1 } as const;
    const origin = { admissionClass: "advancement", entry: "advancement-control" } as const;
    const lease = await fixture.governor.acquireRoot(
      workload,
      { maxCalls: 1 },
      origin,
      context,
    );
    const recordCount = (await fixture.log.readAll()).length;
    await expect(fixture.restart().acquireRoot(
      workload,
      { maxCalls: 1 },
      origin,
      context,
    )).resolves.toEqual(lease);
    expect(await fixture.log.readAll()).toHaveLength(recordCount);
    await expect(fixture.governor.inspectImmediateRoot(workload)).resolves.toEqual({
      kind: "reservation",
      state: "active",
      lease,
    });
    const terminalContext = {
      ...context,
      deadlineAt: "2026-07-20T00:00:30.000Z",
    };
    await fixture.governor.settle(lease, terminalContext);
    await fixture.governor.release(lease, terminalContext);
    await expect(fixture.restart().inspectImmediateRoot(workload)).resolves.toEqual({
      kind: "reservation",
      state: "released",
      lease,
    });
    await expect(fixture.restart().acquireRoot(
      workload,
      { maxCalls: 1 },
      origin,
      context,
    )).rejects.toBeInstanceOf(ImmediateRootReplayTerminalError);

    const state = await fixture.governor.snapshot();
    expect([...state.reservations.values()].filter(
      (reservation) => reservation.depth === 0 && reservation.state === "active",
    )).toHaveLength(0);
  });

  it("rechecks control capacity at reserve and retains queued work for retry", async () => {
    const fixture = await createHarness(1);
    const root = assignmentLease("assignment-capacity", "run-capacity", 1);
    await accept(fixture, root);
    const workload = { kind: "control", id: "local-control-capacity", attempt: 1 } as const;
    const origin = { admissionClass: "advancement", entry: "advancement-control" } as const;

    await expect(fixture.governor.acquireRoot(
      workload,
      { maxCalls: 1 },
      origin,
      context,
    )).rejects.toBeInstanceOf(ExecutorResourceBackpressureError);
    expect((await fixture.governor.snapshot()).queued.size).toBe(1);

    await fixture.governor.coordinate(async () => {
      await fixture.log.append(fixture.governor.prepareTerminal({
        lease: root,
        mode: "settle-release",
      }));
    });
    await expect(fixture.governor.acquireRoot(
      workload,
      { maxCalls: 1 },
      origin,
      context,
    )).resolves.toMatchObject({ workload });
    expect([...((await fixture.governor.snapshot()).reservations.values())].filter(
      (reservation) => reservation.depth === 0 && reservation.state === "active",
    )).toHaveLength(1);
  });

  it("rejects polluted local governor records during replay", async () => {
    const fixture = await createHarness();
    await fixture.log.append([{
      stream: "governor",
      body: {
        t: "queued",
        reservationId: "reservation-polluted",
        admissionClass: "interactive",
        workload: { kind: "control", id: "polluted", attempt: 1 },
        unknown: true,
      },
    }]);
    await expect(fixture.restart().snapshot()).rejects.toThrow("fields");
  });

  it("rejects unsupported local job roots before durable enqueue", async () => {
    const fixture = await createHarness();
    await expect(fixture.governor.enqueueRoot(
      "reservation:local-job",
      { kind: "job", id: "job-local", attempt: 1 },
      { admissionClass: "scheduler", entry: "schedule-trigger" },
      context,
    )).rejects.toThrow("anchor governor");
    expect(await fixture.log.readAll()).toHaveLength(0);
  });

  it("enforces delegation depth on local assignment roots", async () => {
    const fixture = await createHarness();
    const origin = { admissionClass: "interactive", entry: "conversation-input" } as const;
    const request = {
      assignmentId: "assignment-local-depth",
      executorId: "executor-1",
      workload: { kind: "run" as const, id: "run-local-depth", attempt: 1 },
      scopeBinding: {
        kind: "conversation" as const,
        conversationId: "conversation-1",
        ownerEpoch: 1,
      },
      budget: { maxCalls: 3 },
    };
    await fixture.governor.enqueueRoot(
      "reservation:assignment-local-depth",
      request.workload,
      origin,
      context,
    );
    const root = await fixture.governor.prepareAssignmentRoot(request, origin, context);
    const capability = assignmentCapability(request.assignmentId, "cap-local-depth");
    await accept(fixture, root, [capability.capId]);
    const callContext = {
      ...assignmentCallContext(capability),
      deadlineAt: root.expiry,
    };
    const child = await fixture.governor.acquireChild(
      root,
      { kind: "orchestration-node", id: "local-child", attempt: 1 },
      { maxCalls: 2 },
      callContext,
    );
    await expect(fixture.governor.acquireChild(
      child,
      { kind: "orchestration-node", id: "local-grandchild", attempt: 1 },
      { maxCalls: 1 },
      callContext,
    )).rejects.toThrow("delegation depth");
  });

  it("enforces local hard capacity when accepting delegated roots", async () => {
    const fixture = await createHarness(1);
    await accept(fixture, assignmentLease("assignment-1", "run-1", 2));
    await fixture.governor.coordinate(async () => {
      expect(() => fixture.governor.prepareReceipt(
        assignmentLease("assignment-2", "run-2", 2),
      )).toThrow(ExecutorResourceBackpressureError);
    });
  });

  it("issues bounded children, accounts usage and produces dense reports", async () => {
    const fixture = await createHarness();
    const root = assignmentLease("assignment-1", "run-1", 5);
    const capability = assignmentCapability("assignment-1", "cap-resource-1");
    const assignmentContext = assignmentCallContext(capability);
    await accept(fixture, root, [capability.capId]);
    const child = await fixture.governor.acquireChild(
      root,
      { kind: "orchestration-node", id: "node-1", attempt: 1 },
      { maxCalls: 3 },
      assignmentContext,
    );
    await expect(fixture.governor.acquireChild(
      root,
      { kind: "orchestration-node", id: "node-1", attempt: 1 },
      { maxCalls: 3 },
      assignmentContext,
    )).resolves.toEqual(child);
    await expect(fixture.governor.acquireChild(
      root,
      { kind: "orchestration-node", id: "node-over", attempt: 1 },
      { maxCalls: 3 },
      assignmentContext,
    )).rejects.toThrow("commitments");
    await fixture.governor.reserveUsage(
      child,
      { usageId: "usage-1", calls: 2 },
      assignmentContext,
    );
    await fixture.governor.consume(child, { usageId: "usage-1", calls: 2 }, assignmentContext);
    await fixture.governor.settle(child, assignmentContext);
    await fixture.governor.release(child, assignmentContext);

    const captured: UsageReport[] = [];
    const intake: ResourceUsageIntake = {
      async submitUsageReport(report) {
        captured.push(report);
        return { ackedThroughSeq: report.toUsageSeq };
      },
    };
    const final = await fixture.governor.flushAssignment(
      "assignment-1",
      intake,
      () => ({
        principal: { kind: "usage-reporter", executorId: "executor-1" },
        requestId: "report-1",
        deadlineAt: "2026-07-20T00:05:00.000Z",
      }),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      reporterId: "executor-1",
      fromUsageSeq: 1,
      toUsageSeq: 1,
      usages: [{ usageId: "usage-1", calls: 2 }],
    });
    expect(final).toEqual({
      reportDigest: captured[0]!.digest,
      upToUsageSeq: 1,
    });
  });

  it("keeps expired assignment trees for business recovery and reclaims control roots", async () => {
    let now = NOW;
    let monotonicNow = 0;
    const fixture = await createHarness(4, () => now, 1_000, () => monotonicNow);
    const root = assignmentLease("assignment-expired", "run-expired", 2, {
      issuedAt: NOW,
      expiry: "2026-07-20T00:00:01.000Z",
    });
    const capability = assignmentCapability("assignment-expired", "cap-expired");
    await accept(fixture, root, [capability.capId]);
    const child = await fixture.governor.acquireChild(
      root,
      { kind: "evidence", id: "evidence-1", attempt: 1 },
      { maxCalls: 1 },
      { ...assignmentCallContext(capability), deadlineAt: root.expiry },
    );
    await fixture.governor.reserveUsage(
      child,
      { usageId: "usage-expired-unknown", calls: 1 },
      {
        ...assignmentCallContext(capability),
        deadlineAt: "2026-07-20T00:00:00.500Z",
      },
    );
    const control = await fixture.governor.acquireRoot(
      { kind: "control", id: "local-control-expired", attempt: 1 },
      { maxCalls: 1 },
      { admissionClass: "advancement", entry: "advancement-control" },
      context,
    );
    now = "2026-07-20T00:00:02.000Z";
    monotonicNow = 2_000;
    await expect(fixture.governor.reclaimExpired()).resolves.toBe(1);
    const projection = await fixture.governor.snapshot();
    expect(projection.reservations.get(root.reservationId)?.state).toBe("active");
    expect(projection.reservations.get(child.reservationId)?.state).toBe("active");
    expect(projection.reservations.get(control.reservationId)?.state).toBe("reclaimed");
    expect(projection.usageReservations.get("usage-expired-unknown")?.state).toBe("reserved");

    const reports: UsageReport[] = [];
    await fixture.governor.flushAssignment(
      "assignment-expired",
      {
        async submitUsageReport(report) {
          reports.push(report);
          return { ackedThroughSeq: report.toUsageSeq };
        },
      },
      () => ({
        principal: { kind: "usage-reporter", executorId: "executor-1" },
        requestId: "report-expired",
        deadlineAt: "2026-07-20T00:05:00.000Z",
      }),
    );
    expect(reports).toHaveLength(1);
    expect((await fixture.governor.snapshot()).usages.get("usage-expired-unknown")?.usage.calls)
      .toBe(1);
  });

  it("rebuilds the durable lease deadline and does not revive it after wall-clock rollback", async () => {
    let now = NOW;
    let monotonicNow = 0;
    const fixture = await createHarness(4, () => now, 1_000, () => monotonicNow);
    const root = assignmentLease("assignment-deadline", "run-deadline", 2, {
      issuedAt: NOW,
      expiry: "2026-07-20T00:00:01.000Z",
    });
    const capability = assignmentCapability("assignment-deadline", "cap-deadline");
    await accept(fixture, root, [capability.capId]);
    now = "2026-07-20T00:00:00.500Z";
    const restarted = fixture.restart();
    const callContext = {
      ...assignmentCallContext(capability),
      deadlineAt: root.expiry,
    };
    await expect(restarted.reserveUsage(
      root,
      { usageId: "usage-before-deadline", calls: 1 },
      callContext,
    )).resolves.toBeUndefined();

    now = "2026-07-19T23:59:00.000Z";
    monotonicNow = 501;
    await expect(restarted.reserveUsage(
      root,
      { usageId: "usage-after-deadline", calls: 1 },
      callContext,
    )).rejects.toThrow("expired");
  });

  it("keeps an activated assignment capability expired after wall-clock rollback", async () => {
    let now = NOW;
    let monotonicNow = 0;
    const fixture = await createHarness(4, () => now, 10_000, () => monotonicNow);
    const root = assignmentLease("assignment-capability-deadline", "run-capability-deadline", 2, {
      issuedAt: NOW,
      expiry: "2026-07-20T00:00:10.000Z",
    });
    const capability = assignmentCapability(
      "assignment-capability-deadline",
      "cap-capability-deadline",
      "2026-07-20T00:00:01.000Z",
    );
    await accept(fixture, root, [capability.capId]);
    now = "2026-07-20T00:00:00.500Z";
    const restarted = fixture.restart();
    const callContext = assignmentCallContext(capability);
    await expect(restarted.reserveUsage(
      root,
      { usageId: "usage-capability-before-deadline", calls: 1 },
      callContext,
    )).resolves.toBeUndefined();

    now = "2026-07-19T23:59:00.000Z";
    monotonicNow = 501;
    await expect(restarted.reserveUsage(
      root,
      { usageId: "usage-capability-after-deadline", calls: 1 },
      callContext,
    )).rejects.toThrow("capability is expired");
  });

  it("returns every exact resource replay after terminal closure without new writes", async () => {
    const fixture = await createHarness();
    const root = assignmentLease("assignment-replay", "run-replay", 3);
    const capability = assignmentCapability("assignment-replay", "cap-replay");
    const callContext = assignmentCallContext(capability);
    await accept(fixture, root, [capability.capId]);
    const workload = { kind: "orchestration-node" as const, id: "node-replay", attempt: 1 };
    const child = await fixture.governor.acquireChild(
      root,
      workload,
      { maxCalls: 2 },
      callContext,
    );
    await fixture.governor.reserveUsage(
      child,
      { usageId: "usage-replay", calls: 1 },
      callContext,
    );
    await fixture.governor.consume(
      child,
      { usageId: "usage-replay", calls: 1 },
      callContext,
    );
    await fixture.governor.settle(child, callContext);
    await fixture.governor.release(child, callContext);
    await fixture.governor.settle(root, callContext);
    await fixture.governor.release(root, callContext);
    const commitCount = (await fixture.log.readAll()).length;

    await expect(fixture.governor.acquireChild(
      root,
      workload,
      { maxCalls: 2 },
      callContext,
    )).resolves.toEqual(child);
    await expect(fixture.governor.reserveUsage(
      child,
      { usageId: "usage-replay", calls: 1 },
      callContext,
    )).resolves.toBeUndefined();
    await expect(fixture.governor.consume(
      child,
      { usageId: "usage-replay", calls: 1 },
      callContext,
    )).resolves.toBeUndefined();
    await expect(fixture.governor.settle(root, callContext)).resolves.toBeUndefined();
    await expect(fixture.governor.release(root, callContext)).resolves.toBeUndefined();
    const unauthorizedContexts = [
      {
        context: assignmentCallContext(assignmentCapability("assignment-other", "cap-other")),
        error: "does not bind",
      },
      {
        context: assignmentCallContext(
          assignmentCapability("assignment-replay", "cap-unaccepted"),
        ),
        error: "not durably accepted",
      },
    ];
    for (const unauthorized of unauthorizedContexts) {
      const unauthorizedReplays = [
        () => fixture.governor.acquireChild(
          root,
          workload,
          { maxCalls: 2 },
          unauthorized.context,
        ),
        () => fixture.governor.reserveUsage(
          child,
          { usageId: "usage-replay", calls: 1 },
          unauthorized.context,
        ),
        () => fixture.governor.consume(
          child,
          { usageId: "usage-replay", calls: 1 },
          unauthorized.context,
        ),
        () => fixture.governor.settle(root, unauthorized.context),
        () => fixture.governor.release(root, unauthorized.context),
      ];
      for (const replay of unauthorizedReplays) {
        await expect(replay()).rejects.toThrow(unauthorized.error);
      }
    }
    expect(await fixture.log.readAll()).toHaveLength(commitCount);
  });

  it("issues nested children within the root delegation depth", async () => {
    const fixture = await createHarness();
    const root = assignmentLease(
      "assignment-nested",
      "run-nested",
      10,
      undefined,
      undefined,
      2,
    );
    const capability = assignmentCapability("assignment-nested", "cap-nested");
    const assignmentContext = assignmentCallContext(capability);
    await accept(fixture, root, [capability.capId]);
    const child = await fixture.governor.acquireChild(
      root,
      { kind: "orchestration-node", id: "node-parent", attempt: 1 },
      { maxCalls: 8 },
      assignmentContext,
    );
    const grandchild = await fixture.governor.acquireChild(
      child,
      { kind: "orchestration-node", id: "node-child", attempt: 1 },
      { maxCalls: 5 },
      assignmentContext,
    );
    await fixture.governor.reserveUsage(
      grandchild,
      { usageId: "usage-nested", calls: 3 },
      assignmentContext,
    );
    await fixture.governor.consume(
      grandchild,
      { usageId: "usage-nested", calls: 3 },
      assignmentContext,
    );
    await fixture.governor.release(grandchild, assignmentContext);
    await fixture.governor.release(child, assignmentContext);
    expect((await fixture.governor.snapshot()).reservations.get(root.reservationId))
      .toMatchObject({
        descendantUsed: { calls: 3 },
        reservedForChildren: { calls: 0 },
      });
  });

  it("settles an abandoned child subtree deepest-first and replays its terminal response", async () => {
    const fixture = await createHarness();
    const root = assignmentLease(
      "assignment-child-finalize",
      "run-child-finalize",
      10,
      undefined,
      undefined,
      2,
    );
    const capability = assignmentCapability(
      "assignment-child-finalize",
      "cap-child-finalize",
    );
    const callContext = assignmentCallContext(capability);
    await accept(fixture, root, [capability.capId]);
    const child = await fixture.governor.acquireChild(
      root,
      { kind: "orchestration-node", id: "child-finalize", attempt: 1 },
      { maxCalls: 8 },
      callContext,
    );
    const grandchild = await fixture.governor.acquireChild(
      child,
      { kind: "orchestration-node", id: "grandchild-finalize", attempt: 1 },
      { maxCalls: 5 },
      callContext,
    );
    await fixture.governor.reserveUsage(
      child,
      { usageId: "usage-child-open", calls: 1 },
      callContext,
    );
    await fixture.governor.reserveUsage(
      grandchild,
      { usageId: "usage-grandchild-open", calls: 3 },
      callContext,
    );

    await fixture.governor.settle(child, callContext);
    let projection = await fixture.governor.snapshot();
    expect(projection.reservations.get(root.reservationId)?.state).toBe("active");
    expect(projection.reservations.get(child.reservationId)?.state).toBe("settled");
    expect(projection.reservations.get(grandchild.reservationId)?.state).toBe("released");
    expect(projection.usageReservations.get("usage-child-open")?.state).toBe("consumed");
    expect(projection.usageReservations.get("usage-grandchild-open")?.state).toBe("consumed");

    const restarted = fixture.restart();
    await expect(restarted.settle(child, callContext)).resolves.toBeUndefined();
    await expect(restarted.release(child, callContext)).resolves.toBeUndefined();
    projection = await restarted.snapshot();
    expect(projection.reservations.get(child.reservationId)?.state).toBe("released");
    expect([...projection.reservations.values()].filter((reservation) =>
      reservation.rootReservationId === root.reservationId &&
      reservation.depth > 0 &&
      reservation.state === "active"
    )).toHaveLength(0);
  });

  it("flushes every abandoned assignment descendant before publishing final usage", async () => {
    const fixture = await createHarness();
    const root = assignmentLease(
      "assignment-flush-descendants",
      "run-flush-descendants",
      10,
      undefined,
      undefined,
      2,
    );
    const capability = assignmentCapability(
      "assignment-flush-descendants",
      "cap-flush-descendants",
    );
    const callContext = assignmentCallContext(capability);
    await accept(fixture, root, [capability.capId]);
    const child = await fixture.governor.acquireChild(
      root,
      { kind: "orchestration-node", id: "flush-child", attempt: 1 },
      { maxCalls: 8 },
      callContext,
    );
    const grandchild = await fixture.governor.acquireChild(
      child,
      { kind: "orchestration-node", id: "flush-grandchild", attempt: 1 },
      { maxCalls: 5 },
      callContext,
    );
    await fixture.governor.reserveUsage(
      grandchild,
      { usageId: "usage-flush-open", calls: 2 },
      callContext,
    );

    const restarted = fixture.restart();
    const reports: UsageReport[] = [];
    const final = await restarted.flushAssignment(
      "assignment-flush-descendants",
      {
        async submitUsageReport(report) {
          reports.push(report);
          return { ackedThroughSeq: report.toUsageSeq };
        },
      },
      (report) => ({
        principal: { kind: "usage-reporter", executorId: "executor-1" },
        requestId: `report:${report.digest}`,
        deadlineAt: "2026-07-20T00:05:00.000Z",
      }),
    );
    const projection = await restarted.snapshot();
    expect(projection.reservations.get(child.reservationId)?.state).toBe("released");
    expect(projection.reservations.get(grandchild.reservationId)?.state).toBe("released");
    expect(projection.usageReservations.get("usage-flush-open")?.state).toBe("consumed");
    expect(reports.at(-1)?.usages).toContainEqual(expect.objectContaining({
      usageId: "usage-flush-open",
      calls: 2,
    }));
    await expect(restarted.flushAssignment(
      "assignment-flush-descendants",
      { async submitUsageReport(report) { return { ackedThroughSeq: report.toUsageSeq }; } },
      (report) => ({
        principal: { kind: "usage-reporter", executorId: "executor-1" },
        requestId: `report:${report.digest}`,
        deadlineAt: "2026-07-20T00:05:00.000Z",
      }),
    )).resolves.toEqual(final);
  });

  it("rejects host access to an assignment reservation", async () => {
    const fixture = await createHarness();
    const lease = assignmentLease("assignment-host", "run-host", 2);
    const capability = assignmentCapability("assignment-host", "cap-host");
    await accept(fixture, lease, [capability.capId]);
    await expect(
      fixture.governor.consume(lease, { usageId: "usage-host", calls: 1 }, context),
    ).rejects.toThrow("activated assignment principal");
  });

  it("accepts resource use only from a capability in the durable received proof", async () => {
    const fixture = await createHarness();
    const lease = assignmentLease("assignment-cap", "run-cap", 2);
    const capability = assignmentCapability("assignment-cap", "cap-active");
    await accept(fixture, lease, [capability.capId]);

    await fixture.governor.reserveUsage(
      lease,
      { usageId: "usage-cap", calls: 1 },
      assignmentCallContext(capability),
    );
    await expect(fixture.governor.consume(
      lease,
      { usageId: "usage-cap", calls: 1 },
      assignmentCallContext(capability),
    )).resolves.toBeUndefined();

    const unactivated = assignmentCapability("assignment-cap", "cap-candidate");
    await expect(fixture.governor.consume(
      lease,
      { usageId: "usage-unactivated", calls: 1 },
      assignmentCallContext(unactivated),
    )).rejects.toThrow("not durably accepted");
  });

  it("rejects roots from another local governor domain", async () => {
    const fixture = await createHarness();
    const foreign = assignmentLease("assignment-local", "run-local", 2, undefined, {
      kind: "local",
      localDomainId: "local-foreign",
      localGovernorEpoch: 1,
    });
    await expect(fixture.governor.coordinate(async () => {
      fixture.governor.prepareReceipt(foreign);
    })).rejects.toThrow("another governor domain");
  });

  it("reconstructs final usage after restart and accepts replayed batch watermarks", async () => {
    const fixture = await createHarness();
    const lease = assignmentLease("assignment-batched", "run-batched", 300);
    await accept(fixture, lease);
    await fixture.log.append(Array.from({ length: 257 }, (_, index) => {
      const usageId = `usage-batched-${index + 1}`;
      return [{
        stream: "governor",
        body: {
          t: "usage-reserved" as const,
          rootReservationId: lease.reservationId,
          reservationId: lease.reservationId,
          usageId,
          calls: 1,
        },
      }, {
        stream: "governor",
        body: {
          t: "consume" as const,
          usageSeq: index + 1,
          rootReservationId: lease.reservationId,
          reservationId: lease.reservationId,
          usageId,
          calls: 1,
        },
      }];
    }).flat());
    const restarted = fixture.restart();
    await restarted.snapshot();
    const beforeFlush = restarted.usageFinal("assignment-batched");
    expect(beforeFlush.upToUsageSeq).toBe(257);

    let watermark = 0;
    const intake: ResourceUsageIntake = {
      async submitUsageReport(report) {
        watermark = Math.max(watermark, report.toUsageSeq);
        return { ackedThroughSeq: watermark };
      },
    };
    const contextFor = (report: UsageReport): AuthorityCallContext => ({
      principal: { kind: "usage-reporter", executorId: "executor-1" },
      requestId: `report:${report.digest}`,
      deadlineAt: "2026-07-20T00:05:00.000Z",
    });
    await expect(restarted.flushAssignment("assignment-batched", intake, contextFor))
      .resolves.toEqual(beforeFlush);
    await expect(restarted.flushAssignment("assignment-batched", intake, contextFor))
      .resolves.toEqual(beforeFlush);
  });
});

async function createHarness(
  maxActiveRoots = 4,
  clock: () => string = () => NOW,
  leaseTtlMs = 60_000,
  monotonicClock: () => number = () => performance.now(),
) {
  const root = await createTempDir("executor-resource-governor");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock,
  });
  return {
    log,
    artifacts,
    governor: createGovernor(),
    restart: createGovernor,
  };

  function createGovernor() {
    return new ExecutorResourceGovernor({
      log,
      signer,
      verifier,
      guard: { assert() {} },
      executorId: "executor-1",
      localDomainId: "local-1",
      localGovernorEpoch: 1,
      maxActiveRoots,
      leaseTtlMs,
      clock,
      monotonicClock,
    });
  }
}

/**
 * 最小但合法的 DispatchEnvelope 工件。注册根校验只核对 `v`、`assignmentId`、
 * `execution`、`dependencyArtifacts` 与 `work` 的形状,不验签,因此这里不必
 * 走完整签发链;但字段少一个就会 fail-closed。
 */
async function putDispatchEnvelopeArtifact(
  fixture: Awaited<ReturnType<typeof createHarness>>,
  assignmentId: string,
): Promise<ArtifactRef> {
  const bytes = Buffer.from(
    canonicalize({
      v: 1,
      assignmentId,
      execution: "conversation",
      dependencyArtifacts: [],
      work: { conversationId: "conversation-1", contentAssets: [] },
    }),
    "utf8",
  );
  return fixture.artifacts.put(bytes);
}

async function accept(
  fixture: Awaited<ReturnType<typeof createHarness>>,
  lease: AssignmentResourceLease,
  capIds?: readonly string[],
) {
  // `received` 记录是注册根:追加时会解引用 `envelope.ref` 并按 DispatchEnvelope
  // 的注册 schema 核对,`activation.ref.execution` 也必须在场。夹具只有 capIds
  // 而没有这两处,append 就会被 fail-closed 拦下。
  const envelopeRef = capIds
    ? await putDispatchEnvelopeArtifact(fixture, lease.activation.assignmentId)
    : undefined;
  await fixture.governor.coordinate(async () => {
    const records = fixture.governor.prepareReceipt(lease);
    fixture.governor.assertReceiptRecords({ lease, records });
    await fixture.log.append([
      ...(capIds
        ? [{
            stream: `assignment:${lease.activation.assignmentId}`,
            body: {
              v: 1,
              assignmentId: lease.activation.assignmentId,
              body: {
                v: 1,
                t: "received",
                envelope: { ref: envelopeRef },
                activation: {
                  assignmentId: lease.activation.assignmentId,
                  executorId: lease.audience.executorId,
                  reservation: { reservationId: lease.reservationId, attempt: 1 },
                  ref: { execution: "conversation" },
                  capIds: [...capIds],
                },
              },
            },
          },
          {
            stream: `assignment:${lease.activation.assignmentId}`,
            body: {
              v: 1,
              assignmentId: lease.activation.assignmentId,
              body: { v: 1, t: "started" },
            },
          }]
        : []),
      ...records,
    ]);
  });
}

function assignmentCapability(
  assignmentId: string,
  capId: string,
  expiry = "2026-07-20T00:05:00.000Z",
): AuthorityCapability<"conversation"> {
  const payload = {
    v: 1 as const,
    capId,
    executorId: "executor-1",
    scope: { execution: "conversation" as const, conversationId: "conversation-1" },
    ownerEpoch: 1,
    methods: [
      "reservation.acquireChild",
      "reservation.reserveUsage",
      "reservation.consume",
      "reservation.settle",
      "reservation.release",
    ] as const,
    resources: ["conversation:conversation-1"] as const,
    assignmentId,
    issuedAt: NOW,
    expiry,
  };
  return {
    ...payload,
    methods: [...payload.methods],
    resources: [...payload.resources],
    signature: signer.sign("AuthorityCapability", 1, payload),
  };
}

function assignmentCallContext(
  capability: AuthorityCapability<"conversation">,
): AuthorityCallContext {
  return {
    principal: { kind: "assignment", capability },
    requestId: `resource:${capability.capId}`,
    deadlineAt: capability.expiry,
  };
}

function assignmentLease(
  assignmentId: string,
  runId: string,
  maxCalls: number,
  time: { issuedAt: string; expiry: string } | undefined = {
    issuedAt: NOW,
    expiry: "2026-07-20T00:05:00.000Z",
  },
  domain: AssignmentResourceLease<"conversation">["domain"] = {
    kind: "anchor",
    anchorEpoch: 1,
  },
  delegationDepth = 1,
): AssignmentResourceLease<"conversation"> {
  const payload = {
    v: 1 as const,
    reservationId: `reservation:${assignmentId}`,
    admissionClass: "interactive" as const,
    workload: { kind: "run" as const, id: runId, attempt: 1 },
    scopeBinding: {
      kind: "conversation" as const,
      conversationId: "conversation-1",
      ownerEpoch: 1,
    },
    audience: { executorId: "executor-1" },
    budget: { maxCalls },
    domain,
    delegation: {
      executorId: "executor-1",
      maxDepth: delegationDepth,
      maxBudget: { maxCalls },
    },
    activation: { kind: "assignment" as const, assignmentId },
    ...(time ?? {
      issuedAt: NOW,
      expiry: "2026-07-20T00:05:00.000Z",
    }),
  };
  const withDigest = {
    ...payload,
    digest: protocolDigest("ResourceLease", 1, payload),
  };
  return {
    ...withDigest,
    signature: signer.sign("ResourceLease", 1, withDigest),
  };
}
