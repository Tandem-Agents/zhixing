import { describe, expect, it } from "vitest";
import type { MutationBatch, PublishRecord } from "../contracts/records.js";
import type { WorksceneAppliedResult, WorksceneWriteMutation } from "../contracts/state.js";
import { createMutationBatch } from "./commit.js";
import {
  validatePublishDecisionForBatch,
  validatePublishResultNotice,
} from "./contract-validation.js";

const NOW = "2026-08-05T00:00:00.000Z";
const BATCH_REF = { digest: `sha256:${"0".repeat(64)}`, bytes: 1 };

describe("validatePublishDecisionForBatch", () => {
  it.each([
    {
      mutation: {
        kind: "workscene-create",
        name: "Project",
        workspace: { deviceId: "device-a", bindingRef: "binding-a" },
      },
      result: applied("create", 1, {
        id: "scene-a",
        name: "Project",
        revision: 1,
        workspace: { deviceId: "device-a", bindingRef: "binding-a" },
      }),
    },
    {
      mutation: {
        kind: "workscene-rename",
        sceneId: "scene-a",
        name: "Renamed",
        expectedRevision: 1,
      },
      result: applied("rename", 2, {
        id: "scene-a",
        name: "Renamed",
        revision: 2,
      }),
    },
    {
      mutation: {
        kind: "workscene-set-workdir",
        sceneId: "scene-a",
        workspace: { deviceId: "device-b", bindingRef: "binding-b" },
        expectedRevision: 2,
      },
      result: applied("set-workdir", 3, {
        id: "scene-a",
        name: "Renamed",
        revision: 3,
        workspace: { deviceId: "device-b", bindingRef: "binding-b" },
      }),
    },
    {
      mutation: {
        kind: "workscene-delete",
        sceneId: "scene-a",
        expectedRevision: 3,
      },
      result: {
        kind: "workscene-deleted",
        operation: "delete",
        revision: 4,
        sceneId: "scene-a",
        previousObjectRevision: 3,
      },
    },
  ] satisfies ReadonlyArray<{
    mutation: WorksceneWriteMutation;
    result: WorksceneAppliedResult;
  }>)(
    "accepts the authoritative $mutation.kind result",
    ({ mutation, result }) => {
      const batch = worksceneBatch(mutation);
      expect(() => validatePublishDecisionForBatch(decision(batch, result), batch)).not.toThrow();
    },
  );

  it("rejects missing, mismatched and structurally open workscene results", () => {
    const batch = worksceneBatch({
      kind: "workscene-rename",
      sceneId: "scene-a",
      name: "Renamed",
      expectedRevision: 1,
    });
    const valid = decision(
      batch,
      applied("rename", 2, { id: "scene-a", name: "Renamed", revision: 2 }),
    );
    const variants: unknown[] = [
      { ...valid, outcomes: [{ seq: 1, outcome: { t: "granted", targetRevision: 2 } }] },
      withResult(valid, { operation: "set-workdir" }),
      withResult(valid, { scene: { ...validResult(valid).scene, id: "scene-b" } }),
      withResult(valid, { scene: { ...validResult(valid).scene, revision: 3 } }),
      withResult(valid, { revision: 3 }),
      withResult(valid, { unexpected: true }),
    ];
    for (const variant of variants) {
      expect(() => validatePublishDecisionForBatch(variant, batch)).toThrow();
    }
  });

  it("rejects applied results on non-workscene mutations and decision/batch drift", () => {
    const batch = createMutationBatch("assignment-a", [
      {
        v: 1,
        t: "staged-mutation",
        seq: 1,
        domain: "global",
        requestId: "schedule-a",
        expected: { anchorEpoch: 1 },
        mutation: { kind: "schedule-delete", taskId: "task-a", taskRevision: 1 },
      },
    ]);
    const result = applied("create", 1, { id: "scene-a", name: "Project", revision: 1 });
    expect(() => validatePublishDecisionForBatch(decision(batch, result), batch)).toThrow();
    expect(() =>
      validatePublishDecisionForBatch(
        { ...decision(batch), assignmentId: "assignment-b" },
        batch,
      ),
    ).toThrow();
    expect(() =>
      validatePublishDecisionForBatch(
        { ...decision(batch), globalCount: 0 },
        batch,
      ),
    ).toThrow();
  });
});

describe("validatePublishResultNotice", () => {
  const valid = {
    conversationId: "conversation-a",
    runId: "run-a",
    commitRevision: 2,
    assignmentId: "assignment-a",
    seq: 1,
    mutation: { kind: "schedule-delete", taskId: "task-a", taskRevision: 1 },
    decision: {
      t: "conflicted",
      error: { code: "revision-conflict", message: "changed", retryable: false },
    },
  } as const;

  it("accepts the complete mutation and decision union", () => {
    expect(validatePublishResultNotice(valid)).toEqual(valid);
  });

  it.each([
    { ...valid, extra: true },
    { ...valid, mutation: { ...valid.mutation, extra: true } },
    { ...valid, decision: { ...valid.decision, extra: true } },
    {
      ...valid,
      decision: {
        t: "granted",
        targetRevision: 2,
        appliedResult: applied("create", 2, {
          id: "scene-a",
          name: "Project",
          revision: 2,
        }),
      },
    },
  ])("rejects open or mutation-mismatched notice %#", (variant) => {
    expect(() => validatePublishResultNotice(variant)).toThrow();
  });
});

function worksceneBatch(mutation: WorksceneWriteMutation): MutationBatch {
  return createMutationBatch("assignment-a", [
    {
      v: 1,
      t: "staged-mutation",
      seq: 1,
      domain: "global",
      requestId: "workscene-a",
      expected: { anchorEpoch: 1 },
      mutation,
    },
  ]);
}

function decision(
  batch: MutationBatch,
  appliedResult?: WorksceneAppliedResult,
): Extract<PublishRecord, { t: "publish-decision" }> {
  return {
    t: "publish-decision",
    assignmentId: batch.assignmentId,
    batch: { ref: BATCH_REF },
    sessionCount: 0,
    globalCount: 1,
    outcomes: [
      {
        seq: 1,
        outcome: {
          t: "granted",
          targetRevision: appliedResult?.revision ?? 1,
          ...(appliedResult ? { appliedResult } : {}),
        },
      },
    ],
  };
}

function applied(
  operation: "create" | "rename" | "set-workdir",
  revision: number,
  scene: {
    id: string;
    name: string;
    revision: number;
    workspace?: { deviceId: string; bindingRef: string };
  },
): WorksceneAppliedResult {
  return {
    kind: "workscene-applied",
    operation,
    revision,
    scene: {
      ...scene,
      createdAt: NOW,
      lastActiveAt: NOW,
    },
  };
}

function validResult(
  value: Extract<PublishRecord, { t: "publish-decision" }>,
): Extract<WorksceneAppliedResult, { kind: "workscene-applied" }> {
  return value.outcomes[0]!.outcome.t === "granted" &&
    value.outcomes[0]!.outcome.appliedResult?.kind === "workscene-applied"
    ? value.outcomes[0]!.outcome.appliedResult
    : (() => { throw new Error("fixture has no workscene result"); })();
}

function withResult(
  value: Extract<PublishRecord, { t: "publish-decision" }>,
  patch: Record<string, unknown>,
): unknown {
  return {
    ...value,
    outcomes: [{
      seq: 1,
      outcome: {
        ...(value.outcomes[0]!.outcome as object),
        appliedResult: { ...validResult(value), ...patch },
      },
    }],
  };
}
