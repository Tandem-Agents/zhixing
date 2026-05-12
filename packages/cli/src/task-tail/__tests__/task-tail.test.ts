/**
 * TaskTail 集成测试 —— 验证订阅 service + 投递 setStatusTail 的端到端契约。
 *
 * 用真实 TaskListService + stub TaskListStore + spy ScreenController.setStatusTail，
 * 避免 mock service 让契约与 production 实现脱节。
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { TaskListState } from "@zhixing/core";
import { TaskListService, type TaskListStore } from "@zhixing/tools-builtin";
import { TaskTail } from "../task-tail.js";
import { stripAnsi } from "../../tui/index.js";

function makeStubStore(): TaskListStore & {
  data: Map<string, TaskListState>;
} {
  const data = new Map<string, TaskListState>();
  return {
    data,
    async load(id) {
      return data.get(id);
    },
    async save(id, state) {
      data.set(id, state);
    },
    async delete(id) {
      data.delete(id);
    },
  };
}

/**
 * 仅捕获 setStatusTail 调用的最小 ScreenController stub。
 * 其他 API 不实现（TaskTail 不应调用）—— 调到则测试自然挂。
 *
 * 协议适配：ScreenController.setStatusTail 是 (id, text) 多段协议；TaskTail
 * 必然用 id="task" 调用，本 spy 只记 text 简化断言（id 偏离会单独断言）。
 */
function makeScreenSpy(): {
  setStatusTail: (id: string, text: string | null) => void;
  calls: (string | null)[];
  idCalls: string[];
} {
  const calls: (string | null)[] = [];
  const idCalls: string[] = [];
  return {
    calls,
    idCalls,
    setStatusTail(id: string, text: string | null) {
      idCalls.push(id);
      calls.push(text);
    },
  };
}

describe("TaskTail · 订阅 → setStatusTail 投递", () => {
  it("start 自动 refresh：service 已有数据时立即显示 tail", async () => {
    const store = makeStubStore();
    const service = new TaskListService(store);
    const screen = makeScreenSpy();
    await service.set("conv-1", [
      { id: "a", content: "实现 X", status: "in_progress" },
    ]);

    const tail = new TaskTail({
      screen: screen as never,
      service,
      getConversationId: () => "conv-1",
    });
    tail.start();

    const lastTail = screen.calls[screen.calls.length - 1];
    expect(lastTail).not.toBeNull();
    expect(stripAnsi(lastTail!)).toContain("实现 X");
  });

  it("service.set 触发 emit → tail 更新", async () => {
    const store = makeStubStore();
    const service = new TaskListService(store);
    const screen = makeScreenSpy();

    const tail = new TaskTail({
      screen: screen as never,
      service,
      getConversationId: () => "conv-1",
    });
    tail.start();
    screen.calls.length = 0; // 清启动时的 refresh 调用

    await service.set("conv-1", [
      { id: "a", content: "new task", status: "in_progress" },
    ]);

    expect(screen.calls).toHaveLength(1);
    expect(stripAnsi(screen.calls[0]!)).toContain("new task");
  });

  it("service.clear 触发 emit(null) → tail 隐藏", async () => {
    const store = makeStubStore();
    const service = new TaskListService(store);
    const screen = makeScreenSpy();
    await service.set("conv-1", [
      { id: "a", content: "X", status: "in_progress" },
    ]);

    const tail = new TaskTail({
      screen: screen as never,
      service,
      getConversationId: () => "conv-1",
    });
    tail.start();
    screen.calls.length = 0;

    service.clear("conv-1");

    expect(screen.calls).toEqual([null]);
  });

  it("跨 conversation 隔离：其他 convId 的 emit 不影响当前 tail", async () => {
    const store = makeStubStore();
    const service = new TaskListService(store);
    const screen = makeScreenSpy();

    const tail = new TaskTail({
      screen: screen as never,
      service,
      getConversationId: () => "conv-A",
    });
    tail.start();
    screen.calls.length = 0;

    // 写入另一个 conversation —— 不应触发 setStatusTail
    await service.set("conv-B", [
      { id: "b", content: "B 任务", status: "in_progress" },
    ]);

    expect(screen.calls).toEqual([]);
  });

  it("conversation 切换后 refresh：读新 conv 的 cache 显示新 tail", async () => {
    const store = makeStubStore();
    const service = new TaskListService(store);
    await service.set("conv-A", [
      { id: "a", content: "A 任务", status: "in_progress" },
    ]);
    await service.set("conv-B", [
      { id: "b", content: "B 任务", status: "in_progress" },
    ]);

    let currentConv = "conv-A";
    const screen = makeScreenSpy();
    const tail = new TaskTail({
      screen: screen as never,
      service,
      getConversationId: () => currentConv,
    });
    tail.start();
    expect(stripAnsi(screen.calls[screen.calls.length - 1]!)).toContain(
      "A 任务",
    );

    // 模拟 /switch
    currentConv = "conv-B";
    tail.refresh();

    expect(stripAnsi(screen.calls[screen.calls.length - 1]!)).toContain(
      "B 任务",
    );
  });

  it("refresh 在 conversationId 缺失时隐藏 tail", () => {
    const service = new TaskListService(makeStubStore());
    const screen = makeScreenSpy();

    const tail = new TaskTail({
      screen: screen as never,
      service,
      getConversationId: () => null,
    });
    tail.start();

    expect(screen.calls[screen.calls.length - 1]).toBeNull();
  });

  it("dispose 取消订阅 + 清空 tail", async () => {
    const store = makeStubStore();
    const service = new TaskListService(store);
    const screen = makeScreenSpy();
    const tail = new TaskTail({
      screen: screen as never,
      service,
      getConversationId: () => "conv-1",
    });
    tail.start();
    screen.calls.length = 0;

    tail.dispose();
    expect(screen.calls).toEqual([null]); // dispose 时调一次 setStatusTail(null)
    screen.calls.length = 0;

    // dispose 后 service 再写入：subscribe 已退订，不应触发
    await service.set("conv-1", [
      { id: "a", content: "x", status: "in_progress" },
    ]);
    expect(screen.calls).toEqual([]);
  });

  it("start 后重复 start 幂等（不重复订阅）", async () => {
    const store = makeStubStore();
    const service = new TaskListService(store);
    const screen = makeScreenSpy();
    const tail = new TaskTail({
      screen: screen as never,
      service,
      getConversationId: () => "conv-1",
    });
    tail.start();
    tail.start();
    tail.start();
    screen.calls.length = 0;

    await service.set("conv-1", [
      { id: "a", content: "X", status: "in_progress" },
    ]);

    // 仅一次 emit 触发 —— 不应有重复 setStatusTail 调用
    expect(screen.calls).toHaveLength(1);
  });

  it("dispose 后 start 抛错（防误用）", () => {
    const service = new TaskListService(makeStubStore());
    const screen = makeScreenSpy();
    const tail = new TaskTail({
      screen: screen as never,
      service,
      getConversationId: () => "conv-1",
    });
    tail.dispose();
    expect(() => tail.start()).toThrow("after dispose");
  });

  it("dispose 后 refresh 无 op（防御）", () => {
    const service = new TaskListService(makeStubStore());
    const screen = makeScreenSpy();
    const tail = new TaskTail({
      screen: screen as never,
      service,
      getConversationId: () => "conv-1",
    });
    tail.dispose();
    screen.calls.length = 0;
    tail.refresh();
    expect(screen.calls).toEqual([]);
  });

  it("dispose 幂等：重复调用不抛错", () => {
    const service = new TaskListService(makeStubStore());
    const screen = makeScreenSpy();
    const tail = new TaskTail({
      screen: screen as never,
      service,
      getConversationId: () => "conv-1",
    });
    expect(() => {
      tail.dispose();
      tail.dispose();
      tail.dispose();
    }).not.toThrow();
  });
});

describe("TaskTail · 一次性 / ephemeral 路径降级", () => {
  beforeEach(() => {
    // 单独的 beforeEach 让用例隔离干净
  });

  it("getConversationId 总返 undefined → tail 始终隐藏", async () => {
    const store = makeStubStore();
    const service = new TaskListService(store);
    const screen = makeScreenSpy();
    const tail = new TaskTail({
      screen: screen as never,
      service,
      getConversationId: () => undefined,
    });
    tail.start();
    expect(screen.calls).toEqual([null]); // start 内 refresh 调一次

    // 即使其他 conversation 有 emit，TaskTail 不响应（convId 不匹配）
    await service.set("conv-1", [
      { id: "a", content: "x", status: "in_progress" },
    ]);
    expect(screen.calls).toEqual([null]);
  });
});
