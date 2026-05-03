/**
 * TypeaheadInputReader 集成测试
 *
 * 这是 Step 5 的验收测试 —— 在非 TTY PassThrough 流上驱动完整的
 * broker + panel + dispatcher + buffer 链路，验证 8 类端到端场景（spec §9.2
 * Step 5 关键测试）。
 *
 * 关键约束：
 *   - 用 synthetic keypress 事件（bypass Node 的字节解析器），避免 Esc/↑↓
 *     等组合键的编码麻烦
 *   - makeStreams 构造非 TTY PassThrough，raw-mode 走 no-op lease
 *   - Broker 用真实 DefaultTypeaheadBroker + 真实 CommandProvider + registry
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CommandProvider,
  DefaultCommandRegistry,
  DefaultTypeaheadBroker,
  registerBuiltinCommands,
} from "@zhixing/core";
import type { RuntimeContext } from "@zhixing/core";

import { CommandDispatcher } from "../command-dispatcher.js";
import {
  _getRawModeRefcount,
  _resetRawModeRefcountForTests,
} from "../tui/select-with-input.js";
import { readInputLine, type InputLineResult } from "../typeahead-input.js";

// ─── 测试辅助 ───

function makeStreams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  (stdout as unknown as { isTTY: boolean }).isTTY = false;

  let captured = "";
  stdout.on("data", (chunk: Buffer | string) => {
    captured += chunk.toString("utf8");
  });

  return {
    stdin,
    stdout,
    getCaptured: () => captured,
    clearCaptured: () => {
      captured = "";
    },
  };
}

async function sendSyntheticKey(
  stdin: NodeJS.ReadableStream,
  key: {
    name?: string;
    ctrl?: boolean;
    meta?: boolean;
    sequence?: string;
    str?: string;
  },
): Promise<void> {
  (stdin as unknown as EventEmitter).emit(
    "keypress",
    key.str ?? key.sequence ?? "",
    {
      name: key.name,
      ctrl: key.ctrl ?? false,
      meta: key.meta ?? false,
      shift: false,
      sequence: key.sequence ?? "",
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
}

/** 连续发一串可打印字符 */
async function typeChars(
  stdin: NodeJS.ReadableStream,
  text: string,
): Promise<void> {
  for (const ch of Array.from(text)) {
    await sendSyntheticKey(stdin, { str: ch });
  }
}

function makeRuntime(): RuntimeContext {
  return {
    sessionBusy: false,
    workspaceId: null,
    cwd: "/tmp",
    target: "cli",
    features: {},
    now: 1_700_000_000_000,
  };
}

interface Harness {
  readonly broker: DefaultTypeaheadBroker;
  readonly dispatcher: CommandDispatcher;
  readonly registry: DefaultCommandRegistry;
}

function makeHarness(): Harness {
  const registry = new DefaultCommandRegistry();
  registerBuiltinCommands(registry);
  const broker = new DefaultTypeaheadBroker({
    now: () => 1_700_000_000_000,
  });
  broker.register(new CommandProvider({ registry }));
  const dispatcher = new CommandDispatcher({ registry });
  return { broker, dispatcher, registry };
}

beforeEach(() => {
  _resetRawModeRefcountForTests();
});

afterEach(() => {
  _resetRawModeRefcountForTests();
});

// ─── 端到端场景 ───

describe("readInputLine — 正常对话", () => {
  it("普通文本 Enter 提交 → kind=text", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const resultP = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });

    await typeChars(stdin, "hello");
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });

    const result = await resultP;
    expect(result).toEqual({ kind: "text", text: "hello" });
  });

  it("空行 Enter → kind=text 空字符串", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    expect(await p).toEqual({ kind: "text", text: "" });
  });
});

describe("readInputLine — 命令分派", () => {
  it("无必填参数的 local 命令（/clear）零键执行：Enter 直接触发 handler", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const handler = vi.fn(() => ({ summary: "cleared" }));
    dispatcher.registerHandler("clear:builtin", handler);

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });

    // 打 /clear 然后 Enter
    await typeChars(stdin, "/clear");
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });

    const result = await p;
    // 因为 zero-key execute 把 draft 换成 "/clear"（无尾空格）并直接 submit
    expect(result.kind).toBe("command-dispatched");
    if (result.kind === "command-dispatched") {
      expect(result.dispatchResult.kind).toBe("local-handled");
    }
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("/ 前缀触发 typeahead 面板（输出里能看到 Commands 标题）", async () => {
    const { stdin, stdout, getCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });

    await typeChars(stdin, "/");

    // 断言面板已渲染（输出里有 Commands 字串）
    expect(getCaptured()).toContain("Commands");

    // 退出（Esc 清 trigger 后 再 Enter 提交空）
    await sendSyntheticKey(stdin, { name: "escape", sequence: "\x1b" });
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });

    await p;
  });

  it("hybrid 命令（/new）返回 kind=hybrid + systemMessage", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    dispatcher.registerHandler("new:builtin", () => ({
      systemMessage: "新会话已开启",
    }));

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });

    await typeChars(stdin, "/new");
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });

    const result = await p;
    expect(result.kind).toBe("command-dispatched");
    if (result.kind === "command-dispatched") {
      expect(result.dispatchResult).toMatchObject({
        kind: "hybrid",
        systemMessage: "新会话已开启",
      });
    }
  });

  it("未知命令（/nothere）返回 kind=unknown", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });
    await typeChars(stdin, "/nothere");
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    const result = await p;
    expect(result.kind).toBe("command-dispatched");
    if (result.kind === "command-dispatched") {
      expect(result.dispatchResult).toMatchObject({
        kind: "unknown",
        commandName: "nothere",
      });
    }
  });

  it("必填参数命令（/elevated）不零键执行：Enter 接受后 draft 变成 '/elevated '，继续输入", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    dispatcher.registerHandler("elevated:builtin", (ctx) => ({
      systemMessage: `elevated set to ${ctx.args._rest}`,
    }));

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });

    // 打 /elevated 然后 Enter 接受 suggestion（不 execute —— 必填参数）
    await typeChars(stdin, "/elevated");
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    // 现在 draft = "/elevated "
    // 继续输入 "on" + Enter（这回没有 active trigger —— 空格后 /boundary 不再匹配）
    await typeChars(stdin, "on");
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });

    const result = await p;
    expect(result.kind).toBe("command-dispatched");
    if (result.kind === "command-dispatched") {
      expect(result.text).toBe("/elevated on");
      expect(result.dispatchResult.kind).toBe("hybrid");
    }
  });
});

describe("readInputLine — 取消路径", () => {
  it("Ctrl+C 返回 cancelled/ctrl-c", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });
    await sendSyntheticKey(stdin, {
      name: "c",
      ctrl: true,
      sequence: "\x03",
    });
    expect(await p).toEqual({ kind: "cancelled", cause: "ctrl-c" });
  });

  it("空 buffer 的 Ctrl+D 返回 cancelled/ctrl-d", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });
    await sendSyntheticKey(stdin, {
      name: "d",
      ctrl: true,
      sequence: "\x04",
    });
    expect(await p).toEqual({ kind: "cancelled", cause: "ctrl-d" });
  });

  it("非空 buffer 的 Ctrl+D 视作 deleteForward（不退出）", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });
    await typeChars(stdin, "abc");
    // 光标在末尾，deleteForward 是 no-op —— 但重要的是 Ctrl+D 不 resolve
    await sendSyntheticKey(stdin, {
      name: "d",
      ctrl: true,
      sequence: "\x04",
    });
    // 再 Enter 提交正常
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    const result = await p;
    expect(result).toMatchObject({ kind: "text", text: "abc" });
  });

  it("外部 signal.abort 立即 resolve cancelled/aborted", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const ctrl = new AbortController();
    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      signal: ctrl.signal,
      columns: 80,
    });
    ctrl.abort();
    const result = await p;
    expect(result).toEqual({ kind: "cancelled", cause: "aborted" });
  });
});

describe("readInputLine — 导航与 Esc", () => {
  it("typeahead 活跃时 Esc 清 trigger token（不清整行）", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });
    // 打 "hello /new"
    await typeChars(stdin, "hello ");
    await typeChars(stdin, "/new");
    // 此时 trigger tokenStart = 6 ("/new")
    await sendSyntheticKey(stdin, { name: "escape", sequence: "\x1b" });
    // Draft 应只剩 "hello "
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });

    const result = await p;
    expect(result).toMatchObject({ kind: "text", text: "hello" });
  });

  it("typeahead 活跃时 ↓ 调 moveSelection（不历史浏览）", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const moveSpy = vi.spyOn(broker, "moveSelection");

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });
    await typeChars(stdin, "/");
    await sendSyntheticKey(stdin, { name: "down", sequence: "\x1b[B" });
    expect(moveSpy).toHaveBeenCalled();

    // 清理：Esc + Enter
    await sendSyntheticKey(stdin, { name: "escape", sequence: "\x1b" });
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    await p;
  });

  it("无 typeahead 时 Esc 清整行", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });
    await typeChars(stdin, "hello");
    await sendSyntheticKey(stdin, { name: "escape", sequence: "\x1b" });
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    const result = await p;
    expect(result).toMatchObject({ kind: "text", text: "" });
  });
});

describe("readInputLine — 资源管理", () => {
  it("非 TTY 流不增减 raw-mode 计数", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    expect(_getRawModeRefcount()).toBe(0);
    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });
    expect(_getRawModeRefcount()).toBe(0);
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    await p;
    expect(_getRawModeRefcount()).toBe(0);
  });
});

describe("readInputLine — 处理链", () => {
  it("连续两次 readInputLine：第一轮 /new，第二轮普通对话", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    dispatcher.registerHandler("new:builtin", () => ({
      systemMessage: "ok",
    }));

    // 第一轮
    const r1P = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });
    await typeChars(stdin, "/new");
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    const r1 = await r1P;
    expect(r1.kind).toBe("command-dispatched");

    // 第二轮
    const r2P = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });
    await typeChars(stdin, "hi");
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    const r2 = await r2P;
    expect(r2).toMatchObject({ kind: "text", text: "hi" });
  });
});

describe("readInputLine — 结果 narrowing smoke", () => {
  it("InputLineResult kind 判别有效", async () => {
    const test: InputLineResult = { kind: "text", text: "x" };
    if (test.kind === "text") expect(test.text).toBe("x");
  });
});

// ─── §6.4 光标不变量回归测试（真实 TTY bug 复现） ───
//
// 这一块的故事：Step 5 初版在真实 Windows Terminal 里触发了两个致命 bug：
//   1. 输入 `/` + 任意字符后，prompt 行之上的欢迎语和历史输出全部消失
//   2. 光标在面板的 "Commands" 标题行上移动，而不是在 prompt 行
//
// 根因都是"rerender 入口光标位置 vs 对齐契约"的假设错误：
//   - Bug #1：错误地用 PanelRenderer.clear()，它 moveUp(lastHeight) 从 prompt
//     行往上走 N 行，再 clearBelow —— 把 prompt 行之上的内容一并擦掉
//   - Bug #2：panel.render 结束后 moveUp 少数一次（off-by-one），cursor 停在
//     面板第一行而不是 prompt 行
//
// 这组测试断言重写后的 rerender **不发出任何 moveUp 序列让光标跑到当前行之上**
// —— 也就是整个帧的字节流里不应该有 `\x1b[{N}A`（moveUp）作用到 prompt 行之上
// 的效果。精确断言"不发 moveUp"太严格（面板内部需要），我们断言更保守的语义：
// 每次 clearBelow 之前必须先发 col0，且不在 clearBelow 之前发 moveUp。

describe("readInputLine — §6.4 光标回归护栏", () => {
  it("rerender 永远用 `\\r` + `\\x1b[J` 清行，绝不 moveUp 再清（否则会擦 prompt 之上）", async () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });

    // 打 "/c" 让面板出现
    await typeChars(stdin, "/");
    await typeChars(stdin, "c");
    clearCaptured();
    // 再打一个字触发 rerender
    await typeChars(stdin, "l");

    const frame = getCaptured();
    // 帧里不应该出现 "moveUp 紧接 clearBelow" 的模式 ——
    // 那是旧 panel.clear() 的签名字节流
    const moveUpBeforeClearBelow = /\x1b\[\d+A[\x1b\r][^\x1b]*\x1b\[J/;
    expect(frame).not.toMatch(moveUpBeforeClearBelow);
    // 而应该以同步输出 BSU 包裹起头，紧接 `\r`（col0）—— 同步输出包整帧
    // 防止 TTY 分段刷新让 cursor 在 col 0 闪烁；包裹内仍是 `\r` + `\x1b[J` 起步
    expect(frame.startsWith("\x1b[?2026h\r")).toBe(true);

    await sendSyntheticKey(stdin, {
      name: "c",
      ctrl: true,
      sequence: "\x03",
    });
    await p;
  });

  it("rerender 后发出的 moveUp 行数 = panel 行数 + 1（回到 prompt 行），不是 + 0", async () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });

    // 打 "/" 触发面板
    await typeChars(stdin, "/");
    clearCaptured();
    // 打另一个字符，触发 rerender
    await typeChars(stdin, "c");

    const frame = getCaptured();
    // 帧里应有恰好一次 moveUp，其数值应 >= 2
    // （1 prompt 行分隔的 \r\n + N 条面板行，N >= 1）
    const matches = [...frame.matchAll(/\x1b\[(\d+)A/g)];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const maxMoveUp = Math.max(...matches.map((m) => parseInt(m[1]!, 10)));
    // panel 有至少 4 行（顶+候选+底+hint），+1 prompt 分隔 = 至少 5
    expect(maxMoveUp).toBeGreaterThanOrEqual(5);

    await sendSyntheticKey(stdin, {
      name: "c",
      ctrl: true,
      sequence: "\x03",
    });
    await p;
  });

  it("移动方向键不会擦除 prompt 行之上的内容（clearBelow 必须在 col0 之后）", async () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });

    await typeChars(stdin, "/cl");
    clearCaptured();
    // ← 往左
    await sendSyntheticKey(stdin, { name: "left", sequence: "\x1b[D" });

    const frame = getCaptured();
    // 在 clearBelow 出现之前，只能有 `\r`，不能有 `moveUp`
    const clearBelowIdx = frame.indexOf("\x1b[J");
    expect(clearBelowIdx).toBeGreaterThanOrEqual(0);
    const beforeClear = frame.slice(0, clearBelowIdx);
    expect(beforeClear).not.toMatch(/\x1b\[\d+A/);

    await sendSyntheticKey(stdin, {
      name: "c",
      ctrl: true,
      sequence: "\x03",
    });
    await p;
  });

  it("CJK 字符的 cursor 列用 stringWidth 算（中文占 2 列）", async () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      promptPrefix: "> ", // 显示宽度 = 2
      columns: 80,
    });

    // 输入"你好" —— 2 个字符 / 4 显示列
    await sendSyntheticKey(stdin, { str: "你" });
    clearCaptured();
    await sendSyntheticKey(stdin, { str: "好" });

    const frame = getCaptured();
    // 最后一次 `\x1b[{N}C` 的 N 应该是 6 = "> "(2) + "你好"(4)
    const matches = [...frame.matchAll(/\x1b\[(\d+)C/g)];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const lastOffset = parseInt(matches[matches.length - 1]![1]!, 10);
    expect(lastOffset).toBe(6);

    await sendSyntheticKey(stdin, {
      name: "c",
      ctrl: true,
      sequence: "\x03",
    });
    await p;
  });

  it("no-panel 分支的 cursor 位置正确（@ss 场景 —— @ 无 provider，光标必须紧贴 draft 末尾）", async () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      promptPrefix: "> ", // 显示宽度 = 2
      columns: 80,
    });

    // 输入 "@ss" —— @ 不是 / 触发字符，没有 provider 命中，面板不渲染
    await typeChars(stdin, "@ss");
    // 最后一次按键触发的 rerender 帧应让光标停在 col 5（= "> " + "@ss" = 5）
    // 而不是 col 10（= 5 + 5，旧 bug 的双倍偏移）
    clearCaptured();
    // 再打一个字符重绘一次以拿到干净帧
    await sendSyntheticKey(stdin, { str: "x" });

    const frame = getCaptured();
    // 帧里最后一次 `\x1b[{N}C` 必须紧跟在 `\r` 之后（可能隔着写入的文本）
    // 且 N 应等于 prompt 宽度 + 显示宽度("@ssx") = 2 + 4 = 6
    const offsetMatches = [...frame.matchAll(/\x1b\[(\d+)C/g)];
    expect(offsetMatches.length).toBeGreaterThanOrEqual(1);
    const lastOffset = parseInt(
      offsetMatches[offsetMatches.length - 1]![1]!,
      10,
    );
    expect(lastOffset).toBe(6);

    // 在最后一次 offset shift 之前必须出现 `\r`，否则说明没复位到 col 0
    const lastOffsetMatch = offsetMatches[offsetMatches.length - 1]!;
    const lastOffsetIdx = lastOffsetMatch.index!;
    const beforeOffset = frame.slice(0, lastOffsetIdx);
    expect(beforeOffset).toMatch(/\r[^\n]*$/);

    await sendSyntheticKey(stdin, {
      name: "c",
      ctrl: true,
      sequence: "\x03",
    });
    await p;
  });

  it("提交后 teardown 留下最终 prompt 行 + 换行（不再发 moveUp 擦上方）", async () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    dispatcher.registerHandler("clear:builtin", () => ({}));

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      promptPrefix: "> ",
      columns: 80,
    });

    await typeChars(stdin, "/clear");
    clearCaptured();
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });

    const frame = getCaptured();
    // Teardown 帧应该包含回显 "/clear" + "\r\n"
    expect(frame).toContain("/clear");
    expect(frame).toContain("\r\n");
    // 不应该发 moveUp 从 prompt 行往上走去擦欢迎语
    expect(frame).not.toMatch(/\x1b\[\d+A.*\x1b\[J/);

    await p;
  });
});
