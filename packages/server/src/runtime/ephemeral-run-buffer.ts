/**
 * EphemeralRunBuffer —— ephemeral 会话的内存事实流缓冲。
 *
 * 与磁盘分片流**同构**：磁盘流的 store 是唯一 assigner（append 即定格
 * runIndex）；内存流以本缓冲为唯一 assigner（enqueue 即定格 provisional
 * runIndex），编号纪律相同——从 0 单调递增、出队不回号。promote = 把缓冲
 * 按序重放进磁盘流；对账 = 校验两个 assigner 给号一致。
 *
 * 设计要点：provisional runIndex 是"这条 run 落盘时将拿到此编号"的承诺，
 * 在入列那一刻定格在条目自身上——窗口配对锚（acceptRun）与 promote 对账
 * 消费的是**同一份事实**，不存在事后由外部状态推导的脆弱耦合；序号状态
 * 封闭在缓冲内部，非法形态（重号 / 回号 / 序号与条目分离）不可表示。
 */

import type { RunRecordInput } from "@zhixing/core";

/** 缓冲条目 —— record 与其入列时定格的 provisional runIndex 不可分离 */
export interface PendingRun {
  readonly provisionalRunIndex: number;
  readonly record: RunRecordInput;
}

export class EphemeralRunBuffer {
  private readonly entries: PendingRun[] = [];
  private nextProvisional = 0;

  get size(): number {
    return this.entries.length;
  }

  /**
   * 入列并定格 provisional runIndex —— 内存流的唯一编号分配点。
   * 返回值供调用方随 acceptRun 落进窗口配对（折叠覆盖锚点）。
   */
  enqueue(record: RunRecordInput): number {
    const provisionalRunIndex = this.nextProvisional;
    this.nextProvisional += 1;
    this.entries.push({ provisionalRunIndex, record });
    return provisionalRunIndex;
  }

  /** 队首（promote flush 的下一条）；空缓冲返回 undefined */
  peek(): PendingRun | undefined {
    return this.entries[0];
  }

  /**
   * 队首出队 —— 仅在该条落盘成功后调用（"先盘后出"的 retry 安全时序由
   * 调用方保证）。出队不回号：后续 enqueue 序号继续单调。
   */
  dequeue(): void {
    this.entries.shift();
  }

  /** 只读快照（观测 / 测试断言用） */
  list(): readonly PendingRun[] {
    return [...this.entries];
  }
}
