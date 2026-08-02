import fs from "node:fs/promises";
import path from "node:path";
import type { IEventBus } from "../events/index.js";
import type {
  DeliveryEventMap,
  DeliveryItem,
  DeliveryPriority,
  DeliverySender,
  DeliveryStats,
} from "./types.js";

export interface LegacyDeliveryDrainerConfig {
  readonly maxAttempts: number;
  readonly baseRetryDelayMs: number;
  readonly flushIntervalMs: number;
  readonly queueFilePath: string;
  readonly itemTtlMs: number;
}

export const DEFAULT_LEGACY_DELIVERY_DRAINER_CONFIG: Omit<
  LegacyDeliveryDrainerConfig,
  "queueFilePath"
> = {
  maxAttempts: 3,
  baseRetryDelayMs: 5_000,
  flushIntervalMs: 30_000,
  itemTtlMs: 60 * 60 * 1_000,
};

export interface LegacyDeliveryDrainerDeps {
  readonly sender: DeliverySender;
  readonly eventBus: IEventBus<DeliveryEventMap>;
  readonly config: LegacyDeliveryDrainerConfig;
  readonly now?: () => Date;
  readonly logger?: LegacyDeliveryDrainerLogger;
}

export interface LegacyDeliveryDrainerLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

const PRIORITY_ORDER: Readonly<Record<DeliveryPriority, number>> = {
  high: 3,
  normal: 2,
  low: 1,
};

/**
 * One-way compatibility owner for the retired delivery-queue.json format.
 *
 * The type deliberately exposes no enqueue surface: new producers can only
 * write the authority delivery stream while this owner drains pre-cutover
 * items under their original ids.
 */
export class LegacyDeliveryDrainer {
  readonly #sender: DeliverySender;
  readonly #eventBus: IEventBus<DeliveryEventMap>;
  readonly #config: LegacyDeliveryDrainerConfig;
  readonly #now: () => Date;
  readonly #logger: LegacyDeliveryDrainerLogger;
  #items: DeliveryItem[] = [];
  #state: "unstarted" | "running" | "stopped" = "unstarted";
  #timer: ReturnType<typeof setInterval> | undefined;
  #activeFlush: Promise<void> | undefined;
  #delivered = 0;
  #failed = 0;

  constructor(deps: LegacyDeliveryDrainerDeps) {
    this.#sender = deps.sender;
    this.#eventBus = deps.eventBus;
    this.#config = deps.config;
    this.#now = deps.now ?? (() => new Date());
    this.#logger = deps.logger ?? noopLogger();
  }

  async start(): Promise<void> {
    if (this.#state !== "unstarted") {
      throw new Error(`Legacy drainer cannot start from ${this.#state}`);
    }
    this.#items = await readLegacyQueue(this.#config.queueFilePath);
    this.#state = "running";
    if (this.#items.length > 0) {
      await this.flush();
    } else {
      await persistLegacyQueue(this.#config.queueFilePath, []);
    }
    if (this.#items.length > 0 && this.#config.flushIntervalMs > 0) {
      this.#timer = setInterval(() => {
        if (this.#state !== "running") return;
        void this.flush().catch((error) => {
          this.#logger.error("Legacy delivery drain failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, this.#config.flushIntervalMs);
      this.#timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    if (this.#state !== "running") {
      throw new Error("Legacy drainer was not started");
    }
    this.#state = "stopped";
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#activeFlush?.catch(() => undefined);
    await persistLegacyQueue(this.#config.queueFilePath, this.#items);
  }

  async flush(): Promise<void> {
    if (this.#state !== "running") {
      throw new Error("Legacy drainer is not running");
    }
    if (this.#activeFlush) return this.#activeFlush;
    this.#activeFlush = this.#drain().finally(() => {
      this.#activeFlush = undefined;
    });
    return this.#activeFlush;
  }

  stats(): DeliveryStats {
    return {
      queued: this.#items.length,
      delivered: this.#delivered,
      failed: this.#failed,
      retrying: this.#items.filter(
        (item) => item.attempts > 0 && item.nextAttemptAt !== undefined,
      ).length,
    };
  }

  async #drain(): Promise<void> {
    const ready = this.#items
      .filter((item) =>
        item.nextAttemptAt === undefined
          ? true
          : new Date(item.nextAttemptAt).getTime() <= this.#now().getTime(),
      )
      .sort(
        (left, right) =>
          PRIORITY_ORDER[right.priority] - PRIORITY_ORDER[left.priority],
      );
    for (const item of ready) await this.#process(item);
    await persistLegacyQueue(this.#config.queueFilePath, this.#items);
    if (this.#items.length === 0 && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async #process(item: DeliveryItem): Promise<void> {
    const age = this.#now().getTime() - new Date(item.createdAt).getTime();
    if (age > this.#config.itemTtlMs) {
      await this.#finalFailure(item, "Legacy delivery expired");
      return;
    }
    if (!this.#sender.isReady(item.target.channelId)) {
      item.nextAttemptAt = new Date(
        this.#now().getTime() + this.#config.baseRetryDelayMs,
      ).toISOString();
      return;
    }
    item.attempts += 1;
    try {
      const result = await this.#sender.send(item.target, item.content, {
        ...(item.source ? { source: item.source } : {}),
        itemId: item.id,
        idempotencyKey: item.id,
        attempt: item.attempts,
      });
      if (result.success) {
        this.#remove(item.id);
        this.#delivered += 1;
        await this.#eventBus.emit("delivery:success", {
          itemId: item.id,
          target: item.target,
          attempts: item.attempts,
        });
        return;
      }
      if (result.retryable && item.attempts < item.maxAttempts) {
        await this.#retry(item, result.error);
        return;
      }
      await this.#finalFailure(item, result.error ?? "Legacy delivery failed");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (item.attempts < item.maxAttempts) {
        await this.#retry(item, message);
      } else {
        await this.#finalFailure(item, message);
      }
    }
  }

  async #retry(item: DeliveryItem, error: string | undefined): Promise<void> {
    const nextAttemptAt = new Date(
      this.#now().getTime() +
        this.#config.baseRetryDelayMs * 2 ** Math.max(0, item.attempts - 1),
    ).toISOString();
    item.nextAttemptAt = nextAttemptAt;
    item.lastError = error;
    await this.#eventBus.emit("delivery:retry", {
      itemId: item.id,
      target: item.target,
      attempt: item.attempts,
      nextAttemptAt,
    });
  }

  async #finalFailure(item: DeliveryItem, error: string): Promise<void> {
    this.#remove(item.id);
    this.#failed += 1;
    await this.#eventBus.emit("delivery:failed", {
      itemId: item.id,
      target: item.target,
      error,
      attempts: item.attempts,
    });
    this.#logger.warn("Legacy delivery failed permanently", {
      itemId: item.id,
      error,
    });
  }

  #remove(itemId: string): void {
    this.#items = this.#items.filter((item) => item.id !== itemId);
  }
}

async function readLegacyQueue(filePath: string): Promise<DeliveryItem[]> {
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!Array.isArray(parsed) || !parsed.every(isLegacyDeliveryItem)) {
    throw new TypeError("Legacy delivery queue is corrupt");
  }
  const ids = new Set<string>();
  for (const item of parsed) {
    if (ids.has(item.id)) throw new TypeError("Legacy delivery ids are not unique");
    ids.add(item.id);
  }
  return structuredClone(parsed);
}

async function persistLegacyQueue(
  filePath: string,
  items: readonly DeliveryItem[],
): Promise<void> {
  if (items.length === 0) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(items, null, 2), "utf8");
  await fs.rename(temporary, filePath);
}

function isLegacyDeliveryItem(value: unknown): value is DeliveryItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<DeliveryItem>;
  return (
    typeof item.id === "string" &&
    typeof item.target === "object" &&
    item.target !== null &&
    typeof item.createdAt === "string" &&
    Number.isFinite(Date.parse(item.createdAt)) &&
    (item.priority === "high" || item.priority === "normal" || item.priority === "low") &&
    Number.isSafeInteger(item.attempts) &&
    (item.attempts ?? -1) >= 0 &&
    Number.isSafeInteger(item.maxAttempts) &&
    (item.maxAttempts ?? 0) > 0 &&
    item.content !== undefined
  );
}

function noopLogger(): LegacyDeliveryDrainerLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}
