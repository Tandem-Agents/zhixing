import path from "node:path";
import { Buffer } from "node:buffer";
import {
  parseRubricDocument,
  projectRubricContractDraft,
  rubricDocumentId,
  stringifyRubricDraft,
  type RubricContractDraftSnapshot,
} from "@zhixing/core";
import {
  FileArtifactStore,
  FileAuthorityCommitLog,
} from "@zhixing/core/authority";
import type { AuthorityCommitLog } from "@zhixing/core/authority";
import type {
  AuthorityCallContext,
  DeferredGlobalIntent,
  ScheduleTaskSpecDto,
  TaskDefinition,
} from "@zhixing/core/contracts";
import { validateTaskDefinition } from "@zhixing/core/protocol";
import { AnchorRubricGlobalStateAdapter } from "@zhixing/core/rubrics";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { ControlAdmissionJournal } from "../control-admission.js";
import { DeferredGlobalIntentAnchorReviewService } from "../deferred-global-intent-review.js";
import {
  DEFERRED_INTENT_PROJECTION_ID,
  DeferredGlobalIntentRepository,
  type DeferredIntentConversationAuthority,
} from "../deferred-global-intents.js";
import { GlobalMutationCommitCoordinator } from "../global-mutation-commit-coordinator.js";

const NOW = "2026-08-07T11:00:00.000Z";
const CONVERSATION = "local-12345678-01K1ZZZZZZ0000000000000000";
const SPEC: ScheduleTaskSpecDto = {
  name: "daily summary",
  enabled: true,
  priority: "normal",
  schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
  action: { kind: "agent-turn", prompt: "summarize" },
};

function context(kind: "host" | "surface", requestId: string): AuthorityCallContext {
  return {
    principal: kind === "host"
      ? { kind: "host", component: "deferred-intent-review-test" }
      : {
          kind: "surface",
          surfacePrincipal: "surface:user-a",
          connectionId: "connection-a",
        },
    requestId,
    deadlineAt: "2026-08-07T11:01:00.000Z",
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

async function harness(currentOwner = true) {
  const root = await createTempDir("deferred-intent-review");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"), {
    lockWaitMs: 2_000,
  });
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
    lockWaitMs: 2_000,
  });
  const local = new DeferredGlobalIntentRepository({
    log,
    localDomainId: "local:device-a",
    ownerEpoch: 1,
    mode: "local",
    acceptsConversationId: () => true,
    conversationExists: () => true,
    isCurrentOwner: () => true,
    conversationAuthority: conversationAuthority(log),
    clock: () => NOW,
  });
  const anchor = new DeferredGlobalIntentRepository({
    log,
    localDomainId: "local:device-a",
    ownerEpoch: 1,
    mode: "anchor",
    acceptsConversationId: () => true,
    conversationExists: () => true,
    isCurrentOwner: () => currentOwner,
    conversationAuthority: conversationAuthority(log),
    clock: () => NOW,
  });
  let definitions = new Map<string, TaskDefinition>();
  let nextRefreshFailure: "before" | "after" | undefined;
  const createCoordinator = () => new GlobalMutationCommitCoordinator({
    log,
    artifacts,
    refreshSchedule: async () => {
      const failure = nextRefreshFailure;
      nextRefreshFailure = undefined;
      if (failure === "before") throw new Error("refresh failed before effect");
      const next = new Map<string, TaskDefinition>();
      for (const commit of await log.readAll()) {
        for (const entry of commit.entries) {
          const body = entry.body as { t?: string; def?: unknown };
          if (body.t === "task-revision") {
            const definition = validateTaskDefinition(body.def as TaskDefinition);
            next.set(definition.taskId, definition);
          }
        }
      }
      definitions = next;
      if (failure === "after") throw new Error("refresh failed after effect");
    },
    scheduleDefinitionFor: (taskId) => definitions.get(taskId),
  });
  const coordinator = createCoordinator();
  const rubrics = new AnchorRubricGlobalStateAdapter({
    log,
    artifacts,
    anchorEpoch: 1,
    clock: () => NOW,
  });
  const service = new DeferredGlobalIntentAnchorReviewService({
    repository: anchor,
    admission: new ControlAdmissionJournal(log, artifacts),
    coordinator,
    rubrics,
    anchorEpoch: 1,
    deviceId: "device-a",
    isCurrentOwner: () => currentOwner,
    now: () => NOW,
  });
  return {
    anchor,
    artifacts,
    local,
    log,
    service,
    failNextRefresh(failure: "before" | "after") {
      nextRefreshFailure = failure;
    },
    recoverAfterRestart() {
      return createCoordinator().recoverDerivedState();
    },
  };
}

describe("DeferredGlobalIntentAnchorReviewService", () => {
  it("requires a surface for schedules and atomically commits task, confirmed intent and control result", async () => {
    const fixture = await harness();
    const { intentId } = await fixture.local.record(
      CONVERSATION,
      { kind: "schedule-create", spec: SPEC },
      true,
      context("host", "record-schedule"),
    );
    await expect(fixture.service.decide(
      intentId,
      "confirmed",
      context("host", "host-confirm"),
    )).rejects.toThrow("authenticated user confirmation");
    const before = (await fixture.log.readAll()).length;
    await expect(fixture.service.decide(
      intentId,
      "confirmed",
      context("surface", "surface-confirm"),
    )).resolves.toEqual(expect.objectContaining({ status: "confirmed" }));

    const commits = await fixture.log.readAll();
    const atomic = commits.find((commit) => {
      const kinds = commit.entries.map((entry) => (entry.body as { t?: string }).t);
      return kinds.includes("task-revision") && kinds.includes("intent") && kinds.includes("applied");
    });
    expect(atomic).toBeDefined();
    expect(commits.length).toBeGreaterThan(before);
    const settledCount = commits.length;
    await fixture.service.decide(intentId, "confirmed", context("surface", "retry"));
    expect((await fixture.log.readAll()).length).toBe(settledCount);
  });

  it("allows host rubric confirmation only after asset validation and keeps conflicts pending", async () => {
    const fixture = await harness();
    const draft: RubricContractDraftSnapshot = {
      draftId: "draft-a",
      originalTurnId: "turn-a",
      source: "generated",
      candidateRubricIds: [],
      title: "Delivery",
      description: "Check delivery",
      content: {
        passCriteria: ["Done"],
        evidenceRequirements: [],
        failureHandling: [{ id: "continue", scenario: "Missing", reply: "Continue" }],
      },
      createdAt: NOW,
    };
    const raw = stringifyRubricDraft(projectRubricContractDraft(draft));
    const document = parseRubricDocument(raw);
    const content = await fixture.artifacts.put(Buffer.from(raw, "utf8"));
    const mutation: DeferredGlobalIntent["mutation"] = {
      kind: "rubric-save-own",
      rubric: { title: document.title, description: document.description, content },
    };
    const { intentId } = await fixture.local.record(
      CONVERSATION,
      mutation,
      false,
      context("host", "record-rubric"),
    );
    await expect(fixture.service.decide(
      intentId,
      "confirmed",
      context("host", "confirm-rubric"),
    )).resolves.toEqual(expect.objectContaining({ status: "confirmed" }));
    const atomic = (await fixture.log.readAll()).find((commit) => {
      const kinds = commit.entries.map((entry) => (entry.body as { t?: string }).t);
      return kinds.includes("rubric-upserted") && kinds.includes("intent") && kinds.includes("applied");
    });
    expect(atomic).toBeDefined();
    expect(rubricDocumentId(document)).toBeTruthy();

    const conflicting = await fixture.local.record(
      CONVERSATION,
      { kind: "schedule-delete", taskId: "missing", taskRevision: 1 },
      true,
      context("host", "record-conflict"),
    );
    await expect(fixture.service.decide(
      conflicting.intentId,
      "confirmed",
      context("surface", "confirm-conflict"),
    )).rejects.toThrow("remains pending");
    expect((await fixture.anchor.locate(conflicting.intentId)).intent.status).toBe("pending");
  });

  it("checks current ownership from the durable locator before exposing a full intent", async () => {
    const fixture = await harness(false);
    const { intentId } = await fixture.local.record(
      CONVERSATION,
      { kind: "schedule-create", spec: SPEC },
      true,
      context("host", "record-non-owner"),
    );
    await expect(fixture.service.review(
      intentId,
      context("surface", "review-non-owner"),
    )).rejects.toThrow("not owned by this anchor");
  });

  it.each(["before", "after"] as const)(
    "retries a confirmed schedule in the same process after refresh fails %s the effect",
    async (failure) => {
      const fixture = await harness();
      const { intentId } = await fixture.local.record(
        CONVERSATION,
        { kind: "schedule-create", spec: SPEC },
        true,
        context("host", `record-${failure}`),
      );
      fixture.failNextRefresh(failure);
      await expect(fixture.service.decide(
        intentId,
        "confirmed",
        context("surface", `confirm-${failure}`),
      )).rejects.toThrow(`refresh failed ${failure} effect`);
      expect((await fixture.anchor.locate(intentId)).intent.status).toBe("confirmed");
      const afterFailure = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
      expect(afterFailure.filter((entry) =>
        (entry.body as { t?: string }).t === "task-revision"
      )).toHaveLength(1);
      expect(afterFailure.filter((entry) =>
        (entry.body as { t?: string }).t === "schedule-materialized"
      )).toHaveLength(0);

      await expect(fixture.service.decide(
        intentId,
        "confirmed",
        context("surface", `retry-${failure}`),
      )).resolves.toEqual(expect.objectContaining({ status: "confirmed" }));
      const settled = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
      expect(settled.filter((entry) =>
        (entry.body as { t?: string }).t === "task-revision"
      )).toHaveLength(1);
      expect(settled.filter((entry) =>
        (entry.body as { t?: string }).t === "schedule-materialized"
      )).toHaveLength(1);
    },
  );

  it("keeps confirmed schedule pending across failed restarts and settles it once", async () => {
    const fixture = await harness();
    const { intentId } = await fixture.local.record(
      CONVERSATION,
      { kind: "schedule-create", spec: SPEC },
      true,
      context("host", "record-restart"),
    );
    fixture.failNextRefresh("before");
    await expect(fixture.service.decide(
      intentId,
      "confirmed",
      context("surface", "confirm-restart"),
    )).rejects.toThrow("refresh failed before effect");

    fixture.failNextRefresh("before");
    await expect(fixture.recoverAfterRestart()).rejects.toThrow("refresh failed before effect");
    await expect(fixture.recoverAfterRestart()).resolves.toBeUndefined();
    await expect(fixture.recoverAfterRestart()).resolves.toBeUndefined();

    const settled = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
    expect(settled.filter((entry) =>
      (entry.body as { t?: string }).t === "task-revision"
    )).toHaveLength(1);
    expect(settled.filter((entry) =>
      (entry.body as { t?: string }).t === "schedule-materialized"
    )).toHaveLength(1);
  });

  it("does not let an older terminal replay clear a newer schedule pending target", async () => {
    const fixture = await harness();
    const created = await fixture.local.record(
      CONVERSATION,
      { kind: "schedule-create", spec: SPEC },
      true,
      context("host", "record-create"),
    );
    await fixture.service.decide(
      created.intentId,
      "confirmed",
      context("surface", "confirm-create"),
    );
    const taskRevision = (await fixture.log.readAll()).flatMap((commit) => commit.entries)
      .map((entry) => entry.body as { t?: string; def?: TaskDefinition })
      .find((body) => body.t === "task-revision")!.def!;
    const updatedSpec = { ...SPEC, name: "updated daily summary" };
    const updated = await fixture.local.record(
      CONVERSATION,
      {
        kind: "schedule-update",
        taskId: taskRevision.taskId,
        spec: updatedSpec,
        taskRevision: 1,
      },
      true,
      context("host", "record-update"),
    );
    fixture.failNextRefresh("before");
    await expect(fixture.service.decide(
      updated.intentId,
      "confirmed",
      context("surface", "confirm-update"),
    )).rejects.toThrow("refresh failed before effect");

    const materializedBeforeOldReplay = (await fixture.log.readAll()).flatMap((commit) => commit.entries)
      .filter((entry) => (entry.body as { t?: string }).t === "schedule-materialized").length;
    await fixture.service.decide(
      created.intentId,
      "confirmed",
      context("surface", "replay-create"),
    );
    expect((await fixture.log.readAll()).flatMap((commit) => commit.entries)
      .filter((entry) => (entry.body as { t?: string }).t === "schedule-materialized")).toHaveLength(
        materializedBeforeOldReplay,
      );
    await fixture.service.decide(
      updated.intentId,
      "confirmed",
      context("surface", "retry-update"),
    );
    const settled = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
    expect(settled.filter((entry) =>
      (entry.body as { t?: string }).t === "task-revision"
    )).toHaveLength(2);
    expect(settled.filter((entry) =>
      (entry.body as { t?: string }).t === "schedule-materialized"
    )).toHaveLength(materializedBeforeOldReplay + 1);
  });

  it("reconstructs the original target revision for every terminal schedule mutation replay", async () => {
    const fixture = await harness();
    const created = await fixture.local.record(
      CONVERSATION,
      { kind: "schedule-create", spec: SPEC },
      true,
      context("host", "record-target-create"),
    );
    await fixture.service.decide(
      created.intentId,
      "confirmed",
      context("surface", "confirm-target-create"),
    );
    const taskId = (await fixture.log.readAll()).flatMap((commit) => commit.entries)
      .map((entry) => entry.body as { t?: string; def?: TaskDefinition })
      .find((body) => body.t === "task-revision")!.def!.taskId;
    const mutations: readonly DeferredGlobalIntent["mutation"][] = [
      {
        kind: "schedule-update",
        taskId,
        taskRevision: 1,
        spec: { ...SPEC, name: "updated summary" },
      },
      { kind: "schedule-set-state", taskId, taskRevision: 2, state: "disabled" },
      { kind: "schedule-delete", taskId, taskRevision: 3 },
    ];
    for (const [index, mutation] of mutations.entries()) {
      const recorded = await fixture.local.record(
        CONVERSATION,
        mutation,
        true,
        context("host", `record-target-${index}`),
      );
      fixture.failNextRefresh("before");
      await expect(fixture.service.decide(
        recorded.intentId,
        "confirmed",
        context("surface", `confirm-target-${index}`),
      )).rejects.toThrow("refresh failed before effect");
      await expect(fixture.service.decide(
        recorded.intentId,
        "confirmed",
        context("surface", `retry-target-${index}`),
      )).resolves.toEqual(expect.objectContaining({ status: "confirmed" }));
    }
    const settled = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
    expect(settled.filter((entry) =>
      (entry.body as { t?: string }).t === "task-revision"
    )).toHaveLength(4);
    expect(settled.filter((entry) =>
      (entry.body as { t?: string }).t === "schedule-materialized"
    )).toHaveLength(4);
  });
});
