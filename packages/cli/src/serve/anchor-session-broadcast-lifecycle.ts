import {
  assertSessionBroadcastTransport,
  type SessionActivityBroadcast,
  type SessionBroadcast,
  type SessionBroadcastTransport,
} from "@zhixing/rpc/session-broadcast";

export interface AnchorSessionBroadcastPort {
  readonly session: SessionBroadcast;
  readonly activity: SessionActivityBroadcast;
}

export interface SessionBroadcastGenerationLease {
  release(): void;
}

/**
 * Stable Host port for the single prepared Server broadcast generation.
 *
 * The port exists before long-lived consumers are assembled, but remains
 * fail-closed until the inactive Server generation is installed inside its
 * activation gate. A provenance lease prevents an old generation from
 * releasing a successor.
 */
export class AnchorSessionBroadcastLifecycle {
  readonly port: AnchorSessionBroadcastPort;
  #current: SessionBroadcastTransport | undefined;
  #closed = false;

  constructor() {
    this.port = Object.freeze({
      session: ((conversationId, method, params) => {
        this.#requireCurrent().session(conversationId, method, params);
      }) satisfies SessionBroadcast,
      activity: ((payload) => {
        this.#requireCurrent().activity(payload);
      }) satisfies SessionActivityBroadcast,
    });
  }

  install(
    transport: SessionBroadcastTransport,
  ): SessionBroadcastGenerationLease {
    if (this.#closed) {
      throw new Error("Session broadcast lifecycle is closed");
    }
    assertSessionBroadcastTransport(transport);
    if (this.#current) {
      throw new Error("Session broadcast transport is already installed");
    }
    this.#current = transport;
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        if (this.#current === transport) this.#current = undefined;
      },
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#current = undefined;
  }

  #requireCurrent(): SessionBroadcastTransport {
    if (!this.#current) {
      throw new Error("Session broadcast transport is not active");
    }
    return this.#current;
  }
}
