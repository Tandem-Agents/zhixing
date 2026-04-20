import type { DeliveryFilter, DeliveryItem, FilterVerdict } from "./types.js";

export interface DedupFilterOptions {
  windowMs?: number;
  now?: () => Date;
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * DedupFilter 实现了 DeliveryFilter，用于在指定窗口期（windowMs）内过滤重复的投递内容。
 * - 支持自定义去重时间窗口（默认24小时）。
 * - 通过 `itemKey` 生成目标+内容摘要的唯一标识。
 * - `check` 方法用于在投递前判断内容是否在去重窗口内已投递，如果是则拒绝并提供原因。
 * - `record` 方法在内容投递后登记已投递时间，用于后续去重检查。
 * - 周期性通过 `evict` 清理过期记录，防止内存无限增长。
 */
export class DedupFilter implements DeliveryFilter {
  readonly name = "dedup";
  private readonly windowMs: number;
  private readonly nowMs: () => number;
  private readonly seen = new Map<string, number>();

  constructor(options?: DedupFilterOptions) {
    this.windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
    const nowFn = options?.now;
    this.nowMs = nowFn ? () => nowFn().getTime() : () => Date.now();
  }

  check(item: DeliveryItem): FilterVerdict {
    this.evict();
    const key = this.itemKey(item);

    if (this.seen.has(key)) {
      return {
        pass: false,
        reason: `Duplicate content within ${this.windowMs / 3_600_000}h window`,
      };
    }

    return { pass: true };
  }

  record(item: DeliveryItem): void {
    const key = this.itemKey(item);
    this.seen.set(key, this.nowMs());
  }

  private itemKey(item: DeliveryItem): string {
    return `${item.target.channelId}\0${item.target.to}\0${item.content.text.slice(0, 500)}`;
  }

  private evict(): void {
    const cutoff = this.nowMs() - this.windowMs;
    for (const [key, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(key);
    }
  }
}
