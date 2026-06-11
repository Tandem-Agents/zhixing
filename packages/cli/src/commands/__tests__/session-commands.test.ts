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
  type RuntimeContext,
  assistantMessage,
  createAttentionWindow,
  userMessage,
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
  resetConversationState: ReturnType<typeof vi.fn>;
  onAttentionWindowChange: ReturnType<typeof vi.fn>;
  dispatcher: CommandDispatcher;
  registry: DefaultCommandRegistry;
  writer: CliWriter & { lines: string[] };
}

function setup(
  convOverrides: Partial<Record<string, unknown>> = {},
  runtimeOverrides: Record<string, unknown> = {},
): Harness {
  const registry = new DefaultCommandRegistry();
  const dispatcher = new CommandDispatcher({ registry });
  const writer = makeWriter();
  const rename = vi.fn(async (id: string, name: string) => ({ id, name }));

  const store = {
    appendClear: vi.fn(async () => {}),
    appendRunRecord: vi.fn(async () => ({ runIndex: 0, shardId: "000001" })),
    // countRuns 经倒读原语触达自愈版索引获取 —— null 即"无记录"
    ensureReadableIndex: vi.fn(async () => null),
    readShardLines: vi.fn(async () => []),
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
    window: createAttentionWindow({ conversationId: "conv-1" }),
    pendingInputPrefix: null,
    conversationId: "conv-1",
    turnCounter: 5,
    store,
    snapshots: { write: vi.fn(async () => ({})), list: vi.fn(async () => []) },
    convRepo,
    ...convOverrides,
  } as unknown as Conv;

  const taskClear = vi.fn();
  const taskPrime = vi.fn(async () => {});
  const resetConversationState = vi.fn(async () => {});
  const onAttentionWindowChange = vi.fn(async () => {});

  const deps: SessionCommandsDeps = {
    registry,
    dispatcher,
    writer,
    getConv: () => conv,
    getRuntime: () =>
      ({
        model: "m",
        providerId: "p",
        resetConversationState,
        onAttentionWindowChange,
        forceCompact: vi.fn(async () => ({ modified: false })),
        ...runtimeOverrides,
      }) as unknown as ReturnType<SessionCommandsDeps["getRuntime"]>,
    taskListService: { prime: taskPrime, clear: taskClear },
    onConversationChanged: () => {},
    clearScreenToInitial: undefined,
  };
  registerSessionCommands(deps);
  return {
    conv,
    taskClear,
    taskPrime,
    rename,
    resetConversationState,
    onAttentionWindowChange,
    dispatcher,
    registry,
    writer,
  };
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
  it("清空是事件：appendClear 落盘 + 窗口 reset 清空 + turnCounter 归零 + 清 task cache", async () => {
    const h = setup({ turnCounter: 8 });
    await h.dispatcher.dispatch("/clear", RUNTIME);
    expect(
      (h.conv.store as unknown as { appendClear: ReturnType<typeof vi.fn> })
        .appendClear,
    ).toHaveBeenCalledWith("conv-1");
    expect(h.conv.window.getMessages()).toEqual([]);
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
  it("强制切段成功 → applyCompact 折叠 + 快照出口 + 窗口换代钩子（compact）", async () => {
    const window = createAttentionWindow({ conversationId: "conv-1" });
    for (let i = 0; i < 3; i++) {
      window.acceptRun({
        runMessages: [userMessage(`q${i}`), assistantMessage(`a${i}`)],
        runIndex: i,
      });
    }
    const windowCompact = {
      summary: "切段摘要",
      structuredSummary: { facts: "f", state: "s", active: "a" },
      pairsCompacted: 2,
      tokensBefore: 1000,
      tokensAfter: 100,
    };
    const snapshotWrite = vi.fn(async () => ({}));
    const h = setup(
      { window, snapshots: { write: snapshotWrite, list: vi.fn(async () => []) } },
      {
        forceCompact: vi.fn(async () => ({
          modified: true,
          messages: [],
          windowCompact,
          budget: { usageRatio: 0.1 },
        })),
      },
    );

    await h.dispatcher.dispatch("/compact", RUNTIME);

    // 窗口被折叠：摘要对置首、被折 2 个配对
    const first = h.conv.window.getMessages()[0]!;
    const firstBlock = first.content[0]!;
    expect(firstBlock.type === "text" ? firstBlock.text : "").toContain("切段摘要");
    // 快照出口：覆盖锚 = 被折最后配对的 runIndex（0、1 被折 → 1）
    expect(snapshotWrite).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({
        coveredThroughRunIndex: 1,
        structuredSummary: windowCompact.structuredSummary,
      }),
    );
    // run 外手动压缩 = 窗口换代（与 /clear、/resume 同纪律）
    expect(h.onAttentionWindowChange).toHaveBeenCalledWith("compact");
    expect(visible(h.writer)).toContain("压缩完成");
  });

  it("历史过短（<4）→ 直接提示，不调 forceCompact", async () => {
    const shortWindow = createAttentionWindow({ conversationId: "conv-1" });
    shortWindow.acceptRun({
      runMessages: [userMessage("hi"), assistantMessage("yo")],
      runIndex: 0,
    });
    // 窗口只有一个配对（2 条消息）< 4
    const h = setup({ window: shortWindow });
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

  it("切换成功 = 窗口换代：装填建窗 + prime + reset + onAttentionWindowChange(resume)", async () => {
    const h = setup({
      convRepo: {
        list: vi.fn(async () => [
          { id: "conv-2", name: "目标对话", lastActiveAt: new Date().toISOString() },
        ]),
        get: vi.fn(async (id: string) =>
          id === "conv-2" ? { id: "conv-2", name: "目标对话" } : null,
        ),
        rename: vi.fn(),
        clearViewLayerState: vi.fn(async () => {}),
        touch: vi.fn(async () => {}),
        create: vi.fn(),
      },
    });
    await h.dispatcher.dispatch("/resume conv-2", RUNTIME);

    expect(h.conv.conversationId).toBe("conv-2");
    expect(h.taskPrime).toHaveBeenCalledWith("conv-2");
    // 切换对话 = 注意力窗口换代（与 /new、/clear 同纪律）
    expect(h.resetConversationState).toHaveBeenCalledTimes(1);
    expect(h.onAttentionWindowChange).toHaveBeenCalledWith("resume");
    expect(visible(h.writer)).toContain("已切换到");
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
