import path from "node:path";
import { createTempDir } from "@zhixing-ai/test-utils";
import { describe, expect, it } from "vitest";
import { FileArtifactStore, FileAuthorityCommitLog } from "../authority/index.js";
import type { GlobalControlCallContext, GlobalStagedMutation } from "../contracts/index.js";
import type { SkillCatalogChangedFact } from "./catalog-application.js";
import {
  AnchorSkillGlobalStateAdapter,
  SkillCatalogChangeRelay,
  skillCatalogStructureFingerprint,
  type SkillCatalogObservationSink,
} from "./global-state-adapter.js";
import { skillNameToId } from "./id.js";
import type { SkillCatalogEntry } from "./types.js";

const NOW = "2026-11-12T00:00:00.000Z";

describe("SkillCatalogChangeRelay", () => {
  it("records a primed baseline silently and notifies only structural advances", () => {
    const relay = new SkillCatalogChangeRelay();
    const facts: SkillCatalogChangedFact[] = [];
    relay.onChanged((fact) => facts.push(fact));
    relay.prime({ catalogRevision: 3, fingerprint: "a" });
    relay.observe({ catalogRevision: 3, fingerprint: "b" });
    relay.observe({ catalogRevision: 2, fingerprint: "c" });
    relay.observe({ catalogRevision: 4, fingerprint: "a" });
    expect(facts).toEqual([]);
    expect(relay.observedRevision).toBe(4);
    relay.observe({ catalogRevision: 6, fingerprint: "b" });
    relay.observe({ catalogRevision: 6, fingerprint: "b" });
    relay.observe({ catalogRevision: 7, fingerprint: "c" });
    expect(facts).toEqual([
      { kind: "skill-catalog-changed", catalogRevision: 6 },
      { kind: "skill-catalog-changed", catalogRevision: 7 },
    ]);
  });

  it("compares a later prime with the kept baseline and notifies without one", () => {
    const primed = new SkillCatalogChangeRelay();
    const primedFacts: number[] = [];
    primed.onChanged((fact) => primedFacts.push(fact.catalogRevision));
    primed.prime({ catalogRevision: 1, fingerprint: "a" });
    primed.prime({ catalogRevision: 2, fingerprint: "a" });
    primed.prime({ catalogRevision: 3, fingerprint: "b" });
    expect(primedFacts).toEqual([3]);

    const unprimed = new SkillCatalogChangeRelay();
    const unprimedFacts: number[] = [];
    unprimed.onChanged((fact) => unprimedFacts.push(fact.catalogRevision));
    unprimed.observe({ catalogRevision: 1, fingerprint: "a" });
    expect(unprimedFacts).toEqual([1]);
  });

  it("isolates a throwing listener from the other listeners and reports it", () => {
    const errors: unknown[] = [];
    const relay = new SkillCatalogChangeRelay({ onListenerError: (error) => errors.push(error) });
    const received: number[] = [];
    relay.onChanged(() => { throw new Error("listener failed"); });
    const stop = relay.onChanged((fact) => received.push(fact.catalogRevision));
    relay.prime({ catalogRevision: 0, fingerprint: "a" });
    relay.observe({ catalogRevision: 1, fingerprint: "b" });
    expect(received).toEqual([1]);
    expect(errors).toHaveLength(1);
    stop();
    relay.observe({ catalogRevision: 2, fingerprint: "c" });
    expect(received).toEqual([1]);
  });
});

describe("skillCatalogStructureFingerprint", () => {
  it("ignores usage statistics and insertion order but keeps every visible field", () => {
    const a = entry("alpha", { revision: 1 });
    const b = entry("beta", { revision: 4 });
    const base = skillCatalogStructureFingerprint([a, b]);
    expect(skillCatalogStructureFingerprint([b, a])).toBe(base);
    expect(skillCatalogStructureFingerprint([
      { ...a, revision: 9, digest: "sha256:other", usage: { lastHitAt: NOW, hitCount: 5 } },
      b,
    ])).toBe(base);
    for (const change of [{ pinned: true }, { disabled: true }, { description: "changed" }, { mode: "work" as const },
      { contentRef: { ...a.contentRef, digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222" } }]) {
      expect(skillCatalogStructureFingerprint([{ ...a, ...change }, b])).not.toBe(base);
    }
  });
});

describe("AnchorSkillGlobalStateAdapter catalog observation", { timeout: 30_000 }, () => {
  it("notifies the first committed staged create after priming and stays silent for usage and recovery", async () => {
    const fixture = await createFixture();
    await fixture.adapter.primeCatalogObservation();
    const content = await fixture.artifacts.put(Buffer.from("skill body"));
    await stage(fixture, [{ seq: 1, requestId: "create", mutation: create("Skill", content) }]);
    expect(fixture.facts).toEqual([1]);
    const id = skillNameToId("Skill");
    await stage(fixture, [{ seq: 1, requestId: "usage-1", mutation: usage(id) }]);
    await stage(fixture, [{ seq: 1, requestId: "usage-2", mutation: usage(id) }]);
    await fixture.adapter.refreshStagedMutations([]);
    expect(fixture.facts).toEqual([1]);
    await fixture.log.stopStorageMaintenance();
  });

  it("notifies a committed staged admit at commit time and stays silent when materialization confirms it", async () => {
    const fixture = await createFixture();
    await fixture.adapter.primeCatalogObservation();
    const content = await fixture.artifacts.put(Buffer.from("linked body"));
    const records = [{ seq: 1, requestId: "admit", mutation: admit("Linked", content) }];
    const granted = await commitOnly(fixture, fixture.adapter, records);
    expect(fixture.facts).toEqual([]);
    await fixture.adapter.observeCommittedMutations(records);
    expect(fixture.facts).toEqual([1]);
    await applyAll(fixture.adapter, records, granted);
    await fixture.adapter.refreshStagedMutations([]);
    expect(fixture.facts).toEqual([1]);
    await fixture.log.stopStorageMaintenance();
  });

  it("lets materialization notify a commit whose commit-time observation never ran", async () => {
    const fixture = await createFixture();
    await fixture.adapter.primeCatalogObservation();
    const content = await fixture.artifacts.put(Buffer.from("interrupted body"));
    const records = [{ seq: 1, requestId: "create", mutation: create("Interrupted", content) }];
    const granted = await commitOnly(fixture, fixture.adapter, records);
    await applyAll(fixture.adapter, records, granted);
    expect(fixture.facts).toEqual([1]);
    await fixture.log.stopStorageMaintenance();
  });

  it("merges one batch into its final revision and still notifies a later independent commit", async () => {
    const fixture = await createFixture();
    await fixture.adapter.primeCatalogObservation();
    const content = await fixture.artifacts.put(Buffer.from("batch body"));
    await stage(fixture, [
      { seq: 1, requestId: "create-a", mutation: create("Skill A", content) },
      { seq: 2, requestId: "create-b", mutation: create("Skill B", content) },
    ]);
    expect(fixture.facts).toEqual([2]);
    const replacement = await fixture.artifacts.put(Buffer.from("replacement body"));
    await stage(fixture, [{ seq: 1, requestId: "update-a", mutation: {
      kind: "skill-update", mode: "main", skillId: skillNameToId("Skill A"), expectedRevision: 1,
      record: { name: "Skill A", description: "Useful", content: replacement },
    } as GlobalStagedMutation }]);
    expect(fixture.facts).toEqual([2, 3]);
    await fixture.log.stopStorageMaintenance();
  });

  it("notifies committed management changes once each and nothing for a no-op", async () => {
    const fixture = await createFixture();
    await fixture.adapter.primeCatalogObservation();
    const content = await fixture.artifacts.put(Buffer.from("managed body"));
    await stage(fixture, [{ seq: 1, requestId: "create", mutation: create("Managed", content) }]);
    const id = skillNameToId("Managed");
    const pin = { kind: "skill-set-state" as const, skillId: id, expectedRevision: 1, patch: { pinned: true } };
    await fixture.adapter.mutate(pin, control("pin"));
    await fixture.adapter.mutate(pin, control("pin"));
    await fixture.adapter.mutate({ kind: "skill-archive", skillId: id, expectedRevision: 2 }, control("archive"));
    expect(fixture.facts).toEqual([1, 2, 3]);
    await fixture.log.stopStorageMaintenance();
  });

  it("lets a primed later generation report changes it observed during the swap and drops stale reads", async () => {
    const fixture = await createFixture();
    await fixture.adapter.primeCatalogObservation();
    const content = await fixture.artifacts.put(Buffer.from("generation body"));
    const silent = new AnchorSkillGlobalStateAdapter({ log: fixture.log, anchorEpoch: 1, clock: () => NOW });
    await stageWith(fixture, silent, [{ seq: 1, requestId: "during-swap", mutation: create("Swap", content) }]);
    expect(fixture.facts).toEqual([]);
    const next = new AnchorSkillGlobalStateAdapter({ log: fixture.log, anchorEpoch: 1, clock: () => NOW, catalogChanges: fixture.relay });
    await next.primeCatalogObservation();
    expect(fixture.facts).toEqual([1]);
    await fixture.adapter.refreshStagedMutations([]);
    expect(fixture.facts).toEqual([1]);
    await fixture.log.stopStorageMaintenance();
  });

  it("reports a structural commit found by recovery that this adapter did not apply", async () => {
    const fixture = await createFixture();
    await fixture.adapter.primeCatalogObservation();
    const content = await fixture.artifacts.put(Buffer.from("recovered body"));
    const silent = new AnchorSkillGlobalStateAdapter({ log: fixture.log, anchorEpoch: 1, clock: () => NOW });
    await stageWith(fixture, silent, [{ seq: 1, requestId: "before-crash", mutation: create("Recovered", content) }]);
    expect(fixture.facts).toEqual([]);
    await fixture.adapter.refreshStagedMutations([]);
    expect(fixture.facts).toEqual([1]);
    await fixture.log.stopStorageMaintenance();
  });

  it("does not consult the observation sink when committing or applying usage", async () => {
    const fixture = await createFixture();
    let consulted = 0;
    const counting: SkillCatalogObservationSink = {
      get observedRevision() { consulted++; return fixture.relay.observedRevision; },
      prime: (observation) => fixture.relay.prime(observation),
      observe: (observation) => { consulted++; fixture.relay.observe(observation); },
    };
    const adapter = new AnchorSkillGlobalStateAdapter({ log: fixture.log, anchorEpoch: 1, clock: () => NOW, catalogChanges: counting });
    await adapter.primeCatalogObservation();
    const content = await fixture.artifacts.put(Buffer.from("usage body"));
    await stageWith(fixture, adapter, [{ seq: 1, requestId: "create", mutation: create("Used", content) }]);
    const afterCreate = consulted;
    await stageWith(fixture, adapter, [{ seq: 1, requestId: "usage", mutation: usage(skillNameToId("Used")) }]);
    expect(consulted).toBe(afterCreate);
    await fixture.log.stopStorageMaintenance();
  });

  it("keeps a committed mutation successful when observation fails", async () => {
    const fixture = await createFixture();
    const errors: unknown[] = [];
    const failing: SkillCatalogObservationSink = {
      observedRevision: undefined,
      prime() { throw new Error("prime failed"); },
      observe() { throw new Error("observe failed"); },
    };
    const adapter = new AnchorSkillGlobalStateAdapter({ log: fixture.log, anchorEpoch: 1, clock: () => NOW,
      catalogChanges: failing, onCatalogObservationError: (error) => errors.push(error) });
    await adapter.primeCatalogObservation();
    const content = await fixture.artifacts.put(Buffer.from("failing body"));
    await stageWith(fixture, adapter, [{ seq: 1, requestId: "create", mutation: create("Failing", content) }]);
    await expect(adapter.mutate({ kind: "skill-set-state", skillId: skillNameToId("Failing"), expectedRevision: 1, patch: { pinned: true } },
      control("pin"))).resolves.toMatchObject({ revision: 2 });
    // 提交时观察、物化确认、管理提交各失败一次，都只上报，提交照常成功
    expect(errors.map((error) => (error as Error).message)).toEqual(["prime failed", "observe failed", "observe failed", "observe failed"]);
    await fixture.log.stopStorageMaintenance();
  });
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;
type StagedRecord = Parameters<AnchorSkillGlobalStateAdapter["prepareStagedMutations"]>[0]["records"][number];

async function createFixture() {
  const root = await createTempDir("zhixing-skill-catalog-relay");
  const artifacts = new FileArtifactStore(path.join(root, "artifacts"));
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), artifacts, { clock: () => NOW });
  const relay = new SkillCatalogChangeRelay();
  const facts: number[] = [];
  relay.onChanged((fact) => facts.push(fact.catalogRevision));
  const adapter = new AnchorSkillGlobalStateAdapter({ log, anchorEpoch: 1, clock: () => NOW, catalogChanges: relay });
  return { root, artifacts, log, relay, facts, adapter };
}

/**
 * 与生产相同的次序：在日志事务中提交 → 事务之外观察已提交的记录（submitBundle 经协调器调用）→
 * 逐条 applyStagedMutation（恢复轮的物化确认）。
 */
function stage(fixture: Fixture, records: readonly StagedRecord[]) {
  return stageWith(fixture, fixture.adapter, records);
}

async function stageWith(fixture: Fixture, adapter: AnchorSkillGlobalStateAdapter, records: readonly StagedRecord[]) {
  const granted = await commitOnly(fixture, adapter, records);
  await adapter.observeCommittedMutations(records);
  await applyAll(adapter, records, granted);
}

async function commitOnly(fixture: Fixture, adapter: AnchorSkillGlobalStateAdapter, records: readonly StagedRecord[]) {
  const candidates = await adapter.collectStagedReferences(records);
  const committed = await fixture.log.transactProjection({}, (state) => state, async (_state, context) => {
    const plan = await adapter.prepareStagedMutations({ records, authorityProjection: context.readProjection(adapter.stagedProjectionId), at: context.at });
    return plan.records.length
      ? { kind: "append" as const, entries: plan.records, value: plan.outcomes }
      : { kind: "return" as const, value: plan.outcomes };
  }, { readProjectionIds: [adapter.stagedProjectionId], candidateReferences: candidates });
  return committed.value;
}

async function applyAll(adapter: AnchorSkillGlobalStateAdapter, records: readonly StagedRecord[],
  outcomes: Awaited<ReturnType<typeof commitOnly>>) {
  for (const record of records) {
    const outcome = outcomes.get(record.seq);
    if (outcome?.t !== "granted") throw new Error(`staged mutation ${record.requestId} was not granted`);
    await adapter.applyStagedMutation({ requestId: record.requestId, mutation: record.mutation, targetRevision: outcome.targetRevision });
  }
}

function create(name: string, content: SkillCatalogEntry["contentRef"]): GlobalStagedMutation {
  return { kind: "skill-create", mode: "main", record: { name, description: "Useful", content } } as GlobalStagedMutation;
}

function admit(name: string, content: SkillCatalogEntry["contentRef"]): GlobalStagedMutation {
  return { kind: "skill-admit", mode: "main", record: { name, description: "Linked", content } } as GlobalStagedMutation;
}

function usage(skillId: string): GlobalStagedMutation {
  return { kind: "skill-usage", record: { skillId, occurredAt: NOW, hitDelta: 1 } } as GlobalStagedMutation;
}

function control(requestId: string): GlobalControlCallContext {
  return {
    principal: { kind: "host", component: "skill-relay-test" },
    requestId,
    authority: { domain: "global", anchorEpoch: 1 },
    deadlineAt: "2026-11-12T01:00:00.000Z",
  } as GlobalControlCallContext;
}

function entry(id: string, overrides: Partial<SkillCatalogEntry>): SkillCatalogEntry {
  return {
    id,
    name: id,
    description: "Useful",
    source: "own",
    mode: "main",
    pinned: false,
    disabled: false,
    createdAt: NOW,
    usage: null,
    contentRef: { digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111", bytes: 4 },
    revision: 1,
    digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  } as SkillCatalogEntry;
}
