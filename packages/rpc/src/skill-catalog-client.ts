import type {
  SkillCatalogChangedFact,
  SkillCatalogClient,
  SkillCatalogCommand,
  SkillCatalogEntry,
  SkillCatalogQuery,
  SkillCatalogStatePatch,
  SkillCatalogView,
} from "@zhixing/core/skills/catalog";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

/** Minimal request capability supplied by a Surface connection lifecycle. */
export interface SkillCatalogRpcRequestPort {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/** Transport lifecycle boundary required by the Skill Product API RPC binding. */
export interface SkillCatalogRpcTransportPort {
  getClient(): Promise<SkillCatalogRpcRequestPort>;
  onNotification(
    method: string,
    handler: (payload: unknown) => void,
  ): () => void;
}

/** The single RPC binding for the Skill-owned management client contract. */
export class SkillCatalogRpcClient implements SkillCatalogClient {
  constructor(private readonly link: SkillCatalogRpcTransportPort) {}

  async query(query: SkillCatalogQuery): Promise<SkillCatalogView> {
    if (!isPlainRecord(query) || !hasExactKeys(query, ["kind"]) || query.kind !== "list") {
      throw new TypeError("Unsupported Skill Catalog query");
    }
    const client = await this.link.getClient();
    return decodeSkillCatalogView(await client.request<unknown>("skill.list"));
  }

  async command(command: SkillCatalogCommand): Promise<void> {
    switch (command.kind) {
      case "set-state": {
        const skillId = requireIdentifier(command.skillId, "Skill command id");
        const patch = encodeStatePatch(command.patch);
        const client = await this.link.getClient();
        decodeCommandAcknowledgement(
          await client.request<unknown>("skill.setState", { skillId, ...patch }),
        );
        return;
      }
      case "archive": {
        const skillId = requireIdentifier(command.skillId, "Skill command id");
        const client = await this.link.getClient();
        decodeCommandAcknowledgement(
          await client.request<unknown>("skill.archive", { skillId }),
        );
        return;
      }
      default:
        throw new TypeError("Unsupported Skill Catalog command");
    }
  }

  onFact(handler: (fact: SkillCatalogChangedFact) => void): () => void {
    return this.link.onNotification("skill.changed", (payload) => {
      handler(decodeSkillCatalogChangedFact(payload));
    });
  }
}

function decodeSkillCatalogView(input: unknown): SkillCatalogView {
  const value = requirePlainRecord(input, "Skill Catalog list response");
  requireExactKeys(value, ["skills", "structuralVersion"]);
  if (!Array.isArray(value.skills) || Object.keys(value.skills).length !== value.skills.length) {
    throw new TypeError("Skill Catalog list response skills must be a dense array");
  }
  const entries = Object.freeze(value.skills.map(decodeSkillCatalogEntry));
  const catalogRevision = requireNonNegativeInteger(
    value.structuralVersion,
    "Skill Catalog structural version",
  );
  return Object.freeze({ entries, catalogRevision });
}

function decodeSkillCatalogEntry(input: unknown): SkillCatalogEntry {
  const value = requirePlainRecord(input, "Skill Catalog entry");
  requireExactKeys(value, [
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
  const contentRef = requirePlainRecord(value.contentRef, "Skill content reference");
  requireExactKeys(contentRef, ["bytes", "digest"]);
  const usage = value.usage === null ? null : decodeSkillUsage(value.usage);
  if (value.source !== "own" && value.source !== "linked") {
    throw new TypeError("Skill source is invalid");
  }
  if (value.mode !== "main" && value.mode !== "work") {
    throw new TypeError("Skill mode is invalid");
  }
  if (typeof value.description !== "string") {
    throw new TypeError("Skill description must be a string");
  }
  if (typeof value.pinned !== "boolean" || typeof value.disabled !== "boolean") {
    throw new TypeError("Skill state flags must be boolean");
  }
  return Object.freeze({
    id: requireIdentifier(value.id, "Skill id"),
    name: requireIdentifier(value.name, "Skill name"),
    description: value.description,
    source: value.source,
    mode: value.mode,
    pinned: value.pinned,
    disabled: value.disabled,
    createdAt: requireCanonicalTime(value.createdAt, "Skill creation time"),
    usage,
    contentRef: Object.freeze({
      digest: requireDigest(contentRef.digest, "Skill content digest"),
      bytes: requireNonNegativeInteger(contentRef.bytes, "Skill content bytes"),
    }),
    revision: requirePositiveInteger(value.revision, "Skill revision"),
    digest: requireDigest(value.digest, "Skill digest"),
  });
}

function decodeSkillUsage(input: unknown): NonNullable<SkillCatalogEntry["usage"]> {
  const value = requirePlainRecord(input, "Skill usage");
  requireExactKeys(value, ["hitCount", "lastHitAt"]);
  return Object.freeze({
    lastHitAt: requireCanonicalTime(value.lastHitAt, "Skill last hit time"),
    hitCount: requireNonNegativeInteger(value.hitCount, "Skill hit count"),
  });
}

function encodeStatePatch(patch: SkillCatalogStatePatch): SkillCatalogStatePatch {
  const value = requirePlainRecord(patch, "Skill state patch");
  const keys = Object.keys(value);
  if (
    keys.length === 0 ||
    keys.some((key) => !["disabled", "mode", "pinned"].includes(key)) ||
    (value.mode !== undefined && value.mode !== "main" && value.mode !== "work") ||
    (value.pinned !== undefined && typeof value.pinned !== "boolean") ||
    (value.disabled !== undefined && typeof value.disabled !== "boolean")
  ) {
    throw new TypeError("Skill state patch is invalid");
  }
  return Object.freeze({
    ...(value.mode === undefined ? {} : { mode: value.mode }),
    ...(value.pinned === undefined ? {} : { pinned: value.pinned }),
    ...(value.disabled === undefined ? {} : { disabled: value.disabled }),
  });
}

function decodeCommandAcknowledgement(input: unknown): void {
  const value = requirePlainRecord(input, "Skill command response");
  requireExactKeys(value, ["ok"]);
  if (value.ok !== true) throw new TypeError("Skill command response is invalid");
}

function decodeSkillCatalogChangedFact(input: unknown): SkillCatalogChangedFact {
  const value = requirePlainRecord(input, "Skill changed notification");
  requireExactKeys(value, ["structuralVersion"]);
  return Object.freeze({
    kind: "skill-catalog-changed",
    catalogRevision: requireNonNegativeInteger(
      value.structuralVersion,
      "Skill changed structural version",
    ),
  });
}

function requirePlainRecord(input: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(input)) throw new TypeError(`${label} must be a plain object`);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(input));
  if (descriptors.some((descriptor) => descriptor.get || descriptor.set || !descriptor.enumerable)) {
    throw new TypeError(`${label} contains an accessor or hidden field`);
  }
  return input;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (!hasExactKeys(value, expected)) {
    throw new TypeError("Protocol object fields are incomplete or unknown");
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function requireIdentifier(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 480) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
  return input;
}

function requirePositiveInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return input as number;
}

function requireNonNegativeInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return input as number;
}

function requireCanonicalTime(input: unknown, label: string): string {
  if (typeof input !== "string") throw new TypeError(`${label} must be a string`);
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== input) {
    throw new TypeError(`${label} must be a canonical ISO timestamp`);
  }
  return input;
}

function requireDigest(input: unknown, label: string): string {
  if (typeof input !== "string" || !DIGEST_PATTERN.test(input)) {
    throw new TypeError(`${label} is invalid`);
  }
  return input;
}
