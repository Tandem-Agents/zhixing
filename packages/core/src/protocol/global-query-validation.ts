import type {
  AssetIndexEntry,
  ConfigAssetRecord,
  GlobalQuery,
  GlobalReadResult,
  TaskDefinition,
} from "../contracts/state.js";
import {
  compareMemoryLogicalEntries,
  memoryLogicalEntryDigest,
  memoryLogicalEntryKey,
  memoryLogicalEntryMatches,
} from "../memory/logical-entry.js";
import type {
  MemoryCategoryDto,
  MemoryLogicalEntry,
  MemoryScopeRef,
} from "../memory/contracts.js";
import type { SkillCatalogEntry } from "../skills/types.js";
import type { JsonValue } from "../types/distributed.js";
import { protocolDigest } from "./canonical.js";
import { validateWorksceneDto } from "./contract-validation.js";
import { validateTaskDefinition } from "./job.js";
import { validateTrustRuleSnapshot } from "./permission-snapshot.js";
import { assertProtocolIdentifier } from "./validation.js";
import { canonicalMemoryIdentity } from "../memory/canonical-identity.js";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CONFIG_DOMAINS = new Set([
  "guidance",
  "channel-registry",
  "model-profile",
  "policy",
  "prompt-assets",
]);

/** The single strict request validator used by local and mesh GlobalQuery boundaries. */
export function validateGlobalQuery(input: unknown): GlobalQuery {
  const value = plainObject(validateJson(input, "Global query"), "Global query");
  const kind = identifier(value.kind, "Global query kind");
  switch (kind) {
    case "memory-search":
      exactKeys(value, ["domain", "kind", "limit", "query", "scope"]);
      return {
        kind,
        scope: memoryScope(value.scope),
        domain: memoryDomain(value.domain),
        query: string(value.query, "Memory query text"),
        limit: positiveInteger(value.limit, "Memory query limit"),
      };
    case "memory-list":
      exactKeys(value, ["domain", "kind", "scope"], ["category"]);
      {
        const domain = memoryDomain(value.domain);
        const category = value.category === undefined
          ? undefined
          : memoryCategory(value.category);
        if (
          (domain === "memory" && category !== "profile") ||
          (domain !== "memory" && category !== undefined)
        ) {
          throw new TypeError("Memory list category does not match its domain");
        }
        const scope = memoryScope(value.scope);
        return domain === "memory"
          ? { kind, scope, domain, category: "profile" }
          : { kind, scope, domain };
      }
    case "memory-stats": {
      exactKeys(value, ["domain", "kind", "scope"]);
      const domain = value.domain;
      if (domain !== "journal" && domain !== "people") {
        throw new TypeError("Memory stats domain is invalid");
      }
      return { kind, scope: memoryScope(value.scope), domain };
    }
    case "trust-rules":
      exactKeys(value, ["kind"], ["scope"]);
      return {
        kind,
        ...(value.scope === undefined
          ? {}
          : { scope: identifier(value.scope, "Trust scope") }),
      };
    case "schedule-list":
      exactKeys(value, ["kind"], ["includeDisabled"]);
      return {
        kind,
        ...(value.includeDisabled === undefined
          ? {}
          : {
              includeDisabled: boolean(
                value.includeDisabled,
                "Schedule disabled flag",
              ),
            }),
      };
    case "workscene-list":
      exactKeys(value, ["kind"]);
      return { kind };
    case "workscene-get":
      exactKeys(value, ["kind", "sceneId"]);
      return { kind, sceneId: identifier(value.sceneId, "Workscene id") };
    case "skill-catalog": {
      exactKeys(value, ["kind"], ["includeDisabled", "limit", "mode"]);
      const mode = value.mode;
      if (mode !== undefined && mode !== "main" && mode !== "work") {
        throw new TypeError("Skill catalog mode is invalid");
      }
      return {
        kind,
        ...(mode === undefined ? {} : { mode }),
        ...(value.includeDisabled === undefined
          ? {}
          : {
              includeDisabled: boolean(
                value.includeDisabled,
                "Skill disabled flag",
              ),
            }),
        ...(value.limit === undefined
          ? {}
          : { limit: positiveInteger(value.limit, "Skill catalog limit") }),
      };
    }
    case "skill-get":
      exactKeys(value, ["kind", "skillId"]);
      return { kind, skillId: identifier(value.skillId, "Skill id") };
    case "config-asset": {
      exactKeys(value, ["domain", "kind"], ["key"]);
      const domain = value.domain;
      if (typeof domain !== "string" || !CONFIG_DOMAINS.has(domain)) {
        throw new TypeError("Config asset domain is invalid");
      }
      return {
        kind,
        domain: domain as Extract<GlobalQuery, { kind: "config-asset" }>["domain"],
        ...(value.key === undefined
          ? {}
          : { key: identifier(value.key, "Config asset key") }),
      };
    }
    case "asset-index": {
      exactKeys(value, ["asset", "kind"]);
      const asset = value.asset;
      if (asset !== "skills" && asset !== "rubrics" && asset !== "prompt-assets") {
        throw new TypeError("Asset index kind is invalid");
      }
      return { kind, asset };
    }
    default:
      throw new TypeError("Global query kind is invalid");
  }
}

/**
 * Validates the complete response graph and binds it to the exact request.
 * It deliberately contains no transport policy so local and mesh paths share one predicate.
 */
export function validateGlobalQueryResult(
  queryInput: GlobalQuery | unknown,
  input: unknown,
): GlobalReadResult {
  const query = validateGlobalQuery(queryInput);
  const value = plainObject(
    validateJson(input, "Global query result"),
    "Global query result",
  );
  if (value.kind !== query.kind) {
    throw new TypeError("Global query response kind mismatch");
  }
  switch (query.kind) {
    case "memory-search": {
      exactKeys(value, ["hits", "kind"]);
      const hits = denseArray(value.hits, "Memory search hits").map((input, index) => {
        const hit = plainObject(input, `Memory search hit ${index}`);
        exactKeys(hit, ["entry"], ["score"]);
        const entry = memoryEntry(hit.entry, `Memory search hit ${index}`);
        if (!memoryLogicalEntryMatches(entry, query)) {
          throw new TypeError("Memory search hit is not bound to its query");
        }
        if (hit.score !== undefined) finiteNumber(hit.score, "Memory search score");
        return {
          entry,
          ...(hit.score === undefined ? {} : { score: hit.score as number }),
        };
      });
      if (hits.length > query.limit) {
        throw new TypeError("Memory search result exceeds its query limit");
      }
      assertUnique(hits.map((hit) => memoryLogicalEntryKey(hit.entry)), "Memory search hits");
      assertSorted(
        hits.map((hit) => hit.entry),
        compareMemoryLogicalEntries,
        "Memory search hits",
      );
      return { kind: query.kind, hits };
    }
    case "memory-list": {
      exactKeys(value, ["entries", "kind"]);
      const entries = denseArray(value.entries, "Memory list entries").map((input, index) => {
        const entry = memoryEntry(input, `Memory list entry ${index}`);
        if (!memoryLogicalEntryMatches(entry, query)) {
          throw new TypeError("Memory list entry is not bound to its query");
        }
        return entry;
      });
      assertUnique(entries.map(memoryLogicalEntryKey), "Memory list entries");
      assertSorted(entries, compareMemoryLogicalEntries, "Memory list entries");
      return { kind: query.kind, entries };
    }
    case "memory-stats": {
      exactKeys(value, ["count", "domain", "kind"], ["lastWriteAt"]);
      if (value.domain !== query.domain) {
        throw new TypeError("Memory stats domain is not bound to its query");
      }
      const count = nonNegativeInteger(value.count, "Memory stats count");
      return {
        kind: query.kind,
        domain: query.domain,
        count,
        ...(value.lastWriteAt === undefined
          ? {}
          : { lastWriteAt: canonicalTime(value.lastWriteAt, "Memory last write time") }),
      };
    }
    case "trust-rules": {
      exactKeys(value, ["kind", "snapshot"]);
      const snapshot = validateTrustRuleSnapshot(value.snapshot);
      if (
        query.scope !== undefined &&
        snapshot.rules.some((rule) => rule.scope !== query.scope)
      ) {
        throw new TypeError("Trust rule snapshot is not bound to its query scope");
      }
      return { kind: query.kind, snapshot };
    }
    case "schedule-list": {
      exactKeys(value, ["kind", "tasks"]);
      const tasks = denseArray(value.tasks, "Schedule tasks").map((input) =>
        validateTaskDefinition(input as TaskDefinition)
      );
      for (const task of tasks) {
        if (task.definition.kind !== "user" || task.state === "deleted") {
          throw new TypeError("Schedule query exposed an internal or deleted task");
        }
        if (!query.includeDisabled && task.state !== "enabled") {
          throw new TypeError("Schedule query exposed a disabled task");
        }
      }
      assertUnique(tasks.map((task) => task.taskId), "Schedule tasks");
      assertSorted(tasks, (left, right) => left.taskId.localeCompare(right.taskId, "en-US"), "Schedule tasks");
      return { kind: query.kind, tasks };
    }
    case "workscene-list": {
      exactKeys(value, ["kind", "scenes"]);
      const scenes = denseArray(value.scenes, "Workscene list").map((scene) =>
        validateWorksceneDto(scene)
      );
      assertUnique(scenes.map((scene) => scene.id), "Workscene list");
      return { kind: query.kind, scenes };
    }
    case "workscene-get": {
      exactKeys(value, ["kind", "scene"]);
      const scene = value.scene === null ? null : validateWorksceneDto(value.scene);
      if (scene !== null && scene.id !== query.sceneId) {
        throw new TypeError("Workscene result is not bound to its query id");
      }
      return { kind: query.kind, scene };
    }
    case "skill-catalog": {
      exactKeys(value, ["catalogRevision", "entries", "kind"]);
      const catalogRevision = nonNegativeInteger(
        value.catalogRevision,
        "Skill catalog revision",
      );
      const entries = denseArray(value.entries, "Skill catalog entries").map((entry) =>
        skillEntry(entry)
      );
      for (const entry of entries) {
        if (
          entry.revision > catalogRevision ||
          (query.mode !== undefined && entry.mode !== query.mode) ||
          (!query.includeDisabled && entry.disabled)
        ) {
          throw new TypeError("Skill catalog entry is not bound to its query");
        }
      }
      if (query.limit !== undefined && entries.length > query.limit) {
        throw new TypeError("Skill catalog exceeds its query limit");
      }
      assertUnique(entries.map((entry) => entry.id), "Skill catalog entries");
      assertSorted(entries, compareSkillEntries, "Skill catalog entries");
      return { kind: query.kind, catalogRevision, entries };
    }
    case "skill-get": {
      exactKeys(value, ["catalogRevision", "entry", "kind"]);
      const catalogRevision = nonNegativeInteger(
        value.catalogRevision,
        "Skill catalog revision",
      );
      const entry = value.entry === null ? null : skillEntry(value.entry);
      if (
        entry !== null &&
        (entry.id !== query.skillId || entry.revision > catalogRevision)
      ) {
        throw new TypeError("Skill result is not bound to its query id");
      }
      return { kind: query.kind, catalogRevision, entry };
    }
    case "config-asset": {
      exactKeys(value, ["kind", "records"]);
      const records = denseArray(value.records, "Config asset records").map((record) =>
        configAssetRecord(record)
      );
      for (const record of records) {
        if (
          record.domain !== query.domain ||
          (query.key !== undefined && record.key !== query.key)
        ) {
          throw new TypeError("Config asset record is not bound to its query");
        }
      }
      assertUnique(records.map((record) => `${record.domain}\0${record.key}`), "Config asset records");
      return { kind: query.kind, records };
    }
    case "asset-index": {
      exactKeys(value, ["entries", "kind"]);
      const entries = denseArray(value.entries, "Asset index entries").map((entry) =>
        assetIndexEntry(entry)
      );
      if (entries.some((entry) => entry.kind !== query.asset)) {
        throw new TypeError("Asset index entry is not bound to its query kind");
      }
      assertUnique(entries.map((entry) => entry.id), "Asset index entries");
      return { kind: query.kind, entries };
    }
  }
}

function memoryEntry(input: unknown, label: string): MemoryLogicalEntry {
  const value = plainObject(input, label);
  exactKeys(
    value,
    ["content", "digest", "domain", "id", "meta", "revision", "scope"],
    ["category", "updatedAt"],
  );
  const domain = memoryDomain(value.domain);
  const scope = memoryScope(value.scope);
  const category = value.category === undefined
    ? undefined
    : memoryCategory(value.category);
  const id = identifier(value.id, `${label} id`);
  const canonicalIdentity = canonicalMemoryIdentity(
    { domain, category, id },
    { allowJournalMonth: true },
  );
  const meta = plainObject(value.meta, `${label} metadata`);
  validateJson(meta, `${label} metadata`);
  const content = string(value.content, `${label} content`);
  const revision = positiveInteger(value.revision, `${label} revision`);
  const digest = assertDigest(value.digest, `${label} digest`);
  const identity = {
    ...canonicalIdentity,
    scope,
    meta: meta as Record<string, JsonValue>,
    content,
  };
  if (digest !== memoryLogicalEntryDigest(identity)) {
    throw new TypeError(`${label} digest is invalid`);
  }
  return {
    ...identity,
    revision,
    digest,
    ...(value.updatedAt === undefined
      ? {}
      : { updatedAt: canonicalTime(value.updatedAt, `${label} updatedAt`) }),
  };
}

function skillEntry(input: unknown): SkillCatalogEntry {
  const value = plainObject(input, "Skill catalog entry");
  exactKeys(value, [
    "contentRef",
    "createdAt",
    "description",
    "digest",
    "disabled",
    "id",
    "mode",
    "name",
    "pinned",
    "revision",
    "source",
    "usage",
  ]);
  const id = identifier(value.id, "Skill id");
  const name = identifier(value.name, "Skill name");
  const description = string(value.description, "Skill description");
  if (value.source !== "own" && value.source !== "linked") {
    throw new TypeError("Skill source is invalid");
  }
  if (value.mode !== "main" && value.mode !== "work") {
    throw new TypeError("Skill mode is invalid");
  }
  const createdAt = canonicalTime(value.createdAt, "Skill creation time");
  const usage = value.usage === null ? null : skillUsage(value.usage);
  const entry = {
    id,
    name,
    description,
    source: value.source,
    mode: value.mode,
    pinned: boolean(value.pinned, "Skill pinned flag"),
    disabled: boolean(value.disabled, "Skill disabled flag"),
    createdAt,
    usage,
    contentRef: artifactRef(value.contentRef, "Skill content reference"),
    revision: positiveInteger(value.revision, "Skill revision"),
  } satisfies Omit<SkillCatalogEntry, "digest">;
  const digest = assertDigest(value.digest, "Skill digest");
  if (digest !== protocolDigest("SkillCatalogEntry", 1, entry)) {
    throw new TypeError("Skill digest is invalid");
  }
  return { ...entry, digest };
}

function skillUsage(input: unknown): SkillCatalogEntry["usage"] {
  const value = plainObject(input, "Skill usage");
  exactKeys(value, ["hitCount", "lastHitAt"]);
  return {
    lastHitAt: canonicalTime(value.lastHitAt, "Skill last hit time"),
    hitCount: nonNegativeInteger(value.hitCount, "Skill hit count"),
  };
}

function configAssetRecord(input: unknown): ConfigAssetRecord {
  const value = plainObject(input, "Config asset record");
  exactKeys(value, ["digest", "domain", "key", "revision", "schemaId", "v", "value"]);
  if (value.v !== 1) throw new TypeError("Config asset version is invalid");
  if (typeof value.domain !== "string" || !CONFIG_DOMAINS.has(value.domain)) {
    throw new TypeError("Config asset domain is invalid");
  }
  const record = {
    v: 1 as const,
    domain: value.domain as ConfigAssetRecord["domain"],
    key: identifier(value.key, "Config asset key"),
    revision: positiveInteger(value.revision, "Config asset revision"),
    schemaId: identifier(value.schemaId, "Config asset schema id"),
    value: validateJson(value.value, "Config asset value"),
  };
  const digest = assertDigest(value.digest, "Config asset digest");
  if (digest !== protocolDigest("ConfigAssetRecord", 1, record)) {
    throw new TypeError("Config asset digest is invalid");
  }
  return { ...record, digest };
}

function assetIndexEntry(input: unknown): AssetIndexEntry {
  const value = plainObject(input, "Asset index entry");
  exactKeys(value, ["digest", "id", "kind", "revision"]);
  if (value.kind !== "skills" && value.kind !== "rubrics" && value.kind !== "prompt-assets") {
    throw new TypeError("Asset index entry kind is invalid");
  }
  return {
    id: identifier(value.id, "Asset index id"),
    kind: value.kind,
    revision: positiveInteger(value.revision, "Asset index revision"),
    digest: assertDigest(value.digest, "Asset index digest"),
  };
}

function memoryScope(input: unknown): MemoryScopeRef {
  const value = plainObject(input, "Memory scope");
  if (value.kind === "personal") {
    exactKeys(value, ["kind"]);
    return { kind: "personal" };
  }
  if (value.kind === "workscene") {
    exactKeys(value, ["kind", "sceneId"]);
    return { kind: "workscene", sceneId: identifier(value.sceneId, "Memory scene id") };
  }
  throw new TypeError("Memory scope kind is invalid");
}

function memoryDomain(input: unknown): MemoryLogicalEntry["domain"] {
  if (input !== "memory" && input !== "journal" && input !== "people") {
    throw new TypeError("Memory domain is invalid");
  }
  return input;
}

function memoryCategory(input: unknown): MemoryCategoryDto {
  if (input !== "profile" && input !== "person" && input !== "journal") {
    throw new TypeError("Memory category is invalid");
  }
  return input;
}

function artifactRef(input: unknown, label: string): { digest: string; bytes: number } {
  const value = plainObject(input, label);
  exactKeys(value, ["bytes", "digest"]);
  return {
    digest: assertDigest(value.digest, `${label} digest`),
    bytes: nonNegativeInteger(value.bytes, `${label} bytes`),
  };
}

function compareSkillEntries(left: SkillCatalogEntry, right: SkillCatalogEntry): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const leftAt = left.usage?.lastHitAt ?? left.createdAt;
  const rightAt = right.usage?.lastHitAt ?? right.createdAt;
  if (leftAt !== rightAt) return leftAt < rightAt ? 1 : -1;
  return (right.usage?.hitCount ?? 0) - (left.usage?.hitCount ?? 0) ||
    left.id.localeCompare(right.id);
}

function validateJson(input: unknown, label: string): JsonValue {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean"
  ) {
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new TypeError(`${label} contains a non-finite number`);
    return input;
  }
  if (Array.isArray(input)) {
    if (Object.keys(input).length !== input.length) {
      throw new TypeError(`${label} contains a sparse or extended array`);
    }
    return input.map((item, index) => validateJson(item, `${label}[${index}]`));
  }
  const value = plainObject(input, label);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, validateJson(item, `${label}.${key}`)]),
  );
}

function plainObject(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(input));
  if (descriptors.some((descriptor) => descriptor.get || descriptor.set || !descriptor.enumerable)) {
    throw new TypeError(`${label} contains an accessor or hidden field`);
  }
  return input as Record<string, unknown>;
}

function denseArray(input: unknown, label: string): unknown[] {
  if (!Array.isArray(input) || Object.keys(input).length !== input.length) {
    throw new TypeError(`${label} must be a dense array`);
  }
  return input;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.has(key)) ||
    required.some((key) => !(key in value))
  ) {
    throw new TypeError("Protocol object fields are incomplete or unknown");
  }
}

function identifier(input: unknown, label: string): string {
  assertProtocolIdentifier(input, label);
  return input;
}

function string(input: unknown, label: string): string {
  if (typeof input !== "string") throw new TypeError(`${label} must be a string`);
  return input;
}

function boolean(input: unknown, label: string): boolean {
  if (typeof input !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return input;
}

function positiveInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return input as number;
}

function nonNegativeInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return input as number;
}

function finiteNumber(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new TypeError(`${label} must be finite`);
  }
  return input;
}

function canonicalTime(input: unknown, label: string): string {
  if (typeof input !== "string") throw new TypeError(`${label} must be a string`);
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== input) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return input;
}

function assertDigest(input: unknown, label: string): string {
  if (typeof input !== "string" || !DIGEST_PATTERN.test(input)) {
    throw new TypeError(`${label} is invalid`);
  }
  return input;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} contain duplicate identities`);
  }
}

function assertSorted<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
  label: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1]!, values[index]!) > 0) {
      throw new TypeError(`${label} are not in canonical order`);
    }
  }
}
