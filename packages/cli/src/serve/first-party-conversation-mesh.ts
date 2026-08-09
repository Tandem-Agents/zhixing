import { canonicalize } from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh";
import type {
  MeshServiceHandler,
  MeshServiceRegistry,
} from "@zhixing/mesh/service-registry";
import {
  RpcAppError,
  toJsonRpcError,
  type CanonicalFirstPartyConversationSurface,
  type FirstPartyConversationRpcRouter,
  type RpcConnection,
} from "@zhixing/server";

export const FIRST_PARTY_CONVERSATION_MESH_SERVICE = "conversation.first-party";

const METHODS = new Set([
  "session.abort",
  "session.advancementCancel",
  "session.advancementConfirm",
  "session.advancementDetail",
  "session.advancementRevise",
  "session.clear",
  "session.compact",
  "session.contextBudget",
  "session.delete",
  "session.history",
  "session.list",
  "session.new",
  "session.rename",
  "session.resume",
  "session.security",
  "session.send",
  "session.subscribe",
  "session.taskList",
  "session.taskListUpdate",
  "session.unsubscribe",
  "session.usage",
  "confirmation.list",
  "confirmation.resolve",
  "dutyMigration.targets",
  "dutyMigration.prepare",
  "dutyMigration.commit",
  "dutyMigration.cancel",
]);

interface SurfaceIdentity {
  readonly deviceId: string;
  readonly surfacePrincipal: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly loopback: boolean;
  readonly client?: { readonly id?: string; readonly version?: string };
}

type Command =
  | { readonly v: 1; readonly op: "dispatch"; readonly surface: SurfaceIdentity; readonly method: string; readonly params: unknown }
  | { readonly v: 1; readonly op: "poll"; readonly surface: SurfaceIdentity }
  | { readonly v: 1; readonly op: "close"; readonly surface: SurfaceIdentity };

type Notification = { readonly method: string; readonly params: unknown };
type Result =
  | { readonly v: 1; readonly ok: true; readonly result?: unknown; readonly notifications: readonly Notification[] }
  | { readonly v: 1; readonly ok: false; readonly error: { readonly code: number; readonly message: string; readonly data?: unknown } };

/** Finite authenticated relay; it never exposes arbitrary host RPC. */
export class FirstPartyConversationMeshTarget {
  readonly #relays = new Map<string, RelayConnection>();
  readonly #currentByPrincipal = new Map<string, RelayConnection>();
  #surface: CanonicalFirstPartyConversationSurface | undefined;

  bind(surface: CanonicalFirstPartyConversationSurface): void {
    if (this.#surface && this.#surface !== surface) {
      throw new Error("First-party conversation surface is already bound");
    }
    this.#surface = surface;
  }

  async handle(
    payload: Uint8Array,
    connection: Parameters<MeshServiceHandler>[1],
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      const command = validateCommand(decode(payload), connection.peer.deviceId);
      if (command.op === "close") {
        const relay = this.#relays.get(surfaceKey(command.surface));
        if (!relay) return encode({ v: 1, ok: true, notifications: [] });
        relay.close();
        this.#relays.delete(relay.key);
        if (this.#currentByPrincipal.get(relay.principalKey) === relay) {
          this.#currentByPrincipal.delete(relay.principalKey);
        }
        return encode({ v: 1, ok: true, notifications: [] });
      }
      const relay = this.#relay(command.surface);
      if (command.op === "poll") {
        return encode({ v: 1, ok: true, notifications: await relay.poll(signal) });
      }
      if (!this.#surface) throw new Error("First-party conversation surface is not ready");
      if (!METHODS.has(command.method)) throw new TypeError("First-party conversation method is not allowed");
      const result = await relay.serial(() => this.#surface!.dispatch({
        method: command.method,
        params: command.params,
        connection: relay,
      }));
      return encode({
        v: 1,
        ok: true,
        ...(result !== undefined ? { result } : {}),
        notifications: relay.drain(),
      });
    } catch (error) {
      const rpc = toJsonRpcError(error);
      return encode({
        v: 1,
        ok: false,
        error: {
          code: rpc.code,
          message: rpc.message,
          ...(rpc.data !== undefined ? { data: rpc.data } : {}),
        },
      });
    }
  }

  close(): void {
    for (const relay of this.#relays.values()) relay.close();
    this.#relays.clear();
    this.#currentByPrincipal.clear();
  }

  #relay(identity: SurfaceIdentity): RelayConnection {
    const key = surfaceKey(identity);
    const existing = this.#relays.get(key);
    if (existing) return existing;
    const relay = new RelayConnection(identity);
    const principalKey = `${identity.deviceId}:${identity.surfacePrincipal}`;
    const prior = this.#currentByPrincipal.get(principalKey);
    if (prior && identity.generation < prior.surfaceGeneration) {
      throw new TypeError("First-party conversation surface generation is stale");
    }
    if (prior) {
      prior.close();
      this.#relays.delete(prior.key);
    }
    this.#relays.set(key, relay);
    this.#currentByPrincipal.set(principalKey, relay);
    return relay;
  }
}

export function registerFirstPartyConversationMeshService(
  registry: MeshServiceRegistry,
  target: FirstPartyConversationMeshTarget,
  authorizePeer: (deviceId: string) => boolean,
): () => void {
  return registry.register(FIRST_PARTY_CONVERSATION_MESH_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    authorize: (connection) => authorizePeer(connection.peer.deviceId),
    handler: (payload, connection, signal) => target.handle(payload, connection, signal),
  });
}

export interface FirstPartyIngressConnection {
  readonly id: number;
  readonly closed: boolean;
  readonly authenticated: boolean;
  readonly loopback: boolean;
  readonly clientInfo?: { readonly id?: string; readonly version?: string };
  readonly surfacePrincipal?: string;
  readonly surfaceGeneration?: number;
  notify(method: string, params: unknown): void;
  onClose(handler: () => void): () => void;
}

/** Routes the finite first-party authority surface to the current duty device. */
export class CurrentAnchorFirstPartyRpcRouter
  implements FirstPartyConversationRpcRouter
{
  readonly #remote = new Map<string, FirstPartyConversationMeshClient>();

  constructor(private readonly input: {
    readonly deviceId: string;
    readonly currentAnchorDeviceId: () => string;
    readonly remoteFor: (deviceId: string) => FirstPartyConversationMeshClient;
  }) {}

  async dispatch(input: {
    readonly method: string;
    readonly params: unknown;
    readonly connection: FirstPartyIngressConnection;
  }): Promise<
    | { readonly handled: false }
    | { readonly handled: true; readonly result: unknown }
  > {
    if (!METHODS.has(input.method)) return { handled: false };
    const current = this.input.currentAnchorDeviceId();
    if (current === this.input.deviceId) return { handled: false };
    let remote = this.#remote.get(current);
    if (!remote) {
      remote = this.input.remoteFor(current);
      this.#remote.set(current, remote);
    }
    return {
      handled: true,
      result: await remote.dispatch(input.method, input.params, input.connection),
    };
  }
}

export class FirstPartyConversationMeshClient {
  readonly #active = new Map<number, { readonly abort: AbortController; readonly remove: () => void }>();

  constructor(
    private readonly client: MeshServiceClient,
    private readonly sourceDeviceId: string,
    private readonly onError?: (error: Error) => void,
  ) {}

  async dispatch(method: string, params: unknown, connection: FirstPartyIngressConnection): Promise<unknown> {
    if (!METHODS.has(method)) throw new TypeError("First-party conversation method is not allowed");
    const surface = surfaceIdentity(this.sourceDeviceId, connection);
    this.#ensurePolling(surface, connection);
    const response = await this.#request({ v: 1, op: "dispatch", surface, method, params });
    for (const notification of response.notifications) {
      if (!connection.closed) connection.notify(notification.method, notification.params);
    }
    return response.result;
  }

  async close(connection: FirstPartyIngressConnection): Promise<void> {
    const active = this.#active.get(connection.id);
    active?.abort.abort();
    active?.remove();
    this.#active.delete(connection.id);
    if (!connection.surfacePrincipal || !connection.surfaceGeneration) return;
    await this.#request({
      v: 1,
      op: "close",
      surface: surfaceIdentity(this.sourceDeviceId, connection),
    }).catch(() => {});
  }

  #ensurePolling(surface: SurfaceIdentity, connection: FirstPartyIngressConnection): void {
    if (this.#active.has(connection.id)) return;
    const abort = new AbortController();
    const remove = connection.onClose(() => void this.close(connection));
    this.#active.set(connection.id, { abort, remove });
    void this.#poll(surface, connection, abort.signal).catch((error: unknown) => {
      if (!abort.signal.aborted) this.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  async #poll(surface: SurfaceIdentity, connection: FirstPartyIngressConnection, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && !connection.closed) {
      const response = await this.#request({ v: 1, op: "poll", surface }, signal);
      for (const notification of response.notifications) {
        if (!connection.closed) connection.notify(notification.method, notification.params);
      }
    }
  }

  async #request(command: Command, signal?: AbortSignal): Promise<Extract<Result, { ok: true }>> {
    const result = validateResult(decode(await this.client.request(
      FIRST_PARTY_CONVERSATION_MESH_SERVICE,
      encode(command),
      signal,
    )));
    if (!result.ok) throw new RpcAppError(result.error.code, result.error.message, result.error.data);
    return result;
  }
}

let nextRelayId = 1_000_000;

class RelayConnection implements RpcConnection {
  readonly id = nextRelayId++;
  authenticated = true;
  readonly loopback: boolean;
  readonly clientInfo?: { readonly id?: string; readonly version?: string };
  readonly surfacePrincipal: string;
  readonly surfaceGeneration: number;
  readonly key: string;
  readonly principalKey: string;
  #closed = false;
  #queue: Notification[] = [];
  #waiters = new Set<() => void>();
  #closeHandlers = new Set<() => void>();
  #tail: Promise<void> = Promise.resolve();

  constructor(identity: SurfaceIdentity) {
    this.loopback = identity.loopback;
    this.clientInfo = identity.client;
    this.surfacePrincipal = identity.surfacePrincipal;
    this.surfaceGeneration = identity.generation;
    this.key = surfaceKey(identity);
    this.principalKey = `${identity.deviceId}:${identity.surfacePrincipal}`;
  }

  get closed(): boolean { return this.#closed; }
  sendSuccess(): void {}
  sendError(): void {}
  notify(method: string, params?: unknown): void { this.tryNotify(method, params); }
  tryNotify(method: string, params?: unknown): boolean {
    if (this.#closed) return false;
    if (this.#queue.length >= 1024) throw new Error("First-party conversation notification relay overflowed");
    this.#queue.push({ method, params: params ?? null });
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
    return true;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const handler of this.#closeHandlers) handler();
    this.#closeHandlers.clear();
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }
  onClose(handler: () => void): () => void {
    if (this.#closed) { handler(); return () => {}; }
    this.#closeHandlers.add(handler);
    return () => this.#closeHandlers.delete(handler);
  }
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => {}, () => {});
    return result;
  }
  drain(): readonly Notification[] {
    const notifications = this.#queue;
    this.#queue = [];
    return notifications;
  }
  async poll(signal: AbortSignal): Promise<readonly Notification[]> {
    if (this.#queue.length > 0 || this.#closed || signal.aborted) return this.drain();
    await new Promise<void>((resolve) => {
      let timeout: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", done);
        this.#waiters.delete(done);
        resolve();
      };
      timeout = setTimeout(done, 20_000);
      this.#waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
    return this.drain();
  }
}

function surfaceIdentity(deviceId: string, connection: FirstPartyIngressConnection): SurfaceIdentity {
  if (!connection.authenticated || !connection.surfacePrincipal || !connection.surfaceGeneration) {
    throw new TypeError("First-party conversation relay requires an authenticated stable surface");
  }
  return {
    deviceId,
    surfacePrincipal: connection.surfacePrincipal,
    connectionId: String(connection.id),
    generation: connection.surfaceGeneration,
    loopback: connection.loopback,
    ...(connection.clientInfo ? { client: connection.clientInfo } : {}),
  };
}

function surfaceKey(identity: SurfaceIdentity): string {
  return `${identity.deviceId}:${identity.surfacePrincipal}:${identity.generation}:${identity.connectionId}`;
}

function validateCommand(value: unknown, peerDeviceId: string): Command {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("First-party conversation command is invalid");
  const command = value as Partial<Command>;
  const commandKeys = Object.keys(command).sort();
  const surface = (command as { surface?: unknown }).surface;
  if (!surface || typeof surface !== "object" || Array.isArray(surface)) throw new TypeError("First-party conversation surface identity is missing");
  const identity = surface as Partial<SurfaceIdentity>;
  if (
    command.v !== 1 ||
    (command.op !== "dispatch" && command.op !== "poll" && command.op !== "close") ||
    identity.deviceId !== peerDeviceId ||
    typeof identity.surfacePrincipal !== "string" || !identity.surfacePrincipal.startsWith("rpc:") ||
    typeof identity.connectionId !== "string" || identity.connectionId.length === 0 ||
    !Number.isSafeInteger(identity.generation) || (identity.generation ?? 0) < 1 ||
    typeof identity.loopback !== "boolean"
  ) throw new TypeError("First-party conversation command identity is invalid");
  const expectedKeys = command.op === "dispatch"
    ? ["method", "op", "params", "surface", "v"]
    : ["op", "surface", "v"];
  if (canonicalize(commandKeys) !== canonicalize(expectedKeys)) {
    throw new TypeError("First-party conversation command shape is invalid");
  }
  const surfaceKeys = Object.keys(identity).sort();
  const expectedSurfaceKeys = identity.client === undefined
    ? ["connectionId", "deviceId", "generation", "loopback", "surfacePrincipal"]
    : ["client", "connectionId", "deviceId", "generation", "loopback", "surfacePrincipal"];
  if (canonicalize(surfaceKeys) !== canonicalize(expectedSurfaceKeys)) {
    throw new TypeError("First-party conversation surface shape is invalid");
  }
  if (command.op === "dispatch" && (typeof command.method !== "string" || !METHODS.has(command.method))) {
    throw new TypeError("First-party conversation command method is invalid");
  }
  return command as Command;
}

function validateResult(value: unknown): Result {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("First-party conversation result is invalid");
  const result = value as Partial<Result>;
  if (result.v !== 1 || typeof result.ok !== "boolean") throw new TypeError("First-party conversation result is invalid");
  if (!result.ok) {
    const error = (result as { error?: unknown }).error;
    if (!error || typeof error !== "object" || typeof (error as { code?: unknown }).code !== "number" || typeof (error as { message?: unknown }).message !== "string") {
      throw new TypeError("First-party conversation error is invalid");
    }
    const errorKeys = Object.keys(error).sort();
    if (
      canonicalize(Object.keys(result).sort()) !== canonicalize(["error", "ok", "v"]) ||
      ![
        canonicalize(["code", "message"]),
        canonicalize(["code", "data", "message"]),
      ].includes(canonicalize(errorKeys))
    ) throw new TypeError("First-party conversation error shape is invalid");
    return result as Result;
  }
  const notifications = (result as { notifications?: unknown }).notifications;
  if (!Array.isArray(notifications)) throw new TypeError("First-party conversation notifications are invalid");
  const successKeys = Object.keys(result).sort();
  if (![
    canonicalize(["notifications", "ok", "v"]),
    canonicalize(["notifications", "ok", "result", "v"]),
  ].includes(canonicalize(successKeys))) throw new TypeError("First-party conversation success shape is invalid");
  for (const notification of notifications) {
    if (
      !notification ||
      typeof notification !== "object" ||
      Array.isArray(notification) ||
      canonicalize(Object.keys(notification).sort()) !== canonicalize(["method", "params"]) ||
      typeof (notification as { method?: unknown }).method !== "string"
    ) throw new TypeError("First-party conversation notification is invalid");
  }
  return result as Result;
}

function encode(value: unknown): Uint8Array { return Buffer.from(canonicalize(value)); }
function decode(value: Uint8Array): unknown { return JSON.parse(Buffer.from(value).toString("utf8")); }
