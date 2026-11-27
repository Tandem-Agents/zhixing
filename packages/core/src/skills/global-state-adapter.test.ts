import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing-ai/test-utils";
import { describe, expect, it, vi } from "vitest";
import { FileArtifactStore, FileAuthorityCommitLog, TransactionArtifactReferenceError } from "../authority/index.js";
import type {
  ArtifactRef,
  GlobalControlCallContext,
  GlobalReadCallContext,
  GlobalStagedMutation,
} from "../contracts/index.js";
import { skillNameToId } from "./id.js";
import { AnchorSkillGlobalStateAdapter, SkillMutationConflictError } from "./global-state-adapter.js";
import { validateGlobalQueryResult } from "../protocol/global-query-validation.js";

const NOW = "2026-08-04T00:00:00.000Z";
const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

describe("AnchorSkillGlobalStateAdapter", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("manages a staged-created skill after the adapter opened an empty catalog", async () => {
    const fixture = await createFixture();
    await fixture.adapter.read({ kind: "skill-catalog" }, readContext("open-empty"));
    const content = await fixture.artifacts.put(Buffer.from("staged skill document"));
    const id = skillNameToId("Staged Skill");
    await commitStaged(fixture, [{ seq: 1, requestId: "staged-create", mutation: {
      kind: "skill-create", mode: "work", record: { name: "Staged Skill", description: "Useful", content },
    } }]);
    for (const [index, patch] of [{ pinned: true }, { disabled: true }, { disabled: false, mode: "main" as const }].entries()) {
      const mutation = { kind: "skill-set-state" as const, skillId: id, expectedRevision: index + 1, patch };
      const context = controlContext("manage-" + index);
      await fixture.adapter.mutate(mutation, context);
      const commits = (await fixture.log.readSnapshot()).commits.length;
      await fixture.adapter.mutate(mutation, context);
      expect((await fixture.log.readSnapshot()).commits).toHaveLength(commits);
    }
    const reopened = new AnchorSkillGlobalStateAdapter({ log: fixture.log, anchorEpoch: 1, clock: () => NOW });
    const result = await reopened.read({ kind: "skill-get", skillId: id }, readContext("reopen"));
    expect(result.kind === "skill-get" && result.entry).toMatchObject({ contentRef: content, revision: 4, pinned: true, disabled: false, mode: "main" });
    await fixture.adapter.mutate({ kind: "skill-archive", skillId: id, expectedRevision: 4 }, controlContext("archive"));
    const archived = await reopened.read({ kind: "skill-catalog", includeDisabled: true }, readContext("archived"));
    expect(archived.kind === "skill-catalog" && archived.entries).toEqual([]);
    await fixture.log.stopStorageMaintenance();
  });

  it("keeps the revision check when content changes after management dependency collection", async () => {
    const fixture = await createFixture();
    const contentA = await fixture.artifacts.put(Buffer.from("original"));
    const contentB = await fixture.artifacts.put(Buffer.from("replacement"));
    const id = skillNameToId("Skill");
    await commitStaged(fixture, [{ seq: 1, requestId: "create", mutation: { kind: "skill-create", mode: "main", record: { name: "Skill", description: "Useful", content: contentA } } }]);
    const transact = fixture.log.transactDurableProjection.bind(fixture.log);
    let injected = false;
    const intercept = vi.spyOn(fixture.log, "transactDurableProjection").mockImplementation(async (...args) => {
      if (!injected && args[2]?.candidateReferences) {
        injected = true;
        await commitStaged(fixture, [{ seq: 1, requestId: "replace", mutation: { kind: "skill-update", mode: "main", skillId: id, expectedRevision: 1, record: { name: "Skill", description: "Updated", content: contentB } } }]);
      }
      return transact(...args);
    });
    await expect(fixture.adapter.mutate({ kind: "skill-set-state", skillId: id, expectedRevision: 1, patch: { pinned: true } }, controlContext("stale-pin"))).rejects.toBeInstanceOf(SkillMutationConflictError);
    expect(injected).toBe(true);
    intercept.mockRestore();
    const result = await fixture.adapter.read({ kind: "skill-get", skillId: id }, readContext("after-race"));
    expect(result.kind === "skill-get" && result.entry).toMatchObject({ contentRef: contentB, revision: 2, pinned: false });
    expect((await fixture.log.readSnapshot()).commits).toHaveLength(2);
    await fixture.log.stopStorageMaintenance();
  });

  it("protects same-batch content and commits usage once across durable replay", async () => {
    const fixture = await createFixture();
    const content = await fixture.artifacts.put(Buffer.from("original skill body"));
    const id = skillNameToId("Skill");
    const records = [
      { seq: 1, requestId: "create", mutation: { kind: "skill-create", mode: "main", record: { name: "Skill", description: "Useful", content } } as GlobalStagedMutation },
      { seq: 2, requestId: "usage", mutation: { kind: "skill-usage", record: { skillId: id, occurredAt: NOW, hitDelta: 1 } } as GlobalStagedMutation },
    ];
    await commitStaged(fixture, records);
    const beforeReplay = (await fixture.log.readSnapshot()).commits.length;
    await commitStaged(fixture, records);
    expect((await fixture.log.readSnapshot()).commits).toHaveLength(beforeReplay);
    const reopened = new AnchorSkillGlobalStateAdapter({ log: fixture.log, anchorEpoch: 1, clock: () => NOW });
    const result = await reopened.read({ kind: "skill-get", skillId: id }, readContext("fresh"));
    expect(result.kind === "skill-get" && result.entry).toMatchObject({ contentRef: content, revision: 1, usage: { hitCount: 1 } });
    await fixture.log.stopStorageMaintenance();
  });

  it("rejects stale protected content without append, then recollects the current entry", async () => {
    const fixture = await createFixture();
    const contentA = await fixture.artifacts.put(Buffer.from("body A"));
    const contentB = await fixture.artifacts.put(Buffer.from("body B updated"));
    const id = skillNameToId("Skill");
    await commitStaged(fixture, [{ seq: 1, requestId: "create", mutation: { kind: "skill-create", mode: "main", record: { name: "Skill", description: "Useful", content: contentA } } }]);
    const usage = [{ seq: 1, requestId: "usage-after-update", mutation: { kind: "skill-usage", record: { skillId: id, occurredAt: NOW, hitDelta: 1 } } as GlobalStagedMutation }];
    const stale = await fixture.adapter.collectStagedReferences(usage);
    await commitStaged(fixture, [{ seq: 1, requestId: "update", mutation: { kind: "skill-update", mode: "main", skillId: id, expectedRevision: 1, record: { name: "Skill", description: "Changed", content: contentB } } }]);
    const before = (await fixture.log.readSnapshot()).commits.length;
    await expect(commitStaged(fixture, usage, stale)).rejects.toBeInstanceOf(TransactionArtifactReferenceError);
    expect((await fixture.log.readSnapshot()).commits).toHaveLength(before);
    await commitStaged(fixture, usage);
    await commitStaged(fixture, usage);
    const result = await fixture.adapter.read({ kind: "skill-get", skillId: id }, readContext("after-race"));
    expect(result.kind === "skill-get" && result.entry).toMatchObject({ contentRef: contentB, revision: 2, usage: { hitCount: 1 } });
    await fixture.log.stopStorageMaintenance();
  });

  it("protects replacement content for update and usage in the same transaction", async () => {
    const fixture = await createFixture();
    const contentA = await fixture.artifacts.put(Buffer.from("body A"));
    const contentB = await fixture.artifacts.put(Buffer.from("body B"));
    const id = skillNameToId("Skill");
    await commitStaged(fixture, [{ seq: 1, requestId: "create", mutation: { kind: "skill-create", mode: "main", record: { name: "Skill", description: "Useful", content: contentA } } }]);
    await commitStaged(fixture, [
      { seq: 1, requestId: "update", mutation: { kind: "skill-update", mode: "main", skillId: id, expectedRevision: 1, record: { name: "Skill", description: "Updated", content: contentB } } },
      { seq: 2, requestId: "usage", mutation: { kind: "skill-usage", record: { skillId: id, occurredAt: NOW, hitDelta: 1 } } },
    ]);
    const result = await fixture.adapter.read({ kind: "skill-get", skillId: id }, readContext("updated"));
    expect(result.kind === "skill-get" && result.entry).toMatchObject({ contentRef: contentB, revision: 2, usage: { hitCount: 1 } });
    await fixture.log.stopStorageMaintenance();
  });
  it("commits immutable content without touching an inert legacy Skill directory", async () => {
    const fixture = await createFixture();
    const legacyRoot = path.join(fixture.root, "skills");
    const legacyDocument = path.join(legacyRoot, "own", "legacy", "SKILL.md");
    await fs.mkdir(path.dirname(legacyDocument), { recursive: true });
    await fs.writeFile(legacyDocument, "legacy sentinel", "utf8");
    const legacyTree = await fs.readdir(legacyRoot, { recursive: true });
    const document = "---\nname: My Skill\ndescription: Useful\n---\nDo it.";
    const content = await fixture.artifacts.put(Buffer.from(document));
    const mutation: GlobalStagedMutation = {
      kind: "skill-create",
      mode: "main",
      record: { name: "My Skill", description: "Useful", content },
    };
    const plan = await prepareStaged(fixture, {
      records: [{ seq: 1, requestId: "skill-create", mutation }],
    });
    expect(plan.outcomes.get(1)).toEqual({ t: "granted", targetRevision: 1 });

    await fixture.log.append(plan.records);
    await fixture.adapter.applyStagedMutation({
      requestId: "skill-create",
      mutation,
      targetRevision: 1,
    });
    await fixture.adapter.applyStagedMutation({
      requestId: "skill-create",
      mutation,
      targetRevision: 1,
    });
    await fixture.adapter.refreshStagedMutations([
      { requestId: "skill-create", mutation },
    ]);
    const result = await fixture.adapter.read(
      { kind: "skill-catalog", includeDisabled: true },
      readContext("catalog"),
    );
    if (result.kind !== "skill-catalog") throw new Error("unexpected result");
    expect(result.catalogRevision).toBe(1);
    expect(result.entries[0]).toMatchObject({
      id: skillNameToId("My Skill"),
      name: "My Skill",
      revision: 1,
      contentRef: content,
    });
    expect(JSON.stringify(result)).not.toContain(fixture.root);
    expect(Buffer.from(await fixture.artifacts.get(content)).toString("utf8")).toBe(
      document,
    );
    expect(await fs.readdir(legacyRoot, { recursive: true })).toEqual(legacyTree);
    expect(await fs.readFile(legacyDocument, "utf8")).toBe("legacy sentinel");
    const snapshot = await fixture.log.readSnapshot();
    expect(snapshot.commits.flatMap((commit) =>
      commit.entries.map((entry) => entry.stream)
    )).toEqual(["intent:skill-authority"]);

    await expect(fixture.adapter.applyStagedMutation({
      requestId: "skill-create",
      mutation: {
        ...mutation,
        record: { ...mutation.record, description: "changed" },
      },
      targetRevision: 1,
    })).rejects.toThrow("Committed skill mutation is unavailable or changed");
  });

  it("serializes usage deltas, enforces CAS, and keeps disabled entries only in management views", async () => {
    const fixture = await createFixture();
    const content = await fixture.artifacts.put(
      Buffer.from("---\nname: Skill\ndescription: Useful\n---\nbody"),
    );
    await fixture.adapter.mutate(
      {
        kind: "skill-create",
        mode: "main",
        record: { name: "Skill", description: "Useful", content },
      },
      controlContext("create"),
    );
    const id = skillNameToId("Skill");
    const usage = (requestId: string): GlobalStagedMutation => ({
      kind: "skill-usage",
      record: { skillId: id, occurredAt: NOW, hitDelta: 1 },
    });
    const plan = await prepareStaged(fixture, {
      records: [
        { seq: 1, requestId: "usage-1", mutation: usage("usage-1") },
        { seq: 2, requestId: "usage-2", mutation: usage("usage-2") },
      ],
    });
    expect(plan.outcomes.get(1)).toEqual({ t: "granted", targetRevision: 1 });
    expect(plan.outcomes.get(2)).toEqual({ t: "granted", targetRevision: 1 });
    await fixture.log.append(plan.records);
    await fixture.adapter.applyStagedMutation({
      requestId: "usage-2",
      mutation: usage("usage-2"),
      targetRevision: 1,
    });
    const current = await fixture.adapter.read(
      { kind: "skill-get", skillId: id },
      readContext("get"),
    );
    if (current.kind !== "skill-get" || !current.entry) throw new Error("missing entry");
    expect(current.entry.revision).toBe(1);
    expect(current.entry.usage).toEqual({ lastHitAt: NOW, hitCount: 2 });
    expect(() => validateGlobalQueryResult({ kind: 'skill-get', skillId: id }, current)).not.toThrow();

    await fixture.adapter.mutate(
      {
        kind: "skill-set-state",
        skillId: id,
        expectedRevision: current.entry.revision,
        patch: { disabled: true },
      },
      controlContext("disable"),
    );
    const product = await fixture.adapter.read(
      { kind: "skill-catalog" },
      readContext("product"),
    );
    const management = await fixture.adapter.read(
      { kind: "skill-catalog", includeDisabled: true },
      readContext("management"),
    );
    expect(product.kind === "skill-catalog" ? product.entries : []).toEqual([]);
    expect(management.kind === "skill-catalog" ? management.entries : []).toHaveLength(1);
    expect(() => validateGlobalQueryResult({ kind: 'skill-catalog', includeDisabled: true }, management)).not.toThrow();
    await fixture.log.stopStorageMaintenance();
  });

  it("preserves writeTemplate revision across cross-turn and same-turn skill_read + skill_save while rejecting concurrent edits", async () => {
    const { SkillCatalogLoadApplicationService } = await import("./catalog-load-service.js");
    const { SkillCatalogSaveApplicationService, SkillCatalogSaveError } = await import("./catalog-save-service.js");
    const { byteDigest } = await import("../protocol/index.js");

    const fixture = await createFixture();
    let turnBatch: Array<{
      seq: number;
      requestId: string;
      mutation: GlobalStagedMutation;
      mutationDigest: string;
    }> = [];
    const readEntryV2 = async (skillId: string) => {
      const res = await fixture.adapter.read({ kind: "skill-get-v2", skillId }, readContext(`get-${skillId}-${Date.now()}`));
      return res.kind === "skill-get-v2" ? res.entry : null;
    };
    const saveOverlay = () =>
      turnBatch
        .filter((item) => item.mutation.kind !== "skill-usage")
        .map((item) => ({
          recordSeq: item.seq,
          requestIdentity: item.requestId,
          mutation: item.mutation as never,
          mutationDigest: item.mutationDigest,
        }));
    const loader = new SkillCatalogLoadApplicationService({
      readScope: async (skillId) => ({
        kind: "assignment",
        entry: await readEntryV2(skillId),
        overlay: saveOverlay(),
        issuedAt: NOW,
      }),
      readContent: async (ref) => Buffer.from(await fixture.artifacts.get(ref)).toString("utf8"),
      readBytes: (ref) => fixture.artifacts.get(ref),
      stageUsage: async (opId, mutation) => {
        turnBatch.push({
          seq: turnBatch.length + 1,
          requestId: `req:${opId}`,
          mutation,
          mutationDigest: byteDigest(Buffer.from(JSON.stringify(mutation))),
        });
      },
    });
    const saver = new SkillCatalogSaveApplicationService({
      readCatalogEntry: async () => null,
      readCatalogEntryV2: readEntryV2,
      readOverlay: async () => saveOverlay(),
      requestIdentityFor: (opId) => `req:${opId}`,
      putContent: (doc) => fixture.artifacts.put(Buffer.from(doc, "utf8")),
      putBytes: (bytes) => fixture.artifacts.put(bytes),
      readContent: async (ref) => Buffer.from(await fixture.artifacts.get(ref)).toString("utf8"),
      readBytes: (ref) => fixture.artifacts.get(ref),
      stage: async () => {},
      stageV2: async (opId, mutation) => {
        turnBatch.push({
          seq: turnBatch.length + 1,
          requestId: `req:${opId}`,
          mutation,
          mutationDigest: byteDigest(Buffer.from(JSON.stringify(mutation))),
        });
      },
      assignmentIssuedAt: () => NOW,
    });

    // Create initial multi-file v2 package at revision 1
    await saver.save(
      {
        name: "remote-ws-skill",
        description: "v1 desc",
        body: "# V1 Body\n",
        mode: "work",
        resources: [{ path: "notes/guide.md", content: "Remote guide body\n" }],
      },
      "t0-create",
    );
    await commitStaged(
      fixture,
      turnBatch.map(({ seq, requestId, mutation }) => ({ seq, requestId, mutation })),
    );
    const createdV1 = await readEntryV2("remote-ws-skill");
    const packageRefV1 = createdV1?.packageRef;
    expect(packageRefV1).toBeDefined();

    // 1) Cross-turn: Turn 1 reads root -> commits usage -> revision stays 1, hitCount = 1
    turnBatch = [];
    const readTurn1 = await loader.readPackage({ id: "user:remote-ws-skill", operationId: "t1-read" });
    if ("error" in readTurn1 || !readTurn1.writeTemplate) throw new Error("expected writeTemplate");
    expect(readTurn1.writeTemplate.expectedRevision).toBe(1);
    const committedT1 = await commitStaged(
      fixture,
      turnBatch.map(({ seq, requestId, mutation }) => ({ seq, requestId, mutation })),
    );
    expect(committedT1.value.get(1)).toEqual({ t: "granted", targetRevision: 1 });
    // Replay idempotency: re-committing same usage requestId does not increment hitCount again
    await commitStaged(
      fixture,
      turnBatch.map(({ seq, requestId, mutation }) => ({ seq, requestId, mutation })),
    );
    const afterT1 = await readEntryV2("remote-ws-skill");
    expect(afterT1).toMatchObject({ revision: 1, usage: { hitCount: 1 }, packageRef: packageRefV1 });

    // Turn 2 saves using Turn 1's verbatim writeTemplate (omitting resources -> preserves notes/guide.md)
    turnBatch = [];
    const savedTurn2 = await saver.save(
      {
        name: "remote-ws-skill",
        description: "v2 cross-turn desc",
        body: "# V2 Cross-Turn Body\n",
        mode: "work",
        expectedRevision: readTurn1.writeTemplate.expectedRevision,
        expectedVersion: readTurn1.writeTemplate.expectedVersion,
      },
      "t2-save",
    );
    expect(savedTurn2.outcome).toBe("updated");
    const committedT2 = await commitStaged(
      fixture,
      turnBatch.map(({ seq, requestId, mutation }) => ({ seq, requestId, mutation })),
    );
    expect(committedT2.value.get(1)).toEqual({ t: "granted", targetRevision: 2 });

    // 2) Same-turn: Turn 3 reads root (rev 2) AND immediately saves in the same batch ([skill-usage, skill-update-v2])
    turnBatch = [];
    const readTurn3 = await loader.readPackage({ id: "user:remote-ws-skill", operationId: "t3-read" });
    if ("error" in readTurn3 || !readTurn3.writeTemplate) throw new Error("expected writeTemplate in t3");
    expect(readTurn3.writeTemplate.expectedRevision).toBe(2);
    expect(readTurn3.content).toContain("# V2 Cross-Turn Body");
    await saver.save(
      {
        name: "remote-ws-skill",
        description: "v3 same-turn desc",
        body: "# V3 Same-Turn Body\n",
        mode: "work",
        expectedRevision: readTurn3.writeTemplate.expectedRevision,
        expectedVersion: readTurn3.writeTemplate.expectedVersion,
      },
      "t3-save",
    );
    expect(turnBatch.map((b) => b.mutation.kind)).toEqual(["skill-usage", "skill-update-v2"]);
    const committedT3 = await commitStaged(
      fixture,
      turnBatch.map(({ seq, requestId, mutation }) => ({ seq, requestId, mutation })),
    );
    expect(committedT3.value.get(1)).toEqual({ t: "granted", targetRevision: 2 });
    expect(committedT3.value.get(2)).toEqual({ t: "granted", targetRevision: 3 });

    const afterT3 = await readEntryV2("remote-ws-skill");
    expect(afterT3).toMatchObject({
      revision: 3,
      description: "v3 same-turn desc",
      usage: { hitCount: 2 },
    });
    const verifyRoot = await loader.readPackage({ id: "user:remote-ws-skill" });
    if ("error" in verifyRoot) throw new Error("expected root");
    expect(verifyRoot.content).toContain("# V3 Same-Turn Body");
    const verifyGuide = await loader.readPackage({
      id: "user:remote-ws-skill",
      resource: "notes/guide.md",
      expectedVersion: verifyRoot.packageVersion,
    });
    if ("error" in verifyGuide) throw new Error("expected preserved guide");
    expect(verifyGuide.content).toBe("Remote guide body\n");

    // 3) Real concurrent edit advances revision 3 -> 4; stale writeTemplate (expectedRevision: 3) is rejected
    await fixture.adapter.mutate(
      {
        kind: "skill-set-visibility",
        skillId: "remote-ws-skill",
        expectedRevision: 3,
        visibility: { modelAutoIndex: true, userSlashCommand: false },
      },
      controlContext("concurrent-vis"),
    );
    await expect(
      saver.save(
        {
          name: "remote-ws-skill",
          description: "stale overwrite",
          body: "# Stale\n",
          mode: "work",
          expectedRevision: verifyRoot.writeTemplate?.expectedRevision,
          expectedVersion: verifyRoot.writeTemplate?.expectedVersion,
        },
        "t4-stale-save",
      ),
    ).rejects.toBeInstanceOf(SkillCatalogSaveError);

    await fixture.log.stopStorageMaintenance();
  });
});

async function prepareStaged(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  input: Pick<
    Parameters<AnchorSkillGlobalStateAdapter["prepareStagedMutations"]>[0],
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

async function commitStaged(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  records: Parameters<AnchorSkillGlobalStateAdapter["prepareStagedMutations"]>[0]["records"],
  candidateReferences?: readonly ArtifactRef[],
) {
  const candidates = candidateReferences ?? await fixture.adapter.collectStagedReferences(records);
  return fixture.log.transactProjection({}, (state) => state, async (_state, context) => {
    const plan = await fixture.adapter.prepareStagedMutations({ records, authorityProjection: context.readProjection(fixture.adapter.stagedProjectionId), at: context.at });
    return plan.records.length
      ? { kind: "append" as const, entries: plan.records, value: plan.outcomes }
      : { kind: "return" as const, value: plan.outcomes };
  }, { readProjectionIds: [fixture.adapter.stagedProjectionId], candidateReferences: candidates });
}

async function createFixture() {
  const root = await createTempDir("zhixing-skill-global-state");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
  });
  const adapter = new AnchorSkillGlobalStateAdapter({
    log,
    anchorEpoch: 1,
    clock: () => NOW,
  });
  return { root, artifacts, log, adapter };
}

function readContext(requestId: string): GlobalReadCallContext {
  return {
    principal: { kind: "host", component: "skill-test" },
    requestId,
    authority: { domain: "global", anchorEpoch: 1 },
    deadlineAt: "2026-08-04T01:00:00.000Z",
  };
}

function controlContext(requestId: string): GlobalControlCallContext {
  return readContext(requestId) as GlobalControlCallContext;
}
