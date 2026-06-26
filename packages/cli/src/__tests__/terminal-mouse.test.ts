import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _getTerminalMouseRefcount,
  _resetTerminalMouseRefcountForTests,
  terminalMouseController,
} from "../terminal-mouse.js";

function makeStdout(isTTY: boolean): {
  stdout: NodeJS.WriteStream;
  write: ReturnType<typeof vi.fn>;
} {
  const write = vi.fn();
  const stdout = { isTTY, write } as unknown as NodeJS.WriteStream;
  return { stdout, write };
}

afterEach(() => {
  _resetTerminalMouseRefcountForTests();
});

describe("terminalMouseController", () => {
  it("引用计数启用和关闭 SGR mouse tracking", () => {
    const { stdout, write } = makeStdout(true);

    const first = terminalMouseController.acquire(stdout);
    const second = terminalMouseController.acquire(stdout);

    expect(_getTerminalMouseRefcount()).toBe(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenNthCalledWith(1, "\x1b[?1006h\x1b[?1000h");

    first.release();
    expect(_getTerminalMouseRefcount()).toBe(1);
    expect(write).toHaveBeenCalledTimes(1);

    second.release();
    expect(_getTerminalMouseRefcount()).toBe(0);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(2, "\x1b[?1000l\x1b[?1006l");

    second.release();
    expect(_getTerminalMouseRefcount()).toBe(0);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("非 TTY stdout 不写入 mouse tracking 控制序列", () => {
    const { stdout, write } = makeStdout(false);

    const lease = terminalMouseController.acquire(stdout);
    lease.release();

    expect(_getTerminalMouseRefcount()).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it("process exit hook 兜底关闭 mouse tracking，后续 lease release 保持幂等", () => {
    const before = process.listenerCount("exit");
    const { stdout, write } = makeStdout(true);

    const lease = terminalMouseController.acquire(stdout);
    const exitListener = process.listeners("exit").at(-1);

    expect(process.listenerCount("exit")).toBe(before + 1);
    expect(typeof exitListener).toBe("function");

    (exitListener as () => void)();
    expect(_getTerminalMouseRefcount()).toBe(0);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(2, "\x1b[?1000l\x1b[?1006l");

    lease.release();
    expect(_getTerminalMouseRefcount()).toBe(0);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
