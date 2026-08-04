import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type {
  AssignmentResourceLease,
  AuthorityCapability,
  AuthorityCallContext,
  Signature,
  UsageReport,
} from "@zhixing/core/contracts";
import { ImmediateRootReplayTerminalError } from "@zhixing/core/contracts";
import {
  createSignedConversationEnvelope,
  dispatchEnvelopeArtifact,
  dispatchEnvelopeDigest,
  permissionSnapshotLeaseDigest,
  protocolDigest,
  ResourceAdmissionDeferredError,
  validateSystemJobResourceLease,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  AnchorResourceGovernor,
  assignmentReservationId,
} from "../resource-governor.js";

const NOW = "2026-07-20T00:00:00.000Z";

const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "executor-1",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier = {
  verify(schemaId: string, version: number, payload: unknown, signature: Signature) {
    expect(signature).toEqual(signer.sign(schemaId, version, payload));
  },
};

const hostContext: AuthorityCallContext = {
  principal: { kind: "host", component: "test-resource-governor" },
  requestId: "request-1",
  deadlineAt: "2026-07-20T00:05:00.000Z",
};

describe("AnchorResourceGovernor", () => {
  it("tombstones a terminal workload before any late reservation can queue", async () => {
    const fixture = await createHarness();
    await fixture.governor.coordinate(async () => {
      await fixture.log.append(fixture.governor.prepareQueuedTerminal({
        workload: { kind: "run", id: "run-cancelled", attempt: 1 },
        reason: "cancelled",
      }));
    });
    await expect(fixture.governor.enqueueRoot(
      assignmentReservationId("assignment-late"),
      { kind: "run", id: "run-cancelled", attempt: 1 },
      { admissionClass: "interactive", entry: "conversation-input" },
      hostContext,
    )).rejects.toBeInstanceOf(ImmediateRootReplayTerminalError);
  });

  it("keeps candidate signing side-effect free and atomically rechecks activation", async () => {
    const fixture = await createHarness();
    const reservationId = assignmentReservationId("assignment-1");
    await fixture.governor.enqueueRoot(
      reservationId,
      { kind: "run", id: "run-1", attempt: 1 },
      { admissionClass: "interactive", entry: "conversation-input" },
      hostContext,
    );
    const before = await fixture.log.readAll();
    const lease = await fixture.governor.prepareAssignmentRoot({
      assignmentId: "assignment-1",
      executorId: "executor-1",
      workload: { kind: "run", id: "run-1", attempt: 1 },
      scopeBinding: {
        kind: "conversation",
        conversationId: "conversation-1",
        ownerEpoch: 1,
      },
      budget: { maxCalls: 2, maxTokens: 100 },
    }, { admissionClass: "interactive", entry: "conversation-input" }, hostContext);
    expect(await fixture.log.readAll()).toHaveLength(before.length);
    await expect(fixture.governor.prepareAssignmentRoot({
      assignmentId: "assignment-1",
      executorId: "executor-1",
      workload: { kind: "run", id: "run-1", attempt: 1 },
      scopeBinding: {
        kind: "conversation",
        conversationId: "conversation-1",
        ownerEpoch: 1,
      },
      budget: { maxCalls: 2, maxTokens: 100 },
    }, { admissionClass: "interactive", entry: "conversation-input" }, hostContext))
      .resolves.toEqual(lease);
    await expect(fixture.governor.prepareAssignmentRoot({
      assignmentId: "assignment-1",
      executorId: "executor-1",
      workload: { kind: "run", id: "run-1", attempt: 1 },
      scopeBinding: {
        kind: "conversation",
        conversationId: "conversation-1",
        ownerEpoch: 1,
      },
      budget: { maxCalls: 3, maxTokens: 100 },
    }, { admissionClass: "interactive", entry: "conversation-input" }, hostContext))
      .rejects.toThrow("changed its frozen request");

    const restarted = new AnchorResourceGovernor({
      log: fixture.log,
      signer,
      verifier,
      guard: allowAll,
      anchorEpoch: 1,
      localExecutorId: "executor-1",
      reporterKeyFor: () => "executor-1",
      clock: () => NOW,
    });
    await expect(restarted.prepareAssignmentRoot({
      assignmentId: "assignment-1",
      executorId: "executor-1",
      workload: { kind: "run", id: "run-1", attempt: 1 },
      scopeBinding: {
        kind: "conversation",
        conversationId: "conversation-1",
        ownerEpoch: 1,
      },
      budget: { maxCalls: 2, maxTokens: 100 },
    }, { admissionClass: "interactive", entry: "conversation-input" }, hostContext))
      .resolves.toEqual(lease);

    await fixture.governor.coordinate(async () => {
      const records = fixture.governor.prepareActivation(lease);
      fixture.governor.assertActivationRecords({ lease, records });
      await fixture.log.append(records);
    });
    expect((await fixture.governor.snapshot()).reservations.get(reservationId)?.state)
      .toBe("active");
    await expect(restarted.prepareAssignmentRoot({
      assignmentId: "assignment-1",
      executorId: "executor-1",
      workload: { kind: "run", id: "run-1", attempt: 1 },
      scopeBinding: {
        kind: "conversation",
        conversationId: "conversation-1",
        ownerEpoch: 1,
      },
      budget: { maxCalls: 2, maxTokens: 100 },
    }, { admissionClass: "interactive", entry: "conversation-input" }, hostContext))
      .resolves.toEqual(lease);
    await expect(restarted.prepareAssignmentRoot({
      assignmentId: "assignment-1",
      executorId: "executor-1",
      workload: { kind: "run", id: "run-1", attempt: 1 },
      scopeBinding: {
        kind: "conversation",
        conversationId: "conversation-1",
        ownerEpoch: 1,
      },
      budget: { maxCalls: 3, maxTokens: 100 },
    }, { admissionClass: "interactive", entry: "conversation-input" }, hostContext))
      .rejects.toThrow("changed its frozen request");
  });

  it("waits fairly across assignment and system-job candidates without failing queued work", async () => {
    const fixture = await createHarness();
    const interactive = { admissionClass: "interactive", entry: "conversation-input" } as const;
    const scheduler = { admissionClass: "scheduler", entry: "schedule-trigger" } as const;
    const expiredContext = { ...hostContext, deadlineAt: NOW };
    const firstAssignment = assignmentReservationId("assignment-wait-1");
    await fixture.governor.enqueueRoot(
      firstAssignment,
      { kind: "run", id: "run-wait-1", attempt: 1 },
      interactive,
      hostContext,
    );
    await fixture.governor.prepareAssignmentRoot({
      assignmentId: "assignment-wait-1",
      executorId: "executor-1",
      workload: { kind: "run", id: "run-wait-1", attempt: 1 },
      scopeBinding: { kind: "conversation", conversationId: "conversation-1", ownerEpoch: 1 },
      budget: { maxCalls: 1 },
    }, interactive, hostContext);

    const secondAssignment = assignmentReservationId("assignment-wait-2");
    await fixture.governor.enqueueRoot(
      secondAssignment,
      { kind: "run", id: "run-wait-2", attempt: 1 },
      interactive,
      hostContext,
    );
    await expect(fixture.governor.prepareAssignmentRoot({
      assignmentId: "assignment-wait-2",
      executorId: "executor-1",
      workload: { kind: "run", id: "run-wait-2", attempt: 1 },
      scopeBinding: { kind: "conversation", conversationId: "conversation-1", ownerEpoch: 1 },
      budget: { maxCalls: 1 },
    }, interactive, expiredContext)).rejects.toBeInstanceOf(ResourceAdmissionDeferredError);
    expect((await fixture.governor.snapshot()).queued.has(secondAssignment)).toBe(true);

    const firstSystem = systemReservationIdForTest("system-wait-1", 1);
    await fixture.governor.enqueueRoot(
      firstSystem,
      { kind: "job", id: "system-wait-1", attempt: 1 },
      scheduler,
      hostContext,
    );
    await expect(fixture.governor.prepareSystemJobRoot({
      workload: { kind: "job", id: "system-wait-1", attempt: 1 },
      scopeBinding: { kind: "job", taskId: "task-1", anchorEpoch: 1 },
      budget: { maxCalls: 1 },
    }, scheduler, hostContext)).resolves.toMatchObject({ reservationId: firstSystem });

    const secondSystem = systemReservationIdForTest("system-wait-2", 1);
    await fixture.governor.enqueueRoot(
      secondSystem,
      { kind: "job", id: "system-wait-2", attempt: 1 },
      scheduler,
      hostContext,
    );
    await expect(fixture.governor.prepareSystemJobRoot({
      workload: { kind: "job", id: "system-wait-2", attempt: 1 },
      scopeBinding: { kind: "job", taskId: "task-1", anchorEpoch: 1 },
      budget: { maxCalls: 1 },
    }, scheduler, expiredContext)).rejects.toBeInstanceOf(ResourceAdmissionDeferredError);
    expect((await fixture.governor.snapshot()).queued.has(secondSystem)).toBe(true);
  });

  it("rejects every non-scheduler system-job origin before signing or queuing", async () => {
    const fixture = await createHarness();
    const request = {
      workload: { kind: "job" as const, id: "system-origin", attempt: 1 },
      scopeBinding: { kind: "job" as const, taskId: "task-1", anchorEpoch: 1 },
      budget: { maxCalls: 1 },
    };
    for (const origin of [
      { admissionClass: "interactive", entry: "conversation-input" },
      { admissionClass: "advancement", entry: "advancement-control" },
      { admissionClass: "orchestration", entry: "orchestration" },
    ] as const) {
      await expect(fixture.governor.prepareSystemJobRoot(
        request,
        origin as never,
        hostContext,
      )).rejects.toThrow("scheduler admission");
    }
    expect(await fixture.log.readAll()).toHaveLength(0);

    const origin = { admissionClass: "scheduler", entry: "schedule-trigger" } as const;
    await fixture.governor.enqueueRoot(
      systemReservationIdForTest(request.workload.id, request.workload.attempt),
      request.workload,
      origin,
      hostContext,
    );
    const lease = await fixture.governor.prepareSystemJobRoot(request, origin, hostContext);
    expect(validateSystemJobResourceLease(lease, verifier)).toEqual(lease);
  });

  it("activates control roots without a candidate window and replays the durable result", async () => {
    let monotonicNow = 0;
    const fixture = await createHarness(
      () => NOW,
      15 * 60_000,
      () => {
        monotonicNow += 10_000;
        return monotonicNow;
      },
    );
    const workload = { kind: "control", id: "control-atomic", attempt: 1 } as const;
    const origin = { admissionClass: "advancement", entry: "advancement-control" } as const;
    const lease = await fixture.governor.acquireRoot(
      workload,
      { maxCalls: 1 },
      origin,
      hostContext,
    );
    const recordCount = (await fixture.log.readAll()).length;
    await expect(fixture.restart().acquireRoot(
      workload,
      { maxCalls: 1 },
      origin,
      hostContext,
    )).resolves.toEqual(lease);
    expect(await fixture.log.readAll()).toHaveLength(recordCount);
    await expect(fixture.governor.inspectImmediateRoot(workload)).resolves.toEqual({
      kind: "reservation",
      state: "active",
      lease,
    });
    await fixture.governor.settle(lease, hostContext);
    await fixture.governor.release(lease, hostContext);
    await expect(fixture.restart().inspectImmediateRoot(workload)).resolves.toEqual({
      kind: "reservation",
      state: "released",
      lease,
    });
    await expect(fixture.restart().acquireRoot(
      workload,
      { maxCalls: 1 },
      origin,
      hostContext,
    )).rejects.toBeInstanceOf(ImmediateRootReplayTerminalError);
  });

  it("conservatively consumes unfinished metered usage when settling a control root", async () => {
    const fixture = await createHarness();
    const workload = { kind: "control", id: "control-unfinished-usage", attempt: 1 } as const;
    const lease = await fixture.governor.acquireRoot(
      workload,
      { maxCalls: 1, maxTokens: 100 },
      { admissionClass: "advancement", entry: "advancement-control" },
      hostContext,
    );
    await fixture.governor.reserveUsage(
      lease,
      { usageId: "usage:control-unfinished-usage:1", calls: 1, tokens: 100 },
      hostContext,
    );

    await expect(fixture.governor.settle(lease, hostContext)).resolves.toBeUndefined();
    await expect(fixture.governor.release(lease, hostContext)).resolves.toBeUndefined();
    await expect(fixture.restart().inspectImmediateRoot(workload)).resolves.toMatchObject({
      kind: "reservation",
      state: "released",
    });

    const records = (await fixture.log.readAll())
      .flatMap((envelope) => envelope.entries)
      .map((entry) => entry.body as { t?: string; usageId?: string });
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        t: "consume",
        usageId: "usage:control-unfinished-usage:1",
      }),
    ]));
  });

  it("rejects invalid admission requests before any queue side-effect", async () => {
    const fixture = await createHarness();
    const origin = { admissionClass: "interactive", entry: "conversation-input" } as const;
    const baseline = (await fixture.log.readAll()).length;
    await expect(fixture.governor.acquireRoot(
      { kind: "evidence", id: "not-a-root", attempt: 1 } as never,
      { maxCalls: 1 },
      origin,
      hostContext,
    )).rejects.toThrow();
    await expect(fixture.governor.acquireRoot(
      { kind: "control", id: "control-bad-budget", attempt: 1 },
      {},
      origin,
      hostContext,
    )).rejects.toThrow();
    await expect(fixture.governor.enqueueRoot(
      "rsv-invalid",
      { kind: "control", id: "control-bad-attempt", attempt: 0 } as never,
      origin,
      hostContext,
    )).rejects.toThrow();
    await expect(fixture.governor.enqueueRoot(
      "rsv-bad-ctx",
      { kind: "control", id: "control-good", attempt: 1 },
      origin,
      { ...hostContext, requestId: "" },
    )).rejects.toThrow();
    await expect(fixture.governor.enqueueRoot(
      "rsv-bad-deadline",
      { kind: "control", id: "control-good", attempt: 1 },
      origin,
      { ...hostContext, deadlineAt: "not-a-time" },
    )).rejects.toThrow();
    expect(await fixture.log.readAll()).toHaveLength(baseline);
  });

  it("dequeues a control root precisely when its admission deadline has already passed", async () => {
    let monotonicNow = 0;
    const fixture = await createHarness(
      () => NOW,
      15 * 60_000,
      () => {
        monotonicNow += 10_000;
        return monotonicNow;
      },
    );
    const expired: AuthorityCallContext = {
      principal: { kind: "host", component: "test-resource-governor" },
      requestId: "request-expired",
      deadlineAt: "2026-07-19T23:59:59.000Z",
    };
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
      hostContext,
    )).rejects.toBeInstanceOf(ImmediateRootReplayTerminalError);
  });

  it("rejects polluted governor records during authoritative replay", async () => {
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

  it("rebuilds usage idempotency and terminal state after restart", async () => {
    const fixture = await createHarness();
    const capability = assignmentCapability("assignment-2", "cap-resource-2");
    const context = assignmentCallContext(capability);
    const lease = await activateAssignment(
      fixture,
      "assignment-2",
      "run-2",
      [capability],
    );
    await fixture.governor.reserveUsage(
      lease,
      { usageId: "usage-1", calls: 1 },
      context,
    );
    await fixture.governor.consume(lease, { usageId: "usage-1", calls: 1 }, context);
    await fixture.governor.consume(lease, { usageId: "usage-1", calls: 1 }, context);
    await expect(
      fixture.governor.consume(lease, { usageId: "usage-1", calls: 2 }, context),
    ).rejects.toThrow("different content");
    await fixture.governor.settle(lease, context);
    await fixture.governor.release(lease, context);
    await fixture.governor.settle(lease, context);
    await fixture.governor.release(lease, context);

    const restarted = new AnchorResourceGovernor({
      log: fixture.log,
      signer,
      verifier,
      guard: allowAll,
      anchorEpoch: 1,
      localExecutorId: "executor-1",
      reporterKeyFor: () => "executor-1",
      clock: () => NOW,
    });
    const projected = await restarted.snapshot();
    expect(projected.reservations.get(lease.reservationId)).toMatchObject({
      state: "released",
      used: { calls: 1 },
    });
  });

  it("accepts only dense reporter-bound watermarks and exact overlap", async () => {
    const fixture = await createHarness();
    const lease = await activateAssignment(fixture, "assignment-3", "run-3");
    const first = usageReport({
      assignmentId: "assignment-3",
      rootReservationId: lease.reservationId,
      from: 1,
      calls: [1, 1],
    });
    await expect(fixture.governor.submitUsageReport(first, reporterContext))
      .resolves.toEqual({ ackedThroughSeq: 2 });
    await expect(fixture.governor.submitUsageReport(first, reporterContext))
      .resolves.toEqual({ ackedThroughSeq: 2 });

    const conflicting = usageReport({
      assignmentId: "assignment-3",
      rootReservationId: lease.reservationId,
      from: 1,
      calls: [2, 1],
    });
    await expect(fixture.governor.submitUsageReport(conflicting, reporterContext))
      .rejects.toThrow("overlaps");
    const gap = usageReport({
      assignmentId: "assignment-3",
      rootReservationId: lease.reservationId,
      from: 4,
      calls: [1],
    });
    await expect(fixture.governor.submitUsageReport(gap, reporterContext))
      .rejects.toThrow("gap");
  });

  it("accounts executor-local child usage through the delegated root watermark", async () => {
    const fixture = await createHarness();
    const lease = await activateAssignment(fixture, "assignment-child", "run-child");
    const report = usageReport({
      assignmentId: "assignment-child",
      rootReservationId: lease.reservationId,
      reservationId: "reservation:executor-child",
      from: 1,
      calls: [2],
    });
    await expect(fixture.governor.submitUsageReport(report, reporterContext))
      .resolves.toEqual({ ackedThroughSeq: 1 });
    expect((await fixture.governor.snapshot()).reservations.get(lease.reservationId))
      .toMatchObject({ descendantUsed: { calls: 2 } });
  });

  it("rejects a signed resource capability absent from the durable assignment", async () => {
    const fixture = await createHarness();
    const active = assignmentCapability("assignment-cap", "cap-active");
    const lease = await activateAssignment(
      fixture,
      "assignment-cap",
      "run-cap",
      [active],
    );
    await fixture.governor.reserveUsage(
      lease,
      { usageId: "usage-active", calls: 1 },
      assignmentCallContext(active),
    );
    await expect(fixture.governor.consume(
      lease,
      { usageId: "usage-active", calls: 1 },
      assignmentCallContext(active),
    )).resolves.toBeUndefined();

    const unactivated = assignmentCapability("assignment-cap", "cap-candidate");
    await expect(fixture.governor.consume(
      lease,
      { usageId: "usage-candidate", calls: 1 },
      assignmentCallContext(unactivated),
    )).rejects.toThrow("not durably accepted");
  });

  it("stops resource use when the durable assignment capability is revoked", async () => {
    const fixture = await createHarness();
    const capability = assignmentCapability("assignment-revoked", "cap-revoked");
    const lease = await activateAssignment(
      fixture,
      "assignment-revoked",
      "run-revoked",
      [capability],
    );
    await fixture.log.append([{
      stream: "run:conversation-1",
      body: {
        t: "capability-revoked",
        assignmentId: "assignment-revoked",
        capId: capability.capId,
      },
    }]);
    await expect(fixture.governor.consume(
      lease,
      { usageId: "usage-revoked", calls: 1 },
      assignmentCallContext(capability),
    )).rejects.toThrow("not activated");
  });

  it("rejects host access to an assignment reservation", async () => {
    const fixture = await createHarness();
    const capability = assignmentCapability("assignment-host", "cap-host");
    const lease = await activateAssignment(
      fixture,
      "assignment-host",
      "run-host",
      [capability],
    );
    await expect(
      fixture.governor.consume(lease, { usageId: "usage-host", calls: 1 }, hostContext),
    ).rejects.toThrow("activated assignment principal");
  });

  it("rebuilds the durable lease deadline and does not revive it after wall-clock rollback", async () => {
    let now = NOW;
    let monotonicNow = 0;
    const fixture = await createHarness(() => now, 1_000, () => monotonicNow);
    const capability = assignmentCapability("assignment-deadline", "cap-deadline");
    const lease = await activateAssignment(
      fixture,
      "assignment-deadline",
      "run-deadline",
      [capability],
    );
    now = "2026-07-20T00:00:00.500Z";
    const restarted = fixture.restart();
    const callContext = {
      ...assignmentCallContext(capability),
      deadlineAt: lease.expiry,
    };
    await expect(restarted.reserveUsage(
      lease,
      { usageId: "usage-before-deadline", calls: 1 },
      callContext,
    )).resolves.toBeUndefined();

    now = "2026-07-19T23:59:00.000Z";
    monotonicNow = 501;
    await expect(restarted.reserveUsage(
      lease,
      { usageId: "usage-after-deadline", calls: 1 },
      callContext,
    )).rejects.toThrow("expired");
  });

  it("keeps an activated assignment capability expired after wall-clock rollback", async () => {
    let now = NOW;
    let monotonicNow = 0;
    const fixture = await createHarness(() => now, 10_000, () => monotonicNow);
    const capability = assignmentCapability(
      "assignment-capability-deadline",
      "cap-capability-deadline",
      "2026-07-20T00:00:01.000Z",
    );
    const lease = await activateAssignment(
      fixture,
      "assignment-capability-deadline",
      "run-capability-deadline",
      [capability],
    );
    now = "2026-07-20T00:00:00.500Z";
    const restarted = fixture.restart();
    const callContext = assignmentCallContext(capability);
    await expect(restarted.reserveUsage(
      lease,
      { usageId: "usage-capability-before-deadline", calls: 1 },
      callContext,
    )).resolves.toBeUndefined();

    now = "2026-07-19T23:59:00.000Z";
    monotonicNow = 501;
    await expect(restarted.reserveUsage(
      lease,
      { usageId: "usage-capability-after-deadline", calls: 1 },
      callContext,
    )).rejects.toThrow("capability is expired");
  });

  it("returns every exact resource replay after terminal closure without new writes", async () => {
    const fixture = await createHarness();
    const capability = assignmentCapability("assignment-replay", "cap-replay");
    const lease = await activateAssignment(
      fixture,
      "assignment-replay",
      "run-replay",
      [capability],
    );
    const callContext = assignmentCallContext(capability);
    const workload = { kind: "orchestration-node" as const, id: "node-replay", attempt: 1 };
    const child = await fixture.governor.acquireChild(
      lease,
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
    await fixture.governor.settle(lease, callContext);
    await fixture.governor.release(lease, callContext);
    const commitCount = (await fixture.log.readAll()).length;

    await expect(fixture.governor.acquireChild(
      lease,
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
    await expect(fixture.governor.settle(lease, callContext)).resolves.toBeUndefined();
    await expect(fixture.governor.release(lease, callContext)).resolves.toBeUndefined();
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
          lease,
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
        () => fixture.governor.settle(lease, unauthorized.context),
        () => fixture.governor.release(lease, unauthorized.context),
      ];
      for (const replay of unauthorizedReplays) {
        await expect(replay()).rejects.toThrow(unauthorized.error);
      }
    }
    expect(await fixture.log.readAll()).toHaveLength(commitCount);
  });

  it("leaves expired business roots to business recovery and reclaims control roots", async () => {
    let now = NOW;
    let monotonicNow = 0;
    const fixture = await createHarness(() => now, 1_000, () => monotonicNow);
    const capability = assignmentCapability(
      "assignment-expired",
      "cap-expired",
      "2026-07-20T00:00:01.000Z",
    );
    const lease = await activateAssignment(
      fixture,
      "assignment-expired",
      "run-expired",
      [capability],
    );
    const callContext = assignmentCallContext(capability);
    await fixture.governor.reserveUsage(
      lease,
      { usageId: "usage-expired", calls: 1 },
      callContext,
    );
    const system = await fixture.governor.prepare({
      taskId: "task-expired",
      jobRunId: "system-expired",
      anchorEpoch: 1,
      attempt: 1,
    });
    await fixture.governor.coordinate(async () => {
      await fixture.log.append(system.records);
    });
    const control = await fixture.governor.acquireRoot(
      { kind: "control", id: "control-expired", attempt: 1 },
      { maxCalls: 1 },
      { admissionClass: "advancement", entry: "advancement-control" },
      hostContext,
    );
    now = "2026-07-20T00:00:02.000Z";
    monotonicNow = 2_000;

    await expect(fixture.governor.reclaimExpired()).resolves.toBe(1);
    await expect(fixture.governor.reclaimExpired()).resolves.toBe(0);
    const state = await fixture.governor.snapshot();
    expect(state.reservations.get(lease.reservationId)).toMatchObject({
      state: "active",
      used: { calls: 0 },
    });
    expect(state.usageReservations.get("usage-expired")?.state).toBe("reserved");
    expect(state.reservations.get(system.lease.reservationId)?.state).toBe("active");
    expect(state.reservations.get(control.reservationId)?.state).toBe("reclaimed");
    await expect(fixture.governor.submitUsageReport(usageReport({
      assignmentId: "assignment-expired",
      rootReservationId: lease.reservationId,
      from: 1,
      calls: [1],
    }), reporterContext)).rejects.toThrow("inactive or expired");
  });

  it("compacts anchor terminal projections after the retention window", async () => {
    let now = NOW;
    const fixture = await createHarness(
      () => now,
      15 * 60_000,
      () => performance.now(),
    );
    const capability = assignmentCapability("assignment-compact", "cap-compact");
    const lease = await activateAssignment(
      fixture,
      "assignment-compact",
      "run-compact",
      [capability],
    );
    const callContext = assignmentCallContext(capability);
    await fixture.governor.release(lease, callContext);
    now = "2026-08-17T00:00:00.000Z";

    const compacted = await fixture.restart().snapshot();
    expect(compacted.reservations.size).toBe(0);
    expect(compacted.leaseAcceptances.size).toBe(0);
  });
});

const allowAll = { assert() {} };

const reporterContext: AuthorityCallContext = {
  principal: { kind: "usage-reporter", executorId: "executor-1" },
  requestId: "usage-report-1",
  deadlineAt: "2026-07-20T00:05:00.000Z",
};

async function createHarness(
  clock: () => string = () => NOW,
  leaseTtlMs = 15 * 60_000,
  monotonicClock: () => number = () => performance.now(),
) {
  const root = await createTempDir("anchor-resource-governor");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock,
  });
  const createGovernor = () => new AnchorResourceGovernor({
    log,
    signer,
    verifier,
    guard: allowAll,
    anchorEpoch: 1,
    localExecutorId: "executor-1",
    reporterKeyFor: () => "executor-1",
    leaseTtlMs,
    clock,
    monotonicClock,
  });
  return {
    artifacts,
    log,
    governor: createGovernor(),
    restart: createGovernor,
  };
}

async function activateAssignment(
  fixture: Awaited<ReturnType<typeof createHarness>>,
  assignmentId: string,
  runId: string,
  capabilities?: readonly AuthorityCapability<"conversation">[],
) {
  const reservationId = assignmentReservationId(assignmentId);
  const origin = { admissionClass: "interactive", entry: "conversation-input" } as const;
  await fixture.governor.enqueueRoot(
    reservationId,
    { kind: "run", id: runId, attempt: 1 },
    origin,
    hostContext,
  );
  const lease = await fixture.governor.prepareAssignmentRoot({
    assignmentId,
    executorId: "executor-1",
    workload: { kind: "run", id: runId, attempt: 1 },
    scopeBinding: {
      kind: "conversation",
      conversationId: "conversation-1",
      ownerEpoch: 1,
    },
    budget: { maxCalls: 4 },
  }, origin, hostContext);
  const assigned = capabilities
    ? await createAssignedRecord(fixture, lease, assignmentId, runId, capabilities)
    : undefined;
  await fixture.governor.coordinate(async () => {
    await fixture.log.append([
      ...(assigned
        ? [{
            stream: "run:conversation-1",
            body: assigned,
          }]
        : []),
      ...fixture.governor.prepareActivation(lease),
    ]);
  });
  return lease;
}

async function createAssignedRecord(
  fixture: Awaited<ReturnType<typeof createHarness>>,
  lease: AssignmentResourceLease<"conversation">,
  assignmentId: string,
  runId: string,
  capabilities: readonly AuthorityCapability<"conversation">[],
) {
  const manifestBody = {
    v: 1 as const,
    baseRef: {
      execution: "conversation" as const,
      conversationId: "conversation-1",
      baseRevision: 0,
    },
    requires: {
      runtimeConfigRev: 1,
      modelProfileRev: 1,
      policyRev: 1,
      skillsRev: 1,
      rubricsRev: 1,
      promptAssetsRev: 1,
      permissionSnapshotVersion: 1,
    },
    protocolVersion: "1",
    tools: [],
    mcpServers: [],
    environment: {},
    credentialBindings: [],
  };
  const manifest = {
    ...manifestBody,
    digest: protocolDigest("ExecutionManifest", 1, manifestBody),
  };
  const controlExpiry = new Date(Math.min(
    Date.parse(lease.expiry),
    Date.parse(NOW) + 60_000,
  )).toISOString();
  const controlPayload = {
    v: 1 as const,
    controlLeaseId: `control-${assignmentId}`,
    assignmentId,
    authority: {
      execution: "conversation" as const,
      conversationId: "conversation-1",
      ownerEpoch: 1,
    },
    renewalSeq: 1,
    issuedAt: NOW,
    expiry: controlExpiry,
  };
  const controlLease = {
    ...controlPayload,
    signature: signer.sign("ControlLease", 1, controlPayload),
  };
  const permissionPayload = {
    v: 1 as const,
    snapshotVersion: 1,
    snapshotDigest: protocolDigest("PermissionSnapshot", 1, {
      assignmentId,
      snapshotVersion: 1,
    }),
    binding: {
      execution: "conversation" as const,
      runId,
      conversationId: "conversation-1",
      ownerEpoch: 1,
    },
    assignmentId,
    executorId: "executor-1",
    controlLeaseId: controlPayload.controlLeaseId,
    issuedAt: NOW,
    expiry: lease.expiry,
  };
  const permissionLease = {
    ...permissionPayload,
    signature: signer.sign("PermissionSnapshotLease", 1, permissionPayload),
  };
  const envelope = createSignedConversationEnvelope({
    v: 1,
    execution: "conversation",
    assignmentId,
    executorId: "executor-1",
    manifest,
    controlLease,
    permissionLease,
    capabilities: [...capabilities].sort((left, right) =>
      left.capId.localeCompare(right.capId)
    ),
    resourceLease: lease,
    dependencyArtifacts: [],
    issuedAt: NOW,
    work: {
      t: "conversation",
      runId,
      conversationId: "conversation-1",
      ownerEpoch: 1,
      baseRevision: 0,
      ingress: {
        kind: "first-party",
        surfacePrincipal: "surface:user-1",
        deviceId: "device-1",
        ingressId: `ingress-${assignmentId}`,
        receivedAt: NOW,
      },
      windowInput: { t: "full", windowEpoch: 1, messages: [] },
      contentAssets: [],
      controlContext: [],
    },
  }, signer, verifier);
  const artifact = dispatchEnvelopeArtifact(envelope);
  await fixture.artifacts.put(artifact.bytes);
  return {
    t: "assigned" as const,
    runId,
    assignmentId,
    executorId: "executor-1",
    ownerEpoch: 1,
    baseRevision: 0,
    dispatchDigest: dispatchEnvelopeDigest(envelope),
    manifestDigest: manifest.digest,
    dispatchRef: artifact.ref,
    permissionLeaseDigest: permissionSnapshotLeaseDigest(envelope),
    capIds: envelope.capabilities.map((capability) => capability.capId),
    reservation: { reservationId: lease.reservationId, attempt: 1 },
  };
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

function systemReservationIdForTest(jobRunId: string, attempt: number): string {
  return `reservation:${protocolDigest("SystemJobResourceReservation", 1, {
    jobRunId,
    attempt,
  }).slice("sha256:".length)}`;
}

function usageReport(input: {
  assignmentId: string;
  rootReservationId: string;
  reservationId?: string;
  from: number;
  calls: number[];
}): UsageReport {
  const payload = {
    v: 1 as const,
    reporterId: "executor-1",
    rootReservationId: input.rootReservationId,
    workloadRef: { kind: "assignment" as const, assignmentId: input.assignmentId },
    fromUsageSeq: input.from,
    toUsageSeq: input.from + input.calls.length - 1,
    usages: input.calls.map((calls, index) => ({
      usageSeq: input.from + index,
      reservationId: input.reservationId ?? input.rootReservationId,
      usageId: `usage-${input.from + index}`,
      calls,
    })),
  };
  const withDigest = {
    ...payload,
    digest: protocolDigest("UsageReport", 1, payload),
  };
  return {
    ...withDigest,
    signature: signer.sign("UsageReport", 1, withDigest),
  };
}
