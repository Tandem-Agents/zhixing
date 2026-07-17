import type { DeliveryAuthority } from "./authority.js";
import type { AuthorityDeliveryItem } from "./types.js";

export interface AuthorityDeliveryQueueOptions {
  readonly authority: DeliveryAuthority;
}

/**
 * Compatibility queue view. It owns no facts and is rebuilt from the delivery
 * stream whenever a drain cycle starts.
 */
export class AuthorityDeliveryQueue {
  readonly #authority: DeliveryAuthority;
  #items: readonly AuthorityDeliveryItem[] = [];

  constructor(options: AuthorityDeliveryQueueOptions) {
    this.#authority = options.authority;
  }

  async load(): Promise<number> {
    this.#items = await this.#authority.list();
    return this.pending.length;
  }

  async refresh(): Promise<readonly AuthorityDeliveryItem[]> {
    await this.load();
    return this.#items;
  }

  getReady(now: Date): AuthorityDeliveryItem[] {
    const timestamp = now.getTime();
    return this.#items.filter((item) => {
      if (item.state === "queued" || item.state === "attempting") return true;
      return (
        item.state === "retry-wait" &&
        item.nextAttemptAt !== undefined &&
        Date.parse(item.nextAttemptAt) <= timestamp
      );
    });
  }

  get pending(): readonly AuthorityDeliveryItem[] {
    return this.#items.filter((item) =>
      new Set(["queued", "attempting", "retry-wait", "uncertain"]).has(item.state),
    );
  }

  get size(): number {
    return this.pending.length;
  }

  get all(): readonly AuthorityDeliveryItem[] {
    return this.#items;
  }
}
