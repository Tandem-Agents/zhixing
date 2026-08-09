import { describe, expect, it } from "vitest";
import { partitionPlannedAnchorPostInstall } from "./mesh-runtime-assembly.js";

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
