import type { IEventBus } from "../events/index.js";
import { DeliveryQueue } from "./queue.js";
import type {
  DeliveryEventMap,
  DeliveryItem,
  DeliveryPriority,
  DeliverySender,
  DeliveryStats,
  EnqueueParams,
  IDeliveryPipeline,
} from "./types.js";

/**
 * DeliveryPipeline
 *
 * ─── 契约一：忠实送达（faithful delivery） ──────────────────────
 *
 * 所有 enqueue 的消息都会尝试送到 sender，Pipeline 不主动 drop 任何消息。
 *
 * 历史上 Pipeline 曾内置 DedupFilter（按 content 24h 去重），但该策略会
 * 误杀业务独立事件（两个 scheduler task 生成相同文本时第二条被吞）。去重
 * 是业务策略不是基础设施职责，应在对应层各自处理：
 *   - 防 LLM 复读 → Agent Loop（history dedup / prompt 调优）
 *   - 防 Scheduler 重复 fire → Scheduler 任务一致性保证
 *   - 防 channel 客户端合并 → Channel Adapter 层处理
 *   - 防 pipeline 持久化重入 → Queue 层的 itemId correctness
 *
 * ─── 契约二：显式生命周期 ──────────────────────────────────
 *
 *   unstarted ──start()──▶ running ──stop()──▶ stopped
 *
 * - `unstarted`：constructor 完成后的初始态。enqueue/flush/stop 均抛错。
 *   校验存在的必要性：防止绕过 `queue.load()` 导致 enqueue 后 save 覆盖磁盘历史。
 * - `running`：start() 成功后的正常工作态。enqueue/flush 可用。
 *   start() 契约：**返回即完成所有可恢复 work**——awaited recovery flush，
 *   避免"启动后异步泄漏 + 状态竞态"。
 * - `stopped`：stop() 后。enqueue/flush 抛错；重复 stop() 幂等（no-op）。
 *   不支持重新 start（pipeline 是单次使用对象，callers 通常是进程级生命周期）。
 *
 * ─── 契约三：flush 单飞（singleflight） ───────────────────────
 *
 * 并发 caller 调 flush() 共享同一次 drain 的 promise，等同一次完成——不会
 * 让第二个 caller 立即 return（那是 false positive，caller 以为 queue 清空
 * 但别人的 flush 还在跑）。
 */

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

/**
 * Pipeline 生命周期：
 *   unstarted ──start()──▶ running ──stop()──▶ stopped
 *
 * - `unstarted`：constructor 完成后的初始态。不能 enqueue/flush（会抛错），
 *   防止绕过 `queue.load()` 的持久化数据读取（否则 enqueue 后 save 会覆盖磁盘历史）。
 * - `running`：`start()` 调用成功后的正常工作态。可 enqueue/flush。
 * - `stopped`：`stop()` 调用后。不支持重新 start（caller 通常是进程级生命周期）。
 */
type PipelineState = "unstarted" | "running" | "stopped";

export class DeliveryPipeline implements IDeliveryPipeline {
  private readonly queue: DeliveryQueue;
  private readonly sender: DeliverySender;
  private readonly eventBus: IEventBus<DeliveryEventMap>;
  private readonly config: DeliveryPipelineConfig;
  private readonly now: () => Date;
  private readonly logger: DeliveryLogger;

  private state: PipelineState = "unstarted";
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Singleflight：当前正在运行的 flush 的 promise。
   * 并发 caller 共享这个 promise 等同一次 drain 完成，而不是让后来者立即 return（false positive）。
   */
  private activeFlush: Promise<void> | null = null;

  private deliveredCount = 0;
  private failedCount = 0;

  constructor(deps: DeliveryPipelineDeps) {
    this.sender = deps.sender;
    this.eventBus = deps.eventBus;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? noopLogger();

    this.queue = new DeliveryQueue({ filePath: deps.config.queueFilePath });
  }

  async start(): Promise<void> {
    if (this.state !== "unstarted") {
      throw new Error(
        `Pipeline.start: illegal transition from state="${this.state}" (pipelines are single-use)`,
      );
    }

    const pending = await this.queue.load();
    if (pending > 0) {
      this.logger.info(`Loaded ${pending} pending delivery item(s)`);
    }
    this.state = "running";

    // start() 契约：返回即"启动完成 + **已尝试**恢复 pending"。
    // 同步 flush pending 避免异步泄漏 + 状态竞态；但若恢复因临时 IO 故障（如磁盘 save 失败）
    // 抛错，不让 start 失败——降级为 warn 日志，flushTimer 兜底重试。
    if (pending > 0) {
      try {
        await this.flush();
      } catch (err) {
        this.logger.warn(
          "Recovery flush failed during start; will retry via flushTimer",
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    if (this.config.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        // 防御性 state check：clearInterval 后已排队的 callback 理论不再 fire，
        // 但对 race 边界静默跳过比抛 assertRunning 错误更干净（避免 Auto-flush error 噪音）
        if (this.state !== "running") return;
        this.flush().catch((err) => {
          this.logger.error("Auto-flush error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, this.config.flushIntervalMs);
    }
  }

  async stop(): Promise<void> {
    if (this.state !== "running") {
      // stop 对已 stopped 幂等；但对 unstarted 抛（通常是调用方 bug）
      if (this.state === "stopped") return;
      throw new Error(
        `Pipeline.stop: illegal transition from state="${this.state}"`,
      );
    }

    // 顺序至关重要——优雅关停的四步走：
    //  ① 先置 stopped：后续新 enqueue/flush 走 assertRunning 立刻抛错，不再入场
    //  ② clearInterval：阻止新 timer callback fire
    //  ③ await activeFlush：给 in-flight drain 落地机会，不留后台发送泄漏
    //  ④ save queue：兜底持久化（activeFlush 内已 save 过一次，这里覆盖可能的最终脏态）
    this.state = "stopped";
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.activeFlush) {
      try {
        await this.activeFlush;
      } catch {
        // in-flight drain 错误已在内部记录；stop 保持 best-effort
      }
    }
    await this.queue.save();
  }

  async enqueue(params: EnqueueParams): Promise<string> {
    this.assertRunning("enqueue");
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
    this.assertRunning("flush");
    // Singleflight：并发 caller 等同一次 drain 完成。避免"第二个 caller 看到
    // activeFlush 非空就立即 return"的 false positive——那会让 caller 误以为
    // queue 已清空，但其实别人的 flush 还在跑。
    if (this.activeFlush) return this.activeFlush;

    this.activeFlush = this.doFlush().finally(() => {
      this.activeFlush = null;
    });
    return this.activeFlush;
  }

  private async doFlush(): Promise<void> {
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

  private assertRunning(op: string): void {
    if (this.state !== "running") {
      throw new Error(
        `Pipeline.${op}: pipeline not running (state="${this.state}"). Call start() first.`,
      );
    }
  }

  private async processItem(item: DeliveryItem): Promise<void> {
    const ageMs = this.now().getTime() - new Date(item.createdAt).getTime();
    if (ageMs > this.config.itemTtlMs) {
      await this.handleFinalFailure(
        item,
        `Expired after ${Math.round(ageMs / 60_000)}min in queue`,
      );
      return;
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
      const result = await this.sender.send(item.target, item.content, {
        source: item.source,
        itemId: item.id,
      });

      if (result.success) {
        this.queue.remove(item.id);
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
