/**
 * 底部信息行的内容模型 —— 来源无关的具名块容器。
 *
 * 信息行横向分左 / 右两区,每区可并排多个具名块。任何来源(输入区的输入态、
 * 系统事件、用户行为等)都通过 `set(zone, id, content)` 往容器推内容、
 * `set(..., null)` 清除;**容器与渲染都不关心块来自谁** —— 来源无关是它存在的
 * 根本理由:渲染侧只消费 `snapshot()`,永不读任何来源的内部状态。
 *
 * 块的视觉顺序由 `BOTTOM_INFO_IDS` 的声明顺序唯一决定(`snapshot` 按此序输出),
 * 与各来源运行时首次写入的时序无关 —— 顺序是命名权威的属性,而非时序竞态的
 * 产物。新增来源时在 `BOTTOM_INFO_IDS` 加 key,声明位置即区内视觉顺序。
 *
 * 生命周期约定:**来源负责自己 block 的完整生命周期**。来源 active 时维护自己
 * 的块,销毁(如其宿主 stop)时须 `set(..., null)` 清除自己贡献的块,不给容器
 * 留"不知道谁放的、谁该清的"残留块。
 */

export type BottomInfoZone = "left" | "right";

/**
 * 信息行具名块 id 注册表 —— 命名与区内视觉顺序的唯一权威。
 * 调用方禁止直接写字符串字面量,必须引用本对象常量;声明顺序即视觉顺序。
 */
export const BOTTOM_INFO_IDS = {
  /** 输入框有内容时的清空提示(由输入区作为来源推送) */
  escHint: "esc-hint",
} as const;

/** 已知 block id 的字面量联合 —— set 的 id 受此约束,杜绝野 id。 */
export type BottomInfoId = (typeof BOTTOM_INFO_IDS)[keyof typeof BOTTOM_INFO_IDS];

export interface BottomInfoSnapshot {
  readonly left: readonly string[];
  readonly right: readonly string[];
}

export class BottomInfoModel {
  private readonly left = new Map<BottomInfoId, string>();
  private readonly right = new Map<BottomInfoId, string>();

  /** 推送(content 非空)或清除(content === null)指定区的一个具名块。 */
  set(zone: BottomInfoZone, id: BottomInfoId, content: string | null): void {
    const map = zone === "left" ? this.left : this.right;
    if (content === null) {
      map.delete(id);
    } else {
      map.set(id, content);
    }
  }

  /**
   * 渲染读 —— 每区按 `BOTTOM_INFO_IDS` 声明顺序输出当前存在的块内容。
   * 按注册表序(而非 Map 插入序)保证视觉顺序稳定、与各来源写入时序无关。
   */
  snapshot(): BottomInfoSnapshot {
    const order = Object.values(BOTTOM_INFO_IDS) as BottomInfoId[];
    const pick = (map: Map<BottomInfoId, string>): string[] =>
      order.filter((id) => map.has(id)).map((id) => map.get(id)!);
    return { left: pick(this.left), right: pick(this.right) };
  }
}
