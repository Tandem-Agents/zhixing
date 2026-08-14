import { describe, expect, it, vi } from "vitest";
import {
  partitionPlannedAnchorPostInstall,
  resolveDeviceRemovalStatus,
} from "./mesh-runtime-assembly.js";

describe("planned anchor post-install consumer closure", () => {
  it("partitions every durable pending kind into exactly one fixed consumer", () => {
    const groups = partitionPlannedAnchorPostInstall([
      { kind: "assignment", id: "assignment-1" },
      { kind: "intent", id: "intent-1" },
      { kind: "interaction", id: "interaction-1" },
      { kind: "confirmation", id: "confirmation-1" },
      { kind: "final", id: "final-1" },
      { kind: "delivery", id: "delivery-1" },
    ]);

    expect(groups).toEqual({
      scheduler: [
        { kind: "assignment", id: "assignment-1" },
        { kind: "intent", id: "intent-1" },
      ],
      conversation: [
        { kind: "interaction", id: "interaction-1" },
        { kind: "confirmation", id: "confirmation-1" },
        { kind: "final", id: "final-1" },
      ],
      delivery: [{ kind: "delivery", id: "delivery-1" }],
    });
    expect(Object.isFrozen(groups)).toBe(true);
    expect(new Set([
      ...groups.scheduler,
      ...groups.conversation,
      ...groups.delivery,
    ].map(({ kind }) => kind))).toEqual(new Set([
      "assignment",
      "intent",
      "interaction",
      "confirmation",
      "final",
      "delivery",
    ]));
  });
});

describe("device removal status projection", () => {
  it("prefers the target state and falls back to the issuer when target status fails", async () => {
    const issuer = vi.fn(async () => removalState("needs-conversation-decision"));
    const target = vi.fn(async () => removalState("moving-conversations"));
    await expect(resolveDeviceRemovalStatus({
      targetStatus: target,
      issuerStatus: issuer,
    })).resolves.toEqual(removalState("moving-conversations"));
    expect(issuer).not.toHaveBeenCalled();

    target.mockRejectedValueOnce(new Error("target went offline"));
    await expect(resolveDeviceRemovalStatus({
      targetStatus: target,
      issuerStatus: issuer,
    })).resolves.toEqual(removalState("needs-conversation-decision"));
    expect(issuer).toHaveBeenCalledOnce();
  });
});

function removalState(phase: "needs-conversation-decision" | "moving-conversations") {
  return {
    phase,
    conversations: [],
    localData: "known" as const,
    credentialActions: [],
  };
}
