import type {
  AssignmentGlobalQueryPort,
  AuthorityCapability,
  GlobalQuery,
  GlobalReadResult,
  GlobalStatePort,
} from "@zhixing/core/contracts";
import {
  canonicalize,
  protocolDigest,
  validateAuthorityCapability,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type { MeshServiceRegistry } from "@zhixing/mesh/service-registry";

const GLOBAL_QUERY_SERVICE = "authority.global.read";

type GlobalQueryRequest = {
  readonly query: GlobalQuery;
  readonly capability: AuthorityCapability;
  readonly anchorEpoch: number;
  readonly requestId: string;
  readonly deadlineAt: string;
};

/** Authenticated, path-free assignment read facade for remote executors. */
export class MeshAssignmentGlobalQueryPort implements AssignmentGlobalQueryPort {
  constructor(
    private readonly client: MeshServiceClient,
    private readonly capability: AuthorityCapability,
    private readonly anchorEpoch: number,
  ) {}

  async read(query: GlobalQuery): Promise<GlobalReadResult> {
    const request: GlobalQueryRequest = {
      query: validateQuery(query),
      capability: this.capability,
      anchorEpoch: this.anchorEpoch,
      requestId: `global-read:${protocolDigest("AssignmentGlobalQuery", 1, query)}`,
      deadlineAt: this.capability.expiry,
    };
    return validateResult(
      decode(await this.client.request(GLOBAL_QUERY_SERVICE, encode(request))),
      query.kind,
    );
  }
}

export function registerGlobalQueryMeshService(
  registry: MeshServiceRegistry,
  state: GlobalStatePort,
  verifier: ProtocolSignatureVerifier,
  executorIdForPeer: (deviceId: string) => string | undefined,
): () => void {
  return registry.register(GLOBAL_QUERY_SERVICE, {
    access: "read",
    availability: "negotiated-version",
    authorize: (connection) => executorIdForPeer(connection.peer.deviceId) !== undefined,
    handler: async (payload, connection, signal) => {
      signal.throwIfAborted();
      const request = validateRequest(decode(payload), verifier);
      if (executorIdForPeer(connection.peer.deviceId) !== request.capability.executorId) {
        throw new Error("Global query capability is bound to another executor");
      }
      const result = await state.read(request.query, {
        principal: { kind: "assignment", capability: request.capability },
        requestId: request.requestId,
        deadlineAt: request.deadlineAt,
        authority: { domain: "global", anchorEpoch: request.anchorEpoch },
      });
      signal.throwIfAborted();
      return encode(validateResult(result, request.query.kind));
    },
  });
}

function validateRequest(
  input: unknown,
  verifier: ProtocolSignatureVerifier,
): GlobalQueryRequest {
  const value = object(input, "Global query request");
  exactKeys(value, ["query", "capability", "anchorEpoch", "requestId", "deadlineAt"]);
  const capability = validateAuthorityCapability(value.capability, verifier);
  const anchorEpoch = positiveInteger(value.anchorEpoch, "Global query anchor epoch");
  if (
    ("ownerEpoch" in capability && capability.ownerEpoch !== anchorEpoch) ||
    ("anchorEpoch" in capability && capability.anchorEpoch !== anchorEpoch)
  ) {
    throw new TypeError("Global query authority fence is not capability-bound");
  }
  return {
    query: validateQuery(value.query),
    capability,
    anchorEpoch,
    requestId: nonEmptyString(value.requestId, "Global query request id"),
    deadlineAt: isoTime(value.deadlineAt, "Global query deadline"),
  };
}

function validateQuery(input: unknown): GlobalQuery {
  const value = object(input, "Global query");
  const kind = nonEmptyString(value.kind, "Global query kind");
  if (kind === "memory-search") {
    exactKeys(value, ["kind", "scope", "domain", "query", "limit"]);
    return {
      kind,
      scope: memoryScope(value.scope),
      domain: memoryDomain(value.domain),
      query: typeof value.query === "string" ? value.query : invalid("Memory query text"),
      limit: positiveInteger(value.limit, "Memory query limit"),
    };
  }
  if (kind === "memory-list") {
    exactKeys(value, ["kind", "scope", "domain", "category"], ["category"]);
    return {
      kind,
      scope: memoryScope(value.scope),
      domain: memoryDomain(value.domain),
      ...(value.category === undefined ? {} : { category: memoryCategory(value.category) }),
    };
  }
  if (kind === "memory-stats") {
    exactKeys(value, ["kind", "scope", "domain"]);
    const domain = value.domain;
    if (domain !== "journal" && domain !== "people") invalid("Memory stats domain");
    return { kind, scope: memoryScope(value.scope), domain };
  }
  if (kind === "trust-rules") {
    exactKeys(value, ["kind", "scope"], ["scope"]);
    return { kind, ...(value.scope === undefined ? {} : { scope: nonEmptyString(value.scope, "Trust scope") }) };
  }
  if (kind === "schedule-list") {
    exactKeys(value, ["kind", "includeDisabled"], ["includeDisabled"]);
    return { kind, ...(value.includeDisabled === undefined ? {} : { includeDisabled: boolean(value.includeDisabled, "Schedule disabled flag") }) };
  }
  if (kind === "workscene-list") {
    exactKeys(value, ["kind"]);
    return { kind };
  }
  if (kind === "workscene-get") {
    exactKeys(value, ["kind", "sceneId"]);
    return { kind, sceneId: nonEmptyString(value.sceneId, "Workscene id") };
  }
  if (kind === "skill-catalog") {
    exactKeys(value, ["kind", "mode", "includeDisabled", "limit"], [
      "mode",
      "includeDisabled",
      "limit",
    ]);
    const mode = value.mode;
    if (mode !== undefined && mode !== "main" && mode !== "work") {
      invalid("Skill catalog mode");
    }
    return {
      kind,
      ...(mode === undefined ? {} : { mode }),
      ...(value.includeDisabled === undefined
        ? {}
        : { includeDisabled: boolean(value.includeDisabled, "Skill disabled flag") }),
      ...(value.limit === undefined
        ? {}
        : { limit: positiveInteger(value.limit, "Skill catalog limit") }),
    };
  }
  if (kind === "skill-get") {
    exactKeys(value, ["kind", "skillId"]);
    return { kind, skillId: nonEmptyString(value.skillId, "Skill id") };
  }
  if (kind === "config-asset") {
    exactKeys(value, ["kind", "domain", "key"], ["key"]);
    const domain = value.domain;
    if (!["guidance", "channel-registry", "model-profile", "policy", "prompt-assets"].includes(String(domain))) {
      invalid("Config asset domain");
    }
    return { kind, domain: domain as Extract<GlobalQuery, { kind: "config-asset" }>["domain"], ...(value.key === undefined ? {} : { key: nonEmptyString(value.key, "Config asset key") }) };
  }
  if (kind === "asset-index") {
    exactKeys(value, ["kind", "asset"]);
    const asset = value.asset;
    if (asset !== "skills" && asset !== "rubrics" && asset !== "prompt-assets") invalid("Asset index kind");
    return { kind, asset };
  }
  return invalid("Global query kind");
}

function validateResult(input: unknown, expectedKind: GlobalQuery["kind"]): GlobalReadResult {
  const value = object(input, "Global query result");
  if (value.kind !== expectedKind) throw new TypeError("Global query response kind mismatch");
  return structuredClone(value) as unknown as GlobalReadResult;
}

function memoryScope(input: unknown): Extract<GlobalQuery, { kind: "memory-list" }>["scope"] {
  const value = object(input, "Memory scope");
  if (value.kind === "personal") {
    exactKeys(value, ["kind"]);
    return { kind: "personal" };
  }
  if (value.kind === "workscene") {
    exactKeys(value, ["kind", "sceneId"]);
    return { kind: "workscene", sceneId: nonEmptyString(value.sceneId, "Memory scene id") };
  }
  return invalid("Memory scope kind");
}

function memoryDomain(input: unknown): "memory" | "journal" | "people" {
  if (input !== "memory" && input !== "journal" && input !== "people") invalid("Memory domain");
  return input;
}

function memoryCategory(input: unknown): "profile" | "person" | "journal" {
  if (input !== "profile" && input !== "person" && input !== "journal") invalid("Memory category");
  return input;
}

function object(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid(label);
  return input as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], optional: readonly string[] = []): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || allowed.some((key) => !optional.includes(key) && !(key in value))) {
    throw new TypeError("Protocol object has invalid keys");
  }
}

function nonEmptyString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.trim().length === 0) invalid(label);
  return input;
}

function positiveInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || Number(input) <= 0) invalid(label);
  return Number(input);
}

function isoTime(input: unknown, label: string): string {
  const value = nonEmptyString(input, label);
  if (!Number.isFinite(Date.parse(value))) invalid(label);
  return value;
}

function boolean(input: unknown, label: string): boolean {
  if (typeof input !== "boolean") invalid(label);
  return input;
}

function invalid(label: string): never {
  throw new TypeError(`${label} is invalid`);
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(canonicalize(value), "utf8");
}

function decode(bytes: Uint8Array): unknown {
  const text = Buffer.from(bytes).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TypeError("Global query payload is not JSON");
  }
  if (canonicalize(value) !== text) throw new TypeError("Global query payload is not canonical");
  return value;
}
