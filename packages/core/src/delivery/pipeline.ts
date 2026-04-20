import type { IEventBus } from "../events/index.js";
import { DedupFilter } from "./dedup.js";
import { DeliveryQueue } from "./queue.js";
import type {
  DeliveryEventMap,
  DeliveryFilter,
  DeliveryItem,
  DeliveryPriority,
  DeliverySender,
  DeliveryStats,
  EnqueueParams,
  IDeliveryPipeline,
} from "./types.js";

// ─── 配置 ───

export interface DeliveryPipelineConfig {
  maxAttempts: number;
  baseRetryDelayMs: number;
  flushIntervalMs: number;
  queueFilePath: string;
  itemTtlMs: number;
}

export const DEFAULT_DELIVERY_CONFIG: Omit<DeliveryPipelineConfig, "queueFilePath"> = {
  maxAttempts: 3,
  baseRetryDelayMs: 5_000,
  flushIntervalMs: 30_000,
  itemTtlMs: 60 * 60 * 1000,
};

// ─── 依赖注入 ───

export interface DeliveryPipelineDeps {
  sender: DeliverySender;
  eventBus: IEventBus<DeliveryEventMap>;
  config: DeliveryPipelineConfig;
  filters?: DeliveryFilter[];
  now?: () => Date;
  logger?: DeliveryLogger;
}

export interface DeliveryLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}

// ─── DeliveryPipeline ───

const PRIORITY_ORDER: Record<DeliveryPriority, number> = {
  high: 3,
  normal: 2,
  low: 1,
};

export class DeliveryPipeline implements IDeliveryPipeline {
  private readonly queue: DeliveryQueue;
  private readonly sender: DeliverySender;
  private readonly eventBus: IEventBus<DeliveryEventMap>;
  private readonly config: DeliveryPipelineConfig;
  private readonly filters: DeliveryFilter[];
  private readonly dedup: DedupFilter;
  private readonly now: () => Date;
  private readonly logger: DeliveryLogger;

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  private deliveredCount = 0;
  private failedCount = 0;

  constructor(deps: DeliveryPipelineDeps) {
    this.sender = deps.sender;
    this.eventBus = deps.eventBus;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? noopLogger();

    this.queue = new DeliveryQueue({ filePath: deps.config.queueFilePath });
    this.dedup = new DedupFilter({ now: this.now });
    this.filters = [this.dedup, ...(deps.filters ?? [])];
  }

  async start(): Promise<void> {
    const pending = await this.queue.load();
    if (pending > 0) {
      this.logger.info(`Loaded ${pending} pending delivery item(s)`);
    }

    if (this.config.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch((err) => {
          this.logger.error("Auto-flush error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, this.config.flushIntervalMs);
    }

    if (pending > 0) {
      this.flush().catch((err) => {
        this.logger.error("Recovery flush error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.queue.save();
  }

  async enqueue(params: EnqueueParams): Promise<string> {
    const id = generateId();
    const item: DeliveryItem = {
      id,
      target: params.target,
      content: params.content,
      priority: params.priority ?? "normal",
      source: params.source,
      createdAt: this.now().toISOString(),
      attempts: 0,
      maxAttempts: params.maxAttempts ?? this.config.maxAttempts,
    };

    this.queue.enqueue(item);
    await this.queue.save();

    await this.eventBus.emit("delivery:enqueued", {
      itemId: id,
      target: item.target,
    });

    this.logger.debug("Delivery enqueued", {
      id,
      channelId: item.target.channelId,
    });
    return id;
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    try {
      const now = this.now();
      const ready = this.queue.getReady(now);
      ready.sort((a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]);

      for (const item of ready) {
        try {
          await this.processItem(item);
        } catch (err) {
          this.logger.error("Unexpected error processing delivery item", {
            id: item.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await this.queue.save();
    } finally {
      this.flushing = false;
    }
  }

  stats(): DeliveryStats {
    const retrying = this.queue.all.filter(
      (i) => i.attempts > 0 && i.nextAttemptAt,
    ).length;
    return {
      queued: this.queue.size,
      delivered: this.deliveredCount,
      failed: this.failedCount,
      retrying,
    };
  }

  // ─── 内部 ───

  private async processItem(item: DeliveryItem): Promise<void> {
    const ageMs = this.now().getTime() - new Date(item.createdAt).getTime();
    if (ageMs > this.config.itemTtlMs) {
      await this.handleFinalFailure(
        item,
        `Expired after ${Math.round(ageMs / 60_000)}min in queue`,
      );
      return;
    }

    for (const filter of this.filters) {
      const verdict = await filter.check(item);
      if (!verdict.pass) {
        this.logger.debug(`Filtered by ${filter.name}: ${verdict.reason}`, {
          id: item.id,
        });
        this.queue.remove(item.id);
        return;
      }
    }

    if (!this.sender.isReady(item.target.channelId)) {
      item.nextAttemptAt = new Date(
        this.now().getTime() + this.config.baseRetryDelayMs,
      ).toISOString();
      this.queue.markDirty();
      this.logger.debug("Channel not ready, deferring", {
        id: item.id,
        channelId: item.target.channelId,
      });
      return;
    }

    item.attempts += 1;
    this.queue.markDirty();

    try {
      const result = await this.sender.send(item.target, item.content);

      if (result.success) {
        this.queue.remove(item.id);
        this.dedup.record(item);
        this.deliveredCount += 1;

        await this.eventBus.emit("delivery:success", {
          itemId: item.id,
          target: item.target,
          attempts: item.attempts,
        });
        this.logger.info("Delivery success", {
          id: item.id,
          attempts: item.attempts,
        });
      } else if (result.retryable && item.attempts < item.maxAttempts) {
        item.lastError = result.error;
        await this.scheduleRetry(item);
      } else {
        await this.handleFinalFailure(item, result.error ?? "Unknown error");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (item.attempts < item.maxAttempts) {
        item.lastError = message;
        await this.scheduleRetry(item);
      } else {
        await this.handleFinalFailure(item, message);
      }
    }
  }

  private async scheduleRetry(item: DeliveryItem): Promise<void> {
    const delay =
      this.config.baseRetryDelayMs * Math.pow(2, item.attempts - 1);
    const nextAt = new Date(this.now().getTime() + delay).toISOString();
    item.nextAttemptAt = nextAt;
    this.queue.markDirty();

    await this.eventBus.emit("delivery:retry", {
      itemId: item.id,
      target: item.target,
      attempt: item.attempts,
      nextAttemptAt: nextAt,
    });

    this.logger.debug("Retry scheduled", {
      id: item.id,
      attempt: item.attempts,
      nextAt,
    });
  }

  private async handleFinalFailure(
    item: DeliveryItem,
    error: string,
  ): Promise<void> {
    this.queue.remove(item.id);
    this.failedCount += 1;

    await this.eventBus.emit("delivery:failed", {
      itemId: item.id,
      target: item.target,
      error,
      attempts: item.attempts,
    });

    this.logger.warn("Delivery failed permanently", {
      id: item.id,
      attempts: item.attempts,
      error,
    });
  }
}

// ─── 工具函数 ───

function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `dlv_${ts}_${rand}`;
}

function noopLogger(): DeliveryLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}
