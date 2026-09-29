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
import { stringWidth } from "../line-width.js";
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
  it("reflows draft and cursor on resize without losing text or adding the hint to submission", async () => {
    const stdin = makeStdin();
    const text = "中英文 abc ".repeat(5);
    const options = { prompt: "重命名", placeholder: "请输入名称", prefill: text, columns: 80, screen: makeScreen().screen, stdin };
    const region = new InlineTextPromptRegion(options);
    const done = region.run();
    const oldRow = region.cursorPosition().row;
    options.columns = 24;
    const lines = region.renderLines(), cursor = region.cursorPosition();
    expect(cursor.row).toBeGreaterThan(oldRow);
    expect(lines[cursor.row]).toContain("\x1b[7m \x1b[27m");
    expect(lines.every(line => stringWidth(line) <= 23)).toBe(true);
    await sendKey(stdin, { name: "return" });
    await expect(done).resolves.toBe(text);
  });
  it.each([24, 30, 40, 80, 120])("全部行与光标遵守 %i 列视口", columns => {
    const region = new InlineTextPromptRegion({
      prompt: "长标题".repeat(40), prefill: "中文 abc 🙂 ".repeat(30),
      columns, screen: makeScreen().screen, stdin: makeStdin(),
    });
    expect(region.renderLines().every(line => stringWidth(line) <= columns - 1)).toBe(true);
    expect(region.cursorPosition().col).toBeLessThan(columns - 1);
  });
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

  it("占位说明独立于编辑行，框外同时保留操作提示", () => {
    const region = new InlineTextPromptRegion({
      prompt: "新建工作场景",
      placeholder: "场景名称",
      screen: makeScreen().screen,
      stdin: makeStdin(),
      columns: 50,
    });
    const lines = region.renderLines();
    expect(lines.length).toBe(5);
    expect(stripAnsi(lines[region.cursorPosition().row]!)).not.toContain("场景名称");
    const joined = stripAnsi(lines.join("\n"));
    expect(joined).toContain("新建工作场景");
    expect(joined).toContain("场景名称");
    expect(joined).toContain("Enter 提交");
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
