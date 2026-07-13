import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type { ControlRecord, ControlResult } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  channelSurfacePrincipal,
  ControlAdmissionJournal,
  createInitialControlEnvelope,
  type TrustedControlSource,
} from "../control-admission.js";

const NOW = "2026-07-13T08:00:00.000Z";

async function createHarness() {
  const root = await createTempDir("control-admission");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const log = new FileAuthorityCommitLog(path.join(root, "log"), artifacts, {
    clock: () => NOW,
    lockWaitMs: 2_000,
  });
  return {
    artifacts,
    log,
    journal: new ControlAdmissionJournal(log, artifacts),
  };
}

function sessionSource(
  connectionId = "connection-1",
  deviceId = "device-1",
): TrustedControlSource {
  return {
    principal: {
      surfacePrincipal: "surface:user-1",
      deviceId,
      connectionId,
    },
  };
}

function inputSource(
  ingressId: string,
  connectionId = "connection-1",
  deviceId = "device-1",
): TrustedControlSource {
  return {
    principal: {
      surfacePrincipal: "surface:user-1",
      deviceId,
      connectionId,
    },
    ingress: {
      kind: "first-party",
      surfacePrincipal: "surface:user-1",
      deviceId,
      ingressId,
      receivedAt: NOW,
      turnOrigin: { channel: "rpc", triggeredBy: connectionId },
    },
  };
}

function channelSource(
  ingressId: string,
  connectionId = "channel-host-1",
  deviceId = "anchor-device-1",
): TrustedControlSource {
  const responder = {
    channelId: "feishu",
    platformSubject: "user-1",
    tenant: "tenant-1",
  };
  const surfacePrincipal = channelSurfacePrincipal(responder);
  return {
    principal: { surfacePrincipal, deviceId, connectionId },
    ingress: {
      kind: "channel",
      surfacePrincipal,
      responder,
      replyTarget: { channelId: "feishu", to: "chat-1" },
      deviceId,
      ingressId,
      receivedAt: NOW,
    },
  };
}

function sessionEnvelope(
  requestId: string,
  source = sessionSource(),
  requestedName = "New conversation",
) {
  return createInitialControlEnvelope({
    requestId,
    source,
    at: NOW,
    body: { t: "session-create", requestedName },
  });
}

function inputEnvelope(
  requestId: string,
  source: TrustedControlSource,
  text = "hello",
) {
  if (!source.ingress) throw new Error("input source requires ingress");
  return createInitialControlEnvelope({
    requestId,
    source,
    at: NOW,
    body: {
      t: "input",
      conversationId: "conversation-1",
      ingress: {
        ingressId: source.ingress.ingressId,
        source: source.ingress.kind,
      },
      input: { parts: [{ type: "text", text }] },
      ownerEpoch: 1,
    },
  });
}

function sessionResult(conversationId: string): ControlResult {
  return {
    v: 1,
    status: "ok",
    body: { t: "session-create", conversationId },
  };
}

function inputResult(runId: string, queuedPosition = 0): ControlResult {
  return {
    v: 1,
    status: "ok",
    body: { t: "input", runId, queuedPosition },
  };
}

describe("ControlAdmissionJournal", () => {
  it("linearizes concurrent request retries and commits one authority change", async () => {
    const { artifacts, log } = await createHarness();
    const peerLog = new FileAuthorityCommitLog(log.rootDir, artifacts, {
      clock: () => NOW,
      lockWaitMs: 2_000,
    });
    const first = new ControlAdmissionJournal(log, artifacts);
    const second = new ControlAdmissionJournal(peerLog, artifacts);
    const envelope = sessionEnvelope("request-create-1");

    const outcomes = await Promise.all([
      first.apply({
        envelope,
        source: sessionSource(),
        prepare: () => ({
          result: sessionResult("conversation-a"),
          authorityRevision: 1,
          authorityEntries: [
            {
              stream: "publish",
              body: { t: "shadow-session-created", conversationId: "conversation-a" },
            },
          ],
        }),
      }),
      second.apply({
        envelope,
        source: sessionSource(),
        prepare: () => ({
          result: sessionResult("conversation-b"),
          authorityRevision: 1,
          authorityEntries: [
            {
              stream: "publish",
              body: { t: "shadow-session-created", conversationId: "conversation-b" },
            },
          ],
        }),
      }),
    ]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual([
      "applied",
      "replayed",
    ]);
    expect(outcomes[0]!.result).toEqual(outcomes[1]!.result);
    expect(await log.readStream("publish")).toHaveLength(1);
    const control = await log.readStream<ControlRecord>("control");
    expect(control.map((entry) => entry.body.t)).toEqual(["received", "applied"]);
    expect(await log.readAll()).toHaveLength(2);
  });

  it("replays the original result after response loss and authority restart", async () => {
    const { artifacts, log, journal } = await createHarness();
    const envelope = sessionEnvelope("request-lost-response");
    const applied = await journal.apply({
      envelope,
      source: sessionSource(),
      prepare: () => ({ result: sessionResult("conversation-stable"), authorityRevision: 7 }),
    });
    expect(applied.kind).toBe("applied");

    const restartedLog = new FileAuthorityCommitLog(log.rootDir, artifacts, {
      clock: () => NOW,
      lockWaitMs: 2_000,
    });
    const restarted = new ControlAdmissionJournal(restartedLog, artifacts);
    const replayPrepare = vi.fn(() => ({
      result: sessionResult("conversation-wrong"),
      authorityRevision: 99,
    }));
    const migratedSource = sessionSource(
      "connection-after-restart",
      "device-after-restart",
    );
    const replayed = await restarted.apply({
      envelope: sessionEnvelope(
        "request-lost-response",
        migratedSource,
      ),
      source: migratedSource,
      prepare: replayPrepare,
    });

    expect(replayed).toMatchObject({
      kind: "replayed",
      canonicalRequestId: "request-lost-response",
      result: sessionResult("conversation-stable"),
      authorityRevision: 7,
    });
    expect(replayPrepare).not.toHaveBeenCalled();
    if (replayed.kind !== "replayed") throw new Error("expected replay");
    (replayed.result as { status: string }).status = "rejected";
    const replayedAgain = await restarted.apply({
      envelope: sessionEnvelope(
        "request-lost-response",
        sessionSource("connection-final-retry"),
      ),
      source: sessionSource("connection-final-retry"),
      prepare: () => ({ result: sessionResult("conversation-wrong"), authorityRevision: 100 }),
    });
    expect(replayedAgain).toMatchObject({
      kind: "replayed",
      result: sessionResult("conversation-stable"),
      authorityRevision: 7,
    });
    expect(await log.readAll()).toHaveLength(2);
  });

  it("maps at-least-once ingress retries to one run even if requestId changes", async () => {
    const { log, journal } = await createHarness();
    const originalSource = inputSource("platform-message-1");
    const first = await journal.apply({
      envelope: inputEnvelope("request-input-1", originalSource),
      source: originalSource,
      prepare: () => ({
        result: inputResult("run-stable"),
        authorityRevision: 12,
        authorityEntries: [
          {
            stream: "run:conversation-1",
            body: { t: "shadow-admitted", runId: "run-stable" },
          },
        ],
      }),
    });
    expect(first.kind).toBe("applied");

    const retrySource = inputSource(
      "platform-message-1",
      "connection-2",
      "device-after-migration",
    );
    const replayed = await journal.apply({
      envelope: inputEnvelope("request-input-2", retrySource),
      source: retrySource,
      prepare: () => ({
        result: inputResult("run-must-not-win", 1),
        authorityRevision: 13,
        authorityEntries: [
          {
            stream: "run:conversation-1",
            body: { t: "shadow-admitted", runId: "run-must-not-win" },
          },
        ],
      }),
    });

    expect(replayed).toMatchObject({
      kind: "replayed",
      canonicalRequestId: "request-input-1",
      result: inputResult("run-stable"),
      authorityRevision: 12,
    });
    expect(await log.readStream("run:conversation-1")).toHaveLength(1);
    const afterAlias = (await log.readAll()).length;

    await journal.apply({
      envelope: inputEnvelope("request-input-2", retrySource),
      source: retrySource,
      prepare: () => ({ result: inputResult("another-run"), authorityRevision: 14 }),
    });
    expect(await log.readAll()).toHaveLength(afterAlias);
  });

  it("deduplicates an at-least-once channel event after its anchor host changes", async () => {
    const { log, journal } = await createHarness();
    const originalSource = channelSource("feishu-message-1");
    await journal.apply({
      envelope: inputEnvelope("channel-request-1", originalSource),
      source: originalSource,
      prepare: () => ({
        result: inputResult("channel-run"),
        authorityRevision: 20,
        authorityEntries: [
          {
            stream: "run:conversation-1",
            body: { t: "shadow-admitted", runId: "channel-run" },
          },
        ],
      }),
    });

    const retrySource = channelSource(
      "feishu-message-1",
      "channel-host-after-restart",
      "anchor-device-after-migration",
    );
    const sameRequestPrepare = vi.fn(() => ({
      result: inputResult("must-not-run"),
      authorityRevision: 21,
    }));
    const sameRequestReplay = await journal.apply({
      envelope: inputEnvelope("channel-request-1", retrySource),
      source: retrySource,
      prepare: sameRequestPrepare,
    });
    expect(sameRequestReplay).toMatchObject({
      kind: "replayed",
      canonicalRequestId: "channel-request-1",
      result: inputResult("channel-run"),
    });
    expect(sameRequestPrepare).not.toHaveBeenCalled();

    const replayed = await journal.apply({
      envelope: inputEnvelope("channel-request-2", retrySource),
      source: retrySource,
      prepare: () => ({
        result: inputResult("must-not-run"),
        authorityRevision: 21,
        authorityEntries: [
          {
            stream: "run:conversation-1",
            body: { t: "shadow-admitted", runId: "must-not-run" },
          },
        ],
      }),
    });

    expect(replayed).toMatchObject({
      kind: "replayed",
      canonicalRequestId: "channel-request-1",
      result: inputResult("channel-run"),
      authorityRevision: 20,
    });
    expect(await log.readStream("run:conversation-1")).toHaveLength(1);
  });

  it("rejects request and ingress key reuse with a different payload", async () => {
    const { log, journal } = await createHarness();
    await journal.apply({
      envelope: sessionEnvelope("request-conflict", sessionSource(), "first"),
      source: sessionSource(),
      prepare: () => ({ result: sessionResult("conversation-1"), authorityRevision: 1 }),
    });
    const requestConflict = await journal.apply({
      envelope: sessionEnvelope("request-conflict", sessionSource(), "second"),
      source: sessionSource(),
      prepare: () => ({ result: sessionResult("conversation-2"), authorityRevision: 2 }),
    });
    expect(requestConflict).toMatchObject({
      kind: "rejected",
      result: { error: { code: "idempotency-conflict", retryable: false } },
    });
    expect(await log.readAll()).toHaveLength(2);

    const source = inputSource("same-ingress");
    await journal.apply({
      envelope: inputEnvelope("request-input-a", source, "first input"),
      source,
      prepare: () => ({ result: inputResult("run-1"), authorityRevision: 3 }),
    });
    const ingressConflict = await journal.apply({
      envelope: inputEnvelope("request-input-b", source, "changed input"),
      source,
      prepare: () => ({ result: inputResult("run-2"), authorityRevision: 4 }),
    });
    expect(ingressConflict).toMatchObject({
      kind: "rejected",
      result: { error: { code: "idempotency-conflict", retryable: false } },
    });
    expect(await log.readAll()).toHaveLength(4);
  });

  it("durably replays the original rejected result", async () => {
    const { log, journal } = await createHarness();
    const envelope = sessionEnvelope("request-rejected");
    const rejected: ControlResult = {
      v: 1,
      status: "rejected",
      error: { code: "busy", message: "owner is busy", retryable: true },
    };
    await journal.apply({
      envelope,
      source: sessionSource(),
      prepare: () => ({ result: rejected, authorityRevision: 4 }),
    });

    const replayed = await journal.apply({
      envelope,
      source: sessionSource(),
      prepare: () => ({ result: sessionResult("must-not-apply"), authorityRevision: 5 }),
    });
    expect(replayed).toMatchObject({
      kind: "replayed",
      result: rejected,
      authorityRevision: 4,
    });
    expect(await log.readAll()).toHaveLength(2);
  });

  it("recovers a request whose lazy preparation crashed after received was durable", async () => {
    const { artifacts, log, journal } = await createHarness();
    const envelope = sessionEnvelope("request-recovery");
    await expect(
      journal.apply({
        envelope,
        source: sessionSource(),
        prepare: () => {
          throw new Error("crash after received");
        },
      }),
    ).rejects.toThrow("crash after received");
    expect((await log.readStream<ControlRecord>("control")).map((entry) => entry.body.t)).toEqual([
      "received",
    ]);

    const restarted = new ControlAdmissionJournal(
      new FileAuthorityCommitLog(log.rootDir, artifacts, {
        clock: () => NOW,
        lockWaitMs: 2_000,
      }),
      artifacts,
    );
    const outcome = await restarted.apply({
      envelope,
      source: sessionSource(),
      prepare: () => ({
        result: sessionResult("conversation-recovered"),
        authorityRevision: 2,
        authorityEntries: [
          {
            stream: "publish",
            body: { t: "shadow-session-created", conversationId: "conversation-recovered" },
          },
        ],
      }),
    });

    expect(outcome.kind).toBe("applied");
    expect((await log.readStream<ControlRecord>("control")).map((entry) => entry.body.t)).toEqual([
      "received",
      "applied",
    ]);
    expect(await log.readStream("publish")).toHaveLength(1);
  });

  it("lets a same-ingress retry finish a received-only input exactly once", async () => {
    const { artifacts, log, journal } = await createHarness();
    const originalSource = inputSource("pending-ingress", "connection-before-crash");
    const original = inputEnvelope("request-before-crash", originalSource);
    await expect(
      journal.apply({
        envelope: original,
        source: originalSource,
        prepare: () => {
          throw new Error("crash after ingress receipt");
        },
      }),
    ).rejects.toThrow("crash after ingress receipt");

    const retrySource = inputSource("pending-ingress", "connection-after-crash");
    const restarted = new ControlAdmissionJournal(
      new FileAuthorityCommitLog(log.rootDir, artifacts, {
        clock: () => NOW,
        lockWaitMs: 2_000,
      }),
      artifacts,
    );
    const outcome = await restarted.apply({
      envelope: inputEnvelope("request-after-crash", retrySource),
      source: retrySource,
      prepare: () => ({
        result: inputResult("run-recovered"),
        authorityRevision: 8,
        authorityEntries: [
          {
            stream: "run:conversation-1",
            body: { t: "shadow-admitted", runId: "run-recovered" },
          },
        ],
      }),
    });

    expect(outcome).toMatchObject({
      kind: "applied",
      canonicalRequestId: "request-before-crash",
      result: inputResult("run-recovered"),
    });
    expect(await log.readStream("run:conversation-1")).toHaveLength(1);
    expect(
      (await log.readStream<ControlRecord>("control")).map((entry) => [
        entry.body.t,
        entry.body.requestId,
      ]),
    ).toEqual([
      ["received", "request-before-crash"],
      ["applied", "request-before-crash"],
      ["received", "request-after-crash"],
      ["applied", "request-after-crash"],
    ]);
  });

  it("externalizes oversized envelopes and still replays them after restart", async () => {
    const { artifacts, log, journal } = await createHarness();
    const source = inputSource("large-input");
    const envelope = inputEnvelope("request-large", source, "x".repeat(40 * 1024));
    await journal.apply({
      envelope,
      source,
      prepare: () => ({ result: inputResult("run-large"), authorityRevision: 5 }),
    });

    const records = await log.readStream<ControlRecord>("control");
    expect(records[0]!.body).toMatchObject({
      t: "received",
      envelope: { ref: { digest: expect.stringMatching(/^sha256:/u) } },
    });

    const restarted = new ControlAdmissionJournal(
      new FileAuthorityCommitLog(log.rootDir, artifacts, {
        clock: () => NOW,
        lockWaitMs: 2_000,
      }),
      artifacts,
    );
    const outcome = await restarted.apply({
      envelope,
      source,
      prepare: () => ({ result: inputResult("run-wrong"), authorityRevision: 6 }),
    });
    expect(outcome).toMatchObject({
      kind: "replayed",
      result: inputResult("run-large"),
      authorityRevision: 5,
    });
    expect(await log.readAll()).toHaveLength(2);
  });

  it("rejects caller-reported identity and enforces channel principal derivation", async () => {
    const { log, journal } = await createHarness();
    const envelope = sessionEnvelope("request-source");
    await expect(
      journal.apply({
        envelope,
        source: {
          principal: {
            ...sessionSource().principal,
            surfacePrincipal: "surface:attacker",
          },
        },
        prepare: () => ({ result: sessionResult("conversation-1"), authorityRevision: 1 }),
      }),
    ).rejects.toThrow("not the authenticated source");
    expect(await log.readAll()).toHaveLength(0);

    const responder = {
      channelId: "feishu",
      platformSubject: "user-1",
      tenant: "tenant-1",
    };
    const channelSource: TrustedControlSource = {
      principal: {
        surfacePrincipal: channelSurfacePrincipal(responder),
        deviceId: "anchor-device",
        connectionId: "channel-host",
      },
      ingress: {
        kind: "channel",
        surfacePrincipal: channelSurfacePrincipal(responder),
        responder,
        replyTarget: { channelId: "feishu", to: "chat-1" },
        deviceId: "anchor-device",
        ingressId: "message-1",
        receivedAt: NOW,
      },
    };
    expect(() =>
      createInitialControlEnvelope({
        requestId: "channel-request",
        source: {
          ...channelSource,
          ingress: {
            ...channelSource.ingress!,
            surfacePrincipal: "channel:caller-reported",
          },
        },
        at: NOW,
        body: {
          t: "input",
          conversationId: "conversation-1",
          ingress: { ingressId: "message-1", source: "channel" },
          input: { parts: [{ type: "text", text: "hello" }] },
          ownerEpoch: 1,
        },
      }),
    ).toThrow("not derived from its responder");
  });
});
