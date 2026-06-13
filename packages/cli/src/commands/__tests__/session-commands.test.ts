/**
 * registerSessionCommands / registerModeCommands 测试 —— 真实 registry +
 * dispatcher 驱动,锁住"分发在本地、执行体在宿主"的接线:每个命令 handler
 * 把动作翻译成 controller(组合会话 / 场景 facade)的对应调用。
 */

import { describe, it, expect, vi } from "vitest";
import {
  CommandDispatcher,
  DefaultCommandRegistry,
  type RuntimeContext,
} from "@zhixing/core";
import {
  registerSessionCommands,
  registerModeCommands,
} from "../session-commands.js";
import { stripAnsi } from "../../tui/index.js";
import type { CliWriter } from "../../screen/index.js";
import type { ConversationController } from "../../runtime/conversation-controller.js";

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

function makeController() {
  const stub = {
    current: {
      conversationId: "conv-current",
      name: "当前对话",
      mode: { kind: "main" as const },
    },
    newConversation: vi.fn(async () => ({
      conversationId: "conv-new",
      name: "conv-new",
      mode: { kind: "main" as const },
    })),
    clear: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    compact: vi.fn(async () => ({ modified: false })),
    resume: vi.fn(async (id: string) => ({
      conversationId: id,
      name: `名字-${id}`,
      mode: { kind: "main" as const },
    })),
    listConversations: vi.fn(async () => [
      {
        conversationId: "conv-other",
        name: "另一个",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastActiveAt: "2026-01-01T00:00:00.000Z",
        active: false,
        busy: false,
        observerCount: 0,
        pendingCount: 0,
      },
    ]),
    history: vi.fn(async () => ({ runs: [], hasMore: false })),
  };
  return {
    stub,
    controller: stub as unknown as ConversationController,
  };
}

function setup() {
  const registry = new DefaultCommandRegistry();
  const dispatcher = new CommandDispatcher({ registry });
  const writer = makeWriter();
  const { stub, controller } = makeController();
  const onConversationChanged = vi.fn();
  const clearScreenToInitial = vi.fn();
  const markLocalClearSettled = vi.fn();
  const markLocalClear = vi.fn(() => markLocalClearSettled);
  registerSessionCommands({
    registry,
    dispatcher,
    writer,
    controller,
    onConversationChanged,
    markLocalClear,
    clearScreenToInitial,
  });
  return {
    registry,
    dispatcher,
    writer,
    stub,
    onConversationChanged,
    markLocalClear,
    markLocalClearSettled,
    clearScreenToInitial,
  };
}

describe("registerSessionCommands(执行体经宿主)", () => {
  it("/new → 宿主建新对话 + UI 刷新通知", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/new", RUNTIME);
    expect(h.stub.newConversation).toHaveBeenCalledOnce();
    expect(h.onConversationChanged).toHaveBeenCalledOnce();
    expect(stripAnsi(h.writer.lines.join("\n"))).toContain("已创建新对话");
  });

  it("/clear → 宿主清空 + 清屏回初始态;失败渲染错误且不清屏", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/clear", RUNTIME);
    expect(h.stub.clear).toHaveBeenCalledOnce();
    expect(h.markLocalClear).toHaveBeenCalledWith("conv-current");
    expect(h.markLocalClearSettled).toHaveBeenCalledWith("success");
    expect(h.clearScreenToInitial).toHaveBeenCalledOnce();

    h.stub.clear.mockRejectedValueOnce(new Error("busy"));
    await h.dispatcher.dispatch("/clear", RUNTIME);
    expect(stripAnsi(h.writer.lines.join("\n"))).toContain("清空失败");
    expect(h.markLocalClearSettled).toHaveBeenLastCalledWith("failed");
    expect(h.clearScreenToInitial).toHaveBeenCalledTimes(1);
  });

  it("/name <名称> → 宿主改名", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/name 新名字", RUNTIME);
    expect(h.stub.rename).toHaveBeenCalledWith("新名字");
  });

  it("/resume <id> → 宿主 touch + 切指针 + 历史尾巴经 RPC 倒读", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/resume conv-other", RUNTIME);
    expect(h.stub.resume).toHaveBeenCalledWith("conv-other");
    expect(h.stub.history).toHaveBeenCalledWith("conv-other");
    expect(h.onConversationChanged).toHaveBeenCalled();
  });

  it("/compact → 宿主执行体;无可压缩内容如实呈现", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/compact", RUNTIME);
    expect(h.stub.compact).toHaveBeenCalledOnce();
    expect(stripAnsi(h.writer.lines.join("\n"))).toContain("已无可压缩内容");
  });
});

describe("registerModeCommands", () => {
  function setupMode() {
    const registry = new DefaultCommandRegistry();
    const dispatcher = new CommandDispatcher({ registry });
    const writer = makeWriter();
    const applyModeSwitch = vi.fn(async () => {});
    let mode: { kind: string } = { kind: "main" };
    registerModeCommands({
      registry,
      dispatcher,
      writer,
      applyModeSwitch,
      getActiveMode: () => mode,
      getActiveTurnPromise: () => null,
      listScenes: async () => [
        { sceneId: "scene-1", name: "写作", workdir: "E:\\w" },
      ],
      rl: { close: vi.fn() },
    });
    return {
      dispatcher,
      writer,
      applyModeSwitch,
      setMode: (m: { kind: string }) => {
        mode = m;
      },
    };
  }

  it("/work <场景> → enter 意图经唯一执行点", async () => {
    const h = setupMode();
    await h.dispatcher.dispatch("/work scene-1", RUNTIME);
    expect(h.applyModeSwitch).toHaveBeenCalledWith({
      kind: "enter",
      sceneId: "scene-1",
    });
  });

  it("场景中 /exit → exit 意图;main 中 /work 重复进入被拒", async () => {
    const h = setupMode();
    h.setMode({ kind: "workscene" });
    await h.dispatcher.dispatch("/exit", RUNTIME);
    expect(h.applyModeSwitch).toHaveBeenCalledWith({ kind: "exit" });

    await h.dispatcher.dispatch("/work scene-1", RUNTIME);
    expect(stripAnsi(h.writer.lines.join("\n"))).toContain("已在工作场景中");
  });
});
