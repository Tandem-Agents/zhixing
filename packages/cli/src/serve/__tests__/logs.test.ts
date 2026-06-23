import { afterEach, describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { runLogsCommand } from "../logs.js";

const ORIGINAL_ZHIXING_HOME = process.env.ZHIXING_HOME;

afterEach(() => {
  if (ORIGINAL_ZHIXING_HOME === undefined) delete process.env.ZHIXING_HOME;
  else process.env.ZHIXING_HOME = ORIGINAL_ZHIXING_HOME;
});

describe("runLogsCommand — default mode", () => {
  it("reads the governed active server log path by default", async () => {
    process.env.ZHIXING_HOME = join("tmp", "zhixing-home");
    const readFile = vi.fn(async () => "line");

    await runLogsCommand({
      deps: {
        readFileFn: readFile,
        console: { log: vi.fn(), error: vi.fn() },
      },
    });

    expect(readFile).toHaveBeenCalledWith(
      join("tmp", "zhixing-home", "logs", "server", "server.log"),
      "utf-8",
    );
  });

  it("prints last N lines of log file", async () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const log = vi.fn();
    await runLogsCommand({
      lines: 10,
      logPath: "/tmp/log",
      deps: {
        readFileFn: vi.fn(async () => content),
        console: { log, error: vi.fn() },
      },
    });
    // 期望最后 10 行 (line 91..100)
    expect(log).toHaveBeenCalledTimes(10);
    expect(log).toHaveBeenNthCalledWith(1, "line 91");
    expect(log).toHaveBeenNthCalledWith(10, "line 100");
  });

  it("handles file shorter than N lines", async () => {
    const content = "only-line-1\nonly-line-2";
    const log = vi.fn();
    await runLogsCommand({
      lines: 10,
      logPath: "/tmp/log",
      deps: {
        readFileFn: vi.fn(async () => content),
        console: { log, error: vi.fn() },
      },
    });
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("handles empty file", async () => {
    const log = vi.fn();
    await runLogsCommand({
      lines: 10,
      logPath: "/tmp/log",
      deps: {
        readFileFn: vi.fn(async () => ""),
        console: { log, error: vi.fn() },
      },
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("strips trailing empty line after final \\n", async () => {
    const log = vi.fn();
    await runLogsCommand({
      lines: 5,
      logPath: "/tmp/log",
      deps: {
        readFileFn: vi.fn(async () => "a\nb\n"),
        console: { log, error: vi.fn() },
      },
    });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(1, "a");
    expect(log).toHaveBeenNthCalledWith(2, "b");
  });

  it("prints error when file read fails", async () => {
    const error = vi.fn();
    await runLogsCommand({
      logPath: "/tmp/log",
      deps: {
        readFileFn: vi.fn(async () => {
          throw new Error("ENOENT");
        }),
        console: { log: vi.fn(), error },
      },
    });
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/Failed to read/));
  });

  it("handles UTF-8 Chinese content correctly", async () => {
    const content = "启动完成\n服务监听中\n收到消息";
    const log = vi.fn();
    await runLogsCommand({
      lines: 10,
      logPath: "/tmp/log",
      deps: {
        readFileFn: vi.fn(async () => content),
        console: { log, error: vi.fn() },
      },
    });
    expect(log).toHaveBeenCalledWith("启动完成");
    expect(log).toHaveBeenCalledWith("服务监听中");
    expect(log).toHaveBeenCalledWith("收到消息");
  });
});

describe("runLogsCommand — tail mode", () => {
  it("reads initial tail, then polls and outputs new content on size growth", async () => {
    let currentSize = 10; // 初始 file = "1234567890"
    let fileContent = "1234567890";
    const log = vi.fn();

    let pollCount = 0;
    const stat = vi.fn(async () => ({ size: currentSize }));
    const readRange = vi.fn(async (_p: string, from: number, to: number) => {
      return fileContent.slice(from, to);
    });
    const readFile = vi.fn(async () => fileContent);
    const sleep = vi.fn(async () => {
      pollCount += 1;
      if (pollCount === 1) {
        // 第一轮 poll 后：append 5 字节
        fileContent += "ABCDE";
        currentSize = fileContent.length;
      }
      // pollCount >= 2 → stopCondition 返回 true
    });

    await runLogsCommand({
      tail: true,
      lines: 5,
      pollMs: 10,
      logPath: "/tmp/log",
      stopCondition: () => pollCount >= 2,
      deps: {
        statFn: stat,
        readFileFn: readFile,
        readRangeFn: readRange,
        sleep,
        console: { log, error: vi.fn() },
      },
    });

    // 读到了新内容
    expect(readRange).toHaveBeenCalledWith("/tmp/log", 10, 15);
    // 输出中包含 "ABCDE"
    const allOutput = log.mock.calls.map((c) => c[0]).join("\n");
    expect(allOutput).toContain("ABCDE");
  });

  it("handles file truncation (size shrinks) by resetting offset", async () => {
    let currentSize = 100;
    const log = vi.fn();
    let pollCount = 0;

    await runLogsCommand({
      tail: true,
      lines: 5,
      pollMs: 10,
      logPath: "/tmp/log",
      stopCondition: () => pollCount >= 2,
      deps: {
        statFn: vi.fn(async () => ({ size: currentSize })),
        readFileFn: vi.fn(async () => "x"),
        readRangeFn: vi.fn(async () => "new-content"),
        sleep: vi.fn(async () => {
          pollCount += 1;
          if (pollCount === 1) currentSize = 50; // 变小（truncation）
          if (pollCount === 2) currentSize = 70; // 重新增长
        }),
        console: { log, error: vi.fn() },
      },
    });

    // 不应该报错，应该正常处理 truncation
    expect(log.mock.calls.some((c) => String(c[0]).includes("new-content"))).toBe(true);
  });
});
