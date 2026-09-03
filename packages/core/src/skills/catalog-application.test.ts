import { describe, expect, it, vi } from "vitest";
import {
  SkillCatalogApplicationError,
  SkillCatalogApplicationService,
  SkillCatalogKernelProjectionApplicationService,
  SkillCatalogLoadApplicationService,
  SkillCatalogSaveApplicationService,
  type SkillCatalogLoadCorrectnessPort,
  type SkillCatalogManagementCommitResult,
  type SkillCatalogUsageMutation,
  type SkillCatalogSaveCorrectnessPort,
  type SkillCatalogSaveMutation,
  type SkillCatalogSaveOverlayRecord,
} from "./catalog-application.js";
import { builtinIndexEntries } from "./builtin.js";
import { skillNameToId } from "./id.js";
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
  readonly commitResult?: SkillCatalogManagementCommitResult;
  readonly commitError?: Error;
}) {
  const readCatalog = vi.fn(async () => ({
    catalogRevision: 7,
    entries: [entry],
  }));
  const readEntry = vi.fn(async () => input?.missing ? null : entry);
  const commit = vi.fn(async () => {
    if (input?.commitError) throw input.commitError;
    return input?.commitResult ?? {
      kind: "committed" as const,
      catalogRevision: 7,
    };
  });
  const service = new SkillCatalogApplicationService({
    readCatalog,
    readEntry,
    commit,
  });
  return { service, readCatalog, readEntry, commit };
}

describe("SkillCatalogApplicationService", () => {
  it("owns the include-disabled management query and stable projection", async () => {
    const { service, readCatalog } = harness();

    await expect(service.query({ kind: "list" })).resolves.toEqual({
      entries: [entry],
      catalogRevision: 7,
    });
    expect(readCatalog).toHaveBeenCalledWith({ includeDisabled: true });
  });

  it("derives expected revision and forms one fact from the exact committed catalog revision", async () => {
    const { service, commit, readEntry } = harness({
      commitResult: { kind: "committed", catalogRevision: 8 },
    });

    await expect(service.execute({
      kind: "set-state",
      skillId: "alpha",
      patch: { mode: "work", pinned: true },
    })).resolves.toEqual({
      fact: { kind: "skill-catalog-changed", catalogRevision: 8 },
    });
    expect(commit).toHaveBeenCalledWith({
      kind: "set-state",
      skillId: "alpha",
      patch: { mode: "work", pinned: true },
      expectedRevision: 4,
    });
    expect(readEntry).toHaveBeenCalledWith("alpha");
  });

  it("keeps not-found and invalid patches inside the Skill application contract", async () => {
    const missing = harness({ missing: true });
    await expect(missing.service.execute({
      kind: "archive",
      skillId: "ghost",
    })).rejects.toMatchObject({
      code: "not-found",
    } satisfies Partial<SkillCatalogApplicationError>);
    expect(missing.commit).not.toHaveBeenCalled();

    const invalid = harness();
    await expect(invalid.service.execute({
      kind: "set-state",
      skillId: "alpha",
      patch: {},
    })).rejects.toMatchObject({ code: "invalid-command" });
    expect(invalid.readEntry).not.toHaveBeenCalled();
    expect(invalid.commit).not.toHaveBeenCalled();
  });

  it("does not return a fact for authority conflict or commit failure", async () => {
    const conflict = harness({
      commitResult: { kind: "conflict", message: "Skill changed" },
    });
    await expect(conflict.service.execute({
      kind: "archive",
      skillId: "alpha",
    })).rejects.toMatchObject({ code: "conflict" });

    const commitFailure = new Error("commit unavailable");
    const failedCommit = harness({ commitError: commitFailure });
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

describe("SkillCatalogLoadApplicationService", () => {
  it("loads builtin instructions without an assignment and never writes usage", async () => {
    const load = loadHarness({ scope: "builtin-only" });

    await expect(load.service.load({ id: skillNameToId("提炼技能") }))
      .resolves.toMatchObject({ name: "提炼技能" });
    expect(load.readContents).toEqual([]);
    expect(load.staged).toEqual([]);

    await expect(load.service.load({ id: "user-or-unknown" })).rejects.toThrow(
      "User skills require an active artifact-backed assignment",
    );
    expect(load.readContents).toEqual([]);
    expect(load.staged).toEqual([]);
  });

  it("lets an artifact-backed user entry shadow the builtin and records usage after parsing", async () => {
    const user = {
      ...entry,
      id: skillNameToId("提炼技能"),
      name: "用户提炼技能",
      disabled: true,
    };
    const load = loadHarness({ entry: user });

    await expect(load.service.load({
      id: user.id,
      operationId: "tool-load",
    })).resolves.toEqual({
      id: user.id,
      name: user.name,
      body: "User body",
    });
    expect(load.events).toEqual(["assignment", "content", "stage"]);
    expect(load.staged).toEqual([{
      operationId: "tool-load:usage",
      mutation: {
        kind: "skill-usage",
        record: {
          skillId: user.id,
          occurredAt: "2026-08-29T00:00:00.000Z",
          hitDelta: 1,
        },
      },
    }]);
  });

  it("folds same-assignment create/admit/update overlay before reading content", async () => {
    const id = skillNameToId("Overlay Skill");
    const record = {
      name: "Overlay Skill",
      description: "overlay",
      content: { digest: "d".repeat(64), bytes: 42 },
    };
    for (const mutation of [
      { kind: "skill-create" as const, mode: "work" as const, record },
      { kind: "skill-admit" as const, mode: "work" as const, record },
      {
        kind: "skill-update" as const,
        skillId: id,
        expectedRevision: 1,
        mode: "work" as const,
        record,
      },
    ]) {
      const load = loadHarness({
        overlay: [{
          recordSeq: 1,
          requestIdentity: mutation.kind,
          mutationDigest: "c".repeat(64),
          mutation,
        }],
      });

      await expect(load.service.load({ id, operationId: `load-${mutation.kind}` }))
        .resolves.toMatchObject({ id, name: "Overlay Skill", body: "User body" });
      expect(load.readContents).toEqual(["d".repeat(64)]);
      expect(load.staged[0]).toMatchObject({
        operationId: `load-${mutation.kind}:usage`,
        mutation: { record: { skillId: id } },
      });
    }
  });

  it("keeps unknown and artifact/operation/stage failures observable without false success", async () => {
    const unknown = loadHarness();
    await expect(unknown.service.load({ id: "unknown", operationId: "missing" }))
      .rejects.toThrow("Skill not found: unknown");
    expect(unknown.staged).toEqual([]);

    const artifactError = new Error("artifact unavailable");
    const failedArtifact = loadHarness({ entry, readError: artifactError });
    await expect(failedArtifact.service.load({ id: entry.id, operationId: "artifact" }))
      .rejects.toBe(artifactError);
    expect(failedArtifact.staged).toEqual([]);

    const missingOperation = loadHarness({ entry });
    await expect(missingOperation.service.load({ id: entry.id })).rejects.toThrow(
      "Skill mutation requires a durable tool operation id",
    );
    expect(missingOperation.staged).toEqual([]);

    const stageError = new Error("usage conflict");
    const failedStage = loadHarness({ entry, stageError });
    await expect(failedStage.service.load({ id: entry.id, operationId: "stage" }))
      .rejects.toBe(stageError);
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

function loadHarness(input: {
  readonly scope?: "builtin-only";
  readonly entry?: SkillCatalogEntry | null;
  readonly overlay?: SkillCatalogSaveOverlayRecord[];
  readonly readError?: Error;
  readonly stageError?: Error;
} = {}) {
  const events: string[] = [];
  const readContents: string[] = [];
  const staged: Array<{
    operationId: string;
    mutation: SkillCatalogUsageMutation;
  }> = [];
  const correctness: SkillCatalogLoadCorrectnessPort = {
    async readScope() {
      events.push("assignment");
      if (input.scope === "builtin-only") return { kind: "builtin-only" };
      return {
        kind: "assignment",
        entry: input.entry ?? null,
        overlay: input.overlay ?? [],
        issuedAt: "2026-08-29T00:00:00.000Z",
      };
    },
    async readContent(content) {
      events.push("content");
      readContents.push(content.digest);
      if (input.readError) throw input.readError;
      return "---\nname: User\ndescription: user\n---\nUser body";
    },
    async stageUsage(operationId, mutation) {
      events.push("stage");
      if (input.stageError) throw input.stageError;
      staged.push({ operationId, mutation });
    },
  };
  return {
    service: new SkillCatalogLoadApplicationService(correctness),
    events,
    readContents,
    staged,
  };
}

describe("SkillCatalogKernelProjectionApplicationService", () => {
  const header =
    "## Available Skills\n" +
    "To use a skill, call the `load_skill` tool with the id shown below. Descriptions are brief — load one for full instructions.";
  const source = (
    entries: readonly SkillCatalogEntry[],
    catalogRevision = 7,
  ) => ({
    readCatalog: vi.fn(async () => ({ catalogRevision, entries })),
  });
  const projectionEntry = (
    id: string,
    overrides: Partial<SkillCatalogEntry> = {},
  ): SkillCatalogEntry => ({
    ...entry,
    id,
    name: id,
    description: `description-${id}`,
    disabled: false,
    ...overrides,
  });
  const shadowAllBuiltins = (mode: "main" | "work") =>
    builtinIndexEntries(mode, new Set()).map((builtin) =>
      projectionEntry(builtin.id, {
        description: `disabled-${builtin.id}`,
        mode,
        disabled: true,
      })
    );

  it("produces one frozen builtin-only projection without exposing catalog entries", async () => {
    const result = await new SkillCatalogKernelProjectionApplicationService()
      .project("main");

    expect(result.catalogRevision).toBe(-1);
    expect(result.content).toContain("## Available Skills");
    expect(result.content).toContain(skillNameToId("提炼技能"));
    expect(Object.keys(result)).toEqual(["catalogRevision", "content"]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("owns mode filtering, disabled shadowing and exact rendered bytes", async () => {
    const input = source([
      projectionEntry("alpha", {
        description: "Alpha instructions",
        pinned: true,
      }),
      projectionEntry("work-only", {
        description: "Work instructions",
        mode: "work",
      }),
      ...shadowAllBuiltins("main"),
    ], 11);
    const result = await new SkillCatalogKernelProjectionApplicationService(input)
      .project("main");

    expect(input.readCatalog).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      catalogRevision: 11,
      content: `${header}\n- ★ **alpha**: Alpha instructions`,
    });
    expect(result.content).not.toContain("work-only");
    expect(result.content).not.toContain(skillNameToId("提炼技能"));
  });

  it("keeps authority order, reserves top twenty for users, then appends builtins", async () => {
    const users = Array.from({ length: 22 }, (_, index) =>
      projectionEntry(`user-${String(index).padStart(2, "0")}`)
    );
    const result = await new SkillCatalogKernelProjectionApplicationService(
      source(users, 12),
    ).project("main");

    expect(result.content).toContain("**user-00**");
    expect(result.content).toContain("**user-19**");
    expect(result.content).not.toContain("**user-20**");
    expect(result.content!.indexOf("**user-00**")).toBeLessThan(
      result.content!.indexOf("**user-19**"),
    );
    expect(result.content!.indexOf("**user-19**")).toBeLessThan(
      result.content!.indexOf(`**${skillNameToId("提炼技能")}**`),
    );
  });

  it("keeps an empty user catalog byte-equal to the builtin-only projection", async () => {
    const builtinOnly = await new SkillCatalogKernelProjectionApplicationService()
      .project("work");
    const catalog = await new SkillCatalogKernelProjectionApplicationService(
      source([], 13),
    ).project("work");

    expect(catalog.catalogRevision).toBe(13);
    expect(catalog.content).toBe(builtinOnly.content);
  });
});
