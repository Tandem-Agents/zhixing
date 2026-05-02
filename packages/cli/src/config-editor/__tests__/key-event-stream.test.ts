/**
 * KeyEventStream 集成测试——focus on Esc timer 行为。
 *
 * 关键不变量（防回归）：
 *   - 单按 Esc + 50ms 超时 → 产出 escape event
 *   - 方向键 ESC[A 同 chunk 到达 → arrow-up event（无 escape）
 *   - Esc 后 50ms 内来字符（如 [A）→ 不视为孤立，走 CSI 路径
 *   - 多次 Esc 连续 → 各自独立产出 escape
 *   - stop() 清理 timer，不留 leak
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeyEventStream } from "../ui/input.js";
import type { KeyEvent } from "../types.js";

/**
 * Mock stdin：支持 setRawMode / setEncoding / resume / pause / on('data') /
 * off / emit。测试通过 stdin.emit('data', chunk) 注入字符流。
 */
function createMockStdin() {
  const emitter = new EventEmitter();
  const stdin = emitter as unknown as NodeJS.ReadStream & {
    rawMode: boolean | null;
  };
  stdin.isRaw = false;
  stdin.setRawMode = vi.fn().mockImplementation(function (
    this: NodeJS.ReadStream,
    mode: boolean,
  ) {
    (this as unknown as { isRaw: boolean }).isRaw = mode;
    return this;
  }) as NodeJS.ReadStream["setRawMode"];
  stdin.setEncoding = vi.fn() as NodeJS.ReadStream["setEncoding"];
  stdin.resume = vi.fn() as NodeJS.ReadStream["resume"];
  stdin.pause = vi.fn() as NodeJS.ReadStream["pause"];
  return stdin;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function nextEvent(
  stream: ReturnType<typeof createKeyEventStream>,
): Promise<KeyEvent> {
  return await stream.next();
}

describe("KeyEventStream · Escape timer", () => {
  it("单按 Esc + 50ms 超时 → 产出 escape event", async () => {
    const stdin = createMockStdin();
    const stream = createKeyEventStream(stdin);
    stream.start();

    stdin.emit("data", "\x1b");
    // 立刻 next 没事件——decoder 在 esc 等待
    const promise = nextEvent(stream);

    // 推进 50ms 触发超时
    vi.advanceTimersByTime(50);

    expect(await promise).toEqual({ type: "escape" });
    stream.stop();
  });

  it("方向键 ESC[A 同 chunk 到达 → arrow-up（不产 escape）", async () => {
    const stdin = createMockStdin();
    const stream = createKeyEventStream(stdin);
    stream.start();

    stdin.emit("data", "\x1b[A");
    // ESC[A 在 decode 时直接产出 arrow-up，state 已重置回 none
    expect(await nextEvent(stream)).toEqual({ type: "arrow-up" });

    // 推进 timer 也不应再产生 escape
    vi.advanceTimersByTime(100);

    stream.stop();
  });

  it("Esc 后 49ms 内来 [A → 走 CSI，不超时", async () => {
    const stdin = createMockStdin();
    const stream = createKeyEventStream(stdin);
    stream.start();

    stdin.emit("data", "\x1b");
    vi.advanceTimersByTime(30); // 未超时
    stdin.emit("data", "[A");

    expect(await nextEvent(stream)).toEqual({ type: "arrow-up" });
    stream.stop();
  });

  it("Esc 后 50ms 超时 → 再来字符独立处理（不再附带 escape）", async () => {
    const stdin = createMockStdin();
    const stream = createKeyEventStream(stdin);
    stream.start();

    stdin.emit("data", "\x1b");
    vi.advanceTimersByTime(50); // 超时 → escape 已产出
    expect(await nextEvent(stream)).toEqual({ type: "escape" });

    // 此时 state 已重置；再来字符正常处理
    stdin.emit("data", "a");
    expect(await nextEvent(stream)).toEqual({ type: "char", ch: "a" });

    stream.stop();
  });

  it("两次 Esc → 两个 escape event", async () => {
    const stdin = createMockStdin();
    const stream = createKeyEventStream(stdin);
    stream.start();

    stdin.emit("data", "\x1b");
    vi.advanceTimersByTime(50);
    expect(await nextEvent(stream)).toEqual({ type: "escape" });

    stdin.emit("data", "\x1b");
    vi.advanceTimersByTime(50);
    expect(await nextEvent(stream)).toEqual({ type: "escape" });

    stream.stop();
  });

  it("Esc 等待中 stop() → 清 timer，不产生 leak", async () => {
    const stdin = createMockStdin();
    const stream = createKeyEventStream(stdin);
    stream.start();

    stdin.emit("data", "\x1b");
    stream.stop();

    vi.advanceTimersByTime(200);
    // 不会触发任何 emit；stop 已唤醒等待者发 ctrl-c 信号
  });
});

describe("KeyEventStream · 普通字符流", () => {
  it("普通字符直通", async () => {
    const stdin = createMockStdin();
    const stream = createKeyEventStream(stdin);
    stream.start();

    stdin.emit("data", "abc");
    expect(await nextEvent(stream)).toEqual({ type: "char", ch: "a" });
    expect(await nextEvent(stream)).toEqual({ type: "char", ch: "b" });
    expect(await nextEvent(stream)).toEqual({ type: "char", ch: "c" });

    stream.stop();
  });

  it("\\r\\n 单 enter（CRLF 行尾归一，护粘贴）", async () => {
    const stdin = createMockStdin();
    const stream = createKeyEventStream(stdin);
    stream.start();

    stdin.emit("data", "\r\n");
    expect(await nextEvent(stream)).toEqual({ type: "enter" });

    stream.stop();
  });

  it("Ctrl+C 即时触发", async () => {
    const stdin = createMockStdin();
    const stream = createKeyEventStream(stdin);
    stream.start();

    stdin.emit("data", "\x03");
    expect(await nextEvent(stream)).toEqual({ type: "ctrl-c" });

    stream.stop();
  });
});
