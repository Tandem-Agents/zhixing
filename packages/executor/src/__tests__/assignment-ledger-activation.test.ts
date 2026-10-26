// 拆分自 assignment-ledger.test.ts（按主题分文件以便并行执行）：activation。
import path from "node:path";
import { StorageMaintenanceAdmissionError } from "@zhixing/core/resources";
import { AuthorityCacheIntegrity, FileAuthorityCommitLog, MAX_INLINE_LOGICAL_RECORD_BYTES } from "@zhixing/core/authority";
import type { AssignmentActivationPayload, AssignmentActivationProof, AssignmentEntry, LedgerEvidencePage, IngressContext } from "@zhixing/core/contracts";
import { assignmentActivationDigest, canonicalize, dataPlaneTicketDigest, dispatchEnvelopeArtifact } from "@zhixing/core/protocol";
import { ConversationRunJournal, InProcessConversationDispatcher } from "@zhixing/owner-kernel/conversation-assignment";
import { channelSurfacePrincipal } from "@zhixing/owner-kernel/control-admission";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ConversationAssignmentLedger, InProcessAssignmentSubmission } from "../assignment-ledger.js";
import { AssignmentStreamSpool } from "../assignment-stream-spool.js";
import { DataPlaneTicketRegistry } from "../data-plane-ticket-registry.js";
import { ExecutorResourceGovernor } from "../resource-governor.js";
import { NOW, EXECUTOR_ID, CONVERSATION_ID, RUN_ID, ASSIGNMENT_ID, SHA256_ZERO, DURABLE_IO_TEST_TIMEOUT_MS, matchingSnapshotFor, matchingPermissionSnapshotFor, allowOnceDecisionDigest, deliveryParticipant, CountingArtifactStore, FaultingArtifactStore, ownerControl, submission, createHarness, createFormalReceiptHarness, ingress, ownerContext, submissionContext, sealDefaultBundle, createCancellationSubmission, createBundleSubmission, reopenJournal, withoutSignature } from "./assignment-ledger-fixture.js";

describe("conversation assignment protocol", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("atomically retires a superseded formal receipt and replays the permanent start fence", async () => {
    const h = await createFormalReceiptHarness();
    expect(await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"))).toMatchObject({ accepted: true });
    expect(await h.governor.activeAssignmentReceipts()).toHaveLength(1);
    const fence = { fenceSeq: 1, requestId: "formal-supersede" };
    await h.ledger.supersede(ASSIGNMENT_ID, fence, ownerContext(ASSIGNMENT_ID, "executor.supersede"));
    const commits = await h.log.readAll();
    const terminal = commits.find(c => c.entries.some(e => (e.body as AssignmentEntry).body?.t === "supersede-fenced"))!;
    expect(terminal.entries.some(e => (e.body as {t?:string}).t === "release")).toBe(true);
    const reopened = h.reopen();
    expect(await reopened.governor.activeAssignmentReceipts()).toHaveLength(0);
    expect(await reopened.ledger.reconcileSupersededReceipts()).toBe(0);
    await expect(reopened.ledger.start(ASSIGNMENT_ID)).rejects.toThrow();
    expect(await h.log.readAll()).toHaveLength(commits.length);
  });

  it("recovers an old fenced receipt without rewriting its fence or repeating release", async () => {
    const h = await createFormalReceiptHarness();
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    // Emit the historical v1 format through a coordinator that predates fence retirement.
    const prepare = vi.spyOn(h.governor, "prepareTerminal").mockReturnValueOnce([]);
    try { await h.ledger.supersede(ASSIGNMENT_ID, { fenceSeq: 1, requestId: "legacy-fence" }, ownerContext(ASSIGNMENT_ID, "executor.supersede")); }
    finally { prepare.mockRestore(); }
    const before = (await h.log.readAll()).length, restarted = h.reopen();
    expect(await restarted.governor.activeAssignmentReceipts()).toHaveLength(1);
    const get = h.artifacts.get.bind(h.artifacts);
    const reads = vi.spyOn(h.artifacts, "get").mockImplementation(async ref => {
      if (ref.digest !== dispatchEnvelopeArtifact(h.envelope).ref.digest) throw new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "readBytes", retryAfterMs: 1 });
      return get(ref);
    });
    onTestFinished(() => reads.mockRestore());
    // Production recovery discovery must retire it even though fenced jobs are not recoverable work.
    expect(await restarted.ledger.reconcileSupersededReceipts()).toBe(1);
    reads.mockRestore();
    expect(await restarted.ledger.recoverableConversationAssignments()).toEqual([]);
    expect(await restarted.governor.activeAssignmentReceipts()).toHaveLength(0);
    expect(await restarted.ledger.reconcileSupersededReceipts()).toBe(0);
    expect(await h.log.readAll()).toHaveLength(before + 1);
    await expect(restarted.ledger.start(ASSIGNMENT_ID)).rejects.toThrow();
  });

  it("does not retire an already-started formal receipt on supersede", async () => {
    const h = await createFormalReceiptHarness();
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    await h.ledger.start(ASSIGNMENT_ID);
    expect(await h.ledger.supersede(ASSIGNMENT_ID, { fenceSeq: 1, requestId: "started-fence" }, ownerContext(ASSIGNMENT_ID, "executor.supersede")))
      .toMatchObject({ decision: "already-started" });
    expect(await h.ledger.reconcileSupersededReceipts()).toBe(0);
    expect(await h.governor.activeAssignmentReceipts()).toHaveLength(1);
  });

  it("preserves live monotonic permission anchors across successful and failed binding batches", async () => {
    let wall = NOW, mono = 0;
    const h = await createFormalReceiptHarness({ clock: () => wall, monotonicClock: () => mono });
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    await h.ledger.start(ASSIGNMENT_ID);
    await h.ledger.authorizeToolExecution(ASSIGNMENT_ID, h.envelope.permissionLease);
    await h.ledger.queryLedger(ASSIGNMENT_ID, ownerContext(ASSIGNMENT_ID, "executor.queryLedger"));
    mono = 60001; wall = new Date(Date.parse(NOW) + 30000).toISOString();
    const checkExpired = async () => {
      await expect(h.ledger.authorizeToolExecution(ASSIGNMENT_ID, h.envelope.permissionLease)).rejects.toThrow("inactive");
      await expect(h.ledger.queryLedger(ASSIGNMENT_ID, ownerContext(ASSIGNMENT_ID, "executor.queryLedger"))).rejects.toThrow("no longer active");
    };
    const requests = [{ assignmentId: ASSIGNMENT_ID, use: "observe" as const }];
    await checkExpired();
    expect((await h.ledger.dataPlaneBindings(requests))[0]?.ref).toEqual(h.activation.ref);
    await checkExpired();
    const get = vi.spyOn(h.artifacts, "get").mockRejectedValueOnce(new Error("batch closure read failed"));
    try { await expect(h.ledger.dataPlaneBindings(requests)).rejects.toThrow("batch closure read failed"); }
    finally { get.mockRestore(); }
    await checkExpired();
  });

  it("durably rejects expiry after cache failure and independent reopen without repeated writes", async () => {
    let wall = NOW, mono = 0;
    const h = await createFormalReceiptHarness({ clock: () => wall, monotonicClock: () => mono });
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    await h.ledger.start(ASSIGNMENT_ID);
    mono = 60001; wall = new Date(Date.parse(NOW) + 30000).toISOString();
    await expect(h.ledger.authorizeToolExecution(ASSIGNMENT_ID, h.envelope.permissionLease)).rejects.toThrow("inactive");
    const count = (await h.log.readAll()).length;
    mono = 0; wall = NOW;
    const reopened = h.reopen().ledger;
    await expect(reopened.authorizeToolExecution(ASSIGNMENT_ID, h.envelope.permissionLease)).rejects.toThrow("inactive");
    await expect(reopened.queryLedger(ASSIGNMENT_ID, ownerContext(ASSIGNMENT_ID, "executor.queryLedger"))).rejects.toThrow("no longer active");
    await expect(reopened.authorizeToolExecution(ASSIGNMENT_ID, h.envelope.permissionLease)).rejects.toThrow("inactive");
    expect(await h.log.readAll()).toHaveLength(count);
  });

  it("anchors a new renewal on effective time while leaving old permission expired", async () => {
    let wall = NOW, mono = 0;
    const h = await createFormalReceiptHarness({ clock: () => wall, monotonicClock: () => mono, shortPermission: true });
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    await h.ledger.start(ASSIGNMENT_ID);
    mono = 120000; wall = new Date(Date.parse(NOW) + 30000).toISOString();
    const renewed = ownerContext(ASSIGNMENT_ID, "executor.queryLedger", CONVERSATION_ID,
      { renewalSeq: 2, issuedAt: wall, expiry: new Date(Date.parse(wall) + 60000).toISOString() });
    await expect(h.ledger.queryLedger(ASSIGNMENT_ID, renewed)).resolves.toMatchObject({ phase: "started" });
    const commits = await h.log.readAll<unknown>();
    const accepted = commits.find(c => c.entries.some(e => (e.body as AssignmentEntry).body?.t === "control-lease-renewed" &&
      ((e.body as AssignmentEntry).body as {lease?:{renewalSeq:number}}).lease?.renewalSeq === 2))!;
    expect(accepted.at).toBe(wall); // Shared authority clock is untouched.
    const frontier = accepted.entries.find(e => e.stream.endsWith(":assignment-lease-clock"))!.body as {frontier:string};
    expect(frontier.frontier).toBe(new Date(Date.parse(NOW) + 120000).toISOString());
    await expect(h.ledger.authorizeToolExecution(ASSIGNMENT_ID, h.envelope.permissionLease)).rejects.toThrow("inactive");
    mono += 30000;
    await expect(h.ledger.queryLedger(ASSIGNMENT_ID, renewed)).resolves.toMatchObject({ phase: "started" });
    mono += 30001;
    await expect(h.ledger.queryLedger(ASSIGNMENT_ID, renewed)).rejects.toThrow("no longer active");
  });

  it("fails closed and preserves storage failure when the expiry frontier cannot commit", async () => {
    let wall = NOW, mono = 0;
    const h = await createFormalReceiptHarness({ clock: () => wall, monotonicClock: () => mono });
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    await h.ledger.start(ASSIGNMENT_ID);
    mono = 60001; wall = new Date(Date.parse(NOW) + 30000).toISOString();
    const write = vi.spyOn(h.log, "transactProjection").mockRejectedValueOnce(new Error("expiry fsync failed"));
    try { await expect(h.ledger.authorizeToolExecution(ASSIGNMENT_ID, h.envelope.permissionLease)).rejects.toThrow("expiry fsync failed"); }
    finally { write.mockRestore(); }
    await expect(h.ledger.authorizeToolExecution(ASSIGNMENT_ID, h.envelope.permissionLease)).rejects.toThrow("inactive");
  });

  it.each(["missing", "mismatched", "duplicate", "malformed"] as const)("rejects an effective acceptance with a %s clock companion", async mode => {
    const h = await createHarness({ monotonicClock: () => 0 });
    const ctx = ownerContext(ASSIGNMENT_ID, "executor.queryLedger");
    if (ctx.principal.kind !== "owner-control") throw new Error("fixture principal");
    const clock = { stream: `executor:${EXECUTOR_ID}:assignment-lease-clock`, body: { v: 1, t: "assignment-lease-time-frontier", executorId: EXECUTOR_ID,
      frontier: mode === "mismatched" ? "2026-07-13T09:00:01.000Z" : NOW, ...(mode === "malformed" ? { extra: true } : {}) } };
    const append = h.log.append<unknown>([
      ...(mode === "missing" ? [] : mode === "duplicate" ? [clock, clock] : [clock]),
      { stream: `assignment:${ASSIGNMENT_ID}`, body: { recordSeq: 1, body: { v: 3, t: "control-lease-renewed",
        effectiveAcceptedAt: NOW, lease: ctx.principal.grant.controlLease } } },
    ]);
    // 格式不对的时钟记录由租约时钟投影在写入时拒绝；其余情形由分派重放拒绝
    if (mode === "malformed") {
      await expect(append).rejects.toThrow("Executor lease time frontier identity is invalid");
      return;
    }
    await append;
    await expect(h.ledger.dataPlaneBinding(ASSIGNMENT_ID, "observe")).rejects.toThrow();
  });

  it("reads historical v1 leases and rejects legacy acceptance after effective-time activation", async () => {
    const h = await createHarness({ monotonicClock: () => 0 });
    const ctx = ownerContext(ASSIGNMENT_ID, "executor.queryLedger");
    if (ctx.principal.kind !== "owner-control") throw new Error("fixture principal");
    const record = { recordSeq: 1, body: { v: 1, t: "control-lease-renewed", lease: ctx.principal.grant.controlLease } };
    await h.log.append<unknown>([{ stream: `assignment:${ASSIGNMENT_ID}`, body: record }]);
    await expect(h.ledger.dataPlaneBinding(ASSIGNMENT_ID, "observe")).resolves.toBeUndefined();
    await h.log.append<unknown>([{ stream: `executor:${EXECUTOR_ID}:assignment-lease-clock`, body: {
      v: 1, t: "assignment-lease-time-frontier", executorId: EXECUTOR_ID, frontier: NOW } }]);
    // 跨分派的时钟规则在写入时校验：登记了租约时钟投影的日志直接拒绝
    await expect(h.log.append<unknown>([{ stream: "assignment:legacy-other", body: record }])).rejects.toThrow("Legacy lease writer");
    // 不登记该投影的写者写下同样的记录：投影追平时按同一规则失败关闭。时钟跨分派共享，
    // 任一分派的决定都先在同一位置追平它，所以原分派的读取也随之拒绝
    const raw = new FileAuthorityCommitLog(h.log.rootDir, h.artifacts, { clock: () => NOW, lockWaitMs: 2_000 });
    try { await raw.append<unknown>([{ stream: "assignment:legacy-other", body: record }]); } finally { await raw.stopStorageMaintenance(); }
    await expect(h.ledger.dataPlaneBinding(ASSIGNMENT_ID, "observe")).rejects.toThrow("Legacy lease writer");
  });

  it("prepares the lease clock outside the ledger queue when a cold instance first reads an assignment", async () => {
    // 单调时钟固定：派发写下的时钟前沿恰为 NOW，造出的历史从其后严格递增，不随负载下的真实耗时漂移
    const h = await createFormalReceiptHarness({ startupProofs: true, monotonicClock: () => 0 });
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    await h.log.stopStorageMaintenance();
    // 一个不登记租约时钟投影的写者写下较长的时钟历史：冷实例首次读分派时，这个投影要先在段外追平
    const logRoot = path.join(h.root, "formal-executor"), integrity = new AuthorityCacheIntegrity(Buffer.alloc(32, 5));
    const writer = new FileAuthorityCommitLog(logRoot, h.artifacts, { clock: () => NOW, integrity });
    try {
      for (let index = 1; index <= 300; index++) {
        await writer.append<unknown>([{ stream: `executor:${EXECUTOR_ID}:assignment-lease-clock`, body: {
          v: 1, t: "assignment-lease-time-frontier", executorId: EXECUTOR_ID, frontier: new Date(Date.parse(NOW) + index * 1_000).toISOString() } }]);
      }
    } finally { await writer.stopStorageMaintenance(); }
    const cold = new FileAuthorityCommitLog(logRoot, h.artifacts, { clock: () => NOW, integrity });
    onTestFinished(() => cold.stopStorageMaintenance());
    const governor = new ExecutorResourceGovernor({ log: cold, signer: h.identity, verifier: h.identity, guard: { assert() {} },
      executorId: EXECUTOR_ID, localDomainId: "local:device-1", localGovernorEpoch: 1, maxActiveRoots: 1, clock: () => NOW });
    const ledger = new ConversationAssignmentLedger({ log: cold, artifacts: h.artifacts, executorId: EXECUTOR_ID,
      signer: h.identity, verifier: h.identity, ownerControl, snapshotFor: matchingSnapshotFor,
      permissionSnapshotFor: digest => matchingPermissionSnapshotFor(h.identity, digest), resources: governor, clock: () => NOW });
    await expect(ledger.dataPlaneBinding(ASSIGNMENT_ID, "observe")).resolves.toMatchObject({ executorId: EXECUTOR_ID });
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("reads binding batches once and preserves each requested use and missing entry", async () => {
    const h = await createFormalReceiptHarness();
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    await h.ledger.supersede(ASSIGNMENT_ID, { fenceSeq: 1, requestId: "batch-supersede" }, ownerContext(ASSIGNMENT_ID, "executor.supersede"));
    // 冷恢复从领域索引读取：一批只读一次
    const read = vi.spyOn(h.log, "transactDurableProjection");
    try {
      const batch = await h.ledger.dataPlaneBindings([
        { assignmentId: ASSIGNMENT_ID, use: "observe" }, { assignmentId: ASSIGNMENT_ID, use: "abort" },
        { assignmentId: "unknown", use: "observe" },
      ]);
      expect(batch).toEqual([{ ref: h.activation.ref, executorId: h.envelope.executorId, ownerKeyId: h.activation.signature.keyId }, undefined, undefined]);
      expect(read).toHaveBeenCalledTimes(1);
      expect(await h.ledger.dataPlaneBindings(Array.from({ length: 4096 }, () => ({ assignmentId: ASSIGNMENT_ID, use: "observe" as const })))).toHaveLength(4096);
      await expect(h.ledger.dataPlaneBindings(Array.from({ length: 4097 }, () => ({ assignmentId: ASSIGNMENT_ID })))).rejects.toThrow("4096");
    } finally { read.mockRestore(); }
  });

  it("reuses recovered bindings across restarts until the assignment's own stream changes", async () => {
    const h = await createFormalReceiptHarness({ startupProofs: true });
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    const requests = [{ assignmentId: ASSIGNMENT_ID, use: "observe" as const }, { assignmentId: ASSIGNMENT_ID, use: "abort" as const }];
    const binding = { ref: h.activation.ref, executorId: h.envelope.executorId, ownerKeyId: h.activation.signature.keyId };
    expect(await h.ledger.dataPlaneBindings(requests)).toEqual([binding, binding]);
    const get = vi.spyOn(h.artifacts, "get");
    try {
      // 重启后分派流没有新记录：沿用上次恢复的绑定，不重新归约、不再读取并验签分派信封。
      expect(await h.reopen().ledger.dataPlaneBindings(requests)).toEqual([binding, binding]);
      expect(get).not.toHaveBeenCalled();
      // 分派流有了新记录（取代栅栏）：重新归约，主动使用的绑定随之失效。
      await h.ledger.supersede(ASSIGNMENT_ID, { fenceSeq: 1, requestId: "binding-supersede" }, ownerContext(ASSIGNMENT_ID, "executor.supersede"));
      get.mockClear();
      expect(await h.reopen().ledger.dataPlaneBindings(requests)).toEqual([binding, undefined]);
      expect(get).toHaveBeenCalled();
    } finally { get.mockRestore(); }
  });

  it("keeps expired monotonic permissions expired across successful and failed receipt scans", async () => {
    let wall = NOW, mono = 0;
    const h = await createFormalReceiptHarness({ clock: () => wall, monotonicClock: () => mono });
    await h.ledger.dispatch(h.envelope, h.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    await h.ledger.start(ASSIGNMENT_ID);
    await expect(h.ledger.authorizeToolExecution(ASSIGNMENT_ID, h.envelope.permissionLease)).resolves.toEqual([]);
    mono = 60001; wall = new Date(Date.parse(NOW) + 30000).toISOString();
    await expect(h.ledger.authorizeToolExecution(ASSIGNMENT_ID, h.envelope.permissionLease)).rejects.toThrow("inactive");
    expect(await h.ledger.reconcileSupersededReceipts()).toBe(0);
    await expect(h.ledger.authorizeToolExecution(ASSIGNMENT_ID, h.envelope.permissionLease)).rejects.toThrow("inactive");
    const get = vi.spyOn(h.artifacts, "get").mockRejectedValueOnce(new Error("receipt read failed"));
    try { await expect(h.ledger.reconcileSupersededReceipts()).rejects.toThrow("receipt read failed"); }
    finally { get.mockRestore(); }
    await expect(h.ledger.authorizeToolExecution(ASSIGNMENT_ID, h.envelope.permissionLease)).rejects.toThrow("inactive");
  });

  it.each([false, true])("does not persist operational artifact pressure as invalid dispatch, previously received=%s", async (received) => {
    const h = await createHarness();
    const dispatch = () => h.ledger.dispatch(h.dispatch.envelope, h.dispatch.activation, ownerContext(ASSIGNMENT_ID, "executor.dispatch"));
    if (received) expect(await dispatch()).toMatchObject({ accepted: true });
    const pressure = new StorageMaintenanceAdmissionError({ kind: "backpressured", blockedBy: "probe-unavailable", retryAfterMs: 1 });
    const put = vi.spyOn(h.artifacts, "put").mockRejectedValueOnce(pressure);
    try { await expect(dispatch()).rejects.toBe(pressure); } finally { put.mockRestore(); }
    expect(await dispatch()).toMatchObject({ accepted: true });
    const records = (await h.log.readAll()).flatMap(e => e.entries);
    expect(records.some(r => (r.body as { body?: { t?: string } }).body?.t === "dispatch-rejected")).toBe(false);
  });

  it("authorizes a surface abort through the owner-issued durable ticket chain", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.acknowledgeDispatch(ASSIGNMENT_ID);
    const observerRequest = {
      ticketId: "ticket-observer",
      assignmentId: ASSIGNMENT_ID,
      surfacePrincipal: "surface:observer-1",
      kind: "run-observe" as const,
      ttlMs: 5 * 60 * 1_000,
    };
    const observer =
      await harness.journal.issueDataPlaneTicket(observerRequest);
    await expect(
      harness.journal.issueDataPlaneTicket(observerRequest),
    ).resolves.toEqual(observer);
    await expect(
      harness.journal.issueDataPlaneTicket({
        ...observerRequest,
        ttlMs: 60_000,
      }),
    ).rejects.toThrow("different grant");
    await expect(
      harness.journal.issueDataPlaneTicket({
        ticketId: "ticket-foreign-interact",
        assignmentId: ASSIGNMENT_ID,
        surfacePrincipal: "surface:observer-1",
        kind: "run-interact",
        ttlMs: 5 * 60 * 1_000,
      }),
    ).rejects.toThrow("restricted to the original surface");
    const interaction = await harness.journal.issueDataPlaneTicket({
      ticketId: "ticket-interact-1",
      assignmentId: ASSIGNMENT_ID,
      surfacePrincipal: "surface:user-1",
      kind: "run-interact",
      ttlMs: 5 * 60 * 1_000,
    });
    const renewalRequest = {
      ticketId: "ticket-interact-2",
      assignmentId: ASSIGNMENT_ID,
      surfacePrincipal: "surface:user-1",
      kind: "run-interact" as const,
      ttlMs: 5 * 60 * 1_000,
      replacesTicketId: interaction.ticketId,
    };
    const renewedInteraction =
      await harness.journal.issueDataPlaneTicket(renewalRequest);
    await expect(
      harness.journal.issueDataPlaneTicket(renewalRequest),
    ).resolves.toEqual(renewedInteraction);
    const { replacesTicketId: _, ...renewalWithoutReplacement } =
      renewalRequest;
    await expect(
      harness.journal.issueDataPlaneTicket(renewalWithoutReplacement),
    ).rejects.toThrow("different grant");
    const ticket = await harness.journal.issueDataPlaneTicket({
      ticketId: "ticket-owner-abort",
      assignmentId: ASSIGNMENT_ID,
      surfacePrincipal: "surface:user-1",
      kind: "abort",
      ttlMs: 5 * 60 * 1_000,
    });
    await expect(
      harness.journal.issueDataPlaneTicket({
        ticketId: "ticket-abort-renewal",
        assignmentId: ASSIGNMENT_ID,
        surfacePrincipal: "surface:user-1",
        kind: "abort",
        ttlMs: 5 * 60 * 1_000,
        replacesTicketId: ticket.ticketId,
      }),
    ).rejects.toThrow("not renewable");
    expect(await harness.journal.dataPlaneTicketFacts()).toEqual({
      issued: [interaction, renewedInteraction, observer, ticket].sort((left, right) =>
        left.ticketId.localeCompare(right.ticketId),
      ),
      revokedTicketIds: [interaction.ticketId],
    });
    const spool = new AssignmentStreamSpool(
      path.join(harness.root, "ticket-spool"),
      harness.artifacts,
      { clock: () => NOW },
    );
    await spool.open(ASSIGNMENT_ID, ticket.ref);
    const tickets = new DataPlaneTicketRegistry({
      log: harness.log,
      executorId: EXECUTOR_ID,
      verifier: harness.identity,
      assignments: harness.ledger,
      spool,
      clock: () => NOW,
    });
    await tickets.accept(ticket);
    const guardedLedger = new ConversationAssignmentLedger({
      log: harness.log,
      artifacts: harness.artifacts,
      executorId: EXECUTOR_ID,
      signer: harness.identity,
      verifier: harness.identity,
      ownerControl,
      snapshotFor: matchingSnapshotFor,
      permissionSnapshotFor: (digest) =>
        matchingPermissionSnapshotFor(harness.identity, digest),
      dataPlaneTickets: tickets,
      clock: () => NOW,
    });

    const abortRequest = {
      v: 1,
      assignmentId: ASSIGNMENT_ID,
      ref: ticket.ref,
      ticket,
      reason: "owner unavailable",
      at: NOW,
    } as const;
    await expect(
      guardedLedger.abortWithTicket(abortRequest),
    ).resolves.toEqual({ kind: "accepted" });
    await guardedLedger.continueTicketCancellation(ASSIGNMENT_ID);
    await expect(
      guardedLedger.abortWithTicket(abortRequest),
    ).resolves.toEqual({ kind: "accepted" });
    const proof = await guardedLedger.cancelProof(ASSIGNMENT_ID);
    expect(proof).toMatchObject({
      cause: "abort-ticket",
      decision: "not-started",
      ticketDigest: dataPlaneTicketDigest(ticket),
    });
    await harness.journal.submitCancelProof(
      ASSIGNMENT_ID,
      proof!,
      submissionContext(harness.unsigned),
    );
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
    expect(await harness.journal.dataPlaneTicketFacts()).toEqual({
      issued: [interaction, renewedInteraction, observer, ticket].sort((left, right) =>
        left.ticketId.localeCompare(right.ticketId),
      ),
      revokedTicketIds: [
        interaction.ticketId,
        renewedInteraction.ticketId,
        observer.ticketId,
        ticket.ticketId,
      ].sort(),
    });
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("revokes data-plane tickets at the owner cancellation fence", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.acknowledgeDispatch(ASSIGNMENT_ID);
    const ticket = await harness.journal.issueDataPlaneTicket({
      ticketId: "ticket-cancel-fence",
      assignmentId: ASSIGNMENT_ID,
      surfacePrincipal: "surface:user-1",
      kind: "abort",
      ttlMs: 5 * 60 * 1_000,
    });
    const spool = new AssignmentStreamSpool(
      path.join(harness.root, "cancel-race-ticket-spool"),
      harness.artifacts,
      { clock: () => NOW },
    );
    await spool.open(ASSIGNMENT_ID, ticket.ref);
    const tickets = new DataPlaneTicketRegistry({
      log: harness.log,
      executorId: EXECUTOR_ID,
      verifier: harness.identity,
      assignments: harness.ledger,
      spool,
      clock: () => NOW,
    });
    await tickets.accept(ticket);
    const guardedLedger = new ConversationAssignmentLedger({
      log: harness.log,
      artifacts: harness.artifacts,
      executorId: EXECUTOR_ID,
      signer: harness.identity,
      verifier: harness.identity,
      ownerControl,
      snapshotFor: matchingSnapshotFor,
      permissionSnapshotFor: (digest) =>
        matchingPermissionSnapshotFor(harness.identity, digest),
      dataPlaneTickets: tickets,
      clock: () => NOW,
    });

    await expect(
      harness.journal.cancelRun({
        runId: RUN_ID,
        requestId: "cancel-revokes-ticket",
      }),
    ).resolves.toMatchObject({ state: "cancel-requested" });
    expect(await harness.journal.dataPlaneTicketFacts()).toEqual({
      issued: [ticket],
      revokedTicketIds: [ticket.ticketId],
    });
    await expect(
      harness.journal.issueDataPlaneTicket({
        ticketId: "ticket-after-cancel",
        assignmentId: ASSIGNMENT_ID,
        surfacePrincipal: "surface:user-1",
        kind: "run-observe",
        ttlMs: 60_000,
      }),
    ).rejects.toThrow("Conversation assignment was durably cancelled before execution");
    const abortRequest = {
      v: 1,
      assignmentId: ASSIGNMENT_ID,
      ref: ticket.ref,
      ticket,
      reason: "owner cancellation raced with surface abort",
      at: NOW,
    } as const;
    await expect(
      guardedLedger.abortWithTicket(abortRequest),
    ).resolves.toEqual({ kind: "accepted" });
    await guardedLedger.continueTicketCancellation(ASSIGNMENT_ID);
    const proof = await guardedLedger.cancelProof(ASSIGNMENT_ID);
    await expect(
      harness.journal.submitCancelProof(
        ASSIGNMENT_ID,
        proof!,
        submissionContext(harness.unsigned),
      ),
    ).resolves.toBeUndefined();
    expect(await harness.journal.currentState(RUN_ID)).toBe("cancelled");
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("keeps synchronized ticket facts behind a durable non-regressing frontier", async () => {
    let nowMs = Date.parse(NOW);
    const harness = await createHarness({
      clock: () => new Date(nowMs).toISOString(),
    });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.acknowledgeDispatch(ASSIGNMENT_ID);
    const ticket = await harness.journal.issueDataPlaneTicket({
      ticketId: "ticket-finite-sync-frontier",
      assignmentId: ASSIGNMENT_ID,
      surfacePrincipal: "surface:observer-1",
      kind: "run-observe",
      ttlMs: 60_000,
    });
    expect(await harness.journal.dataPlaneTicketFacts()).toEqual({
      issued: [ticket],
      revokedTicketIds: [],
    });

    nowMs += 4 * 60 * 1_000;
    expect(await harness.journal.dataPlaneTicketFacts()).toEqual({
      issued: [],
      revokedTicketIds: [],
    });
    nowMs -= 3 * 60 * 1_000;
    expect(await harness.journal.dataPlaneTicketFacts()).toEqual({
      issued: [],
      revokedTicketIds: [],
    });
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("accepts one-shot first-party interaction and projects its durable stream facts", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await harness.journal.acknowledgeDispatch(ASSIGNMENT_ID);
    const ticket = await harness.journal.issueDataPlaneTicket({
      ticketId: "ticket-interaction",
      assignmentId: ASSIGNMENT_ID,
      surfacePrincipal: "surface:user-1",
      kind: "run-interact",
      ttlMs: 5 * 60 * 1_000,
    });
    const observer = await harness.journal.issueDataPlaneTicket({
      ticketId: "ticket-read-only",
      assignmentId: ASSIGNMENT_ID,
      surfacePrincipal: "surface:user-1",
      kind: "run-observe",
      ttlMs: 5 * 60 * 1_000,
    });
    const spool = new AssignmentStreamSpool(
      path.join(harness.root, "interaction-ticket-spool"),
      harness.artifacts,
      { clock: () => NOW },
    );
    await spool.open(ASSIGNMENT_ID, ticket.ref);
    const tickets = new DataPlaneTicketRegistry({
      log: harness.log,
      executorId: EXECUTOR_ID,
      verifier: harness.identity,
      assignments: harness.ledger,
      spool,
      clock: () => NOW,
    });
    await tickets.accept(ticket);
    await tickets.accept(observer);
    const ledger = new ConversationAssignmentLedger({
      log: harness.log,
      artifacts: harness.artifacts,
      executorId: EXECUTOR_ID,
      signer: harness.identity,
      verifier: harness.identity,
      ownerControl,
      snapshotFor: matchingSnapshotFor,
      permissionSnapshotFor: (digest) =>
        matchingPermissionSnapshotFor(harness.identity, digest),
      dataPlaneTickets: tickets,
      clock: () => NOW,
    });
    await ledger.start(ASSIGNMENT_ID);
    await ledger.requestInteraction(ASSIGNMENT_ID, {
      requestId: "interaction-ticket-request",
      toolName: "write-file",
      display: { title: "Write file", lines: ["workspace/report.md"] },
      issuedAt: NOW,
      ttlMs: 60_000,
      expiresAt: "2026-07-13T09:01:00.000Z",
    });

    await expect(
      ledger.prepareInteractionAnswerFromSurface({
        assignmentId: ASSIGNMENT_ID,
        requestId: "interaction-ticket-request",
        ticketId: observer.ticketId,
        surfacePrincipal: "surface:user-1",
        decision: { kind: "allow-once" },
      }),
    ).rejects.toThrow("cannot authorize interact");
    await expect(ledger.prepareInteractionAnswerFromSurface({
      assignmentId: ASSIGNMENT_ID,
      requestId: "interaction-ticket-request",
      ticketId: ticket.ticketId,
      surfacePrincipal: "surface:user-1",
      decision: { kind: "allow-once" },
    })).resolves.toEqual({
      kind: "authorized",
      decision: { kind: "allow-once" },
      ticketId: ticket.ticketId,
      surfacePrincipal: "surface:user-1",
    });
    const answer = await ledger.finishInteraction(
      ASSIGNMENT_ID,
      "interaction-ticket-request",
      {
        t: "answered",
        authority: { via: "surface-ticket", ticketId: ticket.ticketId },
        decision: { allowed: true },
        decisionDigest: allowOnceDecisionDigest("interaction-ticket-request"),
        by: "surface:user-1",
      },
    );
    await expect(
      ledger.prepareInteractionAnswerFromSurface({
        assignmentId: ASSIGNMENT_ID,
        requestId: "interaction-ticket-request",
        ticketId: ticket.ticketId,
        surfacePrincipal: "surface:user-1",
        decision: { kind: "allow-once" },
      }),
    ).resolves.toEqual({ kind: "replayed", result: answer });
    expect(await ledger.interactionStreamEvents(ASSIGNMENT_ID)).toMatchObject([
      {
        payload: {
          kind: "interaction",
          event: { t: "requested", requestId: "interaction-ticket-request" },
        },
      },
      {
        payload: {
          kind: "interaction",
          event: {
            t: "finished",
            requestId: "interaction-ticket-request",
            outcome: "allowed",
          },
        },
      },
    ]);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("closes a clean failed execution durably and replays the same failure fact", async () => {
    const harness = await createHarness();
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const adapter = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    const usageFinal = { reportDigest: SHA256_ZERO, upToUsageSeq: 0 };
    const failure = await harness.ledger.failExecution(ASSIGNMENT_ID, {
      reason: "provider failed",
      usageFinal,
    });
    await expect(harness.ledger.failExecution(ASSIGNMENT_ID, {
      reason: "provider failed",
      usageFinal,
    })).resolves.toEqual(failure);
    await expect(harness.ledger.failExecution(ASSIGNMENT_ID, {
      reason: "another failure",
      usageFinal,
    })).rejects.toThrow("different durable result");
    await harness.journal.failAssignedRun(
      RUN_ID,
      ASSIGNMENT_ID,
      failure?.reason,
      failure?.usageFinal,
    );
    await expect(harness.ledger.cancel(
      ASSIGNMENT_ID,
      { fenceSeq: 99, requestId: "late-cancel-after-failure" },
      ownerContext(ASSIGNMENT_ID, "executor.cancel"),
    )).resolves.toBeUndefined();

    const failedLedger = await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
    );
    expect(failedLedger).toMatchObject({
      phase: "failed",
      failure: { reason: "provider failed", usageFinal },
    });
    expect(failedLedger).not.toHaveProperty("cancelProof");
    await expect(harness.journal.runState(RUN_ID)).resolves.toBe("failed");
  });

  it("atomically derives final and staged deliveries without intermediate status noise", async () => {
    const responder = {
      channelId: "feishu",
      platformSubject: "user-1",
      tenant: "tenant-1",
    };
    const channelIngress: IngressContext = {
      kind: "channel",
      surfacePrincipal: channelSurfacePrincipal(responder),
      responder,
      replyTarget: { channelId: "feishu", to: "chat-1" },
      deviceId: "device-1",
      ingressId: "ingress-channel-1",
      receivedAt: NOW,
    };
    const harness = await createHarness({ ingress: channelIngress });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const adapter = new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    });
    await adapter.startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    await harness.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "global",
      requestId: "deliver-staged-result",
      expected: { anchorEpoch: 3 },
      mutation: {
        kind: "delivery-enqueue",
        request: { target: { kind: "turn-origin" }, content: "staged result" },
      },
    });
    const bundle = await harness.ledger.sealConversationBundle(ASSIGNMENT_ID, {
      runRecord: {
        type: "run",
        runId: RUN_ID,
        runIndex: 8,
        timestamp: NOW,
        messages: [
          { role: "user", content: [{ type: "text", text: "work" }] },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      },
      contentAssets: [],
      streamFinal: { finalSeq: 1, streamDigest: SHA256_ZERO },
      usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      usageFinal: { reportDigest: SHA256_ZERO, upToUsageSeq: 0 },
    });
    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });

    const commits = await harness.log.readAll();
    const committed = commits.find((commit) =>
      commit.entries.some(
        (entry) =>
          entry.stream === `run:${CONVERSATION_ID}` &&
          (entry.body as { readonly t?: string }).t === "committed",
      ),
    );
    const commitDeliveryKinds = committed?.entries
      .filter((entry) => entry.stream === "delivery")
      .map(
        (entry) =>
          (entry.body as { readonly keyBody: { readonly kind: string } }).keyBody.kind,
      );
    expect(commitDeliveryKinds).toEqual([
      "conversation-final-delivery",
      "staged-delivery",
    ]);
    expect(
      committed?.entries.some(
        (entry) =>
          entry.stream === "publish" &&
          (entry.body as { readonly t?: string }).t === "publish-decision",
      ),
    ).toBe(true);
    expect(
      committed?.entries.some(
        (entry) =>
          entry.stream === "publish" &&
          (entry.body as { readonly t?: string }).t === "publish-progress",
      ),
    ).toBe(false);
    expect(
      commits.some((commit) =>
        commit.entries.some(
          (entry) =>
            entry.stream === "delivery" &&
            (entry.body as { readonly keyBody?: { readonly kind?: string } }).keyBody
              ?.kind === "conversation-status-delivery",
        ),
      ),
    ).toBe(false);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("does not write delivery content for an unroutable final or during committed replay", async () => {
    let counted: CountingArtifactStore | undefined;
    const firstParty = await createHarness({
      ownerArtifacts(store) {
        counted = new CountingArtifactStore(store);
        return counted;
      },
    });
    await firstParty.ledger.dispatch(
      firstParty.dispatch.envelope,
      firstParty.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await new InProcessAssignmentSubmission({
      ledger: firstParty.ledger,
      owner: firstParty.journal,
    }).startAndReport(ASSIGNMENT_ID, submissionContext(firstParty.unsigned));
    const unroutable = await sealDefaultBundle(
      firstParty.ledger,
      "x".repeat(MAX_INLINE_LOGICAL_RECORD_BYTES),
    );
    counted!.resetWrites();
    await expect(
      firstParty.journal.submitBundle(
        unroutable,
        submissionContext(firstParty.unsigned),
      ),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    expect(counted!.writes).toBe(0);

    const channel = await createHarness({
      ingress: {
        kind: "channel",
        surfacePrincipal: channelSurfacePrincipal({
          channelId: "feishu",
          platformSubject: "user-1",
        }),
        responder: { channelId: "feishu", platformSubject: "user-1" },
        replyTarget: { channelId: "feishu", to: "chat-1" },
        deviceId: "device-1",
        ingressId: "ingress-replay",
        receivedAt: NOW,
      },
    });
    await channel.ledger.dispatch(
      channel.dispatch.envelope,
      channel.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await new InProcessAssignmentSubmission({
      ledger: channel.ledger,
      owner: channel.journal,
    }).startAndReport(ASSIGNMENT_ID, submissionContext(channel.unsigned));
    const routed = await sealDefaultBundle(
      channel.ledger,
      "y".repeat(MAX_INLINE_LOGICAL_RECORD_BYTES),
    );
    await channel.journal.submitBundle(routed, submissionContext(channel.unsigned));
    counted = new CountingArtifactStore(channel.artifacts);
    const cold = reopenJournal(channel, { artifacts: counted });
    counted.resetWrites();
    await expect(cold.currentState(RUN_ID)).resolves.toBe("committed");
    expect(counted.writes).toBe(0);
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("retries a conversation commit after transient staged-content storage failure", async () => {
    let faulting: FaultingArtifactStore | undefined;
    const harness = await createHarness({
      ownerArtifacts(store) {
        faulting = new FaultingArtifactStore(store);
        return faulting;
      },
    });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    }).startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    const content = await harness.artifacts.put(
      Buffer.from(canonicalize({ text: "staged", markdown: "staged" }), "utf8"),
    );
    await harness.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "global",
      requestId: "transient-conversation-staged-content",
      expected: { anchorEpoch: 3 },
      mutation: {
        kind: "delivery-enqueue",
        request: {
          target: {
            kind: "explicit",
            target: { channelId: "feishu", to: "chat-2" },
          },
          content: { ref: content },
        },
      },
    });
    const bundle = await sealDefaultBundle(harness.ledger);
    const before = (await harness.log.readAll()).length;
    faulting!.failDigest = content.digest;

    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).rejects.toThrow("simulated transient delivery content read failure");
    expect((await harness.log.readAll()).length).toBe(before);

    faulting!.failDigest = undefined;
    await expect(
      harness.journal.submitBundle(bundle, submissionContext(harness.unsigned)),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("commits and cold-replays a conversation with invalid staged delivery content", async () => {
    const harness = await createHarness({
      publisher: {
        decideGlobalBatchAtPrefix() {
          throw new Error("global decision is not expected");
        },
        async apply() {},
      },
    });
    await harness.ledger.dispatch(
      harness.dispatch.envelope,
      harness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    await new InProcessAssignmentSubmission({
      ledger: harness.ledger,
      owner: harness.journal,
    }).startAndReport(ASSIGNMENT_ID, submissionContext(harness.unsigned));
    const invalid = await harness.artifacts.put(
      Buffer.from("not canonical delivery content", "utf8"),
    );
    await harness.ledger.stageMutation(ASSIGNMENT_ID, {
      domain: "global",
      requestId: "invalid-conversation-staged-content",
      expected: { anchorEpoch: 3 },
      mutation: {
        kind: "delivery-enqueue",
        request: {
          target: {
            kind: "explicit",
            target: { channelId: "feishu", to: "chat-2" },
          },
          content: { ref: invalid },
        },
      },
    });

    await expect(
      harness.journal.submitBundle(
        await sealDefaultBundle(harness.ledger),
        submissionContext(harness.unsigned),
      ),
    ).resolves.toEqual({ committed: true, commitRevision: 8 });
    await expect(reopenJournal(harness).currentState(RUN_ID)).resolves.toBe(
      "committed",
    );
  }, DURABLE_IO_TEST_TIMEOUT_MS);

  it("requires durable receipt before start and recovers a lost started report", async () => {
    const harness = await createHarness();
    const disabled = new InProcessConversationDispatcher({
      enabled: false,
      journal: harness.journal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
    });
    expect(await disabled.dispatchPending()).toEqual([]);
    await expect(harness.ledger.start(ASSIGNMENT_ID)).rejects.toThrow(
      "before a durable received record",
    );

    const restartedJournal = new ConversationRunJournal({
      conversationId: CONVERSATION_ID,
      ownerEpoch: 3,
      log: new FileAuthorityCommitLog(harness.log.rootDir, harness.artifacts, {
        clock: () => NOW,
        lockWaitMs: 2_000,
      }),
      artifacts: harness.artifacts,
      signer: harness.identity,
      verifier: harness.identity,
      delivery: deliveryParticipant(harness.log),
      clock: () => NOW,
      submission,
      authority: harness.authority,
      projection: harness.projection,
    });
    expect(await restartedJournal.pendingDispatches()).toHaveLength(1);
    const enabled = new InProcessConversationDispatcher({
      enabled: true,
      journal: restartedJournal,
      executor: harness.ledger,
      contexts: { create: ownerContext },
      cancellationSubmission: createCancellationSubmission(
        harness,
        restartedJournal,
      ),
      bundleSubmission: createBundleSubmission(harness, restartedJournal),
    });
    expect(await enabled.dispatchPending()).toEqual([{ v: 1, accepted: true }]);
    expect(await restartedJournal.pendingDispatches()).toEqual([]);

    await harness.ledger.start(ASSIGNMENT_ID);
    expect(await restartedJournal.currentState(RUN_ID)).toBe("dispatched");
    expect(await enabled.recoverStarted()).toBe(1);
    expect(await restartedJournal.currentState(RUN_ID)).toBe("running");

    const lostAckHarness = await createHarness();
    await lostAckHarness.ledger.dispatch(
      lostAckHarness.dispatch.envelope,
      lostAckHarness.dispatch.activation,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    const submissionAdapter = new InProcessAssignmentSubmission({
      ledger: lostAckHarness.ledger,
      owner: lostAckHarness.journal,
    });
    await submissionAdapter.startAndReport(
      ASSIGNMENT_ID,
      submissionContext(lostAckHarness.unsigned),
    );
    expect(await lostAckHarness.journal.pendingDispatches()).toEqual([]);
  });

  it("linearizes duplicate dispatch, accepts a re-sign, and proves conflicts without appending", async () => {
    const harness = await createHarness();
    const peer = new ConversationAssignmentLedger({
      log: new FileAuthorityCommitLog(harness.log.rootDir, harness.artifacts, {
        clock: () => NOW,
        lockWaitMs: 2_000,
      }),
      artifacts: harness.artifacts,
      executorId: EXECUTOR_ID,
      signer: harness.identity,
      verifier: harness.identity,
      ownerControl,
      snapshotFor: matchingSnapshotFor,
      permissionSnapshotFor: (digest) =>
        matchingPermissionSnapshotFor(harness.identity, digest),
      clock: () => NOW,
    });
    const [first, duplicate] = await Promise.all([
      harness.ledger.dispatch(
        harness.dispatch.envelope,
        harness.dispatch.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      ),
      peer.dispatch(
        harness.dispatch.envelope,
        harness.dispatch.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      ),
    ]);
    expect(first.accepted).toBe(true);
    expect(duplicate.accepted).toBe(true);
    expect(await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)).toHaveLength(2);

    const reissued = await harness.journal.assign(harness.unsigned);
    expect(reissued.envelope).toEqual(harness.dispatch.envelope);
    expect(reissued.activation.signature.sig).not.toBe(
      harness.dispatch.activation.signature.sig,
    );
    expect(
      await harness.ledger.dispatch(
        reissued.envelope,
        reissued.activation,
        ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
      ),
    ).toEqual({ v: 1, accepted: true });

    const changedPayload = {
      ...withoutSignature(reissued.activation),
      commit: {
        ...reissued.activation.commit,
        lsn: reissued.activation.commit.lsn + 1,
      },
    } satisfies AssignmentActivationPayload<"conversation">;
    const conflicting: AssignmentActivationProof<"conversation"> = {
      ...changedPayload,
      signature: harness.identity.sign(
        "AssignmentActivationProof",
        1,
        changedPayload,
      ),
    };
    const conflict = await harness.ledger.dispatch(
      reissued.envelope,
      conflicting,
      ownerContext(ASSIGNMENT_ID, "executor.dispatch"),
    );
    expect(conflict).toMatchObject({
      accepted: false,
      outcome: "conflicting-redelivery",
      error: { code: "idempotency-conflict", retryable: false },
      proof: {
        receivedRecordSeq: 2,
        error: { code: "idempotency-conflict", retryable: false },
      },
    });
    if (conflict.accepted || conflict.outcome !== "conflicting-redelivery") {
      throw new Error("expected a signed dispatch conflict");
    }
    const { signature: conflictSignature, ...conflictPayload } = conflict.proof;
    expect(() =>
      harness.identity.verify(
        "DispatchConflictProof",
        1,
        conflictPayload,
        conflictSignature,
      ),
    ).not.toThrow();
    expect(conflict.proof.acceptedActivationDigest).toBe(
      assignmentActivationDigest(withoutSignature(harness.dispatch.activation)),
    );
    expect(conflict.proof.conflictingActivationDigest).toBe(
      assignmentActivationDigest(changedPayload),
    );
    const receivedPage = (await harness.ledger.queryLedger(
      ASSIGNMENT_ID,
      ownerContext(ASSIGNMENT_ID, "executor.queryLedger"),
      { fromSeq: 2, limit: 1 },
    )) as LedgerEvidencePage;
    expect(conflict.proof.receivedLedgerDigest).toBe(receivedPage.chainDigest);
    expect(await harness.log.readStream(`assignment:${ASSIGNMENT_ID}`)).toHaveLength(2);
  });
});
