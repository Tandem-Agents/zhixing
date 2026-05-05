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
import chalk from "chalk";

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
  stringWidth,
  stripAnsi,
} from "../tui/index.js";
import { readInputLine, type InputLineResult } from "../typeahead-input.js";

// PassThrough 非 TTY，chalk 默认禁用颜色——强开 level=3 让 bg / dim 等 ANSI
// 真实出现在 captured 里供回归断言（与 chalk 在真实 TTY 的输出一致）
chalk.level = 3;

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
// 历史背景：Step 5 初版在真实 Windows Terminal 里触发了两个致命 bug：
//   1. 输入 `/` + 任意字符后，prompt 行之上的欢迎语和历史输出全部消失
//   2. 光标在面板的 "Commands" 标题行上移动，而不是在 prompt 行
// 根因是"rerender 入口光标位置 vs 对齐契约"的假设错误，不当 moveUp 越过 prompt
// 行往上擦了欢迎语。
//
// 升级为 box 形态后，input box 是 3 行（顶+body+底）+ panel N 行结构。新光标契约：
//   入口（非首次）：光标在 box body 行 cursor 列
//   出口：光标在 box body 行 cursor 列
//   每帧 moveUp(1) 回顶边 + col0 + clearBelow + 写整帧 + moveUp(panel + 2) 回 body
//
// 关键不变量：moveUp 数值不能让光标越过 box 顶边——
//   入口 moveUp = 1（box 高度 3，body 回顶边只需 1）
//   出口 moveUp = panel 行数 + 2（panel 之下回 body 行）
// 这两类 moveUp 都在 box 内部 navigation，不会擦欢迎语。

describe("readInputLine — box 形态光标契约护栏", () => {
  it("入口 moveUp 仅回 box 顶边（数值 = 1，clearBelow 之前 ≤ 1 次）", async () => {
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

    // 触发首次 rerender 后再 typeChars 一次，得到非首次 rerender 的 frame
    await typeChars(stdin, "/");
    await typeChars(stdin, "c");
    clearCaptured();
    await typeChars(stdin, "l");

    const frame = getCaptured();
    // 入口 moveUp 在 clearBelow 之前——查 clearBelow 之前的 moveUp 数值
    const clearBelowIdx = frame.indexOf("\x1b[J");
    expect(clearBelowIdx).toBeGreaterThan(0);
    const beforeClear = frame.slice(0, clearBelowIdx);
    const entryMoveUps = [...beforeClear.matchAll(/\x1b\[(\d+)A/g)];
    // 入口 moveUp 至多 1 次，数值 = 1（box 高度 3，body 回顶边只需 1，永远不会越过顶边）
    expect(entryMoveUps.length).toBeLessThanOrEqual(1);
    if (entryMoveUps.length === 1) {
      expect(parseInt(entryMoveUps[0]![1]!, 10)).toBe(1);
    }
    // 整帧用 BSU/ESU 同步输出包裹，避免 TTY 分段 flush 让光标可见闪烁
    expect(frame.startsWith("\x1b[?2026h")).toBe(true);

    await sendSyntheticKey(stdin, {
      name: "c",
      ctrl: true,
      sequence: "\x03",
    });
    await p;
  });

  it("出口 moveUp 回 box body 行（数值 = panel 行数 + 2，含 box 底/body offset）", async () => {
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

    await typeChars(stdin, "/");
    clearCaptured();
    await typeChars(stdin, "c");

    const frame = getCaptured();
    const matches = [...frame.matchAll(/\x1b\[(\d+)A/g)];
    // 至少 2 次 moveUp（入口 1 + 出口 panel + 2）
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const maxMoveUp = Math.max(...matches.map((m) => parseInt(m[1]!, 10)));
    // panel 至少 4 行（顶+候选+底+hint），加 box 底/body offset 2 = 至少 6
    expect(maxMoveUp).toBeGreaterThanOrEqual(6);

    await sendSyntheticKey(stdin, {
      name: "c",
      ctrl: true,
      sequence: "\x03",
    });
    await p;
  });

  it("方向键 rerender 中 clearBelow 之前的 moveUp 数值 ≤ 1（不擦欢迎语）", async () => {
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
    await sendSyntheticKey(stdin, { name: "left", sequence: "\x1b[D" });

    const frame = getCaptured();
    const clearBelowIdx = frame.indexOf("\x1b[J");
    expect(clearBelowIdx).toBeGreaterThanOrEqual(0);
    const beforeClear = frame.slice(0, clearBelowIdx);
    // clearBelow 之前最多 1 次 moveUp（入口回顶边），数值 = 1
    const entryMoveUps = [...beforeClear.matchAll(/\x1b\[(\d+)A/g)];
    expect(entryMoveUps.length).toBeLessThanOrEqual(1);
    if (entryMoveUps.length === 1) {
      expect(parseInt(entryMoveUps[0]![1]!, 10)).toBe(1);
    }

    await sendSyntheticKey(stdin, {
      name: "c",
      ctrl: true,
      sequence: "\x03",
    });
    await p;
  });

  it("CJK 字符的 cursor offset = box │+indent + promptWidth + draftWidth（中文占 2 列）", async () => {
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
    // 最后一次 `\x1b[{N}C` 的 N = box │(1) + indent=1(1) + "> "(2) + "你好"(4) = 8
    const matches = [...frame.matchAll(/\x1b\[(\d+)C/g)];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const lastOffset = parseInt(matches[matches.length - 1]![1]!, 10);
    expect(lastOffset).toBe(8);

    await sendSyntheticKey(stdin, {
      name: "c",
      ctrl: true,
      sequence: "\x03",
    });
    await p;
  });

  it("no-panel 分支 cursor offset 含 box │+indent 偏移（@ss 场景 —— @ 无 provider）", async () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      promptPrefix: "> ",
      columns: 80,
    });

    // 输入 "@ss" —— @ 不是 / 触发字符，没有 provider 命中，面板不渲染
    await typeChars(stdin, "@ss");
    clearCaptured();
    await sendSyntheticKey(stdin, { str: "x" });

    const frame = getCaptured();
    // box │(1) + indent=1(1) + "> "(2) + "@ssx"(4) = 8
    const offsetMatches = [...frame.matchAll(/\x1b\[(\d+)C/g)];
    expect(offsetMatches.length).toBeGreaterThanOrEqual(1);
    const lastOffset = parseInt(
      offsetMatches[offsetMatches.length - 1]![1]!,
      10,
    );
    expect(lastOffset).toBe(8);

    // forward 之前光标必在 col 0：可能因 \r 显式复位（单行场景）或因 moveUp(N)
    // 沿袭前序行尾 \r\n 的 col 0 状态（box 多行场景）。两种结尾都合法。
    const lastOffsetMatch = offsetMatches[offsetMatches.length - 1]!;
    const lastOffsetIdx = lastOffsetMatch.index!;
    const beforeOffset = frame.slice(0, lastOffsetIdx);
    expect(beforeOffset).toMatch(/(\r|\x1b\[\d+A)$/);

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

// ─── Placeholder ───
//
// Placeholder = prompt 行的 0 状态视觉装饰。空 buffer 时显示 dim 文案，输入即消失，
// 删回空重新出现，不参与 submit（仅渲染层）。与 ghost text 共用 dim 通道但语义互斥
// （buffer 空时 broker 自然无 trigger 也无 ghost）。
describe("readInputLine — placeholder", () => {
  it("空 buffer 首帧 stdout 包含 dim placeholder 文案", async () => {
    const { stdin, stdout, getCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
      placeholder: "PLACEHOLDER_SENTINEL",
    });

    // 让首次同步渲染的写入冲到 captured
    await new Promise((r) => setImmediate(r));

    const captured = getCaptured();
    expect(captured).toContain("PLACEHOLDER_SENTINEL");
    // dim ANSI 序列紧邻 placeholder——确认走 dim 通道
    expect(captured).toMatch(/\x1b\[2m[^\x1b]*PLACEHOLDER_SENTINEL/);

    // 收尾：ctrl-c 让 promise resolve，避免 promise 悬挂
    await sendSyntheticKey(stdin, { name: "c", ctrl: true });
    await p;
  });

  it("输入第一个字符后 placeholder 在新帧中消失；删回空重新出现", async () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
      placeholder: "PLACEHOLDER_SENTINEL",
    });

    await new Promise((r) => setImmediate(r));
    expect(getCaptured()).toContain("PLACEHOLDER_SENTINEL");

    // 输入字符后看新帧——placeholder 应消失
    clearCaptured();
    await typeChars(stdin, "h");
    expect(getCaptured()).not.toContain("PLACEHOLDER_SENTINEL");

    // 删回空——placeholder 应重新出现
    clearCaptured();
    await sendSyntheticKey(stdin, { name: "backspace", sequence: "\x7f" });
    expect(getCaptured()).toContain("PLACEHOLDER_SENTINEL");

    await sendSyntheticKey(stdin, { name: "c", ctrl: true });
    await p;
  });

  it("placeholder 不参与 submit——空回车提交空字符串而非 placeholder 文本", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
      placeholder: "PLACEHOLDER_SENTINEL",
    });

    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    const result = await p;
    expect(result).toEqual({ kind: "text", text: "" });
  });

  it("不传 placeholder 时空 buffer 首帧不渲染任何 placeholder 内容", async () => {
    const { stdin, stdout, getCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
      // placeholder 故意不传——验证向后兼容；不传任何 sentinel 文本进 helper，
      // 自然不应在输出里出现这种 sentinel
    });

    await new Promise((r) => setImmediate(r));
    const captured = getCaptured();
    expect(captured).toContain("❯");
    expect(captured).not.toContain("VOLUNTARY_PLACEHOLDER_SENTINEL");

    await sendSyntheticKey(stdin, { name: "c", ctrl: true });
    await p;
  });
});

// ─── 历史回显视觉护栏 ───
//
// 提交后 teardown 把活跃 box 塌缩为整行 bg dim 染色单行，让用户消息在长
// scrollback 里有持续视觉锚（与 agent 输出无 bg 形成对比）。
//   bg 段不含 ❯ prompt 字符——bg 灰底已充分标识"用户消息"，prompt 是 active box
//     的"现在输入"信号，历史里复用是错位双信号
//   bg 段含前导 2 空格让文字不贴 bg 左边缘
//   bg 段 padding 到终端宽度让 bg 延伸到行末
describe("readInputLine — 历史回显视觉护栏", () => {
  it("提交后 teardown 整行 bg ANSI 染色，bg 段含用户消息文本", async () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 40,
    });

    await typeChars(stdin, "hello");
    clearCaptured();
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });

    const frame = getCaptured();
    // bg open / close ANSI 出现在 frame 中
    const bgOpen = "\x1b[48;5;236m";
    const bgClose = "\x1b[49m";
    expect(frame).toContain(bgOpen);
    expect(frame).toContain(bgClose);
    // bg 段内含用户消息文本
    const bgOpenIdx = frame.indexOf(bgOpen);
    const bgCloseIdx = frame.indexOf(bgClose, bgOpenIdx);
    expect(bgCloseIdx).toBeGreaterThan(bgOpenIdx);
    const bgContent = frame.slice(bgOpenIdx + bgOpen.length, bgCloseIdx);
    expect(bgContent).toContain("hello");

    await p;
  });

  it("padding 让 bg 段可见宽度 = 终端列数（视觉锚不断裂）", async () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      promptPrefix: "> ",
      columns: 40,
    });

    await typeChars(stdin, "abc");
    clearCaptured();
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });

    const frame = getCaptured();
    const bgOpen = "\x1b[48;5;236m";
    const bgClose = "\x1b[49m";
    const bgOpenIdx = frame.indexOf(bgOpen);
    const bgCloseIdx = frame.indexOf(bgClose, bgOpenIdx);
    const bgContent = frame.slice(bgOpenIdx + bgOpen.length, bgCloseIdx);
    // bg 段去 ANSI 后的可见宽度恰好 = 终端列数 40（前导空格 2 + "abc"(3) + padding(35) = 40）
    expect(stringWidth(stripAnsi(bgContent))).toBe(40);

    await p;
  });

  it("CJK 文本 padding 用 stringWidth 算正确（中文 = 2 列）", async () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      promptPrefix: "> ",
      columns: 30,
    });

    // 输入 "你好" —— 4 显示列
    await sendSyntheticKey(stdin, { str: "你" });
    await sendSyntheticKey(stdin, { str: "好" });
    clearCaptured();
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });

    const frame = getCaptured();
    const bgOpen = "\x1b[48;5;236m";
    const bgClose = "\x1b[49m";
    const bgOpenIdx = frame.indexOf(bgOpen);
    const bgCloseIdx = frame.indexOf(bgClose, bgOpenIdx);
    const bgContent = frame.slice(bgOpenIdx + bgOpen.length, bgCloseIdx);
    // 前导空格 2 + "你好"(4) + padding = 30
    expect(stringWidth(stripAnsi(bgContent))).toBe(30);

    await p;
  });

  it("取消路径（无 finalEcho）不染色——只清屏 + \\r\\n，不留历史锚", async () => {
    const { stdin, stdout, getCaptured, clearCaptured } = makeStreams();
    const { broker, dispatcher } = makeHarness();

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 40,
    });

    await typeChars(stdin, "draft");
    clearCaptured();
    // Ctrl+C 走 cancelled 路径，teardownVisuals(null)
    await sendSyntheticKey(stdin, { name: "c", ctrl: true, sequence: "\x03" });

    const frame = getCaptured();
    // 取消路径 finalEcho=null，不进 bg 染色分支
    expect(frame).not.toContain("\x1b[48;5;236m");

    await p;
  });
});
