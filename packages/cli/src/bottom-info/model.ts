import { renderBottomInfoLine } from "./render.js";

export type BottomInfoZone = "left" | "right";
export interface BottomInfoSnapshot {
  readonly left: readonly string[];
  readonly right: readonly string[];
}

/** 每个发布者只持有自己的内容块（不含布局缩进）；释放后，迟到更新无效。 */
export interface BottomInfoSource {
  set(zone: BottomInfoZone, id: string, content: string | null): void;
  dispose(): void;
}
interface Entry {
  readonly scope?: BottomInfoScope;
  readonly left: Map<string, string>;
  readonly right: Map<string, string>;
}

/** 接入面提供内容与场景，容器不读取输入、业务或服务状态。 */
export class BottomInfoModel {
  private readonly entries = new Set<Entry>();
  private readonly listeners = new Set<(scope?: BottomInfoScope) => void>();

  createScope(): BottomInfoScope { return new BottomInfoScope(this); }

  /** 无 scope 的来源跨场景共享；有 scope 的来源仅在该次交互有效。 */
  createSource(scope?: BottomInfoScope): BottomInfoSource {
    const entry: Entry = { scope, left: new Map(), right: new Map() };
    if (!scope?.disposed) this.entries.add(entry);
    return {
      set: (zone, id, content) => {
        if (!this.entries.has(entry) || scope?.disposed) return;
        const next = content || null;
        if ((entry[zone].get(id) ?? null) === next) return;
        if (next === null) entry[zone].delete(id);
        else entry[zone].set(id, next);
        this.notify(scope);
      },
      dispose: () => {
        if (!this.entries.delete(entry)) return;
        if (entry.left.size || entry.right.size) this.notify(scope);
      },
    };
  }

  /** 来源及块按注册顺序排列，更新保位。默认只读取跨场景内容。 */
  snapshot(scope?: BottomInfoScope): BottomInfoSnapshot {
    const left: string[] = [];
    const right: string[] = [];
    for (const entry of this.entries) {
      if (entry.scope && (entry.scope !== scope || !scope?.visible)) continue;
      left.push(...entry.left.values());
      right.push(...entry.right.values());
    }
    return { left, right };
  }

  subscribe(listener: (scope?: BottomInfoScope) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  release(scope: BottomInfoScope): void {
    for (const entry of this.entries) {
      if (entry.scope === scope) this.entries.delete(entry);
    }
    this.notify(scope);
  }

  private notify(scope?: BottomInfoScope): void {
    for (const listener of this.listeners) listener(scope);
  }
}

/** 一次交互的可见期。同步提示直接投影，异步公告通过有所有权的 source 发布。 */
export class BottomInfoScope {
  private paused = false;
  private closed = false;
  private readonly subscriptions = new Set<() => void>();
  constructor(private readonly model: BottomInfoModel) {}
  get disposed(): boolean { return this.closed; }
  get visible(): boolean { return !this.closed && !this.paused; }
  createSource(): BottomInfoSource { return this.model.createSource(this); }

  subscribe(listener: () => void): () => void {
    if (this.closed) return () => {};
    const detach = this.model.subscribe((scope) => {
      if (this.visible && (!scope || scope === this)) listener();
    });
    const unsubscribe = () => {
      detach();
      this.subscriptions.delete(unsubscribe);
    };
    this.subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  render(content: BottomInfoSnapshot, width: number): string {
    if (!this.visible) return "";
    const shared = this.model.snapshot(this);
    return renderBottomInfoLine(
      [...content.left, ...shared.left],
      [...content.right, ...shared.right],
      width,
    );
  }
  pause(): void { this.paused = true; }
  resume(): void { if (!this.closed) this.paused = false; }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.model.release(this);
  }
}
