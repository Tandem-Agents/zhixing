import { Buffer } from "node:buffer";
import { canonicalize } from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import { describe, expect, it } from "vitest";
import { JobInteractionMeshClient } from "./job-interaction-mesh.js";

describe("JobInteractionMeshClient", () => {
  it("rejects a retry response bound to another request", async () => {
    const client = {
      request: async () =>
        Buffer.from(
          canonicalize({
            v: 1,
            t: "runtime-unavailable",
            assignmentId: "assignment-other",
            requestId: "request-other",
          }),
          "utf8",
        ),
    } as unknown as MeshServiceClient;
    const interactions = new JobInteractionMeshClient(client);

    await expect(
      interactions.resolveNoInteractiveSurface({
        assignmentId: "assignment-a",
        requestId: "request-a",
      }),
    ).rejects.toThrow("does not bind the request");
  });
});
