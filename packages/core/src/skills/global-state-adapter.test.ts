import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { FileArtifactStore, FileAuthorityCommitLog, TransactionArtifactReferenceError } from "../authority/index.js";
import type {
  ArtifactRef,
  GlobalControlCallContext,
  GlobalReadCallContext,
  GlobalStagedMutation,
} from "../contracts/index.js";
import { skillNameToId } from "./id.js";
import { AnchorSkillGlobalStateAdapter } from "./global-state-adapter.js";

const NOW = "2026-08-04T00:00:00.000Z";
const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

describe("AnchorSkillGlobalStateAdapter", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
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
    expect(result.kind === "skill-get" && result.entry).toMatchObject({ contentRef: content, revision: 2, usage: { hitCount: 1 } });
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
    expect(result.kind === "skill-get" && result.entry).toMatchObject({ contentRef: contentB, revision: 3, usage: { hitCount: 1 } });
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
    expect(result.kind === "skill-get" && result.entry).toMatchObject({ contentRef: contentB, revision: 3, usage: { hitCount: 1 } });
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
    expect(plan.outcomes.get(1)).toEqual({ t: "granted", targetRevision: 2 });
    expect(plan.outcomes.get(2)).toEqual({ t: "granted", targetRevision: 3 });
    await fixture.log.append(plan.records);
    await fixture.adapter.applyStagedMutation({
      requestId: "usage-2",
      mutation: usage("usage-2"),
      targetRevision: 3,
    });
    const current = await fixture.adapter.read(
      { kind: "skill-get", skillId: id },
      readContext("get"),
    );
    if (current.kind !== "skill-get" || !current.entry) throw new Error("missing entry");
    expect(current.entry.usage).toEqual({ lastHitAt: NOW, hitCount: 2 });

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
