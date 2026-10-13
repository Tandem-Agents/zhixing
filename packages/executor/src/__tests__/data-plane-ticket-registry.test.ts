import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type { DataPlaneTicket, ExecutionRef } from "@zhixing/core/contracts";
import {
  createSignedDataPlaneTicket,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { AssignmentStreamSpool } from "../assignment-stream-spool.js";
import { DataPlaneTicketRegistry } from "../data-plane-ticket-registry.js";

const ref: ExecutionRef = {
  execution: "conversation",
  runId: "run-fixed",
  conversationId: "conversation-fixed",
  ownerEpoch: 3,
};

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return {
      alg: "test",
      keyId: "owner-fixed",
      sig: protocolDigest("TestSignature", 1, { schemaId, version, payload }),
    };
  },
  verify(schemaId, version, payload, signature) {
    const expected = this.sign(schemaId, version, payload);
    if (
      signature.alg !== expected.alg ||
      signature.keyId !== expected.keyId ||
      signature.sig !== expected.sig
    ) {
      throw new Error("Test signature is invalid");
    }
  },
};

describe("DataPlaneTicketRegistry", { timeout: 30_000 }, () => {

  it.each(["inactive", "missing", "different-run"] as const)("preserves validated identity when acceptance sees %s assignment", async state => {
    const root = await createTempDir("ticket-inactive");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const clock = () => "2026-07-23T00:01:00.000Z";
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, { clock });
    const spool = new AssignmentStreamSpool(path.join(root, "spool"), artifacts, { clock });
    const registry = new DataPlaneTicketRegistry({ log, spool, clock, executorId: "executor-fixed", verifier: identity,
      assignments: { async dataPlaneBinding(_id, use) {
        if (use !== "observe" || state === "missing") return undefined;
        return { ref: state === "different-run" ? { ...ref, runId: "other-run" } : ref,
          executorId: "executor-fixed", ownerKeyId: "owner-fixed" };
      } },
    });
    const error = await registry.accept(createTicket("run-interact")).catch(error => error);
    if (state === "inactive") expect(error).toMatchObject({ name: "DataPlaneAssignmentInactiveError", assignmentId: "assignment-fixed", ref });
    else { expect(error).toBeInstanceOf(Error); expect(error.name).not.toBe("DataPlaneAssignmentInactiveError"); }
    expect(await log.readAll()).toEqual([]);
  });

  it("persists acceptance before qualification and revocation before denial", async () => {
    const root = await createTempDir("data-plane-ticket-registry");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    let now = "2026-07-23T00:01:00.000Z";
    let monotonic = 1_000;
    const clock = () => now;
    const monotonicClock = () => monotonic;
    const log = new FileAuthorityCommitLog(
      path.join(root, "authority"),
      artifacts,
      { clock },
    );
    const spool = new AssignmentStreamSpool(
      path.join(root, "spool"),
      artifacts,
      { clock, reclaimDelayMs: 1_000 },
    );
    await spool.open("assignment-fixed", ref);
    const options = {
      log,
      executorId: "executor-fixed",
      verifier: identity,
      assignments: {
        async dataPlaneBinding(assignmentId: string) {
          return assignmentId === "assignment-fixed"
            ? {
                ref,
                executorId: "executor-fixed",
                ownerKeyId: "owner-fixed",
              }
            : undefined;
        },
      },
      spool,
      clock,
      monotonicClock,
    };
    const registry = new DataPlaneTicketRegistry(options);
    const ticket = createTicket("run-interact");

    await registry.accept(ticket);
    const acceptedAuthorization = await registry.authorizeSurface(
      ticket.ticketId,
      "observe",
      ticket.assignmentId,
      ticket.surfacePrincipal,
    );
    expect(acceptedAuthorization).toMatchObject({
      ticket,
      digest: expect.any(String),
    });
    const consumer = {
      kind: "surface-ticket" as const,
      ticketId: ticket.ticketId,
    };
    expect((await spool.snapshot(ticket.assignmentId)).consumers).toEqual([
      expect.objectContaining({
        key: `surface:${ticket.ticketId}`,
        qualified: true,
        expiresAt: acceptedAuthorization.expiresAt,
      }),
    ]);

    now = "2026-07-23T00:01:05.000Z";
    monotonic += 5_000;
    const laterAuthorization = await registry.authorizeSurface(
      ticket.ticketId,
      "observe",
      ticket.assignmentId,
      ticket.surfacePrincipal,
    );
    expect(laterAuthorization.expiresAt).toBe(
      acceptedAuthorization.expiresAt,
    );
    const streamEpoch = await spool.beginConnection(
      ticket.assignmentId,
      ticket.ref,
      consumer,
    );
    await expect(
      spool.subscribe({
        request: {
          v: 1,
          ref: ticket.ref,
          assignmentId: ticket.assignmentId,
          consumer,
          afterSeq: 0,
        },
        streamEpoch,
        expiresAt: laterAuthorization.expiresAt,
      }),
    ).resolves.toEqual([]);
    const restartedWhileActive = new DataPlaneTicketRegistry(options);
    await restartedWhileActive.recover();
    await expect(
      restartedWhileActive.authorizeSurface(
        ticket.ticketId,
        "observe",
        ticket.assignmentId,
        ticket.surfacePrincipal,
      ),
    ).resolves.toMatchObject({
      expiresAt: acceptedAuthorization.expiresAt,
    });
    await expect(
      registry.authorizeSurface(
        ticket.ticketId,
        "interact",
        ticket.assignmentId,
        "surface:other",
      ),
    ).rejects.toThrow(/bind/);
    await registry.revoke({
      assignmentId: ticket.assignmentId,
      ticketId: ticket.ticketId,
    });
    await expect(
      registry.authorizeSurface(
        ticket.ticketId,
        "observe",
        ticket.assignmentId,
        ticket.surfacePrincipal,
      ),
    ).rejects.toThrow(/retired/);
    expect((await spool.snapshot(ticket.assignmentId)).consumers[0]).toMatchObject({
      qualified: false,
    });

    const restarted = new DataPlaneTicketRegistry(options);
    await restarted.recover();
    await expect(
      restarted.authorizeSurface(
        ticket.ticketId,
        "observe",
        ticket.assignmentId,
        ticket.surfacePrincipal,
      ),
    ).rejects.toThrow(/retired/);

    const abort = createTicket("abort");
    await restarted.accept(abort);
    monotonic += 5 * 60 * 1_000;
    now = "2026-07-23T00:06:00.000Z";
    await expect(
      restarted.authorizeSurface(
        abort.ticketId,
        "abort",
        abort.assignmentId,
        abort.surfacePrincipal,
      ),
    ).rejects.toThrow(/retired/);

    // Consumer retirement outlives the transient stream. Cold recovery and
    // repeated revocation must not reopen an already reclaimed spool.
    const final = await spool.finalize({ assignmentId: ticket.assignmentId, ref });
    await spool.markTerminal(ticket.assignmentId, final.seq);
    now = "2026-07-23T00:06:02.000Z";
    monotonic += 2_000;
    expect(await spool.reclaimDue(ticket.assignmentId)).toBe(true);
    const coldSpool = new AssignmentStreamSpool(path.join(root, "spool"), artifacts, { clock });
    const cold = new DataPlaneTicketRegistry({ ...options, spool: coldSpool });
    await expect(cold.recover()).resolves.toBeUndefined();
    await expect(cold.revoke({ assignmentId: ticket.assignmentId, ticketId: ticket.ticketId })).resolves.toBe(false);
    await expect(cold.authorizeSurface(ticket.ticketId, "observe", ticket.assignmentId, ticket.surfacePrincipal)).rejects.toThrow(/retired/);
    await expect(coldSpool.open(ticket.assignmentId, ref)).rejects.toThrow(/permanently reclaimed/);
    await coldSpool.stopStorageMaintenance();
    await spool.stopStorageMaintenance();
    await log.stopStorageMaintenance();
  });

  it("skips historical expiry, binds the active owner, and fails closed on rollback", async () => {
    const root = await createTempDir("data-plane-ticket-registry-lifecycle");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    let now = "2026-07-23T00:10:00.000Z";
    const clock = () => now;
    const log = new FileAuthorityCommitLog(
      path.join(root, "authority"),
      artifacts,
      { clock },
    );
    const spool = new AssignmentStreamSpool(
      path.join(root, "spool"),
      artifacts,
      { clock },
    );
    await spool.open("assignment-fixed", ref);
    const verifier: ProtocolSignatureVerifier = {
      verify(schemaId, version, payload, signature) {
        const expected = protocolDigest("TestSignature", 1, {
          schemaId,
          version,
          payload,
        });
        if (signature.sig !== expected) throw new Error("Test signature is invalid");
      },
    };
    const options = {
      log,
      executorId: "executor-fixed",
      verifier,
      assignments: {
        async dataPlaneBinding() {
          return {
            ref,
            executorId: "executor-fixed",
            ownerKeyId: "owner-fixed",
          };
        },
      },
      spool,
      clock,
    };
    const registry = new DataPlaneTicketRegistry(options);
    const expired = createTicketAt(
      "run-observe",
      "ticket:expired",
      "2026-07-22T23:00:00.000Z",
      "2026-07-22T23:05:00.000Z",
      identity,
    );
    await expect(registry.accept(expired)).resolves.toEqual(expired);

    const active = createTicketAt(
      "run-observe",
      "ticket:active",
      "2026-07-23T00:09:00.000Z",
      "2026-07-23T00:14:00.000Z",
      identity,
    );
    await registry.accept(active);
    await expect(
      registry.authorizeSurface(
        active.ticketId,
        "observe",
        active.assignmentId,
        active.surfacePrincipal,
      ),
    ).resolves.toMatchObject({ ticket: active });

    const foreignSigner: ProtocolSigner = {
      sign(schemaId, version, payload) {
        return {
          alg: "test",
          keyId: "trusted-but-not-owner",
          sig: protocolDigest("TestSignature", 1, {
            schemaId,
            version,
            payload,
          }),
        };
      },
    };
    const foreign = createTicketAt(
      "run-observe",
      "ticket:foreign",
      "2026-07-23T00:09:00.000Z",
      "2026-07-23T00:14:00.000Z",
      foreignSigner,
    );
    await expect(registry.accept(foreign)).rejects.toThrow(/active assignment owner/);

    now = "2026-07-23T00:09:30.000Z";
    const restarted = new DataPlaneTicketRegistry(options);
    await expect(
      restarted.authorizeSurface(
        active.ticketId,
        "observe",
        active.assignmentId,
        active.surfacePrincipal,
      ),
    ).rejects.toThrow();
  });

  it("replays durable ticket identities before consulting the current assignment", async () => {
    const root = await createTempDir("data-plane-ticket-registry-history");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    let active = true;
    const clock = () => "2026-07-23T00:10:00.000Z";
    const log = new FileAuthorityCommitLog(
      path.join(root, "authority"),
      artifacts,
      { clock },
    );
    const spool = new AssignmentStreamSpool(
      path.join(root, "spool"),
      artifacts,
      { clock },
    );
    await spool.open("assignment-fixed", ref);
    const registry = new DataPlaneTicketRegistry({
      log,
      executorId: "executor-fixed",
      verifier: identity,
      assignments: {
        async dataPlaneBinding() {
          return active
            ? {
                ref,
                executorId: "executor-fixed",
                ownerKeyId: "owner-fixed",
              }
            : undefined;
        },
      },
      spool,
      clock,
    });
    const accepted = createTicketAt(
      "run-observe",
      "ticket:accepted-history",
      "2026-07-23T00:09:00.000Z",
      "2026-07-23T00:14:00.000Z",
      identity,
    );
    await registry.accept(accepted);
    active = false;

    await expect(registry.accept(accepted)).resolves.toEqual(accepted);
    await expect(
      registry.authorizeSurface(
        accepted.ticketId,
        "observe",
        accepted.assignmentId,
        accepted.surfacePrincipal,
      ),
    ).rejects.toThrow(/retired/);

    const expired = createTicketAt(
      "run-observe",
      "ticket:expired-history",
      "2026-07-22T23:00:00.000Z",
      "2026-07-22T23:05:00.000Z",
      identity,
    );
    await expect(registry.accept(expired)).resolves.toEqual(expired);
  });

  it("keeps observation authorized after execution closes while active uses retire", async () => {
    const root = await createTempDir("data-plane-ticket-registry-final-observation");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    let active = true;
    const clock = () => "2026-07-23T00:10:00.000Z";
    const log = new FileAuthorityCommitLog(
      path.join(root, "authority"),
      artifacts,
      { clock },
    );
    const spool = new AssignmentStreamSpool(
      path.join(root, "spool"),
      artifacts,
      { clock },
    );
    await spool.open("assignment-fixed", ref);
    const binding = {
      ref,
      executorId: "executor-fixed",
      ownerKeyId: "owner-fixed",
    };
    const registry = new DataPlaneTicketRegistry({
      log,
      executorId: "executor-fixed",
      verifier: identity,
      assignments: {
        async dataPlaneBinding(_assignmentId, use) {
          return active || use === "observe" ? binding : undefined;
        },
      },
      spool,
      clock,
    });
    const ticket = createTicketAt(
      "run-interact",
      "ticket:final-observation",
      "2026-07-23T00:09:00.000Z",
      "2026-07-23T00:14:00.000Z",
      identity,
    );
    await registry.accept(ticket);
    active = false;

    await expect(
      registry.authorizeSurface(
        ticket.ticketId,
        "observe",
        ticket.assignmentId,
        ticket.surfacePrincipal,
      ),
    ).resolves.toMatchObject({ ticket });
    await expect(
      registry.authorizeSurface(
        ticket.ticketId,
        "interact",
        ticket.assignmentId,
        ticket.surfacePrincipal,
      ),
    ).rejects.toThrow(/retired/);
  });

  it("keeps retired tickets inactive after a wall-clock rollback and cold replay", async () => {
    const root = await createTempDir("data-plane-ticket-registry-frontier");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    let now = "2026-07-23T00:01:00.000Z";
    let monotonic = 1_000;
    const clock = () => now;
    const log = new FileAuthorityCommitLog(
      path.join(root, "authority"),
      artifacts,
      { clock },
    );
    const spool = new AssignmentStreamSpool(
      path.join(root, "spool"),
      artifacts,
      { clock },
    );
    await spool.open("assignment-fixed", ref);
    const options = {
      log,
      executorId: "executor-fixed",
      verifier: identity,
      assignments: {
        async dataPlaneBinding() {
          return {
            ref,
            executorId: "executor-fixed",
            ownerKeyId: "owner-fixed",
          };
        },
      },
      spool,
      clock,
      monotonicClock: () => monotonic,
    };
    const registry = new DataPlaneTicketRegistry(options);
    const ticket = createTicket("run-observe");
    await registry.accept(ticket);
    await registry.revoke({
      assignmentId: ticket.assignmentId,
      ticketId: ticket.ticketId,
    });

    now = "2026-07-25T00:10:00.000Z";
    monotonic += 48 * 60 * 60 * 1_000;
    await expect(registry.maintain()).resolves.toBe(0);

    now = "2026-07-23T00:02:00.000Z";
    await expect(registry.accept(ticket)).resolves.toEqual(ticket);
    expect((await spool.snapshot(ticket.assignmentId)).consumers[0]).toMatchObject({
      qualified: false,
    });

    const restarted = new DataPlaneTicketRegistry(options);
    await restarted.recover();
    await expect(restarted.accept(ticket)).resolves.toEqual(ticket);
    await expect(
      restarted.authorizeSurface(
        ticket.ticketId,
        "observe",
        ticket.assignmentId,
        ticket.surfacePrincipal,
      ),
    ).rejects.toThrow(/unknown/);
  });

  it("isolates the retirement frontier by executor identity", async () => {
    const root = await createTempDir("ticket-frontier-isolation");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const clock = () => "2026-07-23T00:01:00.000Z";
    const log = new FileAuthorityCommitLog(
      path.join(root, "authority"),
      artifacts,
      { clock },
    );
    const spool = new AssignmentStreamSpool(
      path.join(root, "spool"),
      artifacts,
      { clock },
    );
    await spool.open("assignment-fixed", ref);
    const registry = new DataPlaneTicketRegistry({
      log,
      executorId: "executor-fixed",
      verifier: identity,
      assignments: {
        async dataPlaneBinding() {
          return {
            ref,
            executorId: "executor-fixed",
            ownerKeyId: "owner-fixed",
          };
        },
      },
      spool,
      clock,
      monotonicClock: () => 1_000,
    });
    const ticket = createTicketAt(
      "run-observe",
      "ticket-frontier-isolation",
      "2026-07-23T00:00:00.000Z",
      "2026-07-23T00:05:00.000Z",
      identity,
    );
    await log.append([
      {
        stream:
          "executor:executor-foreign:data-plane-ticket-retirement-frontier",
        body: {
          t: "data-plane-ticket-retirement-frontier",
          executorId: "executor-foreign",
          retiredThrough: new Date(
            Date.parse(ticket.expiry) + 60_000,
          ).toISOString(),
        },
      },
    ]);

    await expect(registry.accept(ticket)).resolves.toEqual(ticket);
    await expect(
      registry.authorizeSurface(
        ticket.ticketId,
        "observe",
        ticket.assignmentId,
        ticket.surfacePrincipal,
      ),
    ).resolves.toMatchObject({ ticket });
  });

  it("retires unused tickets during maintenance and keeps the live projection bounded", async () => {
    const root = await createTempDir("data-plane-ticket-registry-maintenance");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    let now = "2026-07-23T00:01:00.000Z";
    let monotonic = 1_000;
    const clock = () => now;
    const log = new FileAuthorityCommitLog(
      path.join(root, "authority"),
      artifacts,
      { clock },
    );
    const spool = new AssignmentStreamSpool(
      path.join(root, "spool"),
      artifacts,
      { clock },
    );
    await spool.open("assignment-fixed", ref);
    const registry = new DataPlaneTicketRegistry({
      log,
      executorId: "executor-fixed",
      verifier: identity,
      assignments: {
        async dataPlaneBinding() {
          return {
            ref,
            executorId: "executor-fixed",
            ownerKeyId: "owner-fixed",
          };
        },
      },
      spool,
      clock,
      monotonicClock: () => monotonic,
    });
    const ticket = createTicket("run-observe");
    await registry.accept(ticket);

    monotonic += 5 * 60 * 1_000;
    now = "2026-07-23T00:06:00.000Z";
    await expect(registry.maintain()).resolves.toBe(1);
    await expect(registry.maintain()).resolves.toBe(0);
    await expect(
      registry.authorizeSurface(
        ticket.ticketId,
        "observe",
        ticket.assignmentId,
        ticket.surfacePrincipal,
      ),
    ).rejects.toThrow(/retired/);
    expect((await spool.snapshot(ticket.assignmentId)).consumers[0]).toMatchObject({
      qualified: false,
    });
  });

  it.each([false, true])("bounds recovery obligation registration and drains in-flight work before returning (failure=%s)", async failing => {
    const root = await createTempDir("ticket-recovery-batch");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const clock = () => "2026-07-23T00:01:00.000Z";
    const binding = { ref, executorId: "executor-fixed", ownerKeyId: "owner-fixed" };
    const assignments = { dataPlaneBinding: vi.fn(async () => binding),
      dataPlaneBindings: vi.fn(async (requests: readonly unknown[]) => requests.map(() => binding)) };
    const spool = { deferRecoveredConsumers: vi.fn(async () => {}), qualifyConsumer: vi.fn(async () => {}), revokeConsumer: vi.fn(async () => {}) } as unknown as AssignmentStreamSpool;
    const registry = new DataPlaneTicketRegistry({ log: new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, { clock }),
      executorId: "executor-fixed", verifier: identity, assignments, spool, clock, monotonicClock: () => 1000 });
    for (let i = 0; i < 35; i++) await registry.accept(createTicketAt("run-observe", "recovery-" + i, "2026-07-23T00:00:00.000Z", "2026-07-23T00:05:00.000Z", identity, "recovery-assignment-" + i % 8));
    assignments.dataPlaneBinding.mockClear();
    const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
    let active = 0, maximum = 0, released = false, done = false;
    vi.mocked(spool.deferRecoveredConsumers).mockImplementation(async () => {
      active++; maximum = Math.max(maximum, active);
      const gate = Promise.withResolvers<void>(); gates.push(gate);
      try { if (!released) await gate.promise; } finally { active--; }
    });
    const recovering = registry.recover().then(() => ({ ok: true }), error => ({ ok: false, error })).finally(() => { done = true; });
    try {
      await vi.waitFor(() => expect(gates).toHaveLength(4));
      expect(maximum).toBe(4);
      if (failing) gates[0]!.reject(new Error("qualification failed")); else gates[0]!.resolve();
      await vi.waitFor(() => expect(failing ? active : gates.length).toBe(failing ? 3 : 5));
      expect(done).toBe(false);
      released = true; for (const gate of gates) gate.resolve();
      const result = await recovering;
      expect(result.ok).toBe(!failing);
      if (!result.ok) expect(String(result.error)).toContain("qualification failed");
      expect(active).toBe(0); expect(maximum).toBeLessThanOrEqual(4);
      expect(assignments.dataPlaneBinding).not.toHaveBeenCalled();
      expect(assignments.dataPlaneBindings.mock.calls.map(args => args[0].length)).toEqual(failing ? [32] : [32, 3]);
    } finally { released = true; for (const gate of gates) gate.resolve(); await recovering; }
  });

  it("serializes qualification with expiry retirement", async () => {
    const root = await createTempDir("data-plane-ticket-registry-race");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    let now = "2026-07-23T00:01:00.000Z";
    let monotonic = 1_000;
    let releaseQualification!: () => void;
    const qualificationGate = new Promise<void>((resolve) => {
      releaseQualification = resolve;
    });
    const order: string[] = [];
    const spool = {
      qualifyConsumer: vi.fn(async () => {
        order.push("qualify-start");
        await qualificationGate;
        order.push("qualify-end");
      }),
      revokeConsumer: vi.fn(async () => {
        order.push("revoke");
      }),
    } as unknown as AssignmentStreamSpool;
    const registry = new DataPlaneTicketRegistry({
      log: new FileAuthorityCommitLog(
        path.join(root, "authority"),
        artifacts,
        { clock: () => now },
      ),
      executorId: "executor-fixed",
      verifier: identity,
      assignments: {
        async dataPlaneBinding() {
          return {
            ref,
            executorId: "executor-fixed",
            ownerKeyId: "owner-fixed",
          };
        },
      },
      spool,
      clock: () => now,
      monotonicClock: () => monotonic,
    });
    const ticket = createTicket("run-observe");

    const accepting = registry.accept(ticket);
    await vi.waitFor(() => expect(spool.qualifyConsumer).toHaveBeenCalledOnce());
    monotonic += 5 * 60 * 1_000;
    now = "2026-07-23T00:06:00.000Z";
    const maintaining = registry.maintain();
    await Promise.resolve();
    expect(spool.revokeConsumer).not.toHaveBeenCalled();

    releaseQualification();
    await accepting;
    await expect(maintaining).resolves.toBe(1);
    expect(order).toEqual(["qualify-start", "qualify-end", "revoke"]);
  });
});

function createTicket(kind: DataPlaneTicket["kind"]): DataPlaneTicket {
  return createTicketAt(
    kind,
    `ticket:${kind}`,
    "2026-07-23T00:00:00.000Z",
    "2026-07-23T00:05:00.000Z",
    identity,
  );
}

function createTicketAt(
  kind: DataPlaneTicket["kind"],
  ticketId: string,
  issuedAt: string,
  expiry: string,
  signer: ProtocolSigner,
  assignmentId = "assignment-fixed",
): DataPlaneTicket {
  return createSignedDataPlaneTicket(
    {
      v: 1,
      ticketId,
      ref,
      assignmentId,
      surfacePrincipal: "surface:origin",
      executorId: "executor-fixed",
      issuedAt,
      expiry,
      kind,
      renewable: kind !== "abort",
    } as Parameters<typeof createSignedDataPlaneTicket>[0],
    signer,
  );
}

it('retires a recovered invalid binding batch durably before revoking its consumers', async () => {
  const root = await createTempDir('ticket-recovery-retirement-batch');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const clock = () => '2026-07-23T00:01:00.000Z';
  const log = new FileAuthorityCommitLog(path.join(root, 'authority'), artifacts, { clock });
  const binding = { ref, executorId: 'executor-fixed', ownerKeyId: 'owner-fixed' };
  const assignments = { dataPlaneBinding: vi.fn(async () => binding),
    dataPlaneBindings: vi.fn(async (requests: readonly unknown[]) => requests.map(() => undefined)) };
  const spool = { deferRecoveredConsumers: vi.fn(async () => {}), qualifyConsumer: vi.fn(async () => {}), revokeConsumer: vi.fn(async () => {}) } as unknown as AssignmentStreamSpool;
  const options = { log, executorId: 'executor-fixed', verifier: identity, assignments, spool, clock, monotonicClock: () => 1000 };
  const registry = new DataPlaneTicketRegistry(options);
  for (let i = 0; i < 35; i++) await registry.accept(createTicketAt('run-observe', 'invalid-recovery-' + i, '2026-07-23T00:00:00.000Z', '2026-07-23T00:05:00.000Z', identity));
  vi.mocked(spool.qualifyConsumer).mockClear(); assignments.dataPlaneBinding.mockClear();
  vi.mocked(spool.revokeConsumer).mockImplementation(async input => {
    if (input.consumer.kind !== 'surface-ticket') throw Error('Unexpected recovered consumer');
    const ticketId = input.consumer.ticketId;
    const records = (await log.readAll()).flatMap(envelope => envelope.entries.map(entry => entry.body as { t?: string; ticketId?: string }));
    expect(records.some(record => record.t === 'data-plane-ticket-retired' && record.ticketId === ticketId)).toBe(true);
    return undefined;
  });
  const recovered = new DataPlaneTicketRegistry(options);
  await recovered.recover();
  const retirementEnvelopes = (await log.readAll()).filter(envelope => envelope.entries.some(entry => (entry.body as {t?:string}).t === 'data-plane-ticket-retired'));
  expect(retirementEnvelopes.map(envelope => envelope.entries.length)).toEqual([32, 3]);
  // 物理撤销不在启动路径上：恢复只耐久退休，周期维护每轮有界地补齐。
  expect(spool.revokeConsumer).not.toHaveBeenCalled();
  for (let round = 1; round <= 5; round++) {
    await recovered.maintain();
    expect(vi.mocked(spool.revokeConsumer).mock.calls.length).toBe(Math.min(35, round * 8));
  }
  await recovered.maintain();
  expect(spool.revokeConsumer).toHaveBeenCalledTimes(35); expect(spool.qualifyConsumer).not.toHaveBeenCalled();
  expect(assignments.dataPlaneBinding).not.toHaveBeenCalled();
  expect(assignments.dataPlaneBindings.mock.calls.map(args => args[0].length)).toEqual([32, 3]);
}, 30_000);


it('retries failed retirement effects and retains completed revocations across restart', async () => {
  const root = await createTempDir('ticket-retirement-effects');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const clock = () => '2026-07-23T00:01:00.000Z';
  const log = new FileAuthorityCommitLog(path.join(root, 'authority'), artifacts, { clock });
  const spool = { deferRecoveredConsumers: vi.fn(async () => {}), qualifyConsumer: vi.fn(async () => {}), revokeConsumer: vi.fn(async () => {}) } as unknown as AssignmentStreamSpool;
  const options = { log, spool, clock, executorId: 'executor-fixed', verifier: identity,
    assignments: { async dataPlaneBinding() { return { ref, executorId: 'executor-fixed', ownerKeyId: 'owner-fixed' }; } } };
  const registry = new DataPlaneTicketRegistry(options);
  const ticket = createTicket('run-observe'); await registry.accept(ticket);
  vi.mocked(spool.revokeConsumer).mockRejectedValueOnce(Error('physical retirement failed'));
  await expect(registry.revoke({ assignmentId: ticket.assignmentId, ticketId: ticket.ticketId })).rejects.toThrow('physical retirement failed');
  await registry.maintain(); expect(spool.revokeConsumer).toHaveBeenCalledTimes(2);
  await registry.maintain(); await registry.recover(); expect(spool.revokeConsumer).toHaveBeenCalledTimes(2);
  await expect(registry.accept(ticket)).resolves.toEqual(ticket); expect(spool.qualifyConsumer).toHaveBeenCalledOnce();
  const restarted = new DataPlaneTicketRegistry(options); await restarted.recover();
  expect(spool.revokeConsumer).toHaveBeenCalledTimes(2);
  await expect(restarted.authorize(ticket.ticketId, 'observe', { assignmentId: ticket.assignmentId, ref, executorId: 'executor-fixed', surfacePrincipal: ticket.surfacePrincipal })).rejects.toThrow('retired');
  expect(spool.qualifyConsumer).toHaveBeenCalledOnce();
});


it('redrives the effect-to-receipt crash window, binds its consumer epoch and preserves a new ticket', async () => {
  const root = await createTempDir('ticket-revocation-receipt');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const clock = () => '2026-07-23T00:01:00.000Z';
  const log = new FileAuthorityCommitLog(path.join(root, 'authority'), artifacts, { clock });
  const spool = new AssignmentStreamSpool(path.join(root, 'spool'), artifacts, { clock });
  const options = { log, spool, clock, executorId: 'executor-fixed', verifier: identity,
    assignments: { async dataPlaneBinding() { return { ref, executorId: 'executor-fixed', ownerKeyId: 'owner-fixed' }; } } };
  const registry = new DataPlaneTicketRegistry(options), ticket = createTicket('run-observe');
  await registry.accept(ticket);
  const epoch = await spool.beginConnection(ticket.assignmentId, ref, { kind: 'surface-ticket', ticketId: ticket.ticketId });
  const original = spool.revokeConsumer.bind(spool);
  const revoke = vi.spyOn(spool, 'revokeConsumer').mockImplementationOnce(async input => {
    await original(input); throw Error('crash after durable spool revoke');
  });
  await expect(registry.revoke({ assignmentId: ticket.assignmentId, ticketId: ticket.ticketId })).rejects.toThrow('crash after durable spool revoke');
  // 恢复只重建授权视图，不在就绪路径上补做物理撤销；周期维护补齐撤销与回执。
  const recovered = new DataPlaneTicketRegistry(options);
  await recovered.recover();
  expect(revoke).toHaveBeenCalledTimes(1);
  await expect(recovered.authorize(ticket.ticketId, 'observe', { assignmentId: ticket.assignmentId, ref, executorId: 'executor-fixed', surfacePrincipal: ticket.surfacePrincipal })).rejects.toThrow('retired');
  await recovered.maintain();
  expect(revoke).toHaveBeenCalledTimes(2);
  const receipts = (await log.readAll()).flatMap(envelope => envelope.entries.map(entry => entry.body as any))
    .filter(body => body.t === 'data-plane-ticket-revocation-completed');
  expect(receipts).toEqual([{ t: 'data-plane-ticket-revocation-completed', assignmentId: ticket.assignmentId, ticketId: ticket.ticketId, streamEpoch: epoch }]);
  const renewed = createTicketAt('run-observe', 'new-ticket-after-revocation', ticket.issuedAt, ticket.expiry, identity);
  const restarted = new DataPlaneTicketRegistry(options); await restarted.accept(renewed); await restarted.recover(); await restarted.maintain();
  expect(revoke).toHaveBeenCalledTimes(2);
  expect((await spool.snapshot(ticket.assignmentId)).consumers).toContainEqual(expect.objectContaining({ key: 'surface:' + renewed.ticketId, qualified: true }));
  await expect(restarted.authorize(ticket.ticketId, 'observe', { assignmentId: ticket.assignmentId, ref, executorId: 'executor-fixed', surfacePrincipal: ticket.surfacePrincipal })).rejects.toThrow('retired');
});

it('rejects a revocation completion whose durable retirement binds another assignment', async () => {
  const root = await createTempDir('ticket-corrupt-revocation-receipt');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const clock = () => '2026-07-23T00:01:00.000Z';
  const log = new FileAuthorityCommitLog(path.join(root, 'authority'), artifacts, { clock });
  const spool = new AssignmentStreamSpool(path.join(root, 'spool'), artifacts, { clock });
  const options = { log, spool, clock, executorId: 'executor-fixed', verifier: identity,
    assignments: { async dataPlaneBinding() { return { ref, executorId: 'executor-fixed', ownerKeyId: 'owner-fixed' }; } } };
  const registry = new DataPlaneTicketRegistry(options), ticket = createTicket('run-observe');
  await registry.accept(ticket); await registry.revoke({ assignmentId: ticket.assignmentId, ticketId: ticket.ticketId });
  await log.append([{ stream: 'assignment:another-assignment:data-plane-tickets', body: { t: 'data-plane-ticket-revocation-completed', assignmentId: 'another-assignment', ticketId: ticket.ticketId, streamEpoch: null } }]);
  await expect(new DataPlaneTicketRegistry(options).recover()).rejects.toThrow('no matching retirement');
});
