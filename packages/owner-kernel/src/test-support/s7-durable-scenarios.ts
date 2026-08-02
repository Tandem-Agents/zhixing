import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
  type AuthorityCommitLog,
} from "@zhixing/core/authority";
import { DeliveryAuthority } from "@zhixing/core/delivery";
import { protocolDigest, type ProtocolSignatureVerifier, type ProtocolSigner } from "@zhixing/core/protocol";
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
