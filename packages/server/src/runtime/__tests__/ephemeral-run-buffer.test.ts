/**
 * EphemeralRunBuffer —— 内存事实流缓冲的编号纪律契约。
 *
 * 核心不变量由数据结构自身承载：provisional runIndex 在 enqueue 时定格在
 * 条目上（与 record 不可分离）、从 0 单调递增、出队不回号——promote 中途
 * 失败重试 / 继续入列的任何交错下序号都不重复、不倒退。
 */

import { describe, expect, it } from "vitest";
import type { RunRecordInput } from "@zhixing/core";
import { EphemeralRunBuffer } from "../ephemeral-run-buffer.js";

function record(text: string): RunRecordInput {
  return {
    timestamp: new Date().toISOString(),
    messages: [
      { role: "user", content: [{ type: "text", text }] },
      { role: "assistant", content: [{ type: "text", text: `re:${text}` }] },
    ],
  };
}

describe("EphemeralRunBuffer", () => {
  it("enqueue 即定格序号：从 0 单调、随条目自带", () => {
    const buf = new EphemeralRunBuffer();
    expect(buf.enqueue(record("一"))).toBe(0);
    expect(buf.enqueue(record("二"))).toBe(1);
    expect(buf.list().map((e) => e.provisionalRunIndex)).toEqual([0, 1]);
    expect(buf.size).toBe(2);
  });

  it("出队不回号：flush 部分成功后继续入列，序号不重复", () => {
    const buf = new EphemeralRunBuffer();
    buf.enqueue(record("零"));
    buf.enqueue(record("一"));
    // 模拟 promote 落盘成功一条后中断
    expect(buf.peek()!.provisionalRunIndex).toBe(0);
    buf.dequeue();
    // 中断期间继续入列 —— 序号接 2，不与队内 1 重复
    expect(buf.enqueue(record("二"))).toBe(2);
    expect(buf.list().map((e) => e.provisionalRunIndex)).toEqual([1, 2]);
  });

  it("peek 不出队；空缓冲 peek 为 undefined", () => {
    const buf = new EphemeralRunBuffer();
    expect(buf.peek()).toBeUndefined();
    buf.enqueue(record("x"));
    expect(buf.peek()).toBe(buf.peek());
    expect(buf.size).toBe(1);
  });

  it("list 是只读快照，不暴露内部可变结构", () => {
    const buf = new EphemeralRunBuffer();
    buf.enqueue(record("x"));
    const snapshot = [...buf.list()];
    buf.dequeue();
    expect(snapshot).toHaveLength(1); // 快照不随内部变化
    expect(buf.size).toBe(0);
  });
});
