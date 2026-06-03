/**
 * registerSessionCommands 测试 —— 真实 DefaultCommandRegistry + CommandDispatcher 驱动，
 * 重点验证：注册形态、resume 带 args、以及 getConv() 读写 pattern（handler 经 getter 拿到
 * conv 后写其字段，写到的是真实对象）。
 *
 * 用轻量内存 stub 提供 conv.store / conv.convRepo / runtime / taskListService 各命令实际
 * 触达的方法；/new 的核心切换逻辑由 switch-to-new-conversation 自身的测试覆盖，这里只验
 * 注册与会话生命周期 handler 的接线。
 */

import { describe, it, expect, vi } from "vitest";
import {
  CommandDispatcher,
  DefaultCommandRegistry,
  type Message,
  type RuntimeContext,
} from "@zhixing/core";
import {
  registerSessionCommands,
  registerModeCommands,
  type SessionCommandsDeps,
  type ModeCommandsDeps,
} from "../session-commands.js";
import { stripAnsi } from "../../tui/index.js";
import type { CliWriter } from "../../screen/index.js";

const RUNTIME: RuntimeContext = {
  sessionBusy: false,
  workspaceId: null,
  cwd: ".",
  target: "cli",
  features: {},
  now: 0,
};

function makeWriter(): CliWriter & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    line: (text: string) => {
      lines.push(text);
    },
  } as unknown as CliWriter & { lines: string[] };
}

type Conv = SessionCommandsDeps["getConv"] extends () => infer C ? C : never;

interface Harness {
  conv: Conv;
  taskClear: ReturnType<typeof vi.fn>;
  taskPrime: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  dispatcher: CommandDispatcher;
  registry: DefaultCommandRegistry;
  writer: CliWriter & { lines: string[] };
}

function setup(convOverrides: Partial<Record<string, unknown>> = {}): Harness {
  const registry = new DefaultCommandRegistry();
  const dispatcher = new CommandDispatcher({ registry });
  const writer = makeWriter();
  const rename = vi.fn(async (id: string, name: string) => ({ id, name }));

  const store = {
    compactAll: vi.fn(async () => [{ role: "system", content: "cleared" }]),
    countTurns: vi.fn(async () => 3),
    load: vi.fn(async () => ({ messages: [], turnCount: 9 })),
    commitTurn: vi.fn(async () => []),
    init: vi.fn(async () => {}),
  };
  const convRepo = {
    list: vi.fn(async () => [] as unknown[]),
    get: vi.fn(async () => null),
    rename,
    clearViewLayerState: vi.fn(async () => {}),
    touch: vi.fn(async () => {}),
    create: vi.fn(async () => ({ id: "new-id", name: "chat-x" })),
  };
  const conv = {
    messages: [] as Message[],
    conversationId: "conv-1",
    turnCounter: 5,
    store,
    convRepo,
    ...convOverrides,
  } as unknown as Conv;

  const taskClear = vi.fn();
  const taskPrime = vi.fn(async () => {});

  const deps: SessionCommandsDeps = {
    registry,
    dispatcher,
    writer,
    getConv: () => conv,
    getRuntime: () =>
      ({
        model: "m",
        providerId: "p",
        resetConversationState: vi.fn(async () => {}),
        forceCompact: vi.fn(async () => ({ modified: false })),
      }) as unknown as ReturnType<SessionCommandsDeps["getRuntime"]>,
    taskListService: { prime: taskPrime, clear: taskClear },
    onConversationChanged: () => {},
    clearScreenToInitial: undefined,
  };
  registerSessionCommands(deps);
  return { conv, taskClear, taskPrime, rename, dispatcher, registry, writer };
}

function visible(writer: { lines: string[] }): string {
  return writer.lines.map(stripAnsi).join("\n");
}

describe("registerSessionCommands · 注册", () => {
  it("5 条命令注册为 local；resume 带 conversation 选择器 arg", () => {
    const { registry } = setup();
    for (const name of ["new", "clear", "resume", "name", "compact"]) {
      expect(registry.findByName(name)?.execution).toBe("local");
    }
    const resume = registry.findByName("resume");
    expect(resume?.args?.[0]?.name).toBe("conversation");
    expect(resume?.args?.[0]?.kind).toBe("async-enum");
  });
});

describe("registerSessionCommands · /clear", () => {
  it("getConv() 写回 messages（compactAll 结果）+ turnCounter 归零 + 清 task cache", async () => {
    const h = setup({ turnCounter: 8 });
    await h.dispatcher.dispatch("/clear", RUNTIME);
    expect(h.conv.messages).toHaveLength(1);
    expect(h.conv.turnCounter).toBe(0);
    expect(h.taskClear).toHaveBeenCalledWith("conv-1");
  });
});

describe("registerSessionCommands · /name", () => {
  it("/name <名称> → 调 convRepo.rename + echo", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/name 我的对话", RUNTIME);
    expect(h.rename).toHaveBeenCalledWith("conv-1", "我的对话");
    expect(visible(h.writer)).toContain("已命名为: 我的对话");
  });

  it("/name 无参数 → 用法提示，不 rename", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/name", RUNTIME);
    expect(h.rename).not.toHaveBeenCalled();
    expect(visible(h.writer)).toContain("用法");
  });

  it("无 conversationId → 尚未保存提示", async () => {
    const h = setup({ conversationId: null });
    await h.dispatcher.dispatch("/name x", RUNTIME);
    expect(h.rename).not.toHaveBeenCalled();
    expect(visible(h.writer)).toContain("尚未保存");
  });
});

describe("registerSessionCommands · /compact", () => {
  it("历史过短（<4）→ 直接提示，不调 forceCompact", async () => {
    const h = setup({ messages: [{ role: "user", content: "hi" }] });
    await h.dispatcher.dispatch("/compact", RUNTIME);
    expect(visible(h.writer)).toContain("过短");
  });
});

describe("registerSessionCommands · /resume", () => {
  it("无参数 + 空对话列表 → 没有可切换", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/resume", RUNTIME);
    expect(visible(h.writer)).toContain("没有可切换的对话");
  });
});

interface ModeHarness {
  registry: DefaultCommandRegistry;
  dispatcher: CommandDispatcher;
  writer: CliWriter & { lines: string[] };
  applyModeSwitch: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function setupMode(overrides: Partial<ModeCommandsDeps> = {}): ModeHarness {
  const registry = new DefaultCommandRegistry();
  const dispatcher = new CommandDispatcher({ registry });
  const writer = makeWriter();
  const applyModeSwitch = vi.fn(async () => {});
  const close = vi.fn();
  const deps: ModeCommandsDeps = {
    registry,
    dispatcher,
    writer,
    applyModeSwitch,
    getActiveMode: () => ({ kind: "main" }),
    getActiveTurnPromise: () => null,
    workSceneRegistry: {
      list: async () => [{ id: "s1", name: "项目A" }],
    },
    rl: { close },
    ...overrides,
  };
  registerModeCommands(deps);
  return { registry, dispatcher, writer, applyModeSwitch, close };
}

describe("registerModeCommands · 注册", () => {
  it("work/exit 注册为 local；work 带 scene 选择器；exit 有 quit 别名", () => {
    const { registry } = setupMode();
    expect(registry.findByName("work")?.execution).toBe("local");
    expect(registry.findByName("work")?.args?.[0]?.name).toBe("scene");
    const exit = registry.findByName("exit");
    expect(exit?.execution).toBe("local");
    expect(registry.findByName("quit")?.id).toBe("exit:repl");
  });
});

describe("registerModeCommands · /work", () => {
  it("main 模式 + 精确 id → applyModeSwitch(enter)", async () => {
    const h = setupMode();
    await h.dispatcher.dispatch("/work s1", RUNTIME);
    expect(h.applyModeSwitch).toHaveBeenCalledWith(
      { kind: "enter", sceneId: "s1" },
      "command",
    );
  });

  it("已在工作场景 → 提示，不切换", async () => {
    const h = setupMode({ getActiveMode: () => ({ kind: "workscene" }) });
    await h.dispatcher.dispatch("/work s1", RUNTIME);
    expect(h.applyModeSwitch).not.toHaveBeenCalled();
    expect(visible(h.writer)).toContain("已在工作场景中");
  });

  it("空参数 → 引导提示，不切换", async () => {
    const h = setupMode();
    await h.dispatcher.dispatch("/work", RUNTIME);
    expect(h.applyModeSwitch).not.toHaveBeenCalled();
    expect(visible(h.writer)).toContain("选场景");
  });

  it("名称不存在 → 报错，不切换", async () => {
    const h = setupMode();
    await h.dispatcher.dispatch("/work 不存在的场景", RUNTIME);
    expect(h.applyModeSwitch).not.toHaveBeenCalled();
    expect(visible(h.writer)).toContain("不存在");
  });
});

describe("registerModeCommands · /exit", () => {
  it("主对话 → rl.close（退出进程路径），不走 applyModeSwitch", async () => {
    const h = setupMode({ getActiveMode: () => ({ kind: "main" }) });
    await h.dispatcher.dispatch("/exit", RUNTIME);
    expect(h.close).toHaveBeenCalled();
    expect(h.applyModeSwitch).not.toHaveBeenCalled();
  });

  it("工作场景 → applyModeSwitch(exit)，不 close", async () => {
    const h = setupMode({ getActiveMode: () => ({ kind: "workscene" }) });
    await h.dispatcher.dispatch("/exit", RUNTIME);
    expect(h.applyModeSwitch).toHaveBeenCalledWith({ kind: "exit" }, "command");
    expect(h.close).not.toHaveBeenCalled();
  });
});
