import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { FileArtifactStore, FileAuthorityCommitLog } from "../authority/index.js";
import type {
  GlobalControlCallContext,
  GlobalReadCallContext,
  GlobalStagedMutation,
} from "../contracts/index.js";
import { skillNameToId } from "./id.js";
import { AnchorSkillGlobalStateAdapter } from "./global-state-adapter.js";
import { SkillStore } from "./store.js";

const NOW = "2026-08-04T00:00:00.000Z";
const DURABLE_IO_TEST_TIMEOUT_MS = 30_000;

describe("AnchorSkillGlobalStateAdapter", { timeout: DURABLE_IO_TEST_TIMEOUT_MS }, () => {
  it("commits an immutable content dependency before path-free catalog publication", async () => {
    const fixture = await createFixture();
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
    await expect(fixture.store.loadText(skillNameToId("My Skill"))).rejects.toThrow();

    await fixture.log.append(plan.records);
    await fixture.adapter.applyStagedMutation({
      requestId: "skill-create",
      mutation,
      targetRevision: 1,
    });
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
    expect((await fixture.store.loadText(skillNameToId("My Skill"))).body).toContain("Do it.");
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

async function createFixture() {
  const root = await createTempDir("zhixing-skill-global-state");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, {
    clock: () => NOW,
  });
  const store = new SkillStore(path.join(root, "skills"));
  const adapter = new AnchorSkillGlobalStateAdapter({
    log,
    artifacts,
    store,
    anchorEpoch: 1,
    clock: () => NOW,
  });
  await adapter.initializeStagedPublishing();
  return { root, artifacts, log, store, adapter };
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
