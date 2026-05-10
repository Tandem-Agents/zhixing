import { describe, expect, it } from "vitest";
import {
  detectTerminalCapability,
  type DetectionContext,
} from "../terminal-capability.js";

/** 构造一个最小 mock stdout——仅暴露探测函数读到的字段 */
function mockStdout(opts: {
  isTTY?: boolean;
  rows?: number;
  columns?: number;
}): NodeJS.WriteStream {
  return {
    isTTY: opts.isTTY ?? true,
    rows: opts.rows,
    columns: opts.columns,
  } as unknown as NodeJS.WriteStream;
}

/** 默认 ok 路径的 context——TTY、TERM=xterm、Linux 平台 */
function okContext(overrides: Partial<DetectionContext> = {}): DetectionContext {
  return {
    stdout: mockStdout({ isTTY: true, rows: 30, columns: 120 }),
    env: { TERM: "xterm-256color" },
    platform: "linux",
    osRelease: "5.15.0",
    ...overrides,
  };
}

describe("detectTerminalCapability — TTY 检查", () => {
  it("stdout.isTTY = true + 正常 env → ok", () => {
    const r = detectTerminalCapability(okContext());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.capability.viewport).toEqual({ rows: 30, cols: 120 });
      expect(r.capability.platform).toBe("linux");
      expect(r.capability.tmux).toBe(false);
    }
  });

  it("stdout.isTTY = false → !ok", () => {
    const r = detectTerminalCapability({
      ...okContext(),
      stdout: mockStdout({ isTTY: false }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("TTY");
    }
  });
});

describe("detectTerminalCapability — TERM 检查", () => {
  it("TERM=dumb → !ok", () => {
    const r = detectTerminalCapability(
      okContext({ env: { TERM: "dumb" } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("dumb");
    }
  });

  it("TERM 未设 → ok（允许，多数 ssh / 容器环境不设 TERM 但终端正常）", () => {
    const r = detectTerminalCapability(okContext({ env: {} }));
    expect(r.ok).toBe(true);
  });

  it("TERM=xterm-256color → ok", () => {
    const r = detectTerminalCapability(
      okContext({ env: { TERM: "xterm-256color" } }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("detectTerminalCapability — Windows 版本检查", () => {
  it("Win10 build 17134 (1803) → ok（基线）", () => {
    const r = detectTerminalCapability(
      okContext({ platform: "win32", osRelease: "10.0.17134" }),
    );
    expect(r.ok).toBe(true);
  });

  it("Win11 build 22631 → ok", () => {
    const r = detectTerminalCapability(
      okContext({ platform: "win32", osRelease: "10.0.22631.4112" }),
    );
    expect(r.ok).toBe(true);
  });

  it("Win10 build 16299 (1709) → !ok（早于基线）", () => {
    const r = detectTerminalCapability(
      okContext({ platform: "win32", osRelease: "10.0.16299" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("16299");
      expect(r.reason).toContain("17134");
    }
  });

  it("Win10 build 早于基线 → !ok（10240 = TH1）", () => {
    const r = detectTerminalCapability(
      okContext({ platform: "win32", osRelease: "10.0.10240" }),
    );
    expect(r.ok).toBe(false);
  });

  it("不可识别的 Windows 版本字串 → !ok", () => {
    const r = detectTerminalCapability(
      okContext({ platform: "win32", osRelease: "definitely-not-a-version" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("不可识别");
    }
  });

  it("Windows 7 风格版本号 (6.1) → !ok", () => {
    const r = detectTerminalCapability(
      okContext({ platform: "win32", osRelease: "6.1.7601" }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("detectTerminalCapability — 非 Windows 平台", () => {
  it("macOS → ok（不做版本检查）", () => {
    const r = detectTerminalCapability(
      okContext({ platform: "darwin", osRelease: "23.6.0" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.capability.platform).toBe("darwin");
    }
  });

  it("Linux → ok", () => {
    const r = detectTerminalCapability(
      okContext({ platform: "linux", osRelease: "5.15.0-86-generic" }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("detectTerminalCapability — viewport fallback", () => {
  it("stdout.rows / .columns 缺失时降级到 24×80", () => {
    const r = detectTerminalCapability({
      ...okContext(),
      stdout: mockStdout({ isTTY: true }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.capability.viewport).toEqual({ rows: 24, cols: 80 });
    }
  });

  it("stdout.rows = 0 视为不可读，走 fallback", () => {
    const r = detectTerminalCapability({
      ...okContext(),
      stdout: mockStdout({ isTTY: true, rows: 0, columns: 0 }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.capability.viewport).toEqual({ rows: 24, cols: 80 });
    }
  });

  it("rows / cols 为正常值则原样返回", () => {
    const r = detectTerminalCapability({
      ...okContext(),
      stdout: mockStdout({ isTTY: true, rows: 50, columns: 200 }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.capability.viewport).toEqual({ rows: 50, cols: 200 });
    }
  });
});

describe("detectTerminalCapability — tmux 检测", () => {
  it("env.TMUX 存在 → tmux = true", () => {
    const r = detectTerminalCapability(
      okContext({
        env: { TERM: "xterm-256color", TMUX: "/tmp/tmux-1000/default,1234,0" },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.capability.tmux).toBe(true);
    }
  });

  it("env.TMUX 不存在 → tmux = false", () => {
    const r = detectTerminalCapability(
      okContext({ env: { TERM: "xterm-256color" } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.capability.tmux).toBe(false);
    }
  });

  it("env.TMUX 为空字串 → tmux = true（视存在为已嵌套）", () => {
    const r = detectTerminalCapability(
      okContext({ env: { TERM: "xterm-256color", TMUX: "" } }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.capability.tmux).toBe(true);
    }
  });
});

describe("detectTerminalCapability — 不写 stdout（纯探测）", () => {
  it("成功路径不调用 stdout.write", () => {
    let writeCalled = false;
    const stdout = {
      isTTY: true,
      rows: 30,
      columns: 120,
      write: () => {
        writeCalled = true;
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    detectTerminalCapability({
      stdout,
      env: { TERM: "xterm" },
      platform: "linux",
      osRelease: "5.15.0",
    });

    expect(writeCalled).toBe(false);
  });

  it("失败路径也不调用 stdout.write", () => {
    let writeCalled = false;
    const stdout = {
      isTTY: false,
      write: () => {
        writeCalled = true;
        return true;
      },
    } as unknown as NodeJS.WriteStream;

    detectTerminalCapability({
      stdout,
      env: { TERM: "xterm" },
      platform: "linux",
      osRelease: "5.15.0",
    });

    expect(writeCalled).toBe(false);
  });
});
