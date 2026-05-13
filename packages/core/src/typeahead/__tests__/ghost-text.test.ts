/**
 * Ghost Text 单元测试
 *
 * 覆盖点：
 *   - getBestPrefixMatch 纯函数：unambiguous / ambiguous / exact match / aliases / empty query
 *   - CommandProvider.computeGhostText：通过 registry 的端到端行为
 *   - Broker ghost text 计算：setLoadingFinished 填充 state.ghostText
 *   - Broker acceptGhostText：替换 trigger token 为 fullValue
 */

import { describe, expect, it } from "vitest";
import {
  registerBuiltinCommands,
} from "../builtin-commands.js";
import { DefaultTypeaheadBroker } from "../broker.js";
import { CommandProvider, getBestPrefixMatch } from "../providers/command-provider.js";
import { DefaultCommandRegistry } from "../registry.js";
import type {
  CommandDef,
  RuntimeContext,
  TriggerContext,
} from "../types.js";

// ─── 辅助 ───

function makeRuntime(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    sessionBusy: false,
    workspaceId: null,
    cwd: "/tmp",
    target: "cli",
    features: {},
    now: 1_700_000_000_000,
    ...overrides,
  };
}

function makeCtx(
  draft: string,
  cursor = draft.length,
  overrides: Partial<TriggerContext> = {},
): TriggerContext {
  return {
    draft,
    cursor,
    mode: "prompt",
    runtime: makeRuntime(),
    ...overrides,
  };
}

/** 最小命令集，方便精确控制 prefix match */
function makeMinimalCommands(): CommandDef[] {
  return [
    {
      id: "update:test",
      name: "update",
      description: "Update something",
      category: "config",
      execution: "local",
      tag: "builtin",
    },
    {
      id: "upload:test",
      name: "upload",
      description: "Upload file",
      category: "tools",
      execution: "local",
      tag: "builtin",
    },
    {
      id: "new:test",
      name: "new",
      aliases: ["reset"],
      description: "New session",
      category: "session",
      execution: "local",
      tag: "builtin",
    },
    {
      id: "help:test",
      name: "help",
      description: "Show help",
      category: "info",
      execution: "local",
      tag: "builtin",
    },
  ];
}

// ─── getBestPrefixMatch 纯函数 ───

describe("getBestPrefixMatch", () => {
  const commands = makeMinimalCommands();

  it("unambiguous prefix → 返回 ghost", () => {
    // "he" 只匹配 "help"
    const ghost = getBestPrefixMatch("he", commands);
    expect(ghost).not.toBeNull();
    expect(ghost!.suffix).toBe("lp");
    expect(ghost!.fullValue).toBe("/help");
  });

  it("ambiguous prefix → null", () => {
    // "up" 匹配 "update" 和 "upload"
    const ghost = getBestPrefixMatch("up", commands);
    expect(ghost).toBeNull();
  });

  it("exact match → null（不需要 ghost）", () => {
    const ghost = getBestPrefixMatch("help", commands);
    expect(ghost).toBeNull();
  });

  it("空 query → null", () => {
    const ghost = getBestPrefixMatch("", commands);
    expect(ghost).toBeNull();
  });

  it("无匹配 → null", () => {
    const ghost = getBestPrefixMatch("zzz", commands);
    expect(ghost).toBeNull();
  });

  it("alias prefix match → 返回 alias 的 ghost", () => {
    // "res" 只匹配 "reset"（是 "new" 的 alias）
    const ghost = getBestPrefixMatch("res", commands);
    expect(ghost).not.toBeNull();
    expect(ghost!.suffix).toBe("et");
    expect(ghost!.fullValue).toBe("/reset");
  });

  it("name 和 alias 属于同一 command → 算一个匹配（unambiguous）", () => {
    // "ne" 只匹配 "new"（name），不匹配 "reset"（alias 不以 ne 开头）
    const ghost = getBestPrefixMatch("ne", commands);
    expect(ghost).not.toBeNull();
    expect(ghost!.suffix).toBe("w");
    expect(ghost!.fullValue).toBe("/new");
  });

  it("大小写不敏感", () => {
    const ghost = getBestPrefixMatch("HE", commands);
    expect(ghost).not.toBeNull();
    expect(ghost!.suffix).toBe("lp"); // 保留原始大小写的 suffix
    expect(ghost!.fullValue).toBe("/help");
  });
});

// ─── CommandProvider.computeGhostText ───

describe("CommandProvider.computeGhostText", () => {
  it("通过 registry 端到端返回 ghost", () => {
    const registry = new DefaultCommandRegistry();
    registerBuiltinCommands(registry);
    const provider = new CommandProvider({ registry });

    // "hi" 只匹配 "history"
    const match = provider.matchTrigger(makeCtx("/hi"))!;
    expect(match).not.toBeNull();
    const ghost = provider.computeGhostText(match);
    expect(ghost).not.toBeNull();
    expect(ghost!.suffix).toBe("story");
    expect(ghost!.fullValue).toBe("/history");
  });

  it("空 query → null", () => {
    const registry = new DefaultCommandRegistry();
    registerBuiltinCommands(registry);
    const provider = new CommandProvider({ registry });

    const match = provider.matchTrigger(makeCtx("/"))!;
    const ghost = provider.computeGhostText(match);
    expect(ghost).toBeNull();
  });
});

// ─── Broker ghost text state ───

describe("Broker ghost text 计算", () => {
  it("provider supportsGhostText=true 时 state.ghostText 被填充", () => {
    const registry = new DefaultCommandRegistry();
    const commands = makeMinimalCommands();
    for (const cmd of commands) registry.register(cmd);

    const broker = new DefaultTypeaheadBroker();
    broker.register(new CommandProvider({ registry }));

    const session = broker.beginSession(makeCtx("/he"));
    const state = broker.getState(session.id);

    expect(state).not.toBeNull();
    expect(state!.ghostText).not.toBeNull();
    expect(state!.ghostText!.suffix).toBe("lp");
    expect(state!.ghostText!.fullValue).toBe("/help");
  });

  it("ambiguous prefix 时 state.ghostText 为 null", () => {
    const registry = new DefaultCommandRegistry();
    const commands = makeMinimalCommands();
    for (const cmd of commands) registry.register(cmd);

    const broker = new DefaultTypeaheadBroker();
    broker.register(new CommandProvider({ registry }));

    const session = broker.beginSession(makeCtx("/up"));
    const state = broker.getState(session.id);

    expect(state!.ghostText).toBeNull();
  });
});

// ─── Broker acceptGhostText ───

describe("Broker.acceptGhostText", () => {
  it("接受 ghost text → 替换 trigger token", () => {
    const registry = new DefaultCommandRegistry();
    const commands = makeMinimalCommands();
    for (const cmd of commands) registry.register(cmd);

    const broker = new DefaultTypeaheadBroker();
    broker.register(new CommandProvider({ registry }));

    const session = broker.beginSession(makeCtx("/he"));

    const result = broker.acceptGhostText(session.id);
    expect(result).not.toBeNull();
    expect(result!.newDraft).toBe("/help");
    expect(result!.newCursor).toBe(5); // "/help".length
    expect(result!.execute).toBe(false);
  });

  it("无 ghost text 时返回 null", () => {
    const registry = new DefaultCommandRegistry();
    const commands = makeMinimalCommands();
    for (const cmd of commands) registry.register(cmd);

    const broker = new DefaultTypeaheadBroker();
    broker.register(new CommandProvider({ registry }));

    // "up" ambiguous → no ghost
    const session = broker.beginSession(makeCtx("/up"));
    const result = broker.acceptGhostText(session.id);
    expect(result).toBeNull();
  });

  it("acceptGhostText 是 state-纯函数 —— 不动 session state（与 accept 同契约）", () => {
    // 与 broker.accept 同样的 state-纯契约：仅返回 AcceptResult + emit telemetry，
    // **不**清 session state。caller 通过后续 updateInput 驱动状态变更。详见
    // broker.ts acceptGhostText 方法的 docstring。
    const registry = new DefaultCommandRegistry();
    const commands = makeMinimalCommands();
    for (const cmd of commands) registry.register(cmd);

    const broker = new DefaultTypeaheadBroker();
    broker.register(new CommandProvider({ registry }));

    const session = broker.beginSession(makeCtx("/he"));
    const beforeState = broker.getState(session.id)!;
    expect(beforeState.ghostText).not.toBeNull();

    broker.acceptGhostText(session.id);

    // session state 完全不变
    const afterState = broker.getState(session.id)!;
    expect(afterState.ghostText).toEqual(beforeState.ghostText);
    expect(afterState.suggestions).toEqual(beforeState.suggestions);
  });

  it("draft 中间有 trigger 时正确替换", () => {
    const registry = new DefaultCommandRegistry();
    const commands = makeMinimalCommands();
    for (const cmd of commands) registry.register(cmd);

    const broker = new DefaultTypeaheadBroker();
    broker.register(new CommandProvider({ registry }));

    // "请 /he" with cursor at end
    const session = broker.beginSession(makeCtx("请 /he"));
    const state = broker.getState(session.id);
    expect(state!.ghostText).not.toBeNull();

    const result = broker.acceptGhostText(session.id);
    expect(result).not.toBeNull();
    expect(result!.newDraft).toBe("请 /help");
    // cursor at end of "/help": "请" + " " + "/help" = 1 + 1 + 5 = 7 chars
    expect(result!.newCursor).toBe(7);
  });

  it("不存在的 session → null", () => {
    const broker = new DefaultTypeaheadBroker();
    const result = broker.acceptGhostText("nonexistent");
    expect(result).toBeNull();
  });
});
