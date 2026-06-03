/**
 * CommandDispatcher 单元测试
 *
 * 覆盖点：
 *   - 解析：/cmd、/cmd args、空格前缀、非 / 行兜底
 *   - 三档执行：local / agent / hybrid 各自的 DispatchResult
 *   - 未知命令 / 缺 handler / handler 抛异常的降级
 *   - alias 命中（registry.findByName 已经包含 alias）
 */

import { describe, expect, it, vi } from "vitest";
import type { RuntimeContext } from "../types.js";
import { DefaultCommandRegistry } from "../registry.js";
import { registerSampleCommands } from "./sample-commands.js";
import {
  CommandDispatcher,
  parseCommandInvocation,
} from "../command-dispatcher.js";

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

function makeRegistry() {
  const reg = new DefaultCommandRegistry();
  registerSampleCommands(reg);
  return reg;
}

describe("parseCommandInvocation", () => {
  it("只有 /cmd", () => {
    expect(parseCommandInvocation("/new")).toMatchObject({ name: "new", rest: "" });
  });
  it("/cmd args", () => {
    expect(parseCommandInvocation("/model claude-opus-4-6")).toMatchObject({
      name: "model",
      rest: "claude-opus-4-6",
    });
  });
  it("leading whitespace 被 trim", () => {
    expect(parseCommandInvocation("  /help")).toMatchObject({ name: "help" });
  });
  it("非 / 行返回空 name", () => {
    expect(parseCommandInvocation("hello world").name).toBe("");
  });
  it("多空格 rest 合并", () => {
    expect(parseCommandInvocation("/cmd   a b   c")).toMatchObject({
      name: "cmd",
      rest: "a b   c",
    });
  });
});

describe("CommandDispatcher — 三档执行", () => {
  it("local 命令调 handler 并返回 local-handled", async () => {
    const registry = makeRegistry();
    const dispatcher = new CommandDispatcher({ registry });
    const spy = vi.fn(() => ({ summary: "cleared" }));
    dispatcher.registerHandler("clear:builtin", spy);

    const result = await dispatcher.dispatch("/clear", makeRuntime());
    expect(result.kind).toBe("local-handled");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("hybrid 命令返回 kind=hybrid + systemMessage", async () => {
    const registry = makeRegistry();
    const dispatcher = new CommandDispatcher({ registry });
    dispatcher.registerHandler("new:builtin", () => ({
      systemMessage: "用户开启了新会话",
      summary: "new session created",
    }));

    const result = await dispatcher.dispatch("/new", makeRuntime());
    expect(result).toMatchObject({
      kind: "hybrid",
      systemMessage: "用户开启了新会话",
    });
  });

  it("hybrid 命令 handler 不返回 systemMessage 时 dispatcher 给默认值", async () => {
    const registry = makeRegistry();
    const dispatcher = new CommandDispatcher({ registry });
    dispatcher.registerHandler("new:builtin", () => ({}));
    const result = await dispatcher.dispatch("/new", makeRuntime());
    expect(result).toMatchObject({
      kind: "hybrid",
      systemMessage: expect.stringContaining("/new"),
    });
  });

  it("execution=agent 命令不调 handler，返回 agent-message", async () => {
    const registry = new DefaultCommandRegistry();
    registry.register({
      id: "background:test",
      name: "background",
      description: "background task",
      category: "plugin",
      execution: "agent",
    });
    const dispatcher = new CommandDispatcher({ registry });
    const spy = vi.fn();
    dispatcher.registerHandler("background:test", spy);

    const result = await dispatcher.dispatch(
      "/background do something",
      makeRuntime(),
    );
    expect(result).toEqual({
      kind: "agent-message",
      text: "/background do something",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("alias 命中（/reset → /new）", async () => {
    const registry = makeRegistry();
    const dispatcher = new CommandDispatcher({ registry });
    const spy = vi.fn(() => ({ systemMessage: "reset done" }));
    dispatcher.registerHandler("new:builtin", spy);

    const result = await dispatcher.dispatch("/reset", makeRuntime());
    expect(result.kind).toBe("hybrid");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("CommandDispatcher — 降级路径", () => {
  it("未知命令返回 kind=unknown + commandName", async () => {
    const registry = makeRegistry();
    const dispatcher = new CommandDispatcher({ registry });
    const result = await dispatcher.dispatch("/nothere", makeRuntime());
    expect(result).toEqual({ kind: "unknown", commandName: "nothere" });
  });

  it("local 命令缺 handler → missing-handler", async () => {
    const registry = makeRegistry();
    const dispatcher = new CommandDispatcher({ registry });
    // /help 是 local 但没注册 handler
    const result = await dispatcher.dispatch("/help", makeRuntime());
    expect(result).toEqual({
      kind: "missing-handler",
      commandId: "help:builtin",
    });
  });

  it("handler 抛异常 → kind=error", async () => {
    const registry = makeRegistry();
    const dispatcher = new CommandDispatcher({ registry });
    dispatcher.registerHandler("clear:builtin", () => {
      throw new Error("boom");
    });
    const result = await dispatcher.dispatch("/clear", makeRuntime());
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.error.message).toBe("boom");
      expect(result.commandId).toBe("clear:builtin");
    }
  });

  it("async handler 抛出 Promise reject → kind=error", async () => {
    const registry = makeRegistry();
    const dispatcher = new CommandDispatcher({ registry });
    dispatcher.registerHandler("clear:builtin", async () => {
      throw new Error("async boom");
    });
    const result = await dispatcher.dispatch("/clear", makeRuntime());
    expect(result.kind).toBe("error");
  });

  it("非 / 开头的 draft 被保险为 agent-message", async () => {
    const registry = makeRegistry();
    const dispatcher = new CommandDispatcher({ registry });
    const result = await dispatcher.dispatch("hello", makeRuntime());
    expect(result).toEqual({ kind: "agent-message", text: "hello" });
  });
});

describe("CommandDispatcher — handler 上下文", () => {
  it("handler 收到 args + rawInput + runtime", async () => {
    const registry = makeRegistry();
    const dispatcher = new CommandDispatcher({ registry });
    let receivedCtx: unknown = null;
    dispatcher.registerHandler("clear:builtin", (ctx) => {
      receivedCtx = ctx;
      return {};
    });

    const rt = makeRuntime();
    await dispatcher.dispatch("/clear rest text", rt);

    expect(receivedCtx).toMatchObject({
      args: { _rest: "rest text" },
      rawInput: "/clear rest text",
      runtime: rt,
    });
  });
});

describe("CommandDispatcher — 构造与注册", () => {
  it("构造时带 initial handlers 立刻可用", async () => {
    const registry = makeRegistry();
    const spy = vi.fn(() => ({}));
    const dispatcher = new CommandDispatcher({
      registry,
      handlers: new Map([["clear:builtin", spy]]),
    });
    expect(dispatcher.handlerCount).toBe(1);
    await dispatcher.dispatch("/clear", makeRuntime());
    expect(spy).toHaveBeenCalled();
  });

  it("registerHandler 允许覆盖", async () => {
    const registry = makeRegistry();
    const dispatcher = new CommandDispatcher({ registry });
    const first = vi.fn(() => ({}));
    const second = vi.fn(() => ({}));
    dispatcher.registerHandler("clear:builtin", first);
    dispatcher.registerHandler("clear:builtin", second);
    await dispatcher.dispatch("/clear", makeRuntime());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });
});
