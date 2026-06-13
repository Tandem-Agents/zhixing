/**
 * registerTaskCommands 测试 —— 读为只读视图缓存、写经宿主执行体(update 回调)。
 *
 * /task new·done 的动作语义(定位 / 状态机 / 反馈文案)在宿主执行体
 * (task-list-actions,随 serve 装配),此处只锁命令层的动作翻译与反馈呈现。
 */

import { describe, expect, it, vi } from "vitest";
import {
  CommandDispatcher,
  DefaultCommandRegistry,
  type RuntimeContext,
  type TaskListState,
} from "@zhixing/core";
import { registerTaskCommands } from "../task-commands.js";
import { stripAnsi } from "../../tui/index.js";

const RUNTIME: RuntimeContext = {
  sessionBusy: false,
  workspaceId: null,
  cwd: ".",
  target: "cli",
  features: {},
  now: 0,
};

function setup(opts?: {
  conversationId?: string | null;
  cached?: TaskListState | null;
}) {
  const registry = new DefaultCommandRegistry();
  const dispatcher = new CommandDispatcher({ registry });
  const lines: string[] = [];
  const update = vi.fn(async () => ({
    ok: true,
    message: '✓ 添加："x"',
    taskList: { items: [{ id: "t1", content: "x", status: "pending" }] },
  }));
  registerTaskCommands({
    registry,
    dispatcher,
    service: { getCached: () => opts?.cached ?? null },
    update,
    getConversationId: () =>
      opts?.conversationId === undefined ? "conv-1" : opts.conversationId,
    writer: { line: (t) => lines.push(t) },
  });
  return { dispatcher, lines, update };
}

describe("registerTaskCommands(执行体经宿主)", () => {
  it("/task new <内容> → add 动作 + 呈现宿主反馈", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/task new 写周报", RUNTIME);
    expect(h.update).toHaveBeenCalledWith("conv-1", {
      kind: "add",
      content: "写周报",
    });
    expect(stripAnsi(h.lines.join("\n"))).toContain("✓ 添加");
  });

  it("/task <内容> shortcut 等同 new;/task done <token> → done 动作", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/task 买牛奶", RUNTIME);
    expect(h.update).toHaveBeenCalledWith("conv-1", {
      kind: "add",
      content: "买牛奶",
    });

    await h.dispatcher.dispatch("/task done 2", RUNTIME);
    expect(h.update).toHaveBeenCalledWith("conv-1", {
      kind: "done",
      token: "2",
    });
  });

  it("空 rest → 用法提示,不触达宿主", async () => {
    const h = setup();
    await h.dispatcher.dispatch("/task", RUNTIME);
    expect(h.update).not.toHaveBeenCalled();
    expect(stripAnsi(h.lines.join("\n"))).toContain("用法");
  });

  it("update 抛错 → friendly error,不抛", async () => {
    const h = setup();
    h.update.mockRejectedValueOnce(new Error("宿主不可用"));
    await h.dispatcher.dispatch("/task new x", RUNTIME);
    expect(stripAnsi(h.lines.join("\n"))).toContain("操作失败");
  });

  it("无 conversationId(ephemeral)→ 友好拒绝", async () => {
    const h = setup({ conversationId: null });
    await h.dispatcher.dispatch("/task new x", RUNTIME);
    expect(h.update).not.toHaveBeenCalled();
    expect(stripAnsi(h.lines.join("\n"))).toContain("仅在持久化对话中工作");
  });

  it("/tasklist 渲染只读视图缓存", async () => {
    const h = setup({
      cached: {
        items: [{ id: "t1", content: "写周报", status: "pending" }],
      } as TaskListState,
    });
    await h.dispatcher.dispatch("/tasklist", RUNTIME);
    expect(stripAnsi(h.lines.join("\n"))).toContain("写周报");
  });
});
