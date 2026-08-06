import { describe, expect, it, vi } from "vitest";
import type { AuthorityCapability } from "@zhixing/core/contracts";
import type { ConversationAssignmentLedger } from "@zhixing/executor";
import {
  assignmentGlobalCapability,
  createAssignmentMutationPort,
} from "./assignment-schedule-stager.js";

describe("assignment mutation composition", () => {
  it("derives a stable request identity and delegates overlay to the one assignment ledger", async () => {
    const stageMutation = vi.fn(async (_assignmentId, record) => ({
      kind: "assignment-mutation-staged" as const,
      requestId: record.requestId,
      recordSeq: 3,
      mutationDigest: "a".repeat(64),
    }));
    const readStagedMutationOverlay = vi.fn(async () => []);
    const ledger = { stageMutation, readStagedMutationOverlay } as unknown as ConversationAssignmentLedger;
    const port = createAssignmentMutationPort({
      ledger,
      assignmentId: "assignment-1",
      execution: "conversation",
      anchorEpoch: 7,
    });
    const request = {
      domain: "session" as const,
      operationId: "tool-call-1",
      mutation: {
        kind: "task-list-op" as const,
        op: { op: "set" as const, state: { items: [] } },
      },
    };

    const first = await port.stage(request);
    const second = await port.stage(request);
    expect(first.requestId).toBe(second.requestId);
    expect(stageMutation.mock.calls[0]![1]).toEqual(stageMutation.mock.calls[1]![1]);
    await expect(port.readOverlay()).resolves.toEqual([]);
    expect(readStagedMutationOverlay).toHaveBeenCalledWith("assignment-1");
  });

  it("rejects session writes for jobs and exact-scope memory violations before ledger append", async () => {
    const stageMutation = vi.fn();
    const ledger = {
      stageMutation,
      readStagedMutationOverlay: async () => [],
    } as unknown as ConversationAssignmentLedger;
    const job = createAssignmentMutationPort({
      ledger,
      assignmentId: "job-assignment",
      execution: "job",
      anchorEpoch: 1,
    });
    await expect(
      job.stage({
        domain: "session",
        operationId: "session-write",
        mutation: {
          kind: "segment-append",
          segment: {
            segmentId: "segment-1",
            startedAt: "2026-08-04T00:00:00.000Z",
            summary: "summary",
          },
        },
      }),
    ).rejects.toThrow("cannot stage session");

    const capability = authorityCapability({
      assignmentId: "conversation-assignment",
      execution: "conversation",
      resources: ["memory-domain:personal"],
    });
    const conversation = createAssignmentMutationPort({
      ledger,
      assignmentId: "conversation-assignment",
      execution: "conversation",
      anchorEpoch: 1,
      capability,
    });
    await expect(
      conversation.stage({
        domain: "global",
        operationId: "memory-write",
        mutation: {
          kind: "memory-delete",
          scope: { kind: "workscene", sceneId: "scene-a" },
          domain: "people",
          id: "person-a",
          expectedDigest: "a".repeat(64),
        },
      }),
    ).rejects.toThrow("does not cover");
    expect(stageMutation).not.toHaveBeenCalled();
  });

  it("requires one capability bound to the assignment and execution", () => {
    const capability = authorityCapability({
      assignmentId: "assignment-1",
      execution: "conversation",
      resources: ["memory-domain:personal"],
    });
    expect(
      assignmentGlobalCapability({
        assignmentId: "assignment-1",
        execution: "conversation",
        capabilities: [capability],
      }),
    ).toBe(capability);
    expect(() =>
      assignmentGlobalCapability({
        assignmentId: "other",
        execution: "conversation",
        capabilities: [capability],
      }),
    ).toThrow("no unique");
  });

  it("rejects global writes in a session-only domain before touching the ledger", async () => {
    const stageMutation = vi.fn();
    const ledger = {
      stageMutation,
      readStagedMutationOverlay: async () => [],
    } as unknown as ConversationAssignmentLedger;
    const port = createAssignmentMutationPort({
      ledger,
      assignmentId: "local-assignment",
      execution: "conversation",
      anchorEpoch: 1,
      allowGlobal: false,
    });

    await expect(
      port.stage({
        domain: "global",
        operationId: "forbidden-memory-write",
        mutation: {
          kind: "memory-delete",
          scope: { kind: "personal" },
          domain: "people",
          id: "person-a",
          expectedDigest: "a".repeat(64),
        },
      }),
    ).rejects.toThrow("unavailable");
    expect(stageMutation).not.toHaveBeenCalled();
  });
});

function authorityCapability(input: {
  assignmentId: string;
  execution: "conversation" | "job";
  resources: AuthorityCapability["resources"];
}): AuthorityCapability {
  return {
    v: 1,
    capId: `cap-${input.assignmentId}`,
    executorId: "executor-1",
    scope:
      input.execution === "conversation"
        ? { execution: "conversation", conversationId: "main" }
        : { execution: "job", jobId: "job-1" },
    ownerEpoch: 1,
    methods: ["global.read", "global.mutate"],
    resources: input.resources,
    assignmentId: input.assignmentId,
    issuedAt: "2026-08-04T00:00:00.000Z",
    expiry: "2026-08-04T01:00:00.000Z",
    signature: { keyId: "key", algorithm: "ed25519", value: "signature" },
  } as AuthorityCapability;
}
