import fs from "node:fs/promises";
import path from "node:path";
import type { DeliveryItem } from "./types.js";

export interface DeliveryQueueOptions {
  filePath: string;
}

export class DeliveryQueue {
  private items: DeliveryItem[] = [];
  private readonly filePath: string;
  private dirty = false;

  constructor(options: DeliveryQueueOptions) {
    this.filePath = options.filePath;
  }

  async load(): Promise<number> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content);
      this.items = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.items = [];
    }
    return this.items.length;
  }

  /**
   * Persist queue to disk.
   *
   * 已知局限（KL-1 / KL-3，见 research/design/specifications/persistent-service.md
   * §4.7 "Known Limitations"）：并发 save 调用会产生 tmp+rename race，
   * 其一可能抛 ENOENT。高并发 enqueue 或 "stop 与 in-flight enqueue 并发"
   * 场景下可能触发。修复方向：singleflight（activeSave promise）或串行 chain。
   * 当前作为独立工单跟踪，未修。
   */
  async save(): Promise<void> {
    if (!this.dirty) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = this.filePath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(this.items, null, 2), "utf-8");
    await fs.rename(tmpPath, this.filePath);
    this.dirty = false;
  }

  enqueue(item: DeliveryItem): void {
    this.items.push(item);
    this.dirty = true;
  }

  remove(id: string): boolean {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    this.dirty = true;
    return true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  getReady(now: Date): DeliveryItem[] {
    return this.items.filter((item) => {
      if (!item.nextAttemptAt) return true;
      return new Date(item.nextAttemptAt) <= now;
    });
  }

  get size(): number {
    return this.items.length;
  }

  get all(): readonly DeliveryItem[] {
    return this.items;
  }
}
