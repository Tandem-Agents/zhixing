import { describe, expect, it, vi } from "vitest";
import type {
  GlobalReadResult,
  GlobalStatePort,
} from "../contracts/index.js";
import {
  SkillCatalogApplicationError,
  SkillCatalogApplicationService,
} from "./catalog-application.js";
import { SkillMutationConflictError } from "./global-state-adapter.js";
import type { SkillCatalogEntry } from "./types.js";

const entry: SkillCatalogEntry = {
  id: "alpha",
  name: "Alpha",
  description: "alpha skill",
  source: "own",
  mode: "main",
  pinned: false,
  disabled: true,
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

function harness(input?: {
  readonly missing?: boolean;
  readonly mutationError?: Error;
}) {
  const read = vi.fn(async (query: { kind: string }): Promise<GlobalReadResult> => {
    if (query.kind === "skill-get") {
      return {
        kind: "skill-get",
        catalogRevision: 7,
        entry: input?.missing ? null : entry,
      };
    }
    return {
      kind: "skill-catalog",
      catalogRevision: 7,
      entries: [entry],
    };
  });
  const mutate = vi.fn(async () => {
    if (input?.mutationError) throw input.mutationError;
    return { revision: 5, catalogRevision: 8 };
  });
  const service = new SkillCatalogApplicationService({
    globalState: { read, mutate } as unknown as GlobalStatePort,
    anchorEpoch: 3,
    requestId: () => "request",
    now: () => new Date("2026-08-29T00:00:00.000Z"),
  });
  return { service, read, mutate };
}

describe("SkillCatalogApplicationService", () => {
  it("owns the include-disabled management query and stable projection", async () => {
    const { service, read } = harness();

    await expect(service.query({ kind: "list" })).resolves.toEqual({
      entries: [entry],
      catalogRevision: 7,
    });
    expect(read).toHaveBeenCalledWith(
      { kind: "skill-catalog", includeDisabled: true },
      expect.objectContaining({
        principal: { kind: "host", component: "skill-catalog-application" },
        authority: { domain: "global", anchorEpoch: 3 },
      }),
    );
  });

  it("derives expected revision and forms one fact from the exact committed catalog revision", async () => {
    const { service, mutate, read } = harness();

    await expect(service.execute({
      kind: "set-state",
      skillId: "alpha",
      patch: { mode: "work", pinned: true },
    })).resolves.toEqual({
      fact: { kind: "skill-catalog-changed", catalogRevision: 8 },
    });
    expect(mutate).toHaveBeenCalledWith(
      {
        kind: "skill-set-state",
        skillId: "alpha",
        patch: { mode: "work", pinned: true },
        expectedRevision: 4,
      },
      expect.any(Object),
    );
    expect(read.mock.calls.map(([query]) => query.kind)).toEqual(["skill-get"]);
  });

  it("keeps not-found and invalid patches inside the Skill application contract", async () => {
    const missing = harness({ missing: true });
    await expect(missing.service.execute({
      kind: "archive",
      skillId: "ghost",
    })).rejects.toMatchObject({
      code: "not-found",
    } satisfies Partial<SkillCatalogApplicationError>);
    expect(missing.mutate).not.toHaveBeenCalled();

    const invalid = harness();
    await expect(invalid.service.execute({
      kind: "set-state",
      skillId: "alpha",
      patch: {},
    })).rejects.toMatchObject({ code: "invalid-command" });
    expect(invalid.read).not.toHaveBeenCalled();
    expect(invalid.mutate).not.toHaveBeenCalled();
  });

  it("does not return a fact for authority conflict or commit failure", async () => {
    const conflict = harness({
      mutationError: new SkillMutationConflictError({
        code: "revision-conflict",
        message: "Skill changed",
        retryable: false,
      }),
    });
    await expect(conflict.service.execute({
      kind: "archive",
      skillId: "alpha",
    })).rejects.toMatchObject({ code: "conflict" });

    const commitFailure = new Error("commit unavailable");
    const failedCommit = harness({ mutationError: commitFailure });
    await expect(failedCommit.service.execute({
      kind: "archive",
      skillId: "alpha",
    })).rejects.toBe(commitFailure);
  });
});
