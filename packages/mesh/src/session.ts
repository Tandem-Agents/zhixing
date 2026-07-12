import type { DeviceIdentity } from "@zhixing/core/contracts";
import { MeshProtocolError } from "./errors.js";
import {
  type MeshProtocolCompatibility,
  type MeshProtocolRange,
  negotiateMeshProtocol,
  sameMeshProtocolCompatibility,
  snapshotMeshProtocolRange,
} from "./protocol-version.js";
import type { MeshFrameTransport } from "./transport.js";

export interface AuthenticatedSessionOptions {
  readonly transport: MeshFrameTransport;
  readonly connectionId: string;
  readonly compatibility: MeshProtocolCompatibility;
  readonly localProtocolRange: MeshProtocolRange;
  readonly peerProtocolRange: MeshProtocolRange;
  readonly peer: DeviceIdentity;
}

const AUTHENTICATED_SESSION_TOKEN = Symbol("authenticated-mesh-session");
const authenticatedSessions = new WeakSet<object>();

let establishAuthenticatedSession: (
  options: AuthenticatedSessionOptions,
) => SecureMeshConnection;

/** A session that can only be constructed after TLS and trust authorization succeed. */
export class SecureMeshConnection {
  readonly #transport: MeshFrameTransport;
  readonly #peer: DeviceIdentity;
  readonly #connectionId: string;
  readonly #compatibility: MeshProtocolCompatibility;
  readonly #localProtocolRange: MeshProtocolRange;
  readonly #peerProtocolRange: MeshProtocolRange;
  readonly #closed: Promise<void>;
  #sendQueue: Promise<void> = Promise.resolve();
  #receiving = false;
  #isClosed = false;

  private constructor(
    options: AuthenticatedSessionOptions,
    token: symbol,
  ) {
    if (token !== AUTHENTICATED_SESSION_TOKEN) {
      throw new TypeError("Secure mesh sessions can only be created after authentication");
    }
    const localProtocolRange = snapshotMeshProtocolRange(
      options.localProtocolRange,
    );
    const peerProtocolRange = snapshotMeshProtocolRange(
      options.peerProtocolRange,
    );
    if (
      !sameMeshProtocolCompatibility(
        options.compatibility,
        negotiateMeshProtocol(localProtocolRange, peerProtocolRange),
      )
    ) {
      throw new TypeError(
        "Mesh session compatibility does not match its protocol ranges",
      );
    }
    authenticatedSessions.add(this);
    this.#transport = options.transport;
    this.#peer = Object.freeze({ ...options.peer });
    this.#connectionId = options.connectionId;
    this.#compatibility = Object.freeze({ ...options.compatibility });
    this.#localProtocolRange = localProtocolRange;
    this.#peerProtocolRange = peerProtocolRange;
    this.#closed = options.transport.closed;
    Object.freeze(this);
    void this.#closed.then(() => {
      this.#isClosed = true;
    });
  }

  static {
    establishAuthenticatedSession = (options) =>
      new SecureMeshConnection(options, AUTHENTICATED_SESSION_TOKEN);
  }

  get peer(): DeviceIdentity {
    return this.#peer;
  }

  get connectionId(): string {
    return this.#connectionId;
  }

  get compatibility(): MeshProtocolCompatibility {
    return this.#compatibility;
  }

  get localProtocolRange(): MeshProtocolRange {
    return this.#localProtocolRange;
  }

  get peerProtocolRange(): MeshProtocolRange {
    return this.#peerProtocolRange;
  }

  get closed(): Promise<void> {
    return this.#closed;
  }

  send(payload: Uint8Array): Promise<void> {
    assertSecureMeshConnection(this);
    if (this.#isClosed) return Promise.reject(closedError());
    const operation = this.#sendQueue.then(async () => {
      try {
        await this.#transport.send(payload);
      } catch (error) {
        await this.close(error instanceof Error ? error : undefined);
        throw error;
      }
    });
    this.#sendQueue = operation.catch(() => {});
    return operation;
  }

  async receive(signal?: AbortSignal): Promise<Uint8Array> {
    assertSecureMeshConnection(this);
    if (this.#receiving) {
      throw new TypeError("Secure mesh connection allows one active receiver");
    }
    this.#receiving = true;
    try {
      return await this.#transport.receive(signal);
    } catch (error) {
      await this.close(error instanceof Error ? error : undefined);
      throw error;
    } finally {
      this.#receiving = false;
    }
  }

  async close(reason?: Error): Promise<void> {
    assertSecureMeshConnection(this);
    if (this.#isClosed) return;
    this.#isClosed = true;
    await this.#transport.close(reason);
  }
}

Object.freeze(SecureMeshConnection.prototype);

export function assertSecureMeshConnection(
  value: unknown,
): asserts value is SecureMeshConnection {
  if (
    typeof value !== "object" ||
    value === null ||
    !authenticatedSessions.has(value)
  ) {
    throw new TypeError("Mesh operation requires an authenticated session");
  }
}

export function createSecureMeshConnection(
  options: AuthenticatedSessionOptions,
): SecureMeshConnection {
  return establishAuthenticatedSession(options);
}

function closedError(): MeshProtocolError {
  return new MeshProtocolError("connection-closed", "Secure mesh connection is closed");
}
