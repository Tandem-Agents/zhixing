import path from "node:path";
import { Buffer } from "node:buffer";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type { AuthorityCommitLog } from "@zhixing/core/authority";
import { DeliveryAuthority } from "@zhixing/core/delivery";
import type {
  AuthorityCallContext,
  DeferredGlobalIntent,
  Signature,
} from "@zhixing/core/contracts";
import {
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import {
  DEFERRED_INTENT_PROJECTION_ID,
  DeferredGlobalIntentRepository,
  type DeferredIntentConversationAuthority,
} from "../deferred-global-intents.js";
import { ConversationRunJournal } from "../conversation-assignment.js";
import { OwnerDeliveryParticipant } from "../delivery.js";
import {
  DURABLE_IO_TEST_TIMEOUT_MS,
  trackAuthorityLog,
} from "./durable-io-test-support.js";

const NOW = "2026-08-07T09:00:00.000Z";
const CONVERSATION = "local-12345678-01K1ZZZZZZ0000000000000000";
const WORKSCENE_CONVERSATION = "ws:scene-a:primary";

const signer: ProtocolSigner = {
  sign(schemaId, version, payload): Signature {
    return {
      alg: "test-sha256",
      keyId: "device:test-owner",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
};

const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    if (signature.sig !== signer.sign(schemaId, version, payload).sig) {
      throw new TypeError("Signature mismatch");
    }
  },
};

function context(
  requestId: string,
  principal: AuthorityCallContext["principal"] = {
    kind: "host",
    component: "deferred-intent-test",
  },
): AuthorityCallContext {
  return {
    principal,
    requestId,
    deadlineAt: "2026-08-07T09:01:00.000Z",
  };
}

function mutation(revision = 1): DeferredGlobalIntent["mutation"] {
  return {
    kind: "schedule-delete",
    taskId: "task-a",
    taskRevision: revision,
  };
}

function conversationAuthority(
  log: AuthorityCommitLog,
): DeferredIntentConversationAuthority {
  return {
    async transact(input) {
      const result = await log.transactDurableProjection(
        DEFERRED_INTENT_PROJECTION_ID,
        (projection, transaction) => input.decide(
          { ownerEpoch: input.ownerEpoch, hasDurableIdentity: true, deleted: false },
          projection,
          transaction,
        ),
        input.candidateReferences
          ? { candidateReferences: input.candidateReferences }
          : undefined,
      );
      return result.value;
    },
  };
}

async function harness(root?: string) {
  const directory = root ?? await createTempDir("deferred-global-intents");
  const artifacts = new FileArtifactStore(path.join(directory, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(directory, "authority"), artifacts, {
    clock: () => NOW,
    lockWaitMs: 2_000,
  }));
  const repository = new DeferredGlobalIntentRepository({
    log,
    localDomainId: "local:device-a",
    ownerEpoch: 1,
    mode: "local",
    acceptsConversationId: (value) => value === CONVERSATION,
    conversationExists: (value) => value === CONVERSATION,
    isCurrentOwner: (value) => value === CONVERSATION,
    conversationAuthority: conversationAuthority(log),
    clock: () => NOW,
  });
  return { directory, log, repository };
}

async function journalHarness() {
  const directory = await createTempDir("deferred-global-intent-journal");
  const artifacts = new FileArtifactStore(path.join(directory, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(directory, "authority"), artifacts, {
    clock: () => NOW,
    lockWaitMs: 2_000,
  }));
  const journal = new ConversationRunJournal({
    conversationId: WORKSCENE_CONVERSATION,
    ownerEpoch: 1,
    log,
    artifacts,
    signer,
    verifier,
    submission: { authenticate() {}, authorize() {} },
    authority: { decideAtPrefix: () => ({ committed: true, commitRevision: 1 }) },
    projection: { async project() {} },
    delivery: new OwnerDeliveryParticipant({
      authority: new DeliveryAuthority({ log, anchorEpoch: 1 }),
    }),
    clock: () => NOW,
  });
  const repository = new DeferredGlobalIntentRepository({
    log,
    localDomainId: "local:device-a",
    ownerEpoch: 1,
    mode: "local",
    acceptsConversationId: (value) => value === WORKSCENE_CONVERSATION,
    conversationExists: async (value) =>
      value === WORKSCENE_CONVERSATION && !(await journal.authorityState()).deleted,
    isCurrentOwner: (value) => value === WORKSCENE_CONVERSATION,
    conversationAuthority: {
      transact: (input) => journal.transactDeferredIntent(input),
    },
    clock: () => NOW,
  });
  return { artifacts, journal, log, repository };
}

describe("DeferredGlobalIntentRepository", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("records once, preserves the first envelope time and rebuilds ordered latest state", async () => {
    const first = await harness();
    const recorded = await first.repository.record(
      CONVERSATION,
      mutation(),
      true,
      context("request-a"),
    );
    await expect(first.repository.record(
      CONVERSATION,
      mutation(),
      true,
      context("request-a"),
    )).resolves.toEqual(recorded);
    expect((await first.log.readAll()).length).toBe(1);

    const restarted = await harness(first.directory);
    await restarted.repository.rebuild();
    expect(await restarted.repository.list(
      CONVERSATION,
      context("list-a", {
        kind: "surface",
        surfacePrincipal: "surface:user-a",
        connectionId: "connection-a",
      }),
    )).toEqual([expect.objectContaining({
      intentId: recorded.intentId,
      recordedAt: NOW,
      status: "pending",
    })]);
  });

  it("rejects mismatched replay and closes discard races without a half record", async () => {
    const { log, repository } = await harness();
    const { intentId } = await repository.record(
      CONVERSATION,
      mutation(),
      true,
      context("request-a"),
    );
    await expect(repository.record(
      CONVERSATION,
      mutation(2),
      true,
      context("request-a"),
    )).rejects.toThrow("another operation");
    expect((await log.readAll()).length).toBe(1);

    const surface = context("discard-a", {
      kind: "surface",
      surfacePrincipal: "surface:user-a",
      connectionId: "connection-a",
    });
    await Promise.all([
      repository.decide(intentId, "discarded", surface),
      repository.decide(intentId, "discarded", surface),
    ]);
    const listed = await repository.list(CONVERSATION, context("list-a", surface.principal));
    expect(listed[0]).toEqual(expect.objectContaining({
      status: "discarded",
      reviewedAt: NOW,
    }));
    await expect(repository.decide(
      intentId,
      "confirmed",
      context("confirm-a", surface.principal),
    )).rejects.toThrow("anchor review service");
  });

  it("rejects wrong host mode, principal, owner, conversation and expired calls", async () => {
    const { log, repository } = await harness();
    await expect(repository.record(
      "local-other",
      mutation(),
      true,
      context("wrong-conversation"),
    )).rejects.toThrow("another domain");
    await expect(repository.record(
      CONVERSATION,
      mutation(),
      true,
      context("assignment", { kind: "usage-reporter", executorId: "executor-a" }),
    )).rejects.toThrow();
    await expect(repository.record(
      CONVERSATION,
      mutation(),
      true,
      { ...context("expired"), deadlineAt: "2026-08-07T08:59:59.000Z" },
    )).rejects.toThrow("expired");

    const anchor = new DeferredGlobalIntentRepository({
      log,
      localDomainId: "local:device-a",
      ownerEpoch: 1,
      mode: "anchor",
      acceptsConversationId: () => true,
      conversationExists: () => true,
      conversationAuthority: conversationAuthority(log),
      clock: () => NOW,
    });
    await expect(anchor.record(
      CONVERSATION,
      mutation(),
      true,
      context("anchor-record"),
    )).rejects.toThrow("cannot record");
    expect((await log.readAll()).length).toBe(0);
  });

  it("linearizes fresh record and discard with deletion while preserving terminal replay", async () => {
    const unknown = await journalHarness();
    await expect(unknown.repository.record(
      WORKSCENE_CONVERSATION,
      mutation(),
      true,
      context("unknown-record"),
    )).rejects.toThrow("current durable owner identity");
    expect(await unknown.log.readAll()).toHaveLength(0);

    const deleteFirst = await journalHarness();
    await deleteFirst.journal.touchWorksceneSession({
      requestId: "identity-delete-first",
      sceneId: "scene-a",
      at: NOW,
    });
    const deleteResult = deleteFirst.journal.deleteWorksceneSession({
      requestId: "delete-first",
      sceneId: "scene-a",
      at: NOW,
    });
    const rejectedRecord = deleteFirst.repository.record(
      WORKSCENE_CONVERSATION,
      mutation(),
      true,
      context("record-after-delete"),
    );
    await deleteResult;
    await expect(rejectedRecord).rejects.toThrow("current durable owner identity");
    expect((await deleteFirst.log.readAll()).flatMap((commit) => commit.entries)
      .filter((entry) => entry.stream === `intent:${WORKSCENE_CONVERSATION}`)).toHaveLength(0);

    const intentFirst = await journalHarness();
    await intentFirst.journal.touchWorksceneSession({
      requestId: "identity-intent-first",
      sceneId: "scene-a",
      at: NOW,
    });
    const recordPromise = intentFirst.repository.record(
      WORKSCENE_CONVERSATION,
      mutation(),
      true,
      context("record-first"),
    );
    const deletePromise = intentFirst.journal.deleteWorksceneSession({
      requestId: "delete-second",
      sceneId: "scene-a",
      at: NOW,
    });
    const [{ intentId }] = await Promise.all([recordPromise, deletePromise]);
    await expect(intentFirst.repository.record(
      WORKSCENE_CONVERSATION,
      mutation(),
      true,
      context("record-first"),
    )).resolves.toEqual({ intentId });

    const discarded = await journalHarness();
    await discarded.journal.touchWorksceneSession({
      requestId: "identity-discard",
      sceneId: "scene-a",
      at: NOW,
    });
    const recorded = await discarded.repository.record(
      WORKSCENE_CONVERSATION,
      mutation(),
      true,
      context("record-discard"),
    );
    await discarded.repository.decide(
      recorded.intentId,
      "discarded",
      context("discard-terminal", {
        kind: "surface",
        surfacePrincipal: "surface:user-a",
        connectionId: "connection-a",
      }),
    );
    await discarded.journal.deleteWorksceneSession({
      requestId: "delete-after-discard",
      sceneId: "scene-a",
      at: NOW,
    });
    await expect(discarded.repository.decide(
      recorded.intentId,
      "discarded",
      context("discard-replay", {
        kind: "surface",
        surfacePrincipal: "surface:user-a",
        connectionId: "connection-a",
      }),
    )).resolves.toBeUndefined();
  });

  it("routes every supported schedule and rubric record through the same conversation authority", async () => {
    const fixture = await journalHarness();
    await fixture.journal.touchWorksceneSession({
      requestId: "identity-all-mutations",
      sceneId: "scene-a",
      at: NOW,
    });
    const content = await fixture.artifacts.put(Buffer.from("rubric", "utf8"));
    const spec = {
      name: "daily summary",
      enabled: true,
      priority: "normal" as const,
      schedule: { kind: "cron" as const, expr: "0 9 * * *", tz: "Asia/Shanghai" },
      action: { kind: "agent-turn" as const, prompt: "summarize" },
    };
    const mutations: readonly DeferredGlobalIntent["mutation"][] = [
      { kind: "schedule-create", spec },
      { kind: "schedule-update", taskId: "task-a", taskRevision: 1, spec },
      { kind: "schedule-set-state", taskId: "task-a", taskRevision: 1, state: "disabled" },
      { kind: "schedule-delete", taskId: "task-a", taskRevision: 1 },
      {
        kind: "rubric-save-own",
        rubric: { title: "Delivery", description: "Check delivery", content },
      },
      {
        kind: "rubric-update-own",
        rubricId: "rubric-a",
        expectedRevision: 1,
        rubric: { title: "Delivery", description: "Check delivery", content },
      },
    ];
    for (const [index, value] of mutations.entries()) {
      await expect(fixture.repository.record(
        WORKSCENE_CONVERSATION,
        value,
        value.kind.startsWith("schedule-"),
        context(`all-mutations-${index}`),
      )).resolves.toEqual({ intentId: expect.any(String) });
    }
    await expect(fixture.repository.list(
      WORKSCENE_CONVERSATION,
      context("list-all-mutations", {
        kind: "surface",
        surfacePrincipal: "surface:user-a",
        connectionId: "connection-a",
      }),
    )).resolves.toHaveLength(mutations.length);
  });
});
