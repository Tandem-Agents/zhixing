import path from "node:path";
import { FileArtifactStore } from "@zhixing/core/authority";
import type { ExecutionRef } from "@zhixing/core/contracts";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { projectAssignmentInteractionStream } from "../assignment-interaction-stream.js";
import {
  AssignmentStreamSpool,
  AssignmentStreamWriter,
} from "../assignment-stream-spool.js";

const ref: ExecutionRef = {
  execution: "conversation",
  runId: "run-fixed",
  conversationId: "conversation-fixed",
  ownerEpoch: 3,
};

describe("projectAssignmentInteractionStream", { timeout: 30_000 }, () => {
  it("rebuilds requested and finished frames idempotently from an explicit cursor", async () => {
    const root = await createTempDir("assignment-interaction-stream");
    const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
    const spool = new AssignmentStreamSpool(
      path.join(root, "spool"),
      artifacts,
      { clock: () => "2026-07-23T00:00:00.000Z" },
    );
    const writer = await AssignmentStreamWriter.open(
      spool,
      "assignment-fixed",
      ref,
    );
    const ledger = {
      async interactionStreamProjectedUpTo() {
        return undefined;
      },
      async interactionStreamEvents() {
        return [
          {
            recordSeq: 2,
            payload: {
              kind: "interaction" as const,
              event: {
                t: "requested" as const,
                requestId: "request-fixed",
                toolName: "Bash",
                display: { title: "Run command?", lines: ["pnpm test"] },
                issuedAt: "2026-07-23T00:00:00.000Z",
                ttlMs: 60_000,
                expiresAt: "2026-07-23T00:01:00.000Z",
              },
            },
          },
          {
            recordSeq: 3,
            payload: {
              kind: "interaction" as const,
              event: {
                t: "finished" as const,
                requestId: "request-fixed",
                outcome: "allowed" as const,
              },
            },
          },
        ];
      },
    };
    const meta = {
      turnOrigin: {
        channel: "rpc",
        triggeredBy: "surface:origin",
      },
    };

    const first = await projectAssignmentInteractionStream({
      assignmentId: "assignment-fixed",
      ledger,
      writer,
      meta,
    });
    expect(first.projected).toBe(2);
    expect(first.lastRecordSeq).toBe(3);
    expect(first.receipts).toHaveLength(2);
    expect(first.receipts.map((receipt) => receipt.sourceId)).toEqual([
      "interaction:2",
      "interaction:3",
    ]);
    await expect(projectAssignmentInteractionStream({
      assignmentId: "assignment-fixed",
      ledger,
      writer,
      meta,
      afterRecordSeq: first.lastRecordSeq,
    })).resolves.toMatchObject({ projected: 0, lastRecordSeq: 3, receipts: [] });

    await expect(projectAssignmentInteractionStream({
      assignmentId: "assignment-fixed",
      ledger,
      writer,
      meta,
    })).resolves.toMatchObject({ projected: 2, lastRecordSeq: 3 });
    expect((await spool.snapshot("assignment-fixed")).lastSeq).toBe(2);
  });
});
