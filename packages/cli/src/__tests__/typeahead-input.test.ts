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
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import chalk from "chalk";

import {
  ArgumentProvider,
  CommandDispatcher,
  CommandProvider,
  DefaultCommandRegistry,
  DefaultTypeaheadBroker,
  findTriggerToken,
} from "@zhixing/core";
import type {
  CommandDef,
  PanelMode,
  RuntimeContext,
  SuggestionItem,
  SuggestionProvider,
} from "@zhixing/core";
import {
  _getRawModeRefcount,
  _resetRawModeRefcountForTests,
  stringWidth,
  stripAnsi,
} from "../tui/index.js";
import { InputController, readInputLine, type InputLineResult } from "../typeahead-input.js";
import type { ScreenController } from "../screen/index.js";
import { BottomInfoModel } from "../bottom-info/index.js";
import { PasteRegistry } from "../paste-registry.js";
import { InputMaterialRegistry } from "../input-material-registry.js";
import { prepareUserTurnInput } from "../user-turn-input.js";
import { INPUT_HANDLE_TOKEN_PATTERNS } from "../input-handle-tokens.js";

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

function emitPasteText(stdin: NodeJS.ReadableStream, text: string): void {
  for (const ch of Array.from(text)) {
    if (ch === "\n") {
      (stdin as unknown as EventEmitter).emit("keypress", "", {
        name: "return",
        ctrl: false,
        meta: false,
        shift: false,
        sequence: "\r",
      });
      continue;
    }
    (stdin as unknown as EventEmitter).emit("keypress", ch, {
      name: undefined,
      ctrl: false,
      meta: false,
      shift: false,
      sequence: ch,
    });
  }
}

async function pasteText(
  stdin: NodeJS.ReadableStream,
  text: string,
): Promise<void> {
  emitPasteText(stdin, text);
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function drainMicrotasks(): Promise<void> {
  return Promise.resolve();
}

function minimalPng(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
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

// 驱动输入读取器所需的最小命令集 —— 覆盖本测试用到的 local / hybrid / 必填参数 /
// 前缀匹配各路径（/clear /new+reset /elevated /help）。命令真相源在 cli 各域的
// registerXxxCommands，这里只为集成测试提供一组稳定可断言的 registry 输入。
const SAMPLE_COMMANDS: readonly CommandDef[] = [
  {
    id: "new:builtin",
    name: "new",
    aliases: ["reset"],
    description: "开始一个新的会话",
    category: "session",
    execution: "hybrid",
  },
  {
    id: "clear:builtin",
    name: "clear",
    description: "清屏并开始新会话",
    category: "session",
    execution: "local",
  },
  {
    id: "status:builtin",
    name: "status",
    description: "显示会话状态",
    category: "info",
    execution: "local",
  },
  {
    id: "help:builtin",
    name: "help",
    description: "显示命令帮助",
    category: "info",
    execution: "local",
  },
  {
    id: "elevated:builtin",
    name: "elevated",
    description: "切换 elevated（高权限）模式",
    category: "config",
    execution: "hybrid",
    args: [
      {
        kind: "enum",
        name: "level",
        description: "elevated 等级",
        required: true,
        choices: [
          { value: "off", label: "off" },
          { value: "on", label: "on" },
        ],
      },
    ],
  },
];

function makeHarness(): Harness {
  const registry = new DefaultCommandRegistry();
  for (const cmd of SAMPLE_COMMANDS) registry.register(cmd);
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

  it("普通正文提交保留首尾空白", async () => {
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

    await typeChars(stdin, "  hello  ");
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });

    const result = await resultP;
    expect(result).toEqual({ kind: "text", text: "  hello  " });
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

  it("纯空白 Enter → kind=text 空字符串", async () => {
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
    await typeChars(stdin, "   ");
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

  it("submit 层保留前导空白 slash 与顿号 alias 的命令识别", async () => {
    for (const draft of ["  /nothere", "、nothere"]) {
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

      await typeChars(stdin, draft);
      await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });

      const result = await p;
      expect(result.kind).toBe("command-dispatched");
      if (result.kind === "command-dispatched") {
        expect(result.text).toBe("/nothere");
        expect(result.dispatchResult).toMatchObject({
          kind: "unknown",
          commandName: "nothere",
        });
      }
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

  it("空 buffer 的 Ctrl+D 无 inline delete 候选时 no-op(不退出,可继续输入)", async () => {
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
    // Ctrl+D 不再 resolve cancelled(原 EOF 语义已释放);Enter 才完成
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    expect(await p).toMatchObject({ kind: "text", text: "" });
  });

  it("非空 buffer 的 Ctrl+D 无 inline delete 候选时 no-op(buffer 不动 + 不退出)", async () => {
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
    // Ctrl+D 原 deleteForward 语义已释放(完全释放给 typeahead delete 候选)
    await sendSyntheticKey(stdin, {
      name: "d",
      ctrl: true,
      sequence: "\x04",
    });
    // 再 Enter 提交,buffer 仍是 abc
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
    expect(result).toMatchObject({ kind: "text", text: "hello " });
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

  it("argument 面板空 token 时 Esc 清整行（不原地无反应）", async () => {
    // `/cmd ` 进入 argument 面板但还没敲参数时，trigger.tokenStart 已达 draft
    // 末尾 —— 截断到 tokenStart 是 no-op。Esc 必须退一步清整个 buffer，否则
    // 用户感知"按 Esc 无反应"（回归保护：见 typeahead-input.ts 渐进式 Esc）。
    const { stdin, stdout, getCaptured } = makeStreams();
    const registry = new DefaultCommandRegistry();
    registry.register({
      name: "pick",
      id: "pick:test",
      description: "选一个水果",
      category: "session",
      execution: "local",
      args: [
        {
          kind: "enum",
          name: "fruit",
          description: "水果",
          required: true,
          choices: ["alpha", "beta"],
        },
      ],
    });
    const broker = new DefaultTypeaheadBroker({
      now: () => 1_700_000_000_000,
    });
    broker.register(new CommandProvider({ registry }));
    broker.register(new ArgumentProvider({ registry }));
    const dispatcher = new CommandDispatcher({ registry });

    const p = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });

    // "/pick " —— 命令名 + 空格进入参数面板，参数 token 为空
    await typeChars(stdin, "/pick ");
    expect(getCaptured()).toContain("alpha"); // 候选已渲染（确认在面板态）

    // Esc 清整行 → Enter 提交空文本。修复前：Esc 原地无反应、buffer 仍是
    // "/pick "、面板仍在，Enter 会 accept 候选 → command-dispatched（非空 text）。
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

// Enter 按键的 panelMode 分支 —— 锁住 picker / management 两种模式下的回车契约。
// 关键不变量：management 模式下 Enter 完全 no-op（无论候选是否存在），picker
// 模式保持现状（有候选则 accept、无候选则 submit）。锁住此契约后任何"把
// management 检查捆绑 hasActiveSuggestions"的回归直接在此 fail。

function makeMockItem(id: string, providerId: string): SuggestionItem {
  return {
    id,
    providerId,
    displayText: id,
    acceptPayload: {
      replacement: id,
      execute: false,
    },
  };
}

function makeModeProbeProvider(opts: {
  id: string;
  mode: PanelMode;
  items: SuggestionItem[];
}): SuggestionProvider {
  const triggerChar = "?";
  return {
    id: opts.id,
    priority: 200,
    matchTrigger: (ctx) => {
      if (!ctx.draft.startsWith(triggerChar)) return null;
      return {
        providerId: opts.id,
        tokenStart: 0,
        tokenEnd: ctx.draft.length,
        token: ctx.draft,
        query: ctx.draft.slice(1),
        runtime: ctx.runtime,
      };
    },
    query: () => opts.items,
    computePanelMode: () => opts.mode,
  };
}

describe("readInputLine — Enter 按键的 panelMode 行为", () => {
  it("management + 有候选 → Enter 完全 swallow（不 accept、不 submit），Esc 取消", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    broker.register(
      makeModeProbeProvider({
        id: "mgmt",
        mode: "management",
        items: [makeMockItem("a", "mgmt"), makeMockItem("b", "mgmt")],
      }),
    );

    const resultP = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });

    await typeChars(stdin, "?");
    await new Promise((r) => setTimeout(r, 20));
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    await new Promise((r) => setTimeout(r, 20));
    await sendSyntheticKey(stdin, {
      name: "c",
      ctrl: true,
      sequence: "\x03",
    });

    const result = await resultP;
    expect(result.kind).toBe("cancelled");
  });

  it("management + 空候选 → Enter 完全 swallow（不 submit），Esc 取消", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    broker.register(
      makeModeProbeProvider({ id: "mgmt", mode: "management", items: [] }),
    );

    const resultP = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });

    await typeChars(stdin, "?");
    await new Promise((r) => setTimeout(r, 20));
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    await new Promise((r) => setTimeout(r, 20));
    await sendSyntheticKey(stdin, {
      name: "c",
      ctrl: true,
      sequence: "\x03",
    });

    const result = await resultP;
    expect(result.kind).toBe("cancelled");
  });

  it("picker + 有候选 → Enter accept 候选（acceptPayload.replacement 写入 buffer）", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    broker.register(
      makeModeProbeProvider({
        id: "pick",
        mode: "picker",
        items: [makeMockItem("alpha", "pick")],
      }),
    );

    const resultP = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });

    await typeChars(stdin, "?");
    await new Promise((r) => setTimeout(r, 20));
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    await new Promise((r) => setTimeout(r, 20));
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });

    const result = await resultP;
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toBe("alpha");
    }
  });

  it("picker + 空候选 → Enter 走 submit fallback（保护现状）", async () => {
    const { stdin, stdout } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    broker.register(
      makeModeProbeProvider({ id: "pick", mode: "picker", items: [] }),
    );

    const resultP = readInputLine({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      stdin,
      stdout,
      columns: 80,
    });

    await typeChars(stdin, "?xyz");
    await new Promise((r) => setTimeout(r, 20));
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });

    const result = await resultP;
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toBe("?xyz");
    }
  });
});

// 光标契约护栏（旧 readInputLine 直写 ANSI 的实现细节守卫）已随 ScreenController
// 范式升级移除——光标移动 / 区域擦除统一由 screen 模块协调，由 screen-controller
// 单元测试覆盖。输入区行为级测试见上方 readInputLine 各场景。

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

describe("InputController — suspend/resume 输入态快照恢复", () => {
  function makeScreen(): ScreenController {
    return {
      attachInput: vi.fn(),
      detachInput: vi.fn(),
      dispose: vi.fn(),
      requestInputRepaint: vi.fn(),
      ensureScrollLeadingBlank: vi.fn(),
      withScrollWrite: vi.fn(),
    } as unknown as ScreenController;
  }

  it("候选浏览中途 suspend → resume：draft 原样恢复并重新触发候选", async () => {
    const { stdin } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const controller = new InputController({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      screen: makeScreen(),
      stdin,
      columns: 80,
    });
    controller.start();
    await typeChars(stdin, "/he");
    expect(stripAnsi(controller.renderLines().join("\n"))).toContain("/he");

    controller.suspend();
    // 挂起态不渲染输入行（chrome 收缩到 status 高度）
    expect(stripAnsi(controller.renderLines().join("\n"))).not.toContain("/he");

    controller.resume();
    await new Promise((r) => setImmediate(r));
    // 恢复挂起前的 draft —— 候选浏览中途被 inline 编辑接管后原样还原
    expect(stripAnsi(controller.renderLines().join("\n"))).toContain("/he");

    controller.stop();
  });

  it("空 buffer suspend → resume 无残留（confirm 场景零影响）", async () => {
    const { stdin } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const controller = new InputController({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      screen: makeScreen(),
      stdin,
      columns: 80,
    });
    controller.start();
    // 不输入任何字符（模拟 confirm 在 turn 运行时挂起，buffer 已空）
    controller.suspend();
    controller.resume();
    await new Promise((r) => setImmediate(r));
    expect(stripAnsi(controller.renderLines().join("\n"))).not.toContain("/he");

    controller.stop();
  });
});

describe("InputController — 多行粘贴提交历史区", () => {
  function makeCapturingScreen(): {
    screen: ScreenController;
    getScrollbackText: () => string;
  } {
    let scrollbackText = "";
    const screen = {
      attachInput: vi.fn(),
      detachInput: vi.fn(),
      dispose: vi.fn(),
      requestInputRepaint: vi.fn(),
      ensureScrollLeadingBlank: vi.fn(),
      withScrollWrite: vi.fn((render: (write: (text: string) => void) => void) => {
        render((text) => {
          scrollbackText += text;
        });
      }),
    } as unknown as ScreenController;

    return {
      screen,
      getScrollbackText: () => scrollbackText,
    };
  }

  it("粘贴图片路径时输入区显示图片材料 chip", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-input-"));
    try {
      const imagePath = path.join(tempDir, "shot.png");
      await fs.writeFile(imagePath, minimalPng(4, 5));
      const { stdin } = makeStreams();
      const { broker, dispatcher } = makeHarness();
      const materialRegistry = new InputMaterialRegistry();
      const { screen, getScrollbackText } = makeCapturingScreen();
      const controller = new InputController({
        broker,
        dispatcher,
        getRuntime: makeRuntime,
        screen,
        stdin,
        columns: 80,
        materialRegistry,
        workspaceRoot: tempDir,
      });
      const resultP = controller.waitOnce();

      controller.start();
      await pasteText(stdin, imagePath);
      const inputText = stripAnsi(controller.renderLines().join("\n"));
      expect(inputText).toContain("[Image #1 · shot.png · 4x5 ·");
      expect(inputText).not.toContain(imagePath);

      await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
      const result = await resultP;
      expect(result.kind).toBe("text");
      if (result.kind === "text") {
        expect(result.text).toContain("[Image #1 · shot.png · 4x5 ·");
      }
      expect(stripAnsi(getScrollbackText())).toContain("[Image #1 · shot.png");
      expect(materialRegistry.size).toBe(1);

      controller.stop();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("长图片材料 chip 在输入区和历史区都按原子 handle 显示", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-input-"));
    try {
      const longName = `screen-capture-${"abcdef".repeat(8)}.png`;
      const imagePath = path.join(tempDir, longName);
      await fs.writeFile(imagePath, minimalPng(4, 5));
      const { stdin } = makeStreams();
      const { broker, dispatcher } = makeHarness();
      const materialRegistry = new InputMaterialRegistry();
      const { screen, getScrollbackText } = makeCapturingScreen();
      const controller = new InputController({
        broker,
        dispatcher,
        getRuntime: makeRuntime,
        screen,
        stdin,
        columns: 52,
        materialRegistry,
        workspaceRoot: tempDir,
      });
      const resultP = controller.waitOnce();

      controller.start();
      await pasteText(stdin, imagePath);
      const inputText = stripAnsi(controller.renderLines().join("\n"));
      expect(inputText).toMatch(/\[Image #1 · [^\]\n]*…[^\]\n]*\.png[^\]\n]*\]/);
      expect(inputText).not.toContain(longName);
      expect(inputText).not.toContain(imagePath);

      await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
      const result = await resultP;
      expect(result.kind).toBe("text");

      const scrollbackText = stripAnsi(getScrollbackText());
      expect(scrollbackText).toMatch(
        /\[Image #1 · [^\]\n]*…[^\]\n]*\.png[^\]\n]*\]/,
      );

      controller.stop();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("材料 chip 是 typeahead trigger 的词边界", () => {
    const registry = new InputMaterialRegistry();
    const id = registry.registerLocalFile({
      kind: "image",
      filePath: "E:/repo/shot.png",
      name: "shot.png",
      mimeType: "image/png",
      byteSize: 24,
      image: { width: 4, height: 5 },
    });
    const chip = registry.format(id);
    const draft = `${chip}/help`;
    const match = findTriggerToken(draft, Array.from(draft).length, {
      triggerChar: "/",
      requireBoundary: true,
      wordTerminators: INPUT_HANDLE_TOKEN_PATTERNS,
    });

    expect(match?.token).toBe("/help");
    expect(match?.tokenStart).toBe(Array.from(chip).length);
  });

  it("长粘贴输入区折叠，提交后历史区写入原文", async () => {
    const { stdin } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const registry = new PasteRegistry();
    const { screen, getScrollbackText } = makeCapturingScreen();
    const controller = new InputController({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      screen,
      stdin,
      columns: 80,
      registry,
    });
    const resultP = new Promise<InputLineResult>((resolve) => {
      controller.onSubmit(resolve);
    });
    const pasted = ["alpha one", "beta two", "gamma three", "delta four"].join(
      "\n",
    );

    controller.start();
    await pasteText(stdin, pasted);
    const inputText = stripAnsi(controller.renderLines().join("\n"));
    expect(inputText).toContain("[Pasted #");
    expect(inputText).not.toContain("alpha one");

    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    const result = await resultP;
    expect(result).toEqual({ kind: "text", text: pasted });

    const scrollbackText = stripAnsi(getScrollbackText());
    expect(scrollbackText).toContain("alpha one");
    expect(scrollbackText).toContain("delta four");
    expect(scrollbackText).not.toContain("[Pasted #");

    controller.stop();
  });

  it("折叠长粘贴提交保留首尾空白", async () => {
    const { stdin } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const registry = new PasteRegistry();
    const { screen, getScrollbackText } = makeCapturingScreen();
    const controller = new InputController({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      screen,
      stdin,
      columns: 80,
      registry,
    });
    const resultP = controller.waitOnce();
    const pasted = "  indented\n  child\nline3\nline4\n\n";

    controller.start();
    await pasteText(stdin, pasted);
    expect(stripAnsi(controller.renderLines().join("\n"))).toContain(
      "[Pasted #",
    );

    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    expect(await resultP).toEqual({ kind: "text", text: pasted });

    const scrollbackText = stripAnsi(getScrollbackText());
    expect(scrollbackText).toContain("    indented");
    expect(scrollbackText).not.toContain("[Pasted #");

    controller.stop();
  });

  it("折叠长粘贴经过 payload 准备边界后仍向 agent 发送原文", async () => {
    const { stdin } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const registry = new PasteRegistry();
    const { screen, getScrollbackText } = makeCapturingScreen();
    const controller = new InputController({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      screen,
      stdin,
      columns: 80,
      registry,
    });
    const resultP = controller.waitOnce();
    const pasted = "  prompt\n    code\nline3\nline4\n";

    controller.start();
    await pasteText(stdin, pasted);
    expect(stripAnsi(controller.renderLines().join("\n"))).toContain(
      "[Pasted #",
    );

    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    const result = await resultP;
    expect(result).toEqual({ kind: "text", text: pasted });

    if (result.kind === "text") {
      const prepared = await prepareUserTurnInput(result.text, {
        workspaceRoot: "E:/repo",
      });
      expect(prepared?.input).toEqual({
        parts: [{ type: "text", text: pasted }],
      });
    }

    const scrollbackText = stripAnsi(getScrollbackText());
    expect(scrollbackText).toContain("    prompt");
    expect(scrollbackText).not.toContain("[Pasted #");

    controller.stop();
  });

  it("折叠长粘贴以命令触发字符开头时仍作为正文提交", async () => {
    for (const pasted of [
      "/clear\nline two\nline three\nline four",
      "、help\nline two\nline three\nline four",
    ]) {
      const { stdin } = makeStreams();
      const { broker, dispatcher } = makeHarness();
      const registry = new PasteRegistry();
      const { screen, getScrollbackText } = makeCapturingScreen();
      const controller = new InputController({
        broker,
        dispatcher,
        getRuntime: makeRuntime,
        screen,
        stdin,
        columns: 80,
        registry,
      });

      controller.start();
      const resultP = controller.waitOnce();
      await pasteText(stdin, pasted);
      expect(stripAnsi(controller.renderLines().join("\n"))).toContain(
        "[Pasted #",
      );

      await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
      expect(await resultP).toEqual({ kind: "text", text: pasted });

      const scrollbackText = stripAnsi(getScrollbackText());
      expect(scrollbackText).toContain(pasted.split("\n")[0]!);
      expect(scrollbackText).not.toContain("[Pasted #");

      controller.stop();
    }
  });

  it("拆批长粘贴合并为一次输入，不丢前半段", async () => {
    const { stdin } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const registry = new PasteRegistry();
    const { screen, getScrollbackText } = makeCapturingScreen();
    const controller = new InputController({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      screen,
      stdin,
      columns: 80,
      registry,
    });
    const resultP = new Promise<InputLineResult>((resolve) => {
      controller.onSubmit(resolve);
    });
    const pasted = [
      "A1 alpha",
      "A2 beta",
      "A3 gamma",
      "A4 delta",
      "B1 alpha",
      "B2 beta",
      "B3 gamma",
      "B4 delta",
    ].join("\n");
    const splitAt = pasted.indexOf("B1 alpha");

    controller.start();
    emitPasteText(stdin, pasted.slice(0, splitAt));
    await drainMicrotasks();
    emitPasteText(stdin, pasted.slice(splitAt));
    await new Promise((resolve) => setTimeout(resolve, 25));

    const inputText = stripAnsi(controller.renderLines().join("\n"));
    expect(inputText).toContain("[Pasted #");
    expect(inputText).not.toContain("A1 alpha");
    expect(inputText).not.toContain("B4 delta");

    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    const result = await resultP;
    expect(result).toEqual({ kind: "text", text: pasted });

    const scrollbackText = stripAnsi(getScrollbackText());
    expect(scrollbackText).toContain("A1 alpha");
    expect(scrollbackText).toContain("B4 delta");
    expect(scrollbackText).not.toContain("[Pasted #");

    controller.stop();
  });

  it("主动第二次长粘贴显示原文并替换旧 token", async () => {
    const { stdin } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const registry = new PasteRegistry();
    const { screen, getScrollbackText } = makeCapturingScreen();
    const controller = new InputController({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      screen,
      stdin,
      columns: 80,
      registry,
    });
    const resultP = new Promise<InputLineResult>((resolve) => {
      controller.onSubmit(resolve);
    });
    const firstPaste = ["first 1", "first 2", "first 3", "first 4"].join("\n");
    const secondPaste = [
      "second 1",
      "second 2",
      "second 3",
      "second 4",
    ].join("\n");

    controller.start();
    await pasteText(stdin, firstPaste);
    expect(stripAnsi(controller.renderLines().join("\n"))).toContain(
      "[Pasted #",
    );

    await pasteText(stdin, secondPaste);
    const inputText = stripAnsi(controller.renderLines().join("\n"));
    expect(inputText).not.toContain("[Pasted #");
    expect(inputText).not.toContain("first 1");
    expect(inputText).toContain("second 1");
    expect(inputText).toContain("second 4");

    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    const result = await resultP;
    expect(result).toEqual({ kind: "text", text: secondPaste });

    const scrollbackText = stripAnsi(getScrollbackText());
    expect(scrollbackText).toContain("second 1");
    expect(scrollbackText).not.toContain("first 1");

    controller.stop();
  });

  it("长粘贴提交后通过输入历史恢复，仍提交原文", async () => {
    const { stdin } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const registry = new PasteRegistry();
    const { screen, getScrollbackText } = makeCapturingScreen();
    const controller = new InputController({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      screen,
      stdin,
      columns: 80,
      registry,
    });
    const pasted = ["alpha one", "beta two", "gamma three", "delta four"].join(
      "\n",
    );

    controller.start();
    const firstSubmit = controller.waitOnce();
    await pasteText(stdin, pasted);
    expect(stripAnsi(controller.renderLines().join("\n"))).toContain(
      "[Pasted #",
    );
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    expect(await firstSubmit).toEqual({ kind: "text", text: pasted });
    expect(registry.size).toBe(1);

    const secondSubmit = controller.waitOnce();
    await sendSyntheticKey(stdin, { name: "up", sequence: "\x1b[A" });
    const recalledText = stripAnsi(controller.renderLines().join("\n"));
    expect(recalledText).toContain("[Pasted #");
    expect(recalledText).not.toContain("alpha one");

    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    expect(await secondSubmit).toEqual({ kind: "text", text: pasted });

    const scrollbackText = stripAnsi(getScrollbackText());
    expect(scrollbackText).toContain("alpha one");
    expect(scrollbackText).toContain("delta four");
    expect(scrollbackText).not.toContain("[Pasted #");

    controller.stop();
  });

  it("历史浏览前的未提交粘贴草稿恢复后仍可提交原文", async () => {
    const { stdin } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const registry = new PasteRegistry();
    const { screen, getScrollbackText } = makeCapturingScreen();
    const controller = new InputController({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      screen,
      stdin,
      columns: 80,
      registry,
    });
    const pasted = [
      "draft alpha",
      "draft beta",
      "draft gamma",
      "draft delta",
    ].join("\n");

    controller.start();
    const oldSubmit = controller.waitOnce();
    await typeChars(stdin, "old command");
    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    expect(await oldSubmit).toEqual({ kind: "text", text: "old command" });

    const restoredDraftSubmit = controller.waitOnce();
    await pasteText(stdin, pasted);
    expect(stripAnsi(controller.renderLines().join("\n"))).toContain(
      "[Pasted #",
    );
    expect(registry.size).toBe(1);

    await sendSyntheticKey(stdin, { name: "up", sequence: "\x1b[A" });
    expect(stripAnsi(controller.renderLines().join("\n"))).toContain(
      "old command",
    );
    expect(registry.size).toBe(1);

    await sendSyntheticKey(stdin, { name: "down", sequence: "\x1b[B" });
    const restoredText = stripAnsi(controller.renderLines().join("\n"));
    expect(restoredText).toContain("[Pasted #");
    expect(restoredText).not.toContain("draft alpha");

    await sendSyntheticKey(stdin, { name: "return", sequence: "\r" });
    expect(await restoredDraftSubmit).toEqual({ kind: "text", text: pasted });

    const scrollbackText = stripAnsi(getScrollbackText());
    expect(scrollbackText).toContain("draft alpha");
    expect(scrollbackText).toContain("draft delta");
    expect(scrollbackText).not.toContain("[Pasted #");

    controller.stop();
  });
});

describe("InputController — 底部信息行(bottomInfo)", () => {
  function makeScreen(): ScreenController {
    return {
      attachInput: vi.fn(),
      detachInput: vi.fn(),
      dispose: vi.fn(),
      requestInputRepaint: vi.fn(),
      ensureScrollLeadingBlank: vi.fn(),
      withScrollWrite: vi.fn(),
    } as unknown as ScreenController;
  }

  function makeController(bottomInfo?: BottomInfoModel): {
    controller: InputController;
    stdin: ReturnType<typeof makeStreams>["stdin"];
  } {
    const { stdin } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const controller = new InputController({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      screen: makeScreen(),
      stdin,
      columns: 80,
      bottomInfo,
    });
    return { controller, stdin };
  }

  it("普通模式输入文字 → 底部信息行右区显示 esc 清空;空 buffer 不显示", async () => {
    const bottomInfo = new BottomInfoModel();
    const { controller, stdin } = makeController(bottomInfo);
    controller.start();
    // 空 buffer:占位但不显示 esc 清空
    expect(stripAnsi(controller.renderLines().join("\n"))).not.toContain(
      "esc 清空",
    );

    await typeChars(stdin, "hello");
    // 纯文字(无 trigger)→ 普通模式 → 底部信息行显示 esc 清空
    expect(stripAnsi(controller.renderLines().join("\n"))).toContain("esc 清空");

    // 删空 → esc 清空 消失
    await sendSyntheticKey(stdin, { name: "escape", sequence: "\x1b" });
    expect(stripAnsi(controller.renderLines().join("\n"))).not.toContain(
      "esc 清空",
    );

    controller.stop();
  });

  it("命令面板模式(/)→ 不追加底部信息行(面板自带 meta 行)", async () => {
    const bottomInfo = new BottomInfoModel();
    const { controller, stdin } = makeController(bottomInfo);
    controller.start();
    await typeChars(stdin, "/");
    // 有 trigger → panelLines 非空 → 渲染不追加底部信息行(即便 model 里有 escHint)
    expect(stripAnsi(controller.renderLines().join("\n"))).not.toContain(
      "esc 清空",
    );
    controller.stop();
  });

  it("stop() 清除自己贡献的 esc hint 块,不留残留", async () => {
    const bottomInfo = new BottomInfoModel();
    const { controller, stdin } = makeController(bottomInfo);
    controller.start();
    await typeChars(stdin, "hi");
    expect(bottomInfo.snapshot().right.length).toBe(1); // buffer 非空 → 有 escHint 块
    controller.stop();
    expect(bottomInfo.snapshot().right.length).toBe(0); // stop 清除自己的块
  });

  it("未注入 bottomInfo → 不渲染信息行(向后兼容)", async () => {
    const { controller, stdin } = makeController(undefined);
    controller.start();
    await typeChars(stdin, "hello");
    expect(stripAnsi(controller.renderLines().join("\n"))).not.toContain(
      "esc 清空",
    );
    controller.stop();
  });

  it("顺序守护:broker.updateInput 触发的本次 repaint 已能看到 esc hint", async () => {
    // 守护"syncBottomInfo 必须早于 broker.updateInput":updateInput 同步触发一次
    // repaint,若 syncBottomInfo 晚于它,本次 repaint 读到的 model 尚未更新 →
    // esc 清空 落后一帧。捕获 requestInputRepaint 被调那一刻的 model 状态来锁住顺序。
    const { stdin } = makeStreams();
    const { broker, dispatcher } = makeHarness();
    const bottomInfo = new BottomInfoModel();
    let escVisibleAtLastRepaint = false;
    const screen = {
      attachInput: vi.fn(),
      detachInput: vi.fn(),
      dispose: vi.fn(),
      requestInputRepaint: vi.fn(() => {
        escVisibleAtLastRepaint = bottomInfo.snapshot().right.length > 0;
      }),
      ensureScrollLeadingBlank: vi.fn(),
      withScrollWrite: vi.fn(),
    } as unknown as ScreenController;
    const controller = new InputController({
      broker,
      dispatcher,
      getRuntime: makeRuntime,
      screen,
      stdin,
      columns: 80,
      bottomInfo,
    });
    controller.start();
    await typeChars(stdin, "a");
    expect(escVisibleAtLastRepaint).toBe(true);
    controller.stop();
  });

  it("resume 后 esc hint 与恢复的 buffer 一致", async () => {
    const bottomInfo = new BottomInfoModel();
    const { controller, stdin } = makeController(bottomInfo);
    controller.start();
    await typeChars(stdin, "hi");
    controller.suspend(); // buffer=null,model 残留(suspend 不清)
    controller.resume();
    await new Promise((r) => setImmediate(r));
    // resume 恢复 "hi" 非空 → attachKeypressOnly 末尾 + syncBroker 同步 escHint
    expect(stripAnsi(controller.renderLines().join("\n"))).toContain("esc 清空");
    controller.stop();
  });
});
