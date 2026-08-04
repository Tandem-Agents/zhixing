import path from "node:path";
import { Buffer } from "node:buffer";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
  type AuthorityCommitLog,
} from "@zhixing/core/authority";
import { DeliveryAuthority } from "@zhixing/core/delivery";
import {
  byteDigest,
  canonicalize,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import type { AdvancementControlEvent } from "@zhixing/core/advancement";
import {
  ConversationRunJournal,
} from "../conversation-assignment.js";
import { OwnerDeliveryParticipant } from "../delivery-participant.js";
import {
  assert,
  createS7TempDir,
  expectFailure,
  type DurableCaseKind,
} from "@zhixing/core/test-support/s7-durable-harness";

const NOW = "2026-08-01T00:00:00.000Z";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return { alg: "test-digest", keyId: "device-a", sig: protocolDigest(schemaId, version, payload) };
  },
  verify(schemaId, version, payload, signature) {
    assert(JSON.stringify(signature) === JSON.stringify(this.sign(schemaId, version, payload)), "signature did not bind the production payload");
  },
};

export async function executeSessionActivityCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  const fixture = await createSessionActivityFixture();
  if (kind === "variant") {
    await fixture.journal.touchWorksceneSession({
      requestId: "session-upsert",
      sceneId: "scene-a",
      at: NOW,
    });
    if (caseKey === "upsert") {
      assert(
        (await sessionActivityRecords(fixture.log)).some(
          (record) => record.operation === "upsert" && record.sessionRevision === 1,
        ),
        "session owner did not persist the upsert activity fact",
        { kind: "variant", caseKey: "upsert" },
      );
    } else if (caseKey === "delete") {
      await fixture.journal.deleteWorksceneSession({
        requestId: "session-delete",
        sceneId: "scene-a",
        at: "2026-08-01T00:01:00.000Z",
      });
      assert(
        (await sessionActivityRecords(fixture.log)).some(
          (record) => record.operation === "delete" && record.sessionRevision === 2,
        ),
        "session owner did not persist the delete activity fact",
        { kind: "variant", caseKey: "delete" },
      );
    } else {
      throw new Error(`Unimplemented session activity variant: ${caseKey}`);
    }
    await fixture.createJournal().authorityState();
    return;
  }

  if (kind === "rejection") {
    if (caseKey === "conversation-scene-mismatch") {
      await expectFailure(
        () => fixture.journal.touchWorksceneSession({
          requestId: "wrong-scene",
          sceneId: "scene-b",
          at: NOW,
        }),
        "conversation identity",
        { kind: "rejection", caseKey: "conversation-scene-mismatch" },
      );
    } else if (caseKey === "non-monotonic-revision") {
      await fixture.journal.touchWorksceneSession({
        requestId: "newer-session",
        sceneId: "scene-a",
        at: "2026-08-01T00:02:00.000Z",
      });
      const before = (await fixture.log.readAll()).length;
      await expectFailure(
        () => fixture.journal.touchWorksceneSession({
          requestId: "older-session",
          sceneId: "scene-a",
          at: NOW,
        }),
        "unique next owner mutation",
      );
      assert((await fixture.log.readAll()).length === before, "stale session activity was committed", { kind: "rejection", caseKey: "non-monotonic-revision" });
    } else if (caseKey === "external-construction") {
      await expectFailure(
        () => fixture.journal.touchWorksceneSession({
          requestId: "external-record",
          sceneId: "scene-a",
          at: NOW,
          record: sessionActivityEntry(
            fixture.conversationId,
            "scene-a",
            NOW,
            "upsert",
            1,
          ).body,
        } as never),
        "fields",
      );
      assert((await fixture.log.readAll()).length === 0, "external activity construction wrote state", { kind: "rejection", caseKey: "external-construction" });
    } else {
      throw new Error(`Unimplemented session activity rejection: ${caseKey}`);
    }
    return;
  }

  const meta = {
    t: "session-meta",
    operation: "create",
    domainRevision: 1,
    requestId: "corrupt-session",
    sceneId: "scene-a",
    lastActiveAt: NOW,
  } as const;
  if (caseKey === "wrong-stream") {
    await fixture.log.append([{
      stream: `run:${fixture.conversationId}`,
      body: sessionActivityEntry(
        fixture.conversationId,
        "scene-a",
        NOW,
        "upsert",
        1,
      ).body,
    }]);
    await expectFailure(() => fixture.createJournal().authorityState(), "run stream", { kind: "corruption", caseKey: "wrong-stream" });
  } else if (caseKey === "invalid-time") {
    await fixture.log.append<unknown>([
      { stream: `run:${fixture.conversationId}`, body: { ...meta, lastActiveAt: "not-a-time" } },
      sessionActivityEntry(fixture.conversationId, "scene-a", "not-a-time", "upsert", 1),
    ]);
    await expectFailure(() => fixture.createJournal().authorityState(), "time", { kind: "corruption", caseKey: "invalid-time" });
  } else if (caseKey === "identity-rebinding") {
    await fixture.log.append<unknown>([
      { stream: `run:${fixture.conversationId}`, body: meta },
      sessionActivityEntry("ws:scene-a:other", "scene-a", NOW, "upsert", 1),
    ]);
    await expectFailure(() => fixture.createJournal().authorityState(), "atomic activity", { kind: "corruption", caseKey: "identity-rebinding" });
  } else {
    throw new Error(`Unimplemented session activity corruption: ${caseKey}`);
  }
}

async function createSessionActivityFixture() {
  const root = await createS7TempDir("s7-session-activity");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(
    path.join(root, "authority"),
    artifacts,
    { clock: () => NOW },
  );
  const conversationId = "ws:scene-a:conversation-a";
  const createJournal = () => new ConversationRunJournal({
    conversationId,
    ownerEpoch: 1,
    log,
    artifacts,
    signer: identity,
    verifier: identity,
    submission: { authenticate() {}, authorize() {} },
    authority: { decideAtPrefix: () => ({ committed: true, commitRevision: 1 }) },
    projection: { async project() {} },
    delivery: new OwnerDeliveryParticipant({
      authority: new DeliveryAuthority({ log, anchorEpoch: 1 }),
    }),
    clock: () => NOW,
  });
  const journal = createJournal();
  return { conversationId, log, journal, createJournal };
}

async function sessionActivityRecords(log: AuthorityCommitLog) {
  return (await log.readAll())
    .flatMap((envelope) => envelope.entries)
    .filter((entry) =>
      typeof entry.body === "object" &&
      entry.body !== null &&
      "kind" in entry.body &&
      entry.body.kind === "session-activity",
    )
    .map((entry) => entry.body as {
      readonly operation: "upsert" | "delete";
      readonly sessionRevision: number;
    });
}



function sessionActivityEntry(
  conversationId: string,
  sceneId: string,
  at: string,
  operation: "upsert" | "delete",
  sessionRevision: number,
) {
  return {
    stream: `session-activity:${conversationId}`,
    body: { kind: "session-activity" as const, operation, conversationId, sceneId, sessionRevision, lastActiveAt: at },
  };
}

const ADVANCEMENT_NOW = "2026-08-02T00:00:00.000Z";

function advancementCreatedEvent(text: string): AdvancementControlEvent {
  return {
    type: "session_created",
    timestamp: ADVANCEMENT_NOW,
    sessionId: "session-1",
    conversationId: "ws:scene-a:conversation-a",
    originalUserTask: { parts: [{ type: "text", text }] },
    pendingRubricDraft: {
      draftId: "draft-1",
      originalTurnId: "turn-1",
      source: "generated",
      candidateRubricIds: [],
      title: "准则",
      description: "描述",
      content: {
        passCriteria: ["测试通过"],
        evidenceRequirements: [],
        failureHandling: [{ id: "fix", scenario: "失败", reply: "修复" }],
      },
      createdAt: ADVANCEMENT_NOW,
    },
  };
}

function advancementConfirmedEvent(): AdvancementControlEvent {
  const originalUserTask = { parts: [{ type: "text" as const, text: "任务" }] };
  return {
    type: "rubric_confirmed",
    timestamp: ADVANCEMENT_NOW,
    sessionId: "session-1",
    admissionIntent: {
      turnId: "turn-1",
      surfacePrincipal: "surface:test",
      turnOrigin: { channel: "rpc", triggeredBy: "surface:test" },
      inputDigest: protocolDigest(
        "AdvancementOriginalTaskInput",
        1,
        originalUserTask,
      ),
    },
    confirmedRubric: {
      source: { kind: "library", rubricId: "rubric-1", rubricVersion: "v1" },
      title: "准则",
      description: "描述",
      content: {
        passCriteria: [{ id: "pc-1", text: "测试通过" }],
        evidenceRequirements: [],
        failureHandling: [{ id: "fix", scenario: "失败", reply: "修复" }],
      },
      confirmedAt: ADVANCEMENT_NOW,
      confirmedBy: "user",
    },
  };
}

function advancementReviewedEvent(): AdvancementControlEvent {
  return {
    type: "run_reviewed",
    timestamp: ADVANCEMENT_NOW,
    sessionId: "session-1",
    review: {
      id: "review-1",
      runIndex: 0,
      reviewedAt: ADVANCEMENT_NOW,
      decision: "failed",
      evidence: [],
      attribution: { criteria: [] },
      unmetCriteria: ["测试通过"],
      selectedFailureHandlingId: "fix",
      proxyMessageId: "proxy-1",
    },
  };
}

function advancementProxyEvent(): AdvancementControlEvent {
  return {
    type: "proxy_enqueued",
    timestamp: ADVANCEMENT_NOW,
    sessionId: "session-1",
    proxyMessage: {
      id: "proxy-1",
      sessionId: "session-1",
      reviewId: "review-1",
      content: { parts: [{ type: "text", text: "继续" }] },
      rubricFailureHandlingId: "fix",
      variables: {},
      attribution: { criteria: [] },
      createdAt: ADVANCEMENT_NOW,
    },
  };
}

export async function executeAdvancementEventCase(
  kind: DurableCaseKind,
  caseKey: string,
): Promise<void> {
  const fixture = await createSessionActivityFixture();
  const conversationId = fixture.conversationId;
  const write = (
    events: readonly AdvancementControlEvent[],
    requestId: string,
  ) =>
    fixture.journal.applyAdvancementEvents({
      requestId,
      events: events.map((event) =>
        event.type === "session_created"
          ? { ...event, conversationId }
          : event,
      ),
    });

  if (kind === "variant") {
    if (caseKey === "single-event") {
      await write([advancementCreatedEvent("任务")], "write-single");
      assert(
        (await advancementRecords(fixture.log)).length === 1,
        "advancement single event was not persisted",
        { kind: "variant", caseKey },
      );
    } else if (caseKey === "composite-batch") {
      await write([advancementCreatedEvent("任务")], "write-prepare");
      await write([advancementConfirmedEvent()], "write-confirm");
      await write(
        [advancementReviewedEvent(), advancementProxyEvent()],
        "write-composite",
      );
      const envelopes = (await fixture.log.readAll()).filter((envelope) =>
        envelope.entries.some(
          (entry) =>
            entry.stream === `run:${conversationId}` &&
            (entry.body as { t?: string }).t === "advancement-event",
        ),
      );
      const composite = envelopes.at(-1)!;
      const advancementEntries = composite.entries.filter(
        (entry) => (entry.body as { t?: string }).t === "advancement-event",
      );
      assert(
        advancementEntries.length === 2,
        "composite advancement batch was not atomic in one envelope",
        { kind: "variant", caseKey },
      );
    } else if (caseKey === "artifact-stored") {
      await write([advancementCreatedEvent("详".repeat(20_000))], "write-big");
      const records = await advancementRecords(fixture.log);
      assert(
        records.some(
          (record) =>
            typeof (record as { event?: { ref?: unknown } }).event?.ref ===
            "object",
        ),
        "oversized advancement event was not content-addressed",
        { kind: "variant", caseKey },
      );
    } else {
      throw new Error(`Unimplemented advancement variant: ${caseKey}`);
    }
    await fixture.createJournal().advancementSessions();
    return;
  }

  if (kind === "rejection") {
    if (caseKey === "conflicting-payload") {
      await write([advancementCreatedEvent("任务")], "write-conflict");
      const before = (await fixture.log.readAll()).length;
      await expectFailure(
        () =>
          write(
            [
              {
                ...advancementCreatedEvent("另一个任务"),
                sessionId: "session-other",
              },
            ],
            "write-conflict",
          ),
        "conflicting durable payloads",
        { kind: "rejection", caseKey },
      );
      assert(
        (await fixture.log.readAll()).length === before,
        "conflicting advancement payload was committed",
        { kind: "rejection", caseKey },
      );
    } else if (caseKey === "illegal-batch") {
      await expectFailure(
        () =>
          write(
            [
              {
                type: "proxy_settled",
                timestamp: ADVANCEMENT_NOW,
                sessionId: "session-1",
                proxyMessageId: "proxy-missing",
              },
            ],
            "write-illegal",
          ),
        "not found",
        { kind: "rejection", caseKey },
      );
    } else {
      throw new Error(`Unimplemented advancement rejection: ${caseKey}`);
    }
    return;
  }

  const digestOf = (events: readonly AdvancementControlEvent[]) =>
    byteDigest(Buffer.from(canonicalize(events), "utf8"));
  if (caseKey === "invalid-event") {
    await fixture.log.append<unknown>([
      {
        stream: `run:${conversationId}`,
        body: {
          t: "advancement-event",
          requestId: "corrupt-invalid",
          domainRevision: 1,
          eventsDigest: digestOf([advancementCreatedEvent("任务")]),
          event: { type: "bogus", timestamp: ADVANCEMENT_NOW, sessionId: "session-1" },
        },
      },
    ]);
    await expectFailure(
      () => fixture.createJournal().advancementSessions(),
      "contract failed",
      { kind: "corruption", caseKey },
    );
    return;
  }
  if (caseKey === "non-monotonic-revision") {
    await write([advancementCreatedEvent("任务")], "write-mono");
    await fixture.log.append<unknown>([
      {
        stream: `run:${conversationId}`,
        body: {
          t: "advancement-event",
          requestId: "corrupt-mono",
          domainRevision: 1,
          eventsDigest: digestOf([advancementConfirmedEvent()]),
          event: advancementConfirmedEvent(),
        },
      },
    ]);
    await expectFailure(
      () => fixture.createJournal().advancementSessions(),
      "not monotonic",
      { kind: "corruption", caseKey },
    );
    return;
  }
  if (caseKey === "conflicting-durable-payload") {
    await write([advancementCreatedEvent("任务")], "write-dup");
    await fixture.log.append<unknown>([
      {
        stream: `run:${conversationId}`,
        body: {
          t: "advancement-event",
          requestId: "write-dup",
          domainRevision: 99,
          eventsDigest: digestOf([advancementConfirmedEvent()]),
          event: advancementConfirmedEvent(),
        },
      },
    ]);
    await expectFailure(
      () => fixture.createJournal().advancementSessions(),
      "conflicting durable payloads",
      { kind: "corruption", caseKey },
    );
    return;
  }
  throw new Error(`Unimplemented advancement corruption: ${caseKey}`);
}

async function advancementRecords(log: AuthorityCommitLog) {
  return (await log.readAll())
    .flatMap((envelope) => envelope.entries)
    .filter(
      (entry) =>
        typeof entry.body === "object" &&
        entry.body !== null &&
        (entry.body as { t?: string }).t === "advancement-event",
    )
    .map((entry) => entry.body);
}
