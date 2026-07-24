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
      { clock },
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
): DataPlaneTicket {
  return createSignedDataPlaneTicket(
    {
      v: 1,
      ticketId,
      ref,
      assignmentId: "assignment-fixed",
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
