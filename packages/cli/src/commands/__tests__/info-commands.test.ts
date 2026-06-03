/**
 * registerInfoCommands 测试 —— 通过真实 DefaultCommandRegistry + CommandDispatcher
 * 驱动命令，断言注册形态 + deps getter 接线 + writer 输出。
 *
 * 覆盖不依赖真实文件系统的命令（help/model/status/tasks）；me/journal/people 走真实
 * Store I/O，其 handler 体是 repl 迁移过来的逐字拷贝，由 tsc + 形态一致性保证。
 */

import { describe, it, expect } from "vitest";
import {
  CommandDispatcher,
  DefaultCommandRegistry,
  type CommandDef,
  type Message,
  type RuntimeContext,
} from "@zhixing/core";
import {
  registerInfoCommands,
  type InfoCommandsDeps,
} from "../info-commands.js";
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

function setup(overrides: Partial<InfoCommandsDeps> = {}) {
  const registry = new DefaultCommandRegistry();
  const dispatcher = new CommandDispatcher({ registry });
  const writer = makeWriter();
  const deps: InfoCommandsDeps = {
    registry,
    dispatcher,
    writer,
    getRuntime: () =>
      ({
        model: "deepseek-v4",
        providerId: "deepseek",
        calibrationFactor: 1,
      }) as unknown as ReturnType<InfoCommandsDeps["getRuntime"]>,
    getMessages: () => [],
    getConversationId: () => "conv-1",
    getTurnCounter: () => 0,
    getNetworkProxy: () =>
      ({ resolved: null, mode: "auto", display: "直连" }) as unknown as ReturnType<
        InfoCommandsDeps["getNetworkProxy"]
      >,
    getScheduler: () => null,
    ...overrides,
  };
  registerInfoCommands(deps);
  return { registry, dispatcher, writer };
}

function visible(writer: { lines: string[] }): string {
  return writer.lines.map(stripAnsi).join("\n");
}

describe("registerInfoCommands · 注册", () => {
  it("9 条命令注册为 local，可经 findByName 找到", () => {
    const { registry } = setup();
    for (const name of [
      "help",
      "status",
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

  it("journal/people/tasks 的 category 沿用 tools，其余 info", () => {
    const { registry } = setup();
    expect(registry.findByName("journal")?.category).toBe("tools");
    expect(registry.findByName("people")?.category).toBe("tools");
    expect(registry.findByName("tasks")?.category).toBe("tools");
    expect(registry.findByName("status")?.category).toBe("info");
  });
});

describe("registerInfoCommands · /help", () => {
  it("从 registry 派生命令地图（含自身与同库其他命令）", async () => {
    const { registry, dispatcher, writer } = setup();
    // 额外注册一条 session 命令，验证 /help 按分类列出
    registry.register({
      id: "new:repl",
      name: "new",
      description: "创建新对话",
      category: "session",
      execution: "local",
    } satisfies CommandDef);

    await dispatcher.dispatch("/help", RUNTIME);
    const out = visible(writer);
    expect(out).toContain("可用命令");
    expect(out).toContain("/help");
    expect(out).toContain("/new");
  });
});

describe("registerInfoCommands · /model", () => {
  it("读 getRuntime / getTurnCounter 输出模型信息", async () => {
    const { dispatcher, writer } = setup({ getTurnCounter: () => 7 });
    await dispatcher.dispatch("/model", RUNTIME);
    const out = visible(writer);
    expect(out).toContain("deepseek-v4");
    expect(out).toContain("deepseek");
    expect(out).toContain("7");
  });
});

describe("registerInfoCommands · /status", () => {
  it("聚合消息计数 / 会话 id / 模型 / 代理", async () => {
    const messages: Message[] = [
      { role: "user", content: "hi" } as Message,
      { role: "assistant", content: "yo" } as Message,
    ];
    const { dispatcher, writer } = setup({ getMessages: () => messages });
    await dispatcher.dispatch("/status", RUNTIME);
    const out = visible(writer);
    expect(out).toContain("conv-1");
    expect(out).toContain("1 user, 1 assistant");
    expect(out).toContain("deepseek-v4");
  });
});

describe("registerInfoCommands · /tasks", () => {
  it("调度器未初始化 → 提示", async () => {
    const { dispatcher, writer } = setup({ getScheduler: () => null });
    await dispatcher.dispatch("/tasks", RUNTIME);
    expect(visible(writer)).toContain("调度器未初始化");
  });

  it("无任务 → 友好提示", async () => {
    const scheduler = {
      listTasks: () => [],
      activeTaskCount: 0,
    } as never;
    const { dispatcher, writer } = setup({ getScheduler: () => scheduler });
    await dispatcher.dispatch("/tasks", RUNTIME);
    expect(visible(writer)).toContain("没有定时任务");
  });
});
