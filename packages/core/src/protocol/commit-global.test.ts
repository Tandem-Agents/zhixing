import { describe, expect, it } from "vitest";
import { validateGlobalStagedMutation } from "./commit.js";

describe("global staged mutation closed union", () => {
  it("accepts canonical surviving mutations", () => {
    for (const mutation of [
      { kind: "schedule-delete", taskId: "task-1", taskRevision: 3 },
      { kind: "workscene-delete", sceneId: "scene-1", expectedRevision: 4 },
    ]) {
      expect(() => validateGlobalStagedMutation(mutation as never)).not.toThrow();
    }
  });

  it("rejects unknown fields and every retired memory mutation discriminant", () => {
    expect(() => validateGlobalStagedMutation({
      kind: "schedule-delete",
      taskId: "task-1",
      taskRevision: 3,
      extra: true,
    } as never)).toThrow(/fields/u);

    for (const kind of [
      "memory-append",
      "memory-delete",
      "memory-journal-condense",
    ] as const) {
      expect(() => validateGlobalStagedMutation({ kind } as never)).toThrow(/closed union/u);
    }
  });
});
