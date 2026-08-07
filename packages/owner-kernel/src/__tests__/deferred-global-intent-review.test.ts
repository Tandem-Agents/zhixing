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
import { DeferredGlobalIntentRepository } from "../deferred-global-intents.js";
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
    mode: "local",
    acceptsConversationId: () => true,
    conversationExists: () => true,
    isCurrentOwner: () => true,
    clock: () => NOW,
  });
  const anchor = new DeferredGlobalIntentRepository({
    log,
    localDomainId: "local:device-a",
    mode: "anchor",
    acceptsConversationId: () => true,
    conversationExists: () => true,
    isCurrentOwner: () => currentOwner,
    clock: () => NOW,
  });
  let definitions = new Map<string, TaskDefinition>();
  const coordinator = new GlobalMutationCommitCoordinator({
    log,
    artifacts,
    refreshSchedule: async () => {
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
    },
    scheduleDefinitionFor: (taskId) => definitions.get(taskId),
  });
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
  return { anchor, artifacts, local, log, service };
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
});
