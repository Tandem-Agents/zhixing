import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartupProgressPresenter } from "../startup-progress.js";

class FakeStdout {
  buffer = "";
  write(chunk: string): boolean {
    this.buffer += chunk;
    return true;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("StartupProgressPresenter", () => {
  it("快速启动不输出任何提示", () => {
    vi.useFakeTimers();
    const out = new FakeStdout();
    const progress = createStartupProgressPresenter({
      stdout: out,
      delayMs: 500,
      text: "opening",
    });

    progress.begin();
    vi.advanceTimersByTime(499);
    progress.stop();

    expect(out.buffer).toBe("");
  });

  it("超过阈值后只写当前行，不写换行", () => {
    vi.useFakeTimers();
    const out = new FakeStdout();
    const progress = createStartupProgressPresenter({
      stdout: out,
      delayMs: 500,
      text: "opening",
    });

    progress.begin();
    vi.advanceTimersByTime(500);

    expect(out.buffer).toBe("\r\x1b[2Kopening");
  });

  it("停止时清理已显示的当前行", () => {
    vi.useFakeTimers();
    const out = new FakeStdout();
    const progress = createStartupProgressPresenter({
      stdout: out,
      delayMs: 500,
      text: "opening",
    });

    progress.begin();
    vi.advanceTimersByTime(500);
    progress.stop();

    expect(out.buffer).toBe("\r\x1b[2Kopening\r\x1b[2K");
  });

  it("长等待时升级提示，仍停留在当前行", () => {
    vi.useFakeTimers();
    const out = new FakeStdout();
    const progress = createStartupProgressPresenter({
      stdout: out,
      delayMs: 500,
      longDelayMs: 1_000,
      text: "opening",
      longText: "still opening",
    });

    progress.begin();
    vi.advanceTimersByTime(1_000);

    expect(out.buffer).toBe(
      "\r\x1b[2Kopening\r\x1b[2Kstill opening",
    );
  });

  it("禁用后后续 begin 不再输出", () => {
    vi.useFakeTimers();
    const out = new FakeStdout();
    const progress = createStartupProgressPresenter({
      stdout: out,
      delayMs: 500,
      text: "opening",
    });

    progress.begin();
    progress.disable();
    progress.begin();
    vi.advanceTimersByTime(1_000);

    expect(out.buffer).toBe("");
  });

  it("stop 只清理当前行，不结束启动期 lifecycle 屏蔽", () => {
    vi.useFakeTimers();
    const out = new FakeStdout();
    const progress = createStartupProgressPresenter({
      stdout: out,
      delayMs: 500,
      text: "opening",
    });

    progress.begin();
    vi.advanceTimersByTime(500);
    progress.stop();
    expect(progress.acceptsStartupNotices()).toBe(true);

    progress.begin();
    vi.advanceTimersByTime(500);
    expect(out.buffer).toBe(
      "\r\x1b[2Kopening\r\x1b[2K\r\x1b[2Kopening",
    );
  });

  it("暴露启动期是否仍接收 lifecycle notice", () => {
    const out = new FakeStdout();
    const progress = createStartupProgressPresenter({
      stdout: out,
      text: "opening",
    });

    expect(progress.acceptsStartupNotices()).toBe(true);
    progress.disable();
    expect(progress.acceptsStartupNotices()).toBe(false);
  });
});
