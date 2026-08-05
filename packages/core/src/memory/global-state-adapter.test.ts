import path from "node:path";
import { mkdir, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { FileArtifactStore, FileAuthorityCommitLog } from "../authority/index.js";
import type {
  GlobalControlCallContext,
  GlobalReadCallContext,
  GlobalStagedMutation,
} from "../contracts/index.js";
import { MemoryStore } from "./memory-store.js";
import { AnchorMemoryGlobalStateAdapter } from "./global-state-adapter.js";
import { stringifyFrontmatter } from "./frontmatter.js";
import { projectMemoryLogicalEntry } from "./logical-entry.js";
import type { MemoryScopeRef } from "./contracts.js";

const NOW = "2026-08-04T00:00:00.000Z";

describe("AnchorMemoryGlobalStateAdapter", () => {
  it("takes over every declared legacy scope once and preserves all three memory domains", async () => {
    const fixture = await createFixture();
    const worksceneStore = new MemoryStore(fixture.worksceneRoot("scene-a"));
    await fixture.store.save({
      category: "profile",
      id: "profile",
      meta: { name: "Alice" },
      content: "personal profile",
    });
    await fixture.store.save({
      category: "person",
      id: "bob",
      meta: { name: "Bob", relation: "friend" },
      content: "personal person",
    });
    await fixture.store.save({
      category: "journal",
      id: "2026-08-03",
      meta: { date: "2026-08-03" },
      content: "personal journal",
    });
    await worksceneStore.save({
      category: "profile",
      id: "profile",
      meta: { name: "Scene" },
      content: "workscene profile",
    });
    await worksceneStore.save({
      category: "person",
      id: "carol",
      meta: { name: "Carol", relation: "teammate" },
      content: "workscene person",
    });
    await worksceneStore.save({
      category: "journal",
      id: "2026-08-02",
      meta: { date: "2026-08-02" },
      content: "workscene journal",
    });

    await fixture.adapter.initializeStagedPublishing([
      { kind: "personal" },
      { kind: "workscene", sceneId: "scene-a" },
    ]);

    await expect(
      readEntries(fixture.adapter, { kind: "personal" }, "memory"),
    ).resolves.toMatchObject([{ id: "profile", content: "personal profile" }]);
    await expect(
      readEntries(fixture.adapter, { kind: "personal" }, "people"),
    ).resolves.toMatchObject([{ id: "bob", content: "personal person" }]);
    await expect(
      readEntries(fixture.adapter, { kind: "personal" }, "journal"),
    ).resolves.toMatchObject([{ id: "2026-08-03", content: "personal journal" }]);
    await expect(
      readEntries(
        fixture.adapter,
        { kind: "workscene", sceneId: "scene-a" },
        "memory",
      ),
    ).resolves.toMatchObject([{ id: "profile", content: "workscene profile" }]);
    await expect(
      readEntries(
        fixture.adapter,
        { kind: "workscene", sceneId: "scene-a" },
        "people",
      ),
    ).resolves.toMatchObject([{ id: "carol", content: "workscene person" }]);
    await expect(
      readEntries(
        fixture.adapter,
        { kind: "workscene", sceneId: "scene-a" },
        "journal",
      ),
    ).resolves.toMatchObject([{ id: "2026-08-02", content: "workscene journal" }]);

    const records = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
    expect(records.filter((record) => record.body.t === "memory-legacy-cutover-started"))
      .toHaveLength(1);
    expect(records.filter((record) => record.body.t === "memory-legacy-cutover")).toHaveLength(1);
    expect(records.filter((record) => record.body.t === "memory-mutation-applied"))
      .toHaveLength(6);
  });

  it("keeps the cutover authoritative across restart so deleted or late legacy files cannot revive", async () => {
    const fixture = await createFixture();
    await fixture.store.save({
      category: "person",
      id: "bob",
      meta: { name: "Bob", relation: "friend" },
      content: "legacy",
    });
    await fixture.adapter.initializeStagedPublishing();
    const imported = await readEntries(
      fixture.adapter,
      { kind: "personal" },
      "people",
    );
    const bob = imported[0];
    if (!bob) throw new Error("legacy person was not imported");
    await fixture.adapter.mutate(
      {
        kind: "memory-delete",
        scope: { kind: "personal" },
        domain: "people",
        id: "bob",
        expectedDigest: bob.digest,
      },
      controlContext("delete-imported"),
    );

    await fixture.store.save({
      category: "person",
      id: "bob",
      meta: { name: "Bob", relation: "friend" },
      content: "stale legacy resurrection",
    });
    await fixture.store.save({
      category: "person",
      id: "late",
      meta: { name: "Late", relation: "unknown" },
      content: "created after cutover",
    });
    const reopened = new AnchorMemoryGlobalStateAdapter({
      log: fixture.log,
      anchorEpoch: 1,
      scopeRoot: fixture.scopeRoot,
      clock: () => NOW,
    });
    await reopened.initializeStagedPublishing();

    await expect(
      readEntries(reopened, { kind: "personal" }, "people"),
    ).resolves.toEqual([]);
  });

  it("resumes a partially acknowledged legacy import without duplicating authority facts", async () => {
    const fixture = await createFixture();
    await fixture.store.save({
      category: "person",
      id: "alice",
      meta: { name: "Alice", relation: "friend" },
      content: "committed before the response was lost",
    });
    await fixture.store.save({
      category: "person",
      id: "bob",
      meta: { name: "Bob", relation: "friend" },
      content: "not imported yet",
    });

    const transact = fixture.log.transactDurableProjection.bind(fixture.log);
    let lost = false;
    const spy = vi.spyOn(fixture.log, "transactDurableProjection").mockImplementation(
      async (...args: Parameters<typeof transact>) => {
        const result = await transact(...args);
        const imports = (await fixture.log.readAll())
          .flatMap((commit) => commit.entries)
          .filter((entry) =>
            entry.body.t === "memory-mutation-applied" &&
            String(entry.body.requestId).startsWith("memory-legacy-import:")
          );
        if (!lost && imports.length === 1) {
          lost = true;
          throw new Error("legacy import response lost");
        }
        return result;
      },
    );
    await expect(fixture.adapter.initializeStagedPublishing()).rejects.toThrow(
      "legacy import response lost",
    );
    spy.mockRestore();
    const reopened = new AnchorMemoryGlobalStateAdapter({
      log: fixture.log,
      anchorEpoch: 1,
      scopeRoot: fixture.scopeRoot,
      clock: () => NOW,
    });

    await reopened.initializeStagedPublishing();

    await expect(
      readEntries(reopened, { kind: "personal" }, "people"),
    ).resolves.toMatchObject([
      { id: "alice", revision: 1 },
      { id: "bob", revision: 1 },
    ]);
    const records = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
    expect(records.filter((record) => record.body.t === "memory-mutation-applied"))
      .toHaveLength(2);
    expect(records.filter((record) => record.body.t === "memory-legacy-cutover-started"))
      .toHaveLength(1);
    expect(records.filter((record) => record.body.t === "memory-legacy-cutover"))
      .toHaveLength(1);
  });

  it("maps nested legacy identities deterministically and aggregates journal collisions", async () => {
    const fixture = await createFixture();
    const peopleRoot = path.join(fixture.root, "memory", "people", "team");
    const journalRoot = path.join(fixture.root, "memory", "journal", "archive");
    await mkdir(peopleRoot, { recursive: true });
    await mkdir(journalRoot, { recursive: true });
    await writeFile(
      path.join(peopleRoot, "Alice.md"),
      stringifyFrontmatter(
        { name: "Alice", relation: "teammate" },
        "nested person",
      ),
      "utf-8",
    );
    await writeFile(
      path.join(journalRoot, "first.md"),
      stringifyFrontmatter({ date: "2026-07-01" }, "first source"),
      "utf-8",
    );
    await writeFile(
      path.join(journalRoot, "second.md"),
      stringifyFrontmatter({ date: "2026-07-01" }, "second source"),
      "utf-8",
    );

    await fixture.adapter.initializeStagedPublishing();

    const people = await readEntries(
      fixture.adapter,
      { kind: "personal" },
      "people",
    );
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      id: expect.stringMatching(/^legacy-[a-f0-9]{40}$/u),
      content: "nested person",
      meta: {
        name: "Alice",
        relation: "teammate",
        legacySourceManifest: expect.stringContaining('"originalId":"team/Alice"'),
      },
    });
    const journal = await readEntries(
      fixture.adapter,
      { kind: "personal" },
      "journal",
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({
      id: "2026-07-01",
      content: "first source\n\n---\n\nsecond source",
      meta: {
        legacySourceManifest: expect.stringMatching(
          /"originalId":"archive\/first".*"originalId":"archive\/second"/u,
        ),
      },
    });
  });

  it("freezes file mtime as the fallback identity for a legacy journal without a date", async () => {
    const fixture = await createFixture();
    const journalRoot = path.join(fixture.root, "memory", "journal", "archive");
    const source = path.join(journalRoot, "undated.md");
    await mkdir(journalRoot, { recursive: true });
    await writeFile(source, stringifyFrontmatter({}, "legacy note"), "utf-8");
    await utimes(
      source,
      new Date("2026-06-15T12:00:00.000Z"),
      new Date("2026-06-15T12:00:00.000Z"),
    );

    await fixture.adapter.initializeStagedPublishing();

    await expect(
      readEntries(fixture.adapter, { kind: "personal" }, "journal"),
    ).resolves.toMatchObject([{
      id: "2026-06-15",
      content: "legacy note",
      meta: {
        legacySourceManifest: expect.stringContaining('"originalId":"archive/undated"'),
      },
    }]);
  });

  it("fails closed when a frozen physical source set changes before terminal cutover", async () => {
    const fixture = await createFixture();
    for (const id of ["alice", "bob"]) {
      await fixture.store.save({
        category: "person",
        id,
        meta: { name: id, relation: "friend" },
        content: id,
      });
    }
    const transact = fixture.log.transactDurableProjection.bind(fixture.log);
    let lost = false;
    const spy = vi.spyOn(fixture.log, "transactDurableProjection").mockImplementation(
      async (...args: Parameters<typeof transact>) => {
        const result = await transact(...args);
        const imports = (await fixture.log.readAll())
          .flatMap((commit) => commit.entries)
          .filter((entry) => entry.body.t === "memory-mutation-applied");
        if (!lost && imports.length === 1) {
          lost = true;
          throw new Error("response lost after import");
        }
        return result;
      },
    );
    await expect(fixture.adapter.initializeStagedPublishing()).rejects.toThrow(
      "response lost after import",
    );
    spy.mockRestore();
    await unlink(path.join(fixture.root, "memory", "people", "bob.md"));
    const reopened = new AnchorMemoryGlobalStateAdapter({
      log: fixture.log,
      anchorEpoch: 1,
      scopeRoot: fixture.scopeRoot,
      clock: () => NOW,
    });

    await expect(reopened.initializeStagedPublishing()).rejects.toThrow(
      "Legacy memory sources changed after cutover started",
    );
    const records = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
    expect(records.some((entry) => entry.body.t === "memory-legacy-cutover"))
      .toBe(false);
  });

  it.each([
    "memory-legacy-cutover-started",
    "memory-legacy-cutover",
  ] as const)("replays the same cutover generation when the %s response is lost", async (type) => {
    const fixture = await createFixture();
    await fixture.store.save({
      category: "person",
      id: "alice",
      meta: { name: "Alice", relation: "friend" },
      content: "legacy person",
    });
    const transact = fixture.log.transactDurableProjection.bind(fixture.log);
    let lost = false;
    const spy = vi.spyOn(fixture.log, "transactDurableProjection").mockImplementation(
      async (...args: Parameters<typeof transact>) => {
        const result = await transact(...args);
        const records = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
        if (!lost && records.some((entry) => entry.body.t === type)) {
          lost = true;
          throw new Error(`${type} response lost`);
        }
        return result;
      },
    );
    await expect(fixture.adapter.initializeStagedPublishing()).rejects.toThrow(
      `${type} response lost`,
    );
    spy.mockRestore();
    const reopened = new AnchorMemoryGlobalStateAdapter({
      log: fixture.log,
      anchorEpoch: 1,
      scopeRoot: fixture.scopeRoot,
      clock: () => NOW,
    });

    await reopened.initializeStagedPublishing();

    const records = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
    expect(records.filter((entry) => entry.body.t === "memory-legacy-cutover-started"))
      .toHaveLength(1);
    expect(records.filter((entry) => entry.body.t === "memory-mutation-applied"))
      .toHaveLength(1);
    expect(records.filter((entry) => entry.body.t === "memory-legacy-cutover"))
      .toHaveLength(1);
  });

  it("does not follow links found below a legacy owned root", async () => {
    const fixture = await createFixture();
    const outside = path.join(fixture.root, "outside");
    const people = path.join(fixture.root, "memory", "people");
    await mkdir(outside, { recursive: true });
    await mkdir(people, { recursive: true });
    await writeFile(
      path.join(outside, "secret.md"),
      stringifyFrontmatter({ name: "Secret", relation: "unknown" }, "outside"),
      "utf-8",
    );
    try {
      await symlink(outside, path.join(people, "linked"), "junction");
    } catch (error) {
      if ((error as { code?: string }).code === "EPERM") return;
      throw error;
    }

    await expect(fixture.adapter.initializeStagedPublishing()).rejects.toThrow(
      "symbolic links",
    );
    const records = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
    expect(records.some((entry) => entry.body.t === "memory-legacy-cutover-started"))
      .toBe(false);
  });

  it("imports an owned legacy filename beginning with dots without treating it as an escape", async () => {
    const fixture = await createFixture();
    const people = path.join(fixture.root, "memory", "people");
    await mkdir(people, { recursive: true });
    await writeFile(
      path.join(people, "..alice.md"),
      stringifyFrontmatter({ name: "Alice", relation: "friend" }, "legacy"),
      "utf-8",
    );

    await fixture.adapter.initializeStagedPublishing();

    await expect(
      readEntries(fixture.adapter, { kind: "personal" }, "people"),
    ).resolves.toMatchObject([{
      id: expect.stringMatching(/^legacy-[a-f0-9]{40}$/u),
      content: "legacy",
    }]);
  });

  it("records an empty cutover so legacy files created later stay out of authority", async () => {
    const fixture = await createFixture();
    await fixture.adapter.initializeStagedPublishing();
    await fixture.store.save({
      category: "person",
      id: "late",
      meta: { name: "Late", relation: "unknown" },
      content: "created after the empty cutover",
    });
    const reopened = new AnchorMemoryGlobalStateAdapter({
      log: fixture.log,
      anchorEpoch: 1,
      scopeRoot: fixture.scopeRoot,
      clock: () => NOW,
    });

    await reopened.initializeStagedPublishing();

    await expect(
      readEntries(reopened, { kind: "personal" }, "people"),
    ).resolves.toEqual([]);
    const records = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
    expect(records.filter((record) => record.body.t === "memory-legacy-cutover"))
      .toHaveLength(1);
  });

  it("appends to a taken-over journal entry on the same day", async () => {
    const fixture = await createFixture();
    await fixture.store.save({
      category: "journal",
      id: "2026-08-04",
      meta: { date: "2026-08-04" },
      content: "legacy morning",
    });
    await fixture.adapter.initializeStagedPublishing();

    await fixture.adapter.mutate(
      {
        kind: "memory-append",
        payload: {
          domain: "journal",
          scope: { kind: "personal" },
          date: "2026-08-04",
          content: "authority afternoon",
        },
      },
      controlContext("same-day-journal-append"),
    );

    await expect(
      readEntries(fixture.adapter, { kind: "personal" }, "journal"),
    ).resolves.toMatchObject([{
      id: "2026-08-04",
      revision: 2,
      content: "legacy morning\n\n---\n\nauthority afternoon",
    }]);
  });

  it("imports blank legacy daily and monthly journals for authority cleanup", async () => {
    const fixture = await createFixture();
    await fixture.store.save({
      category: "journal",
      id: "2026-06-01",
      meta: { date: "2026-06-01" },
      content: " \n\t ",
    });
    await fixture.store.save({
      category: "journal",
      id: "2026-06",
      meta: { date: "2026-06", condensed: true },
      content: "",
    });

    await fixture.adapter.initializeStagedPublishing();

    await expect(
      readEntries(fixture.adapter, { kind: "personal" }, "journal"),
    ).resolves.toMatchObject([
      { id: "2026-06", content: "", meta: { condensed: true } },
      { id: "2026-06-01", content: "" },
    ]);
  });

  it("rejects blank journal writes at both staged and control authority boundaries", async () => {
    const fixture = await createFixture();
    await fixture.adapter.initializeStagedPublishing();
    const mutation = {
      kind: "memory-append" as const,
      payload: {
        domain: "journal" as const,
        scope: { kind: "personal" as const },
        date: "2026-08-04",
        content: " \n\t ",
      },
    };

    await expect(fixture.adapter.mutate(
      mutation,
      controlContext("blank-control-journal"),
    )).rejects.toThrow("non-whitespace");
    await expect(prepareStaged(fixture, {
      records: [{ seq: 1, requestId: "blank-staged-journal", mutation }],
    })).rejects.toThrow("non-whitespace");
    await expect(
      readEntries(fixture.adapter, { kind: "personal" }, "journal"),
    ).resolves.toEqual([]);
  });

  it("fails closed before the cutover marker when a legacy source cannot be read", async () => {
    const fixture = await createFixture();
    await mkdir(path.join(fixture.root, "memory", "profile.md"), {
      recursive: true,
    });

    await expect(fixture.adapter.initializeStagedPublishing()).rejects.toThrow();
    const records = (await fixture.log.readAll<{ readonly t: string }>())
      .flatMap((commit) => commit.entries);
    expect(records.some((record) => record.body.t === "memory-legacy-cutover")).toBe(false);
  });

  it("plans staged personal memory, materializes only after commit, and returns path-free DTOs", async () => {
    const fixture = await createFixture();
    const mutation: GlobalStagedMutation = {
      kind: "memory-append",
      payload: {
        domain: "memory",
        scope: { kind: "personal" },
        category: "profile",
        id: "profile",
        meta: { name: "Alice" },
        content: "Prefers concise answers.",
      },
    };
    const plan = await prepareStaged(fixture, {
      records: [{ seq: 1, requestId: "memory-save", mutation }],
    });
    expect(plan.outcomes.get(1)).toEqual({ t: "granted", targetRevision: 1 });
    expect(await fixture.store.load("profile", "profile")).toBeNull();

    await fixture.log.append(plan.records);
    await fixture.adapter.applyStagedMutation({
      requestId: "memory-save",
      mutation,
      targetRevision: 1,
    });
    const result = await fixture.adapter.read(
      {
        kind: "memory-list",
        scope: { kind: "personal" },
        domain: "memory",
        category: "profile",
      },
      readContext("memory-list"),
    );
    expect(result.kind).toBe("memory-list");
    if (result.kind !== "memory-list") throw new Error("unexpected read result");
    expect(result.entries[0]).toMatchObject({
      id: "profile",
      revision: 1,
      content: "Prefers concise answers.",
    });
    expect(JSON.stringify(result)).not.toContain(fixture.root);
    expect(await fixture.store.load("profile", "profile")).toMatchObject({
      content: "Prefers concise answers.",
    });
  });

  it("serializes same-batch update/delete by digest and rejects stale scope capability", async () => {
    const fixture = await createFixture();
    await fixture.adapter.mutate(
      {
        kind: "memory-append",
        payload: {
          domain: "people",
          scope: { kind: "workscene", sceneId: "scene-a" },
          id: "person-a",
          meta: { name: "A" },
          content: "first",
        },
      },
      controlContext("create"),
    );
    const listed = await fixture.adapter.read(
      {
        kind: "memory-list",
        scope: { kind: "workscene", sceneId: "scene-a" },
        domain: "people",
      },
      readContext("read-created"),
    );
    if (listed.kind !== "memory-list") throw new Error("unexpected result");
    const current = listed.entries[0]!;
    const update: GlobalStagedMutation = {
      kind: "memory-append",
      payload: {
        domain: "people",
        scope: { kind: "workscene", sceneId: "scene-a" },
        id: "person-a",
        meta: { name: "A" },
        content: "second",
        expectedDigest: current.digest,
      },
    };
    const remove: GlobalStagedMutation = {
      kind: "memory-delete",
      scope: { kind: "workscene", sceneId: "scene-a" },
      domain: "people",
      id: "person-a",
      expectedDigest: "0".repeat(64),
    };
    const plan = await prepareStaged(fixture, {
      records: [
        { seq: 1, requestId: "update", mutation: update },
        { seq: 2, requestId: "delete", mutation: remove },
      ],
    });
    expect(plan.outcomes.get(1)).toMatchObject({ t: "granted", targetRevision: 2 });
    expect(plan.outcomes.get(2)).toMatchObject({
      t: "conflicted",
      error: { code: "revision-conflict" },
    });

    await expect(
      fixture.adapter.read(
        {
          kind: "memory-list",
          scope: { kind: "workscene", sceneId: "scene-a" },
          domain: "people",
        },
        {
          ...readContext("wrong-capability"),
          principal: {
            kind: "assignment",
            capability: {
              authorityId: "authority",
              subject: "assignment",
              methods: ["global.read"],
              resources: ["memory-domain:personal"],
              issuedAt: NOW,
              expiresAt: "2026-08-04T02:00:00.000Z",
              nonce: "nonce",
              signature: { keyId: "key", algorithm: "ed25519", value: "sig" },
            },
          },
        },
      ),
    ).rejects.toThrow("does not cover");
  });

  it("accepts consecutive same-batch people updates using the shared projected digest", async () => {
    const fixture = await createFixture();
    await fixture.adapter.mutate(
      {
        kind: "memory-append",
        payload: {
          domain: "people",
          scope: { kind: "personal" },
          id: "person-a",
          meta: { name: "A", relation: "friend" },
          content: "first",
        },
      },
      controlContext("people-create"),
    );
    const listed = await fixture.adapter.read(
      { kind: "memory-list", scope: { kind: "personal" }, domain: "people" },
      readContext("people-current"),
    );
    if (listed.kind !== "memory-list") throw new Error("unexpected result");
    const current = listed.entries[0]!;
    const secondPayload = {
      domain: "people" as const,
      scope: { kind: "personal" as const },
      id: "person-a",
      meta: { name: "A", relation: "friend" },
      content: "second",
      expectedDigest: current.digest,
    };
    const projected = projectMemoryLogicalEntry(secondPayload, current, { revision: 2 });
    const plan = await prepareStaged(fixture, {
      records: [
        {
          seq: 1,
          requestId: "people-second",
          mutation: { kind: "memory-append", payload: secondPayload },
        },
        {
          seq: 2,
          requestId: "people-third",
          mutation: {
            kind: "memory-append",
            payload: {
              ...secondPayload,
              content: "third",
              expectedDigest: projected.digest,
            },
          },
        },
      ],
    });

    expect(plan.outcomes.get(1)).toEqual({ t: "granted", targetRevision: 2 });
    expect(plan.outcomes.get(2)).toEqual({ t: "granted", targetRevision: 3 });
  });

  it("condenses journal sources atomically and replays one pending materialization after I/O recovery", async () => {
    const fixture = await createFixture();
    await fixture.adapter.initializeStagedPublishing();
    for (const [date, content] of [
      ["2026-01-02", "first"],
      ["2026-01-03", "second"],
    ] as const) {
      await fixture.adapter.mutate(
        {
          kind: "memory-append",
          payload: {
            domain: "journal",
            scope: { kind: "personal" },
            date,
            content,
          },
        },
        controlContext(`append:${date}`),
      );
    }
    const sources = await readEntries(
      fixture.adapter,
      { kind: "personal" },
      "journal",
    );
    const journalDir = path.join(fixture.root, "memory", "journal");
    const blockedSource = path.join(journalDir, "2026-01-03.md");
    await unlink(blockedSource);
    await mkdir(blockedSource);

    const mutation = {
      kind: "memory-journal-condense" as const,
      scope: { kind: "personal" as const },
      month: "2026-01",
      sources: sources.map((source) => ({
        id: source.id,
        expectedDigest: source.digest,
      })).sort((left, right) => left.id.localeCompare(right.id, "en-US")),
      summary: "monthly summary",
    };
    await fixture.adapter.mutate(
      mutation,
      maintenanceContext("condense:2026-01"),
    );
    await expect(
      readEntries(fixture.adapter, { kind: "personal" }, "journal"),
    ).resolves.toMatchObject([{
      id: "2026-01",
      content: "monthly summary",
      meta: { condensed: true, condensedFrom: 2 },
    }]);
    const beforeRecovery = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
    expect(beforeRecovery.filter((record) => record.body.t === "memory-journal-condensed"))
      .toHaveLength(1);
    expect(beforeRecovery.filter((record) =>
      record.body.t === "memory-materialized" &&
      record.body.requestId === "condense:2026-01"
    )).toHaveLength(0);

    await expect(fixture.store.load("journal", "2026-01")).resolves.toMatchObject({
      content: "monthly summary",
    });
    await expect(fixture.store.load("journal", "2026-01-02")).resolves.toBeNull();
    await rm(blockedSource, { recursive: true });
    const reopened = new AnchorMemoryGlobalStateAdapter({
      log: fixture.log,
      anchorEpoch: 1,
      scopeRoot: fixture.scopeRoot,
      clock: () => NOW,
    });
    await reopened.initializeStagedPublishing();

    await expect(fixture.store.load("journal", "2026-01")).resolves.toMatchObject({
      content: "monthly summary",
    });
    await expect(fixture.store.load("journal", "2026-01-02")).resolves.toBeNull();
    await expect(fixture.store.load("journal", "2026-01-03")).resolves.toBeNull();
    const afterRecovery = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
    expect(afterRecovery.filter((record) =>
      record.body.t === "memory-materialized" &&
      record.body.requestId === "condense:2026-01"
    )).toHaveLength(1);
    const reopenedAgain = new AnchorMemoryGlobalStateAdapter({
      log: fixture.log,
      anchorEpoch: 1,
      scopeRoot: fixture.scopeRoot,
      clock: () => NOW,
    });
    await reopenedAgain.initializeStagedPublishing();
    const afterSecondRecovery = (await fixture.log.readAll())
      .flatMap((commit) => commit.entries);
    expect(afterSecondRecovery.filter((record) =>
      record.body.t === "memory-materialized" &&
      record.body.requestId === "condense:2026-01"
    )).toHaveLength(1);
  });

  it("keeps condensation control-only and rejects source drift without side effects", async () => {
    const fixture = await createFixture();
    await fixture.adapter.initializeStagedPublishing();
    await fixture.adapter.mutate(
      {
        kind: "memory-append",
        payload: {
          domain: "journal",
          scope: { kind: "personal" },
          date: "2026-01-02",
          content: "source",
        },
      },
      controlContext("append-source"),
    );
    const [source] = await readEntries(
      fixture.adapter,
      { kind: "personal" },
      "journal",
    );
    if (!source) throw new Error("journal source missing");
    const mutation = {
      kind: "memory-journal-condense" as const,
      scope: { kind: "personal" as const },
      month: "2026-01",
      sources: [{ id: source.id, expectedDigest: `sha256:${"0".repeat(64)}` }],
      summary: "summary",
    };

    await expect(
      fixture.adapter.mutate(mutation, maintenanceContext("stale-condense")),
    ).rejects.toMatchObject({
      authorityError: { code: "revision-conflict" },
    });
    await expect(
      fixture.adapter.mutate(
        { ...mutation, sources: [{ id: source.id, expectedDigest: source.digest }] },
        controlContext("wrong-owner"),
      ),
    ).rejects.toThrow("owned by anchor memory maintenance");
    await expect(
      fixture.adapter.mutate(
        {
          ...mutation,
          month: "2026-02",
          sources: [{ id: "2026-02-31", expectedDigest: source.digest }],
        },
        maintenanceContext("invalid-calendar-day"),
      ),
    ).rejects.toThrow("sources are invalid");
    await expect(
      readEntries(fixture.adapter, { kind: "personal" }, "journal"),
    ).resolves.toMatchObject([{ id: "2026-01-02", content: "source" }]);
  });
});

async function prepareStaged(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  input: Pick<
    Parameters<AnchorMemoryGlobalStateAdapter["prepareStagedMutations"]>[0],
    "records"
  >,
) {
  const transaction = await fixture.log.transactProjection(
    {},
    (state) => state,
    async (_state, context) => ({
      kind: "return" as const,
      value: await fixture.adapter.prepareStagedMutations({
        records: input.records,
        authorityProjection: context.readProjection(fixture.adapter.stagedProjectionId),
        at: context.at,
      }),
    }),
    { readProjectionIds: [fixture.adapter.stagedProjectionId] },
  );
  return transaction.value;
}

async function createFixture() {
  const root = await createTempDir("zhixing-memory-global-state");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
  });
  const personalRoot = path.join(root, "memory");
  const worksceneRoot = (sceneId: string) => path.join(root, "workscenes", sceneId, "memory");
  const scopeRoot = (scope: MemoryScopeRef) =>
    scope.kind === "personal" ? personalRoot : worksceneRoot(scope.sceneId);
  return {
    root,
    log,
    store: new MemoryStore(personalRoot),
    scopeRoot,
    worksceneRoot,
    adapter: new AnchorMemoryGlobalStateAdapter({
      log,
      anchorEpoch: 1,
      scopeRoot,
      clock: () => NOW,
    }),
  };
}

async function readEntries(
  adapter: AnchorMemoryGlobalStateAdapter,
  scope: MemoryScopeRef,
  domain: "memory" | "people" | "journal",
) {
  const result = await adapter.read(
    domain === "memory"
      ? { kind: "memory-list", scope, domain, category: "profile" }
      : { kind: "memory-list", scope, domain },
    readContext(`read-${domain}-${scope.kind}`),
  );
  if (result.kind !== "memory-list") throw new Error("unexpected result");
  return result.entries;
}

function readContext(requestId: string): GlobalReadCallContext {
  return {
    principal: { kind: "host", component: "memory-test" },
    requestId,
    authority: { domain: "global", anchorEpoch: 1 },
    deadlineAt: "2026-08-04T01:00:00.000Z",
  };
}

function controlContext(requestId: string): GlobalControlCallContext {
  return readContext(requestId) as GlobalControlCallContext;
}

function maintenanceContext(requestId: string): GlobalControlCallContext {
  return {
    ...controlContext(requestId),
    principal: { kind: "host", component: "memory-journal-maintenance" },
  };
}
