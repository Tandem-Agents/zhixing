import type {
  ConfigAssetRecord,
  GlobalQuery,
  GlobalReadResult,
  TaskDefinition,
} from "../contracts/state.js";
import type { MemoryLogicalEntry } from "../memory/contracts.js";
import { memoryLogicalEntryDigest } from "../memory/logical-entry.js";
import type { SkillCatalogEntry } from "../skills/types.js";
import { describe, expect, it } from "vitest";
import { protocolDigest } from "./canonical.js";
import {
  validateGlobalQuery,
  validateGlobalQueryResult,
} from "./global-query-validation.js";

const NOW = "2026-08-05T00:00:00.000Z";
const DIGEST_A = `sha256:${"a".repeat(64)}`;

function memoryEntry(): MemoryLogicalEntry {
  const identity = {
    domain: "memory" as const,
    scope: { kind: "personal" as const },
    category: "profile" as const,
    id: "profile",
    meta: { source: "user" },
    content: "hello world",
  };
  return {
    ...identity,
    revision: 1,
    digest: memoryLogicalEntryDigest(identity),
    updatedAt: NOW,
  };
}

function task(): TaskDefinition {
  return {
    taskId: "task-1",
    taskRevision: 1,
    state: "enabled",
    definition: {
      kind: "user",
      spec: {
        name: "daily summary",
        enabled: true,
        priority: "normal",
        schedule: { kind: "interval", everyMs: 60_000 },
        action: { kind: "agent-turn", prompt: "summarize" },
      },
    },
  };
}

function skill(): SkillCatalogEntry {
  const entry: Omit<SkillCatalogEntry, "digest"> = {
    id: "skill-1",
    name: "Skill One",
    description: "A skill",
    source: "own",
    mode: "main",
    pinned: false,
    disabled: false,
    createdAt: NOW,
    usage: null,
    contentRef: { digest: DIGEST_A, bytes: 12 },
    revision: 1,
  };
  return {
    ...entry,
    digest: protocolDigest("SkillCatalogEntry", 1, entry),
  };
}

function config(): ConfigAssetRecord {
  const record = {
    v: 1 as const,
    domain: "guidance" as const,
    key: "default",
    revision: 1,
    schemaId: "GuidanceConfig",
    value: { enabled: true },
  };
  return {
    ...record,
    digest: protocolDigest("ConfigAssetRecord", 1, record),
  };
}

const scene = {
  id: "scene-1",
  revision: 1,
  name: "Scene One",
  createdAt: NOW,
  lastActiveAt: NOW,
};

const trustSnapshot = (() => {
  const unsigned = {
    v: 1 as const,
    snapshotVersion: 1,
    rules: [],
    generatedAt: NOW,
  };
  return {
    ...unsigned,
    digest: protocolDigest("TrustRuleSnapshot", 1, unsigned),
    signature: { alg: "test", keyId: "anchor", sig: "signed" },
  };
})();

describe("GlobalQuery strict request/result contract", () => {
  it("accepts every closed query/result variant and binds the result to its query", () => {
    const entry = memoryEntry();
    const cases: Array<[GlobalQuery, GlobalReadResult]> = [
      [
        { kind: "memory-search", scope: { kind: "personal" }, domain: "memory", query: "hello", limit: 1 },
        { kind: "memory-search", hits: [{ entry }] },
      ],
      [
        { kind: "memory-list", scope: { kind: "personal" }, domain: "memory", category: "profile" },
        { kind: "memory-list", entries: [entry] },
      ],
      [
        { kind: "memory-stats", scope: { kind: "personal" }, domain: "people" },
        { kind: "memory-stats", domain: "people", count: 0 },
      ],
      [{ kind: "trust-rules" }, { kind: "trust-rules", snapshot: trustSnapshot }],
      [{ kind: "schedule-list" }, { kind: "schedule-list", tasks: [task()] }],
      [{ kind: "workscene-list" }, { kind: "workscene-list", scenes: [scene] }],
      [{ kind: "workscene-get", sceneId: scene.id }, { kind: "workscene-get", scene }],
      [
        { kind: "skill-catalog", mode: "main", limit: 1 },
        { kind: "skill-catalog", catalogRevision: 1, entries: [skill()] },
      ],
      [
        { kind: "skill-get", skillId: "skill-1" },
        { kind: "skill-get", catalogRevision: 1, entry: skill() },
      ],
      [
        { kind: "config-asset", domain: "guidance", key: "default" },
        { kind: "config-asset", records: [config()] },
      ],
      [
        { kind: "asset-index", asset: "skills" },
        { kind: "asset-index", entries: [{ id: "skill-1", kind: "skills", revision: 1, digest: DIGEST_A }] },
      ],
    ];

    for (const [query, result] of cases) {
      expect(validateGlobalQuery(query)).toEqual(query);
      expect(validateGlobalQueryResult(query, result)).toEqual(result);
    }
  });

  it("rejects nested shape, digest, identity and query-binding violations", () => {
    const entry = memoryEntry();
    expect(() => validateGlobalQuery({ kind: "workscene-get", sceneId: "scene-1", extra: true }))
      .toThrow(/fields/u);
    expect(() => validateGlobalQueryResult(
      { kind: "memory-search", scope: { kind: "personal" }, domain: "people", query: "hello", limit: 1 },
      { kind: "memory-search", hits: [{ entry }] },
    )).toThrow(/bound/u);
    expect(() => validateGlobalQueryResult(
      { kind: "memory-list", scope: { kind: "personal" }, domain: "memory", category: "profile" },
      { kind: "memory-list", entries: [{ ...entry, digest: DIGEST_A }] },
    )).toThrow(/digest/u);
    expect(() => validateGlobalQuery({
      kind: "memory-list",
      scope: { kind: "personal" },
      domain: "memory",
    })).toThrow(/category/u);
    expect(() => validateGlobalQuery({
      kind: "memory-list",
      scope: { kind: "personal" },
      domain: "people",
      category: "person",
    })).toThrow(/category/u);
    expect(() => validateGlobalQueryResult(
      { kind: "memory-search", scope: { kind: "personal" }, domain: "people", query: "hello", limit: 1 },
      { kind: "memory-search", hits: [{ entry: { ...entry, domain: "people", category: undefined } }] },
    )).toThrow();
    expect(() => validateGlobalQueryResult(
      { kind: "workscene-get", sceneId: "scene-2" },
      { kind: "workscene-get", scene: { ...scene, workspace: { deviceId: "d", bindingRef: "b", path: "C:\\secret" } } },
    )).toThrow(/fields/u);
    expect(() => validateGlobalQueryResult(
      { kind: "skill-get", skillId: "skill-2" },
      { kind: "skill-get", catalogRevision: 1, entry: skill() },
    )).toThrow(/bound/u);
    expect(() => validateGlobalQueryResult(
      { kind: "config-asset", domain: "guidance", key: "other" },
      { kind: "config-asset", records: [config()] },
    )).toThrow(/bound/u);
    expect(() => validateGlobalQueryResult(
      { kind: "asset-index", asset: "rubrics" },
      { kind: "asset-index", entries: [{ id: "skill-1", kind: "skills", revision: 1, digest: DIGEST_A }] },
    )).toThrow(/bound/u);

    const accessorQuery = Object.defineProperty({}, "kind", {
      enumerable: true,
      get: () => "workscene-list",
    });
    expect(() => validateGlobalQuery(accessorQuery)).toThrow(/accessor/u);

    const accessorResult = {
      kind: "workscene-list",
      scenes: [Object.defineProperty({ ...scene }, "name", {
        enumerable: true,
        get: () => "Scene One",
      })],
    };
    expect(() => validateGlobalQueryResult(
      { kind: "workscene-list" },
      accessorResult,
    )).toThrow(/accessor/u);
  });

  it("rejects internal, deleted and unrequested disabled schedule definitions", () => {
    const disabled = task();
    disabled.state = "disabled";
    if (disabled.definition.kind !== "user") throw new Error("test fixture is invalid");
    disabled.definition.spec.enabled = false;
    expect(() => validateGlobalQueryResult(
      { kind: "schedule-list" },
      { kind: "schedule-list", tasks: [disabled] },
    )).toThrow();
    const deleted = task();
    deleted.state = "deleted";
    if (deleted.definition.kind !== "user") throw new Error("test fixture is invalid");
    deleted.definition.spec.enabled = false;
    expect(() => validateGlobalQueryResult(
      { kind: "schedule-list", includeDisabled: true },
      { kind: "schedule-list", tasks: [deleted] },
    )).toThrow(/internal or deleted/u);
  });
});
