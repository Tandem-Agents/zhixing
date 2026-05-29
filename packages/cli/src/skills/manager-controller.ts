/**
 * 技能管理器控制器 —— UI 无关的"大脑":持有技能列表 + 选中位置,把导航与状态
 * 操作(置顶 / 禁用 / 改 mode / 归档)落到 Store,供 alt-screen 外壳渲染与按键驱动。
 *
 * 与渲染、按键解码彻底分离:外壳把按键映射到这里的方法、把 `view()` 画出来;
 * 控制器只管状态机与 Store 调用,故可不依赖 TUI 独立单测(注入轻量 store stub)。
 *
 * 选中跟随被操作项:状态变更会让列表重排(置顶上移等),故每次变更后按 id 找回
 * 该项的新位置,而非死守索引 —— 否则置顶后选中会跳到"恰好排到该位置"的别的技能。
 *
 * 变更后经 `onMutate` 回调通知外层(接 `registry.refresh()` 让 `/<name>` 补全即时
 * 反映禁用 / 归档带来的成员变化),再重读列表重画。
 */

import type { ManagedSkillRecord, SkillMode } from "@zhixing/core";

/** 控制器对 Store 的最小依赖(接口隔离,便于注入 stub 单测)。 */
export interface SkillManagerStore {
  listForManagement(): Promise<readonly ManagedSkillRecord[]>;
  setState(
    id: string,
    patch: { mode?: SkillMode; pinned?: boolean; disabled?: boolean },
  ): Promise<void>;
  archive(id: string): Promise<void>;
}

/** 渲染所需的视图快照 —— 外壳据此画列表 + 高亮。 */
export interface SkillManagerView {
  readonly items: readonly ManagedSkillRecord[];
  /** 当前高亮项的下标;列表空时为 -1。 */
  readonly selectedIndex: number;
}

export class SkillManagerController {
  private items: ManagedSkillRecord[] = [];
  private selected = 0;

  constructor(
    private readonly store: SkillManagerStore,
    /**
     * 技能集变更后的回调 —— 接 `registry.refresh()` 让 `/<name>` 补全即时反映
     * 禁用 / 归档带来的成员变化(§5.1)。可选:无 `/<name>` 注册的场景(测试)不传。
     */
    private readonly onMutate?: () => void | Promise<void>,
  ) {}

  /** 从 Store 读全集(含 disabled)+ usage,初始化 / 刷新列表。 */
  async load(): Promise<void> {
    this.items = [...(await this.store.listForManagement())];
    this.clampSelection();
  }

  view(): SkillManagerView {
    return {
      items: this.items,
      selectedIndex: this.items.length > 0 ? this.selected : -1,
    };
  }

  moveUp(): void {
    if (this.items.length > 0) {
      this.selected = (this.selected - 1 + this.items.length) % this.items.length;
    }
  }

  moveDown(): void {
    if (this.items.length > 0) {
      this.selected = (this.selected + 1) % this.items.length;
    }
  }

  async togglePin(): Promise<void> {
    const cur = this.current();
    if (!cur) return;
    await this.store.setState(cur.id, { pinned: !cur.pinned });
    await this.afterMutate(cur.id);
  }

  async toggleDisabled(): Promise<void> {
    const cur = this.current();
    if (!cur) return;
    await this.store.setState(cur.id, { disabled: !cur.disabled });
    await this.afterMutate(cur.id);
  }

  async cycleMode(): Promise<void> {
    const cur = this.current();
    if (!cur) return;
    const next: SkillMode = cur.mode === "main" ? "work" : "main";
    await this.store.setState(cur.id, { mode: next });
    await this.afterMutate(cur.id);
  }

  async archiveSelected(): Promise<void> {
    const cur = this.current();
    if (!cur) return;
    await this.store.archive(cur.id);
    await this.afterMutate(cur.id);
  }

  private current(): ManagedSkillRecord | null {
    return this.items[this.selected] ?? null;
  }

  /** 变更后:重读列表(重排)→ 选中跟回被操作项(还在则跟,已归档则由 clamp 落位)→ 通知外层刷新。 */
  private async afterMutate(operatedId: string): Promise<void> {
    await this.load();
    const idx = this.items.findIndex((m) => m.id === operatedId);
    if (idx >= 0) this.selected = idx;
    await this.onMutate?.();
  }

  private clampSelection(): void {
    if (this.items.length === 0) {
      this.selected = 0;
      return;
    }
    this.selected = Math.min(Math.max(this.selected, 0), this.items.length - 1);
  }
}
