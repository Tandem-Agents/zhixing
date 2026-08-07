import path from "node:path";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type {
  AuthorityCallContext,
  DeferredGlobalIntent,
} from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { DeferredGlobalIntentRepository } from "../deferred-global-intents.js";

const NOW = "2026-08-07T09:00:00.000Z";
const CONVERSATION = "local-12345678-01K1ZZZZZZ0000000000000000";

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

async function harness(root?: string) {
  const directory = root ?? await createTempDir("deferred-global-intents");
  const artifacts = new FileArtifactStore(path.join(directory, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const log = new FileAuthorityCommitLog(path.join(directory, "authority"), artifacts, {
    clock: () => NOW,
    lockWaitMs: 2_000,
  });
  const repository = new DeferredGlobalIntentRepository({
    log,
    localDomainId: "local:device-a",
    mode: "local",
    acceptsConversationId: (value) => value === CONVERSATION,
    conversationExists: (value) => value === CONVERSATION,
    isCurrentOwner: (value) => value === CONVERSATION,
    clock: () => NOW,
  });
  return { directory, log, repository };
}

describe("DeferredGlobalIntentRepository", () => {
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
      mode: "anchor",
      acceptsConversationId: () => true,
      conversationExists: () => true,
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
});
