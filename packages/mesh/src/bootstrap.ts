import { createHmac, hkdfSync } from "node:crypto";
import type {
  BlindRendezvousHello,
  DeviceRole,
  HomeTrustRecord,
  MeshEndpointDescriptor,
  MeshEndpointTransport,
  MeshRoleBootConfig,
  RendezvousKey,
  SecretStorePort,
} from "@zhixing/core/contracts";
import { canonicalize } from "./canonical.js";
import { MeshProtocolError } from "./errors.js";
import type { MeshServiceClient } from "./request-channel.js";
import { MeshRequestChannel } from "./request-channel.js";
import type { SecureMeshConnection } from "./session.js";
import { MeshServiceRegistry } from "./service-registry.js";

export const MESH_ENDPOINT_SERVICE_ID = "mesh.endpoint";
export const MAX_RENDEZVOUS_TTL_MS = 3_600_000;
export const RENDEZVOUS_WINDOW_MS = 24 * 60 * 60_000;
const RENDEZVOUS_KEY = /^rzv:[a-f0-9]{64}$/u;
const DEVICE_ID = /^[^\u0000-\u001f\u007f]{1,480}$/u;
const HOST = /^[^\u0000-\u001f\u007f]{1,255}$/u;
const PAIRWISE_INFO = Buffer.from("zhixing:rendezvous:pairwise:v1", "utf8");
const CONTROL_KEY_DOMAIN = Buffer.from("zhixing:rendezvous:v1", "utf8");

export interface EffectiveMeshRoles {
  readonly mode: "single-machine" | "trusted-home";
  readonly roles: readonly DeviceRole[];
}

export type HostLaunchMode = "managed" | "on-demand" | "none";

export interface HostLaunchPlan {
  readonly mode: HostLaunchMode;
  readonly roles: readonly DeviceRole[];
}

export type HostLaunchPlanErrorCode =
  | "configuration-invalid"
  | "identity-ambiguous"
  | "member-inactive"
  | "role-unauthorized"
  | "anchor-authority-conflict";

export class HostLaunchPlanError extends Error {
  constructor(
    readonly code: HostLaunchPlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostLaunchPlanError";
  }
}

/**
 * Resolves only how the existing host composition root is launched. The
 * returned roles are the complete configured role set and are never trimmed.
 */
export function resolveHostLaunchPlan(input: {
  readonly localDeviceId: string;
  readonly configuration?: MeshRoleBootConfig;
  readonly trust?: HomeTrustRecord;
}): HostLaunchPlan {
  assertDeviceId(input.localDeviceId, "Local mesh device id");
  if (!input.trust) {
    if (input.configuration !== undefined) {
      try {
        validateMeshRoleBootConfig(input.configuration);
      } catch (error) {
        throw new HostLaunchPlanError(
          "configuration-invalid",
          error instanceof Error ? error.message : "Mesh role configuration is invalid",
        );
      }
    }
    return Object.freeze({
      mode: "on-demand" as const,
      roles: Object.freeze(["anchor", "executor"] as DeviceRole[]),
    });
  }

  let configuration: MeshRoleBootConfig;
  try {
    configuration = validateMeshRoleBootConfig(input.configuration);
  } catch (error) {
    throw new HostLaunchPlanError(
      "configuration-invalid",
      error instanceof Error ? error.message : "Mesh role configuration is invalid",
    );
  }
  const matches = input.trust.members.filter(
    (candidate) => candidate.device.deviceId === input.localDeviceId,
  );
  if (matches.length !== 1) {
    throw new HostLaunchPlanError(
      "identity-ambiguous",
      "Local mesh device identity must occur exactly once in current trust",
    );
  }
  const member = matches[0]!;
  if (member.state !== "active") {
    throw new HostLaunchPlanError(
      "member-inactive",
      "Local mesh device is not an active member of current trust",
    );
  }
  const authorized = new Set(member.roles);
  for (const role of configuration.enabledRoles) {
    if (!authorized.has(role)) {
      throw new HostLaunchPlanError(
        "role-unauthorized",
        `Local mesh role is not authorized by current trust: ${role}`,
      );
    }
  }

  const roles = Object.freeze([...configuration.enabledRoles]);
  const roleSet = new Set(roles);
  const isCurrentAnchor = input.trust.issuer.deviceId === input.localDeviceId;
  if (isCurrentAnchor && !authorized.has("anchor")) {
    throw new HostLaunchPlanError(
      "anchor-authority-conflict",
      "Current mesh issuer is not authorized for the anchor role",
    );
  }
  if (!isCurrentAnchor && roleSet.has("anchor")) {
    throw new HostLaunchPlanError(
      "anchor-authority-conflict",
      "A non-current device cannot launch the anchor role",
    );
  }
  if (isCurrentAnchor && roleSet.has("anchor")) {
    return Object.freeze({ mode: "managed" as const, roles });
  }
  if (roleSet.has("executor")) {
    return Object.freeze({
      mode: configuration.executorAutoStart === true ? "managed" as const : "on-demand" as const,
      roles,
    });
  }
  return Object.freeze({ mode: "none" as const, roles });
}

export function resolveEffectiveMeshRoles(input: {
  readonly localDeviceId: string;
  readonly configuration?: MeshRoleBootConfig;
  readonly trust?: HomeTrustRecord;
}): EffectiveMeshRoles {
  assertDeviceId(input.localDeviceId, "Local mesh device id");
  if (!input.trust) {
    if (input.configuration !== undefined) {
      validateMeshRoleBootConfig(input.configuration);
    }
    return Object.freeze({
      mode: "single-machine" as const,
      roles: Object.freeze(["anchor", "executor"] as DeviceRole[]),
    });
  }
  const member = input.trust.members.find(
    (candidate) => candidate.device.deviceId === input.localDeviceId,
  );
  if (!member || member.state !== "active") {
    throw new MeshProtocolError(
      "unauthorized-peer",
      "Local device is not an active member of the home trust chain",
    );
  }
  const configuration = validateMeshRoleBootConfig(input.configuration);
  const authorized = new Set(member.roles);
  for (const role of configuration.enabledRoles) {
    if (!authorized.has(role)) {
      throw new MeshProtocolError(
        "unauthorized-peer",
        `Local mesh role is not authorized by the trust chain: ${role}`,
      );
    }
  }
  return Object.freeze({
    mode: "trusted-home" as const,
    roles: Object.freeze([...configuration.enabledRoles]),
  });
}

export function validateMeshRoleBootConfig(
  value: unknown,
): MeshRoleBootConfig {
  if (!isRecord(value)) {
    throw new TypeError("Trusted-home mesh startup requires role configuration");
  }
  assertExactKeys(value, [
    "anchorListen",
    "enabledRoles",
    "executorAutoStart",
    "relayRegistration",
  ]);
  if (!Array.isArray(value.enabledRoles)) {
    throw new TypeError("Mesh enabledRoles must be an array");
  }
  const roles = value.enabledRoles.map((role) => assertDeviceRole(role));
  if (new Set(roles).size !== roles.length) {
    throw new TypeError("Mesh enabledRoles cannot contain duplicates");
  }
  const anchorListen = value.anchorListen === undefined
    ? undefined
    : validateAnchorListen(value.anchorListen);
  const relayRegistration = value.relayRegistration === undefined
    ? undefined
    : validateEndpoint(value.relayRegistration, "Mesh relay registration");
  if (value.executorAutoStart !== undefined && typeof value.executorAutoStart !== "boolean") {
    throw new TypeError("Mesh executorAutoStart must be a boolean");
  }
  const configuration = Object.freeze({
    enabledRoles: roles,
    ...(value.executorAutoStart !== undefined
      ? { executorAutoStart: value.executorAutoStart }
      : {}),
    ...(anchorListen ? { anchorListen } : {}),
    ...(relayRegistration ? { relayRegistration } : {}),
  });
  validateRoleParameters(configuration);
  return configuration;
}

export function createMeshEndpointDescriptor(input: {
  readonly deviceId: string;
  readonly configuration: MeshRoleBootConfig;
  readonly revision: number;
  readonly at?: string;
}): MeshEndpointDescriptor {
  const configuration = validateMeshRoleBootConfig(input.configuration);
  const transports: MeshEndpointTransport[] = [];
  const advertised = configuration.anchorListen?.advertised ?? (
    configuration.anchorListen && !isWildcardHost(configuration.anchorListen.bind.host)
      ? [configuration.anchorListen.bind]
      : []
  );
  for (const endpoint of advertised) {
    transports.push({ kind: "direct", ...endpoint });
  }
  if (configuration.relayRegistration) {
    transports.push({
      kind: "blind-relay",
      relay: configuration.relayRegistration,
    });
  }
  return validateMeshEndpointDescriptor({
    v: 1,
    deviceId: input.deviceId,
    transports,
    revision: input.revision,
    at: input.at ?? new Date().toISOString(),
  });
}

export function validateMeshEndpointDescriptor(
  value: unknown,
): MeshEndpointDescriptor {
  if (!isRecord(value)) throw invalidFrame("Mesh endpoint descriptor must be an object");
  assertExactKeys(value, ["at", "deviceId", "revision", "transports", "v"]);
  if (value.v !== 1) throw invalidFrame("Mesh endpoint descriptor version is invalid");
  assertDeviceId(value.deviceId, "Mesh endpoint device id");
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw invalidFrame("Mesh endpoint revision must be a positive safe integer");
  }
  assertCanonicalTime(value.at, "Mesh endpoint timestamp");
  if (
    !Array.isArray(value.transports) ||
    value.transports.length < 1 ||
    value.transports.length > 8
  ) {
    throw invalidFrame("Mesh endpoint transports must contain one to eight entries");
  }
  const transports = value.transports.map(validateTransport);
  const keys = transports.map(transportKey);
  if (new Set(keys).size !== keys.length) {
    throw invalidFrame("Mesh endpoint transports cannot contain duplicates");
  }
  return Object.freeze({
    v: 1 as const,
    deviceId: value.deviceId as string,
    transports,
    revision: value.revision as number,
    at: value.at as string,
  });
}

export class MeshEndpointDirectory {
  readonly #descriptors = new Map<string, MeshEndpointDescriptor>();

  constructor(initial: readonly MeshEndpointDescriptor[] = []) {
    for (const descriptor of initial) this.accept(descriptor);
  }

  accept(value: unknown): MeshEndpointDescriptor {
    const descriptor = validateMeshEndpointDescriptor(value);
    const current = this.#descriptors.get(descriptor.deviceId);
    if (current && descriptor.revision <= current.revision) {
      throw new MeshProtocolError(
        "replay-detected",
        "Mesh endpoint descriptor revision did not advance",
      );
    }
    this.#descriptors.set(descriptor.deviceId, descriptor);
    return descriptor;
  }

  get(deviceId: string): MeshEndpointDescriptor | undefined {
    return this.#descriptors.get(deviceId);
  }

  list(): readonly MeshEndpointDescriptor[] {
    return [...this.#descriptors.values()].sort((left, right) =>
      left.deviceId.localeCompare(right.deviceId, "en-US"));
  }
}

export function derivePairwiseRendezvousSecret(
  sharedKeyMaterial: Uint8Array | string,
): string {
  const input = typeof sharedKeyMaterial === "string"
    ? Buffer.from(sharedKeyMaterial, "utf8")
    : Buffer.from(sharedKeyMaterial);
  if (input.byteLength < 16) {
    throw new TypeError("Pairwise rendezvous key material must contain at least 128 bits");
  }
  return Buffer.from(
    hkdfSync("sha256", input, Buffer.alloc(0), PAIRWISE_INFO, 32),
  ).toString("base64url");
}

export async function persistPairwiseRendezvousSecret(
  store: SecretStorePort,
  peerDeviceId: string,
  secret: string,
): Promise<void> {
  assertDeviceId(peerDeviceId, "Rendezvous peer device id");
  assertPairwiseSecret(secret);
  const ref = { kind: "rendezvous" as const, bindingId: peerDeviceId };
  await store.put(ref, secret);
  if (await store.get(ref) !== secret) {
    throw new Error("Pairwise rendezvous secret did not survive durable read-back");
  }
}

export async function deletePairwiseRendezvousSecret(
  store: SecretStorePort,
  peerDeviceId: string,
): Promise<void> {
  assertDeviceId(peerDeviceId, "Rendezvous peer device id");
  await store.delete({ kind: "rendezvous", bindingId: peerDeviceId });
}

export function deriveControlRendezvousKey(
  pairwiseSecret: string,
  windowAt: number | Date = Date.now(),
): RendezvousKey {
  assertPairwiseSecret(pairwiseSecret);
  const timestamp = windowAt instanceof Date ? windowAt.getTime() : windowAt;
  if (!Number.isFinite(timestamp)) throw new TypeError("Rendezvous window time is invalid");
  const date = new Date(timestamp).toISOString().slice(0, 10);
  const mac = createHmac("sha256", Buffer.from(pairwiseSecret, "base64url"))
    .update(CONTROL_KEY_DOMAIN)
    .update(Buffer.from([0]))
    .update(date, "utf8")
    .digest("hex");
  return `rzv:${mac}`;
}

export function currentAndPreviousRendezvousKeys(
  pairwiseSecret: string,
  now = Date.now(),
): readonly [RendezvousKey, RendezvousKey] {
  return Object.freeze([
    deriveControlRendezvousKey(pairwiseSecret, now),
    deriveControlRendezvousKey(pairwiseSecret, now - RENDEZVOUS_WINDOW_MS),
  ]) as readonly [RendezvousKey, RendezvousKey];
}

export function validateRendezvousKey(value: unknown): RendezvousKey {
  if (typeof value !== "string" || !RENDEZVOUS_KEY.test(value)) {
    throw invalidFrame("Rendezvous key format is invalid");
  }
  return value as RendezvousKey;
}

export function validateBlindRendezvousHello(
  value: unknown,
): BlindRendezvousHello {
  if (!isRecord(value)) throw invalidFrame("Blind rendezvous hello must be an object");
  assertExactKeys(value, ["key", "ttlMs", "v"]);
  if (
    value.v !== 1 ||
    !Number.isSafeInteger(value.ttlMs) ||
    (value.ttlMs as number) < 1 ||
    (value.ttlMs as number) > MAX_RENDEZVOUS_TTL_MS
  ) {
    throw invalidFrame("Blind rendezvous hello fields are invalid");
  }
  return Object.freeze({
    v: 1 as const,
    key: validateRendezvousKey(value.key),
    ttlMs: value.ttlMs as number,
  });
}

export class MeshConnectionRegistry {
  readonly #channels = new Map<string, MeshRequestChannel>();

  attach(connection: SecureMeshConnection, services: MeshServiceRegistry): MeshRequestChannel {
    const channel = new MeshRequestChannel(connection, services);
    const deviceId = connection.peer.deviceId;
    const previous = this.#channels.get(deviceId);
    this.#channels.set(deviceId, channel);
    if (previous) void previous.close().catch(() => undefined);
    void channel.closed.finally(() => {
      if (this.#channels.get(deviceId) === channel) this.#channels.delete(deviceId);
    }).catch(() => undefined);
    return channel;
  }

  client(peerDeviceId: string): MeshServiceClient {
    assertDeviceId(peerDeviceId, "Mesh service peer device id");
    return {
      request: (serviceId, payload, signal) => {
        const channel = this.#channels.get(peerDeviceId);
        if (!channel) {
          throw new MeshProtocolError(
            "service-unavailable",
            "Authenticated mesh peer is offline",
          );
        }
        return channel.request(serviceId, payload, signal);
      },
    };
  }

  has(peerDeviceId: string): boolean {
    return this.#channels.has(peerDeviceId);
  }

  async disconnect(peerDeviceId: string, reason?: Error): Promise<void> {
    const channel = this.#channels.get(peerDeviceId);
    if (!channel) return;
    this.#channels.delete(peerDeviceId);
    await channel.close(reason);
  }

  async close(reason?: Error): Promise<void> {
    const channels = [...this.#channels.values()];
    this.#channels.clear();
    await Promise.all(channels.map((channel) => channel.close(reason)));
  }
}

export function registerMeshEndpointService(
  services: MeshServiceRegistry,
  directory: MeshEndpointDirectory,
  persist?: (
    descriptor: MeshEndpointDescriptor,
  ) => MeshEndpointDescriptor | Promise<MeshEndpointDescriptor>,
): () => void {
  return services.register(MESH_ENDPOINT_SERVICE_ID, {
    access: "write",
    availability: "negotiated-version",
    handler: async (payload, connection) => {
      let value: unknown;
      try {
        value = JSON.parse(Buffer.from(payload).toString("utf8"));
      } catch {
        throw invalidFrame("Mesh endpoint descriptor payload is not JSON");
      }
      const descriptor = validateMeshEndpointDescriptor(value);
      if (descriptor.deviceId !== connection.peer.deviceId) {
        throw new MeshProtocolError(
          "identity-mismatch",
          "Mesh endpoint descriptor does not belong to its authenticated peer",
        );
      }
      await commitMeshEndpointUpdate(directory, descriptor, persist);
      return Buffer.from("{}", "utf8");
    },
  });
}

/** Publishes an endpoint only after its device-domain durable commit succeeds. */
export async function commitMeshEndpointUpdate(
  directory: MeshEndpointDirectory,
  value: unknown,
  persist?: (
    descriptor: MeshEndpointDescriptor,
  ) => MeshEndpointDescriptor | Promise<MeshEndpointDescriptor>,
): Promise<MeshEndpointDescriptor> {
  const descriptor = validateMeshEndpointDescriptor(value);
  const accepted = persist
    ? validateMeshEndpointDescriptor(await persist(descriptor))
    : descriptor;
  if (canonicalize(accepted) !== canonicalize(descriptor)) {
    throw new MeshProtocolError(
      "service-failed",
      "Durable mesh endpoint commit returned another descriptor",
    );
  }
  return directory.accept(accepted);
}

function validateRoleParameters(configuration: MeshRoleBootConfig): void {
  const roles = new Set(configuration.enabledRoles);
  if (!roles.has("anchor") && (configuration.anchorListen || configuration.relayRegistration)) {
    throw new TypeError("Only an enabled anchor may configure mesh listeners");
  }
  const advertisedDirect = configuration.anchorListen !== undefined && (
    configuration.anchorListen.advertised !== undefined
      ? configuration.anchorListen.advertised.length > 0
      : !isWildcardHost(configuration.anchorListen.bind.host)
  );
  if (roles.has("anchor") && !advertisedDirect && !configuration.relayRegistration) {
    throw new TypeError("An enabled trusted-home anchor requires direct or relay reachability");
  }
}

function validateAnchorListen(value: unknown): NonNullable<MeshRoleBootConfig["anchorListen"]> {
  if (!isRecord(value)) throw new TypeError("Mesh anchorListen must be an object");
  assertExactKeys(value, ["advertised", "bind"]);
  const bind = validateEndpoint(value.bind, "Mesh anchor bind endpoint");
  if (value.advertised !== undefined && !Array.isArray(value.advertised)) {
    throw new TypeError("Mesh advertised endpoints must be an array");
  }
  const advertised = (value.advertised as unknown[] | undefined)?.map((endpoint) =>
    validateEndpoint(endpoint, "Mesh advertised endpoint"));
  if (advertised && (advertised.length > 8 || new Set(advertised.map(endpointKey)).size !== advertised.length)) {
    throw new TypeError("Mesh advertised endpoints must be unique and bounded");
  }
  return Object.freeze({
    bind,
    ...(advertised ? { advertised } : {}),
  });
}

function validateEndpoint(value: unknown, label: string): { host: string; port: number } {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, ["host", "port"]);
  if (typeof value.host !== "string" || !HOST.test(value.host)) {
    throw new TypeError(`${label} host is invalid`);
  }
  if (!Number.isSafeInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535) {
    throw new TypeError(`${label} port is invalid`);
  }
  return Object.freeze({ host: value.host, port: value.port as number });
}

function validateTransport(value: unknown): MeshEndpointTransport {
  if (!isRecord(value)) throw invalidFrame("Mesh endpoint transport must be an object");
  if (value.kind === "direct") {
    assertExactKeys(value, ["host", "kind", "port"]);
    return Object.freeze({ kind: "direct" as const, ...validateEndpoint({ host: value.host, port: value.port }, "Direct mesh endpoint") });
  }
  if (value.kind === "blind-relay") {
    assertExactKeys(value, ["kind", "relay"]);
    return Object.freeze({ kind: "blind-relay" as const, relay: validateEndpoint(value.relay, "Blind relay endpoint") });
  }
  throw invalidFrame("Mesh endpoint transport kind is invalid");
}

function transportKey(value: MeshEndpointTransport): string {
  return value.kind === "direct"
    ? `direct:${value.host}:${value.port}`
    : `relay:${value.relay.host}:${value.relay.port}`;
}

function endpointKey(value: { host: string; port: number }): string {
  return `${value.host}:${value.port}`;
}

function isWildcardHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function assertPairwiseSecret(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError("Pairwise rendezvous secret is invalid");
  }
}

function assertDeviceRole(value: unknown): DeviceRole {
  if (value !== "anchor" && value !== "executor" && value !== "surface") {
    throw new TypeError("Mesh role is invalid");
  }
  return value;
}

function assertDeviceId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DEVICE_ID.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertCanonicalTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw invalidFrame(`${label} is invalid`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw invalidFrame(`${label} is invalid`);
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const present = allowed.filter((key) => value[key] !== undefined).sort();
  if (actual.length !== present.length || actual.some((key, index) => key !== present[index])) {
    throw invalidFrame("Mesh bootstrap object contains unknown or undefined fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function invalidFrame(message: string): MeshProtocolError {
  return new MeshProtocolError("invalid-frame", message);
}
