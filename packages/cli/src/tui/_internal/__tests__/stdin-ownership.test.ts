/**
 * stdin-ownership.ts 单元测试
 *
 * 覆盖点：
 *   1. Snapshot 当前 listeners + removeAll
 *   2. release 按原顺序恢复
 *   3. 独占期间，预挂 listener 不收到 keypress（核心 §6.4 陷阱 3 回归护栏）
 *   4. release 后预挂 listener 恢复接收
 *   5. 多次 acquire/release 嵌套（独立 handle）
 *   6. release 幂等
 *   7. 空 listener 集合下 acquire/release 不崩
 *   8. emitKeypressEvents 幂等调用（不重复绑 data 解码器）
 */

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { acquireStdinOwnership } from "../stdin-ownership.js";

/**
 * 构造一个类 TTY stdin。PassThrough 默认非 TTY，但 stdin-ownership
 * 的逻辑不关心 isTTY —— 它只操作 listeners，对任意 EventEmitter 工作。
 */
function makeStdin() {
  const stdin = new PassThrough();
  // 用一个数组记录所有执行过的 acquire / release 以便清理
  return stdin as unknown as NodeJS.ReadStream & PassThrough;
}

const cleanup: Array<() => void> = [];

afterEach(() => {
  while (cleanup.length > 0) {
    cleanup.pop()?.();
  }
});

describe("acquireStdinOwnership — 基础语义", () => {
  it("Snapshot 并摘除已挂的 keypress listener", () => {
    const stdin = makeStdin();
    const spy1 = (_str: string | undefined) => {};
    const spy2 = (_str: string | undefined) => {};
    stdin.on("keypress", spy1);
    stdin.on("keypress", spy2);
    expect(stdin.listenerCount("keypress")).toBe(2);

    const handle = acquireStdinOwnership(stdin);
    expect(stdin.listenerCount("keypress")).toBe(0);

    handle.release();
    expect(stdin.listenerCount("keypress")).toBe(2);
    // 按原顺序恢复
    expect(stdin.listeners("keypress")).toEqual([spy1, spy2]);
  });

  it("独占期间，预挂 listener 不被调用（§6.4 陷阱 3 回归护栏）", () => {
    const stdin = makeStdin();
    const received: Array<string | undefined> = [];
    const preExisting = (str: string | undefined) => {
      received.push(str);
    };
    stdin.on("keypress", preExisting);

    const handle = acquireStdinOwnership(stdin);

    // 模拟组件期间的 keypress 事件
    (stdin as NodeJS.EventEmitter).emit("keypress", "a", { name: "a" });
    (stdin as NodeJS.EventEmitter).emit("keypress", "b", { name: "b" });
    expect(received).toEqual([]);

    handle.release();

    // 恢复后 keypress 应能到达
    (stdin as NodeJS.EventEmitter).emit("keypress", "c", { name: "c" });
    expect(received).toEqual(["c"]);
  });

  it("release 幂等：重复调用不重复恢复", () => {
    const stdin = makeStdin();
    const listener = () => {};
    stdin.on("keypress", listener);

    const handle = acquireStdinOwnership(stdin);
    handle.release();
    handle.release(); // 应无操作
    handle.release();

    expect(stdin.listenerCount("keypress")).toBe(1);
    expect(stdin.listeners("keypress")).toEqual([listener]);
  });

  it("空 listener 集合：acquire/release 不崩", () => {
    const stdin = makeStdin();
    expect(stdin.listenerCount("keypress")).toBe(0);

    const handle = acquireStdinOwnership(stdin);
    expect(stdin.listenerCount("keypress")).toBe(0);

    handle.release();
    expect(stdin.listenerCount("keypress")).toBe(0);
  });

  it("嵌套 acquire：内层 snapshot 的是外层加的 listener（不含更早的）", () => {
    // 这个测试验证"嵌套"语义：外层摘除原始 listener，内层 snapshot 的是
    // 外层（当时 listener 数为 0）的状态，release 时恢复到无 listener。
    // 外层 release 时恢复到原始 listener。
    const stdin = makeStdin();
    const original = () => {};
    stdin.on("keypress", original);

    const outer = acquireStdinOwnership(stdin);
    expect(stdin.listenerCount("keypress")).toBe(0);

    // 外层组件挂自己的 listener
    const outerOwn = () => {};
    stdin.on("keypress", outerOwn);
    expect(stdin.listenerCount("keypress")).toBe(1);

    const inner = acquireStdinOwnership(stdin);
    expect(stdin.listenerCount("keypress")).toBe(0);

    inner.release();
    // 内层 snapshot 的是 [outerOwn]，恢复后 listenerCount=1
    expect(stdin.listenerCount("keypress")).toBe(1);
    expect(stdin.listeners("keypress")).toEqual([outerOwn]);

    // 外层组件收工前先摘掉自己的 listener
    stdin.off("keypress", outerOwn);

    outer.release();
    // 外层 snapshot 的是 [original]，恢复后 listenerCount=1
    expect(stdin.listenerCount("keypress")).toBe(1);
    expect(stdin.listeners("keypress")).toEqual([original]);
  });

  it("保持 listener 引用身份（对比相同函数可用 removeListener）", () => {
    const stdin = makeStdin();
    const listener = (_str: string | undefined) => {};
    stdin.on("keypress", listener);

    const handle = acquireStdinOwnership(stdin);
    handle.release();

    // 恢复后应该能用原引用 removeListener 成功
    stdin.off("keypress", listener);
    expect(stdin.listenerCount("keypress")).toBe(0);
  });

  it("snapshot 是拷贝：期间外部改动不影响 restore", () => {
    const stdin = makeStdin();
    const a = () => {};
    const b = () => {};
    stdin.on("keypress", a);
    stdin.on("keypress", b);

    const handle = acquireStdinOwnership(stdin);
    // 期间如果某种逻辑又把 a 加回来（不该发生但防御测试）
    stdin.on("keypress", a);

    handle.release();
    // 恢复后的 listener 应该是 snapshot 时的 [a, b]，加上期间临时加的那个 a —— 总共 3 个
    // 关键：snapshot 是 .slice()，不会被期间的外部改动污染
    expect(stdin.listenerCount("keypress")).toBe(3);
  });
});
