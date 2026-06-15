/**
 * registerInfoCommands 测试 —— 真实 registry + dispatcher 驱动。
 *
 * 运行时信息(上下文预算 / journal / people)的权威在宿主——经注入的
 * controller / management 取;模型显示来自本地配置(宿主按同一配置装配)。
 */

import { describe, it, expect, vi } from "vitest";
import {
  CommandDispatcher,
  DefaultCommandRegistry,
  type RuntimeContext,
} from "@zhixing/core";
import { registerInfoCommands } from "../info-commands.js";
import { stripAnsi } from "../../tui/index.js";
import type { CliWriter } from "../../screen/index.js";
import type { ConversationController } from "../../runtime/conversation-controller.js";
import type { RpcManagementFacade } from "../../runtime/rpc-management-facade.js";
import type { ZhixingConfig } from "@zhixing/providers";
import type { SelectionService } from "../../tui/selection/index.js";

const RUNTIME: RuntimeContext = {
  sessionBusy: false,
  workspaceId: null,
  cwd: ".",
  target: "cli",
  features: {},
  now: 0,
};

function makeWriter(): CliWriter & { text: () => string } {
  const lines: string[] = [];
  return {
    line: (t: string) => lines.push(t),
    text: () => lines.join("\n"),
  } as unknown as CliWriter & { text: () => string };
}

function setup(options: { selection?: SelectionService; requestExit?: () => void } = {}) {
  const registry = new DefaultCommandRegistry();
  const dispatcher = new CommandDispatcher({ registry });
  const writer = makeWriter();
  let config = {
    llm: { main: { provider: "anthropic", model: "claude-x" } },
  } as unknown as ZhixingConfig;
  const contextBudget = vi.fn(async () => ({
    budget: {
      contextWindow: 200_000,
      effectiveWindow: 180_000,
      currentTokens: 1_000,
      usageRatio: 0.01,
      status: "normal" as const,
    },
    turnCount: 3,
    calibrationFactor: 1,
  }));
  const usage = vi.fn(async () => ({
    budget: {
      contextWindow: 200_000,
      effectiveWindow: 180_000,
      currentTokens: 1_000,
      usageRatio: 0.01,
      status: "normal" as const,
    },
    turnCount: 3,
    calibrationFactor: 1,
    subUsages: [
      {
        index: 1,
        description: "调研模块结构",
        tokens: 12_000,
        toolUses: 2,
        durationMs: 3000,
        subId: "abc123",
        status: "succeeded" as const,
      },
    ],
  }));
  const controller = {
    current: {
      conversationId: "conv-1",
      name: "当前对话",
      mode: { kind: "main" as const },
    },
    contextBudget,
    usage,
  } as unknown as ConversationController;
  const management = {
    serverInfo: vi.fn(async () => ({
      pid: 123,
      port: 19869,
      connectionCount: 1,
      channels: [],
      activeWork: {
        count: 0,
        cancellableCount: 0,
        drainOnlyCount: 0,
        cancellableWork: [],
        drainOnlyWork: [],
      },
      deferredWork: [],
      keepAliveWork: [],
    })),
    serverShutdown: vi.fn(async () => {}),
    journalStats: vi.fn(async () => ({
      stats: { totalFiles: 2, hotCount: 1, warmCount: 1, condensedCount: 0 },
      condense: null,
      expiredCount: 0,
    })),
    peopleList: vi.fn(async () => []),
  } as unknown as RpcManagementFacade;

  registerInfoCommands({
    registry,
    dispatcher,
    writer,
    getConfig: () => config,
    controller,
    getNetworkProxy: () => ({ mode: "off", resolved: null, display: "off" }) as never,
    getScheduler: () => ({ list: async () => [] }) as never,
    management,
    selection: options.selection,
    requestExit: options.requestExit,
  });
  return {
    registry,
    dispatcher,
    writer,
    contextBudget,
    usage,
    management,
    setConfig: (next: ZhixingConfig) => {
      config = next;
    },
  };
}

describe("registerInfoCommands", () => {
  it("10 条命令注册为 local，可经 findByName 找到", () => {
    const { registry } = setup();
    for (const name of [
      "help",
      "status",
      "stop",
      "me",
      "model",
      "usage",
      "context",
      "journal",
      "people",
      "tasks",
    ]) {
      expect(registry.findByName(name)?.execution).toBe("local");
    }
  });

  it("/status 显示会话名 / 模型(本地配置)/ 代理", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/status", RUNTIME);
    const text = stripAnsi(h.writer.text());
    expect(text).toContain("当前对话");
    expect(text).toContain("claude-x");
    expect(text).toContain("anthropic");
    expect(text).toContain("接入面");
    expect(text).toContain("/stop");
  });

  it("/status 显示宿主通道状态", async () => {
    const h = setup();
    (h.management.serverInfo as any).mockResolvedValueOnce({
      channels: [{ channelId: "feishu", state: "connecting" }],
      activeWork: {
        count: 0,
        cancellableCount: 0,
        drainOnlyCount: 0,
        cancellableWork: [],
        drainOnlyWork: [],
      },
      deferredWork: [],
      keepAliveWork: [],
    } as never);

    await h.dispatcher.dispatch("/status", RUNTIME);

    const text = stripAnsi(h.writer.text());
    expect(text).toContain("通道");
    expect(text).toContain("feishu: 连接中");
  });

  it("/stop 经选择服务发出停止请求", async () => {
    const choose = vi.fn(async () => ({ kind: "selected", value: "stop" as const }));
    const requestExit = vi.fn();
    const h = setup({
      selection: { choose } as unknown as SelectionService,
      requestExit,
    });

    await h.dispatcher.dispatch("/stop", RUNTIME);

    expect(choose).toHaveBeenCalledOnce();
    expect(h.management.serverShutdown).toHaveBeenCalledWith({
      reason: "user-stop",
      strategy: "immediate",
      timeoutMs: 30_000,
    });
    expect(requestExit).toHaveBeenCalledOnce();
  });

  it("/stop 有运行中工作时默认等待完成", async () => {
    const choose = vi.fn(async () => ({ kind: "selected", value: "wait" as const }));
    const h = setup({ selection: { choose } as unknown as SelectionService });
    (h.management.serverInfo as any).mockResolvedValueOnce({
      activeWork: {
        count: 1,
        cancellableCount: 1,
        drainOnlyCount: 0,
        cancellableWork: [{ id: "conversation:1", label: "conv-1", count: 1 }],
        drainOnlyWork: [],
      },
      deferredWork: [],
      keepAliveWork: [],
      accessSurfaces: { otherRpcConnections: 0, liveChannels: [] },
    });

    await h.dispatcher.dispatch("/stop", RUNTIME);

    expect(choose).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "wait" }),
    );
    expect(h.management.serverShutdown).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "drain" }),
    );
  });

  it("/model 显示本地配置的模型与 provider", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/model", RUNTIME);
    const text = stripAnsi(h.writer.text());
    expect(text).toContain("claude-x");
  });

  it("/model 在执行时读取最新配置快照", async () => {
    const h = setup();
    h.setConfig({
      llm: { main: { provider: "openai", model: "gpt-next" } },
    } as unknown as ZhixingConfig);

    await h.dispatcher.dispatch("/model", RUNTIME);

    const text = stripAnsi(h.writer.text());
    expect(text).toContain("gpt-next");
    expect(text).toContain("openai");
    expect(text).not.toContain("claude-x");
  });

  it("/journal 经管理面 RPC 渲染扫描投影", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/journal", RUNTIME);
    expect(h.management.journalStats).toHaveBeenCalledOnce();
    const text = stripAnsi(h.writer.text());
    expect(text).toContain("日志状态");
    expect(text).toContain("(2 文件)");
  });

  it("/people 经管理面 RPC;空网络友好提示", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/people", RUNTIME);
    expect(h.management.peopleList).toHaveBeenCalledOnce();
    expect(stripAnsi(h.writer.text())).toContain("关系网络为空");
  });

  it("/context 经宿主上下文预算渲染;失败可观测", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/context", RUNTIME);
    expect(h.contextBudget).toHaveBeenCalledOnce();
    expect(h.usage).not.toHaveBeenCalled();

    h.contextBudget.mockRejectedValueOnce(new Error("宿主不可用"));
    await h.dispatcher.dispatch("/context", RUNTIME);
    expect(stripAnsi(h.writer.text())).toContain("上下文信息不可用");
  });

  it("/usage 经宿主完整用量视图渲染子 agent 拆分", async () => {
    const h = setup();

    await h.dispatcher.dispatch("/usage", RUNTIME);

    expect(h.usage).toHaveBeenCalledOnce();
    expect(h.contextBudget).not.toHaveBeenCalled();
    const text = stripAnsi(h.writer.text());
    expect(text).toContain("Token 用量");
    expect(text).toContain("子 agent 拆分");
    expect(text).toContain("Task#1");
    expect(text).toContain("调研模块结构");
  });
});
