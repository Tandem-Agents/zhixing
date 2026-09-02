/**
 * registerInfoCommands 测试 —— 真实 registry + dispatcher 驱动。
 *
 * 运行时信息（上下文预算 / 会话 / 调度）的权威在宿主——经注入的
 * controller / management 获取；模型显示来自本地配置（宿主按同一配置装配）。
 */

import { describe, it, expect, vi } from "vitest";
import {
  CommandDispatcher,
  DefaultCommandRegistry,
  type RuntimeContext,
  type SchedulerFacade,
  type TaskView,
} from "@zhixing/core";
import { registerInfoCommands } from "../info-commands.js";
import { stripAnsi } from "../../tui/index.js";
import type { CliWriter } from "../../screen/index.js";
import type { ConversationController } from "../../runtime/conversation-controller.js";
import type { RpcManagementFacade } from "../../runtime/rpc-management-facade.js";
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

function setup(options: {
  selection?: SelectionService;
  requestExit?: () => void;
  schedulerTasks?: readonly TaskView[];
} = {}) {
  const registry = new DefaultCommandRegistry();
  const dispatcher = new CommandDispatcher({ registry });
  const writer = makeWriter();
  let primaryModel = { providerId: "anthropic", model: "claude-x" };
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
  } as unknown as RpcManagementFacade;
  const schedulerList = vi.fn(async () => options.schedulerTasks ?? []);

  registerInfoCommands({
    registry,
    dispatcher,
    writer,
    getPrimaryModel: () => primaryModel,
    controller,
    getNetworkProxy: () => ({
      mode: "off",
      hasResolvedProxy: false,
      display: "off",
    }),
    getScheduler: () => ({ list: schedulerList }) as unknown as SchedulerFacade,
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
    schedulerList,
    setConfig: (next: { readonly providerId: string; readonly model: string }) => {
      primaryModel = next;
    },
  };
}

describe("registerInfoCommands", () => {
  it("7 条存活命令构成 local exact-set", () => {
    const { registry } = setup();
    const names = [
      "help",
      "status",
      "stop",
      "model",
      "usage",
      "context",
      "tasks",
    ];
    expect(registry.list(RUNTIME).map((command) => command.name).sort())
      .toEqual([...names].sort());
    for (const name of names) {
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

  it("/status 用用户语言显示恢复备份状态和下一动作", async () => {
    const h = setup();
    (h.management.serverInfo as any).mockResolvedValueOnce({
      recoveryBackup: { state: "pending-verification" },
    } as never);

    await h.dispatcher.dispatch("/status", RUNTIME);

    const text = stripAnsi(h.writer.text());
    expect(text).toContain("恢复备份: 待验证");
    expect(text).toContain("zz backup verify");
    expect(text).not.toMatch(/root|LSN|digest/iu);
  });

  it.each([
    ["repair-backup-configuration", "配置需要修复", "zz backup setup"],
    ["restore-backup-connection", "连接暂不可用", "恢复连接后重试"],
    ["check-backup-target", "目标暂不可用", "检查备份目标后重试"],
  ] as const)("/status 为不可用原因呈现唯一产品行动 %s", async (
    nextAction,
    stateText,
    actionText,
  ) => {
    const h = setup();
    (h.management.serverInfo as any).mockResolvedValueOnce({
      recoveryBackup: { state: "unavailable", fullBackupReady: false, nextAction },
    } as never);

    await h.dispatcher.dispatch("/status", RUNTIME);

    const text = stripAnsi(h.writer.text());
    expect(text).toContain(`恢复备份: ${stateText}`);
    expect(text).toContain(actionText);
    expect(text).not.toMatch(/mesh|runtime|anchor|executor/iu);
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
    h.setConfig({ providerId: "openai", model: "gpt-next" });

    await h.dispatcher.dispatch("/model", RUNTIME);

    const text = stripAnsi(h.writer.text());
    expect(text).toContain("gpt-next");
    expect(text).toContain("openai");
    expect(text).not.toContain("claude-x");
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

  it("/usage 经宿主完整用量视图渲染子任务拆分", async () => {
    const h = setup();

    await h.dispatcher.dispatch("/usage", RUNTIME);

    expect(h.usage).toHaveBeenCalledOnce();
    expect(h.contextBudget).not.toHaveBeenCalled();
    const text = stripAnsi(h.writer.text());
    expect(text).toContain("Token 用量");
    expect(text).toContain("子任务拆分");
    expect(text).toContain("#1");
    expect(text).toContain("调研模块结构");
  });

  it("/tasks 直接展示领域应用已裁决的集合，不重复解释 system 标记", async () => {
    const h = setup({
      schedulerTasks: [{
        id: "domain-visible",
        taskRevision: 1,
        name: "领域已裁决任务",
        enabled: true,
        priority: "normal",
        schedule: { kind: "once", at: "2026-08-31T08:00:00.000Z" },
        action: { kind: "agent-turn", prompt: "提醒" },
        system: true,
        state: { consecutiveErrors: 0, runCount: 0 },
        createdAt: "2026-08-30T08:00:00.000Z",
        updatedAt: "2026-08-30T08:00:00.000Z",
      }],
    });

    await h.dispatcher.dispatch("/tasks", RUNTIME);

    expect(h.schedulerList).toHaveBeenCalledOnce();
    const text = stripAnsi(h.writer.text());
    expect(text).toContain("领域已裁决任务");
    expect(text).toContain("domain-visible");
    expect(text).not.toContain("没有定时任务");
  });
});
