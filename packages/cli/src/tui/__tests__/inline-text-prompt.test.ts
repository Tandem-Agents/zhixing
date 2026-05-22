/**
 * InlineTextPromptRegion 单元测试
 *
 * 用非 TTY PassThrough 作 stdin（raw-mode / stdin-ownership 对非 TTY 走 no-op
 * lease，安全），mock ScreenController 仅捕获 attachInput / requestInputRepaint。
 * 同步 emit keypress + setImmediate flush（绕过 paste-detector 的 microtask
 * 批处理）模拟逐键输入。
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";

import { stripAnsi } from "../ansi.js";
import { _resetRawModeRefcountForTests } from "../_internal/raw-mode.js";
import { InlineTextPromptRegion } from "../inline-text-prompt.js";
import type { InputRegion, ScreenController } from "../../screen/index.js";

function makeStdin(): NodeJS.ReadStream {
  const stdin = new PassThrough();
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  return stdin as unknown as NodeJS.ReadStream;
}

function makeScreen(): {
  screen: ScreenController;
  attached: () => InputRegion | null;
} {
  let attachedRegion: InputRegion | null = null;
  const screen = {
    attachInput: (r: InputRegion) => {
      attachedRegion = r;
    },
    requestInputRepaint: () => {},
  } as unknown as ScreenController;
  return { screen, attached: () => attachedRegion };
}

async function sendKey(
  stdin: NodeJS.ReadStream,
  key: { name: string; ctrl?: boolean; sequence?: string },
): Promise<void> {
  (stdin as unknown as EventEmitter).emit("keypress", key.sequence ?? "", {
    name: key.name,
    ctrl: key.ctrl ?? false,
    meta: false,
    shift: false,
    sequence: key.sequence ?? "",
  });
  await new Promise((resolve) => setImmediate(resolve));
}

/** 输入一个可打印字符（str === key.name === sequence）。 */
async function sendChar(stdin: NodeJS.ReadStream, ch: string): Promise<void> {
  await sendKey(stdin, { name: ch, sequence: ch });
}

describe("InlineTextPromptRegion", () => {
  beforeEach(() => {
    _resetRawModeRefcountForTests();
  });

  it("prefill 渲染到输入行,prompt 渲染到标题", () => {
    const region = new InlineTextPromptRegion({
      prompt: "重命名场景",
      prefill: "old-name",
      screen: makeScreen().screen,
      stdin: makeStdin(),
    });
    const joined = stripAnsi(region.renderLines().join("\n"));
    expect(joined).toContain("重命名场景");
    expect(joined).toContain("old-name");
  });

  it("输入字符 + Enter → resolve 提交文本", async () => {
    const stdin = makeStdin();
    const { screen, attached } = makeScreen();
    const region = new InlineTextPromptRegion({ prompt: "新建", screen, stdin });
    const done = region.run();
    expect(attached()).toBe(region); // run() 把自己 attach 到 chrome

    await sendChar(stdin, "h");
    await sendChar(stdin, "i");
    await sendKey(stdin, { name: "return" });

    await expect(done).resolves.toBe("hi");
  });

  it("Esc → resolve null(取消)", async () => {
    const stdin = makeStdin();
    const region = new InlineTextPromptRegion({
      prompt: "新建",
      prefill: "x",
      screen: makeScreen().screen,
      stdin,
    });
    const done = region.run();
    await sendKey(stdin, { name: "escape" });
    await expect(done).resolves.toBeNull();
  });

  it("backspace 删 prefill 末字符后提交", async () => {
    const stdin = makeStdin();
    const region = new InlineTextPromptRegion({
      prompt: "重命名",
      prefill: "ab",
      screen: makeScreen().screen,
      stdin,
    });
    const done = region.run();
    await sendKey(stdin, { name: "backspace" });
    await sendKey(stdin, { name: "return" });
    await expect(done).resolves.toBe("a");
  });

  it("aborted signal → 立即 resolve null,不接管输入", async () => {
    const controller = new AbortController();
    controller.abort();
    const { screen, attached } = makeScreen();
    const region = new InlineTextPromptRegion({
      prompt: "新建",
      screen,
      stdin: makeStdin(),
      signal: controller.signal,
    });
    await expect(region.run()).resolves.toBeNull();
    expect(attached()).toBeNull();
  });
});
