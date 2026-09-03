import { describe, expect, it, vi } from "vitest";
import type { GlobalReadResult, GlobalStatePort } from "../contracts/index.js";
import type { SkillCatalogEntry } from "./catalog-application.js";
import { createAnchorSkillCatalogManagementCorrectnessPort } from "./catalog-management-correctness.js";
import { SkillMutationConflictError } from "./global-state-adapter.js";

const entry: SkillCatalogEntry = {
  id: "alpha",
  name: "Alpha",
  description: "alpha skill",
  source: "own",
  mode: "main",
  pinned: false,
  disabled: false,
  createdAt: "2026-08-29T00:00:00.000Z",
  usage: null,
  contentRef: {
    digest: "a".repeat(64),
    size: 1,
    mediaType: "text/markdown",
  },
  revision: 4,
  digest: "b".repeat(64),
};

describe("Anchor Skill Catalog management Correctness", () => {
  it("resolves the current state and topology fence independently for every call", async () => {
    const first = stateHarness();
    const second = stateHarness();
    let state = first.state;
    let anchorEpoch = 3;
    const correctness = createAnchorSkillCatalogManagementCorrectnessPort({
      globalState: () => state,
      anchorEpoch: () => anchorEpoch,
      requestId: () => "request",
      now: () => new Date("2026-08-29T00:00:00.000Z"),
    });

    await expect(correctness.readCatalog({ includeDisabled: true })).resolves.toEqual({
      entries: [entry],
      catalogRevision: 7,
    });
    state = second.state;
    anchorEpoch = 4;
    await expect(correctness.readEntry("alpha")).resolves.toEqual(entry);

    expect(first.read).toHaveBeenCalledWith(
      { kind: "skill-catalog", includeDisabled: true },
      {
        principal: { kind: "host", component: "skill-catalog-application" },
        requestId: "skill-list:request",
        deadlineAt: "2026-08-29T00:00:30.000Z",
        authority: { domain: "global", anchorEpoch: 3 },
      },
    );
    expect(second.read).toHaveBeenCalledWith(
      { kind: "skill-get", skillId: "alpha" },
      expect.objectContaining({
        requestId: "skill-get:request",
        authority: { domain: "global", anchorEpoch: 4 },
      }),
    );
    expect(first.read).toHaveBeenCalledTimes(1);
    expect(second.read).toHaveBeenCalledTimes(1);
  });

  it("maps finite domain mutations and preserves commit/conflict/failure boundaries", async () => {
    const harness = stateHarness();
    const correctness = createAnchorSkillCatalogManagementCorrectnessPort({
      globalState: harness.state,
      anchorEpoch: 9,
      requestId: () => "commit",
      now: () => new Date("2026-08-29T00:00:00.000Z"),
    });

    await expect(correctness.commit({
      kind: "set-state",
      skillId: "alpha",
      patch: { disabled: true },
      expectedRevision: 4,
    })).resolves.toEqual({ kind: "committed", catalogRevision: 8 });
    expect(harness.mutate).toHaveBeenCalledWith(
      {
        kind: "skill-set-state",
        skillId: "alpha",
        patch: { disabled: true },
        expectedRevision: 4,
      },
      expect.objectContaining({
        requestId: "skill-set-state:commit",
        authority: { domain: "global", anchorEpoch: 9 },
      }),
    );

    harness.mutate.mockRejectedValueOnce(new SkillMutationConflictError({
      code: "revision-conflict",
      message: "Skill changed",
      retryable: false,
    }));
    await expect(correctness.commit({
      kind: "archive",
      skillId: "alpha",
      expectedRevision: 4,
    })).resolves.toEqual({ kind: "conflict", message: "Skill changed" });

    const unavailable = new Error("authority unavailable");
    harness.mutate.mockRejectedValueOnce(unavailable);
    await expect(correctness.commit({
      kind: "archive",
      skillId: "alpha",
      expectedRevision: 4,
    })).rejects.toBe(unavailable);
  });

  it("fails closed when the global reader returns another result family", async () => {
    const harness = stateHarness();
    harness.read.mockResolvedValueOnce({ kind: "schedule-list", tasks: [] });
    const correctness = createAnchorSkillCatalogManagementCorrectnessPort({
      globalState: harness.state,
      anchorEpoch: 1,
    });

    await expect(correctness.readCatalog({ includeDisabled: true })).rejects.toThrow(
      "Skill catalog returned another result type",
    );
  });
});

function stateHarness() {
  const read = vi.fn(async (query: { kind: string }): Promise<GlobalReadResult> =>
    query.kind === "skill-get"
      ? { kind: "skill-get", catalogRevision: 7, entry }
      : { kind: "skill-catalog", catalogRevision: 7, entries: [entry] });
  const mutate = vi.fn(async () => ({ revision: 5, catalogRevision: 8 }));
  return {
    read,
    mutate,
    state: { read, mutate } as unknown as GlobalStatePort,
  };
}
