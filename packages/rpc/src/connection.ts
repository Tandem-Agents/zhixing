import type { SessionPresentationProfile } from './session-presentation.js';

/** One finite policy for WebSocket and first-party relay observation lifetimes. */
export class SessionPresentationState {
  readonly #profiles = new Map<string, { profile: SessionPresentationProfile; since: number; revision: number }>();
  #revision = 0;

  constructor(private readonly isClosed: () => boolean) {}

  presentationProfile(conversationId: string): SessionPresentationProfile {
    return this.#profiles.get(conversationId)?.profile ?? 'default';
  }
  presentationSince(conversationId: string): number {
    return this.#profiles.get(conversationId)?.since ?? Infinity;
  }
  observationRevision(conversationId: string): number {
    return this.#profiles.get(conversationId)?.revision ?? -1;
  }
  setPresentationProfile(conversationId: string, profile: SessionPresentationProfile): boolean {
    if (this.isClosed() || (!this.#profiles.has(conversationId) && this.#profiles.size >= 128)) return false;
    const previous = this.#profiles.get(conversationId);
    this.#profiles.set(conversationId, {
      profile,
      since: performance.now(),
      // A pause changes display eligibility, never the in-flight control replay.
      revision: previous?.revision ?? ++this.#revision,
    });
    return true;
  }
  dropPresentationProfile(conversationId: string): void { this.#profiles.delete(conversationId); }
  clear(): void { this.#profiles.clear(); }
}

/** RPC 投影所需的最小连接能力，不绑定 WebSocket 或具体网关实现。 */
export interface RpcNotificationConnection {
  readonly id: string | number;
  readonly authenticated: boolean;
  readonly loopback: boolean;
  readonly closed: boolean;
  readonly surfacePrincipal?: string;
  presentationProfile?(conversationId: string): import('./session-presentation.js').SessionPresentationProfile;
  presentationSince?(conversationId: string): number;
  notify(method: string, params?: unknown): void;
}
