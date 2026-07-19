import { describe, expect, it } from "vitest";
import { StreamDigestChain } from "./stream.js";

describe("StreamDigestChain", () => {
  it("uses the frozen empty-stream seed and reserves the final sequence", () => {
    const chain = new StreamDigestChain("assignment-fixed");

    expect(chain.final()).toEqual({
      finalSeq: 1,
      streamDigest: "sha256:e8d2a430008d77c3f5d9636a262d0813edb3781a57a9a4513481ee5f2a78be68",
    });
  });

  it("hashes the actual wrapped payload, sequence and metadata", () => {
    const chain = new StreamDigestChain("assignment-fixed");
    expect(
      chain.append(
        { kind: "agent-yield", yield: { type: "text_delta", text: "hi" } },
        {},
      ),
    ).toBe(1);
    expect(
      chain.append(
        {
          kind: "agent-event",
          event: {
            event: "agent:run_start",
            payload: { runId: "run-fixed", timestamp: 1 },
          },
        },
        { lineage: "main" },
      ),
    ).toBe(2);

    expect(chain.final()).toEqual({
      finalSeq: 3,
      streamDigest: "sha256:9538c65d69de8b3c503a229623ce8dd2b0dfec24b56e68c92ce39c7cb6e49b89",
    });
  });
});
