import type { RpcConnection } from "./connection.js";

const FIRST_PARTY_INSTANCE_ID = /^[a-z0-9][a-z0-9._:-]{1,127}$/iu;

export interface RpcSurfaceBinding {
  readonly surfacePrincipal: string;
  readonly generation: number;
  readonly connection: RpcConnection;
}

/** One stable first-party surface identity has exactly one current connection. */
export class RpcSurfaceRegistry {
  readonly #current = new Map<string, RpcSurfaceBinding>();
  readonly #lastGeneration = new Map<string, number>();

  bind(connection: RpcConnection, clientInstanceId: string): RpcSurfaceBinding {
    if (!FIRST_PARTY_INSTANCE_ID.test(clientInstanceId)) {
      throw new TypeError("First-party RPC client id is invalid");
    }
    const surfacePrincipal = `rpc:${clientInstanceId}`;
    const existing = this.#current.get(surfacePrincipal);
    if (existing?.connection === connection) return existing;
    const generation = (this.#lastGeneration.get(surfacePrincipal) ?? 0) + 1;
    this.#lastGeneration.set(surfacePrincipal, generation);
    const binding = { surfacePrincipal, generation, connection };
    this.#current.set(surfacePrincipal, binding);
    connection.surfacePrincipal = surfacePrincipal;
    connection.surfaceGeneration = generation;
    if (existing && !existing.connection.closed) {
      existing.connection.close(4001, "First-party surface reconnected");
    }
    return binding;
  }

  current(surfacePrincipal: string): RpcSurfaceBinding | undefined {
    const binding = this.#current.get(surfacePrincipal);
    return binding && !binding.connection.closed ? binding : undefined;
  }

  unbind(connection: RpcConnection): void {
    const principal = connection.surfacePrincipal;
    if (!principal) return;
    const current = this.#current.get(principal);
    if (current?.connection === connection) this.#current.delete(principal);
  }
}

export function requireRpcSurfacePrincipal(connection: RpcConnection): string {
  if (connection.surfacePrincipal && connection.surfaceGeneration) {
    return connection.surfacePrincipal;
  }
  // Direct method tests and embedded transports may pre-authenticate a
  // connection without running the auth handler. They still must present a
  // stable client id; an absent id remains fail-closed.
  if (connection.clientInfo?.id && FIRST_PARTY_INSTANCE_ID.test(connection.clientInfo.id)) {
    return `rpc:${connection.clientInfo.id}`;
  }
  {
    throw new TypeError("Authenticated RPC operation requires a stable first-party surface identity");
  }
}
