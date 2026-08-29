import { describe, expect, it, vi } from "vitest";
import type {
  GlobalReadResult,
  GlobalStatePort,
} from "../contracts/index.js";
import {
  SkillCatalogApplicationError,
  SkillCatalogApplicationService,
  SkillCatalogSaveApplicationService,
  type SkillCatalogSaveCorrectnessPort,
  type SkillCatalogSaveMutation,
  type SkillCatalogSaveOverlayRecord,
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

describe("SkillCatalogSaveApplicationService", () => {
  it("owns scrubbing, canonical content, id derivation and staged create identity", async () => {
    const save = saveHarness();
    const result = await save.service.save({
      name: "Deploy sk-ABCDEFGHIJKLMNOPQRSTUV",
      description: "Use with token=abcdefghijklmnop",
      body: "Authorization: Bearer abcdefghijklmnop",
      mode: "main",
    }, "tool-call-1");

    expect(result).toMatchObject({ outcome: "created", scrubbedCount: 3 });
    expect(result.name).not.toContain("ABCDEFGHIJKLMNOPQRSTUV");
    expect(save.documents).toHaveLength(1);
    expect(save.documents[0]).not.toContain("abcdefghijklmnop");
    expect(save.documents[0]).toContain("name:");
    expect(save.documents[0]).toContain("description:");
    expect(save.staged).toEqual([{
      operationId: "tool-call-1:save",
      mutation: expect.objectContaining({
        kind: "skill-create",
        mode: "main",
        record: expect.objectContaining({ name: result.name }),
      }),
    }]);
    expect(save.events).toEqual(["read", "overlay", "artifact", "stage"]);
  });

  it("updates disabled or linked catalog entries and preserves expected revision", async () => {
    for (const source of ["own", "linked"] as const) {
      const save = saveHarness({
        entry: { ...entry, source, disabled: true, revision: 4 },
      });
      await expect(save.service.save({
        name: entry.name,
        description: "updated description",
        body: "updated body",
        mode: "work",
      }, `tool-${source}`)).resolves.toMatchObject({ outcome: "updated" });
      expect(save.staged[0]).toMatchObject({
        operationId: `tool-${source}:save`,
        mutation: {
          kind: "skill-update",
          skillId: entry.id,
          expectedRevision: 4,
          mode: "work",
        },
      });
    }
  });

  it("treats a builtin-only name as create and reads same-assignment overlay for the next update", async () => {
    const save = saveHarness({ updateOverlayOnStage: true });
    const draft = {
      name: "提炼技能",
      description: "用户定制版",
      body: "定制正文",
      mode: "main" as const,
    };
    await expect(save.service.save(draft, "first")).resolves.toMatchObject({
      outcome: "created",
    });
    await expect(save.service.save({ ...draft, body: "第二版" }, "second"))
      .resolves.toMatchObject({ outcome: "updated" });
    expect(save.staged.map(({ operationId, mutation }) => ({
      operationId,
      kind: mutation.kind,
      ...("expectedRevision" in mutation
        ? { expectedRevision: mutation.expectedRevision }
        : {}),
    }))).toEqual([
      { operationId: "first:save", kind: "skill-create" },
      { operationId: "second:save", kind: "skill-update", expectedRevision: 1 },
    ]);
  });

  it("rejects a normalized empty draft before artifact or stage", async () => {
    const save = saveHarness();
    await expect(save.service.save({
      name: '<>:"/\\|?*',
      description: "description",
      body: "body",
      mode: "main",
    }, "tool-invalid")).rejects.toThrow(
      "Skill name, description and body must remain non-empty",
    );
    expect(save.documents).toEqual([]);
    expect(save.staged).toEqual([]);
  });

  it("keeps artifact/stage failure and missing durable identity boundaries observable", async () => {
    const artifactFailure = new Error("artifact failed");
    const failedArtifact = saveHarness({ putError: artifactFailure });
    await expect(failedArtifact.service.save(cleanDraft(), "tool-artifact"))
      .rejects.toBe(artifactFailure);
    expect(failedArtifact.staged).toEqual([]);

    const stageFailure = new Error(
      "Staged mutation requestId has a conflicting payload",
    );
    const failedStage = saveHarness({ stageError: stageFailure });
    await expect(failedStage.service.save(cleanDraft(), "tool-stage"))
      .rejects.toBe(stageFailure);
    expect(failedStage.documents).toHaveLength(1);

    const missingIdentity = saveHarness();
    await expect(missingIdentity.service.save(cleanDraft())).rejects.toThrow(
      "Skill mutation requires a durable tool operation id",
    );
    expect(missingIdentity.documents).toHaveLength(1);
    expect(missingIdentity.staged).toEqual([]);
  });

  it("uses one stable staged payload when response loss retries before overlay visibility", async () => {
    const save = saveHarness();
    await save.service.save(cleanDraft(), "replay");
    await save.service.save(cleanDraft(), "replay");
    expect(save.staged).toHaveLength(2);
    expect(save.staged[0]).toEqual(save.staged[1]);
  });

  it("reconstructs the same create when its durable overlay is already visible", async () => {
    const save = saveHarness({ updateOverlayOnStage: true });
    const first = await save.service.save(cleanDraft(), "visible-replay");
    save.setCatalogEntry({
      ...entry,
      id: first.id,
      name: first.name,
      revision: 99,
    });
    const replay = await save.service.save(cleanDraft(), "visible-replay");
    expect(replay).toEqual(first);
    expect(save.staged).toHaveLength(2);
    expect(save.staged[1]).toEqual(save.staged[0]);
  });
});

function cleanDraft() {
  return {
    name: "Deploy",
    description: "Deploy safely",
    body: "Build and release.",
    mode: "main" as const,
  };
}

function saveHarness(input: {
  readonly entry?: SkillCatalogEntry | null;
  readonly overlay?: SkillCatalogSaveOverlayRecord[];
  readonly putError?: Error;
  readonly stageError?: Error;
  readonly updateOverlayOnStage?: boolean;
} = {}) {
  const documents: string[] = [];
  const staged: Array<{
    operationId: string;
    mutation: SkillCatalogSaveMutation;
  }> = [];
  const overlay = input.overlay ?? [];
  let catalogEntry = input.entry ?? null;
  const events: string[] = [];
  const correctness: SkillCatalogSaveCorrectnessPort = {
    async readCatalogEntry() {
      events.push("read");
      return catalogEntry;
    },
    async readOverlay() {
      events.push("overlay");
      return overlay;
    },
    requestIdentityFor(operationId) {
      return `request:${operationId}`;
    },
    async putContent(document) {
      events.push("artifact");
      documents.push(document);
      if (input.putError) throw input.putError;
      return {
        digest: "a".repeat(64),
        bytes: Buffer.byteLength(document),
      };
    },
    async stage(operationId, mutation) {
      events.push("stage");
      if (input.stageError) throw input.stageError;
      staged.push({ operationId, mutation });
      if (input.updateOverlayOnStage) {
        overlay.push({
          recordSeq: overlay.length + 1,
          requestIdentity: `request:${operationId}`,
          mutation,
          mutationDigest: `${String(overlay.length + 1).padStart(64, "b")}`,
        });
      }
    },
    assignmentIssuedAt: () => "2026-08-29T00:00:00.000Z",
  };
  return {
    service: new SkillCatalogSaveApplicationService(correctness),
    documents,
    staged,
    events,
    setCatalogEntry(value: SkillCatalogEntry | null) {
      catalogEntry = value;
    },
  };
}
