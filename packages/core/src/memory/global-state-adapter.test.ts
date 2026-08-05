import path from "node:path";
import { mkdir, rm, unlink } from "node:fs/promises";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { FileArtifactStore, FileAuthorityCommitLog } from "../authority/index.js";
import type {
  GlobalControlCallContext,
  GlobalReadCallContext,
  GlobalStagedMutation,
} from "../contracts/index.js";
import { protocolDigest } from "../protocol/index.js";
import { MemoryStore } from "./memory-store.js";
import { AnchorMemoryGlobalStateAdapter } from "./global-state-adapter.js";
import {
  memoryLogicalEntryKey,
  projectMemoryLogicalEntry,
} from "./logical-entry.js";
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
    const importedPayload = {
      domain: "people" as const,
      scope: { kind: "personal" as const },
      id: "alice",
      meta: { name: "Alice", relation: "friend" },
      content: "already committed before the response was lost",
    };
    const importedEntry = projectMemoryLogicalEntry(
      importedPayload,
      undefined,
      { revision: 1 },
    );
    const logicalKey = memoryLogicalEntryKey(importedEntry);
    const requestId = `memory-legacy-import:${protocolDigest(
      "MemoryLegacyImportRequest",
      1,
      { logicalKey },
    ).slice("sha256:".length)}`;
    await fixture.log.append([{
      stream: "intent:memory-authority",
      body: {
        t: "memory-mutation-applied",
        requestId,
        mutationDigest: protocolDigest("MemoryLegacyImport", 1, {
          logicalKey,
          entry: importedEntry,
        }),
        mutation: { kind: "memory-append", payload: importedPayload },
        revision: 1,
        entry: importedEntry,
        at: NOW,
      },
    }]);
    await fixture.store.save({
      category: "person",
      id: "alice",
      meta: importedPayload.meta,
      content: importedPayload.content,
    });
    await fixture.store.save({
      category: "person",
      id: "bob",
      meta: { name: "Bob", relation: "friend" },
      content: "not imported yet",
    });

    await fixture.adapter.initializeStagedPublishing();

    await expect(
      readEntries(fixture.adapter, { kind: "personal" }, "people"),
    ).resolves.toMatchObject([
      { id: "alice", revision: 1 },
      { id: "bob", revision: 1 },
    ]);
    const records = (await fixture.log.readAll()).flatMap((commit) => commit.entries);
    expect(records.filter((record) => record.body.t === "memory-mutation-applied"))
      .toHaveLength(2);
    expect(records.filter((record) => record.body.t === "memory-legacy-cutover"))
      .toHaveLength(1);
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
