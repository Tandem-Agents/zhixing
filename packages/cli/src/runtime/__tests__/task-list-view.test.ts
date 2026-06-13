/**
 * TaskListViewCache 测试 —— 接入面 task_list 只读视图缓存。
 *
 * 锁住:
 *   - apply 写入当前 conversation 的最新快照并通知订阅者
 *   - null 表示宿主已清空,读缓存返回 null
 *   - listener 异常隔离,unsubscribe 后不再收到后续推送
 */

import { describe, expect, it, vi } from "vitest";
import { TaskListViewCache } from "../task-list-view.js";

describe("TaskListViewCache", () => {
  it("apply 写缓存并通知订阅者", () => {
    const cache = new TaskListViewCache();
    const listener = vi.fn();
    cache.subscribe(listener);

    const state = {
      items: [{ id: "t1", content: "写周报", status: "pending" as const }],
    };
    cache.apply("conv-1", state);

    expect(cache.getCached("conv-1")).toBe(state);
    expect(listener).toHaveBeenCalledWith({ conversationId: "conv-1", state });
  });

  it("null 快照表示清空,listener 异常不影响其他订阅者", () => {
    const cache = new TaskListViewCache();
    cache.apply("conv-1", {
      items: [{ id: "t1", content: "写周报", status: "pending" as const }],
    });
    const throwing = vi.fn(() => {
      throw new Error("render failed");
    });
    const healthy = vi.fn();
    cache.subscribe(throwing);
    cache.subscribe(healthy);

    cache.apply("conv-1", null);

    expect(cache.getCached("conv-1")).toBeNull();
    expect(throwing).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledWith({
      conversationId: "conv-1",
      state: null,
    });
  });

  it("unsubscribe 后释放 listener", () => {
    const cache = new TaskListViewCache();
    const listener = vi.fn();
    const unsubscribe = cache.subscribe(listener);

    unsubscribe();
    cache.apply("conv-1", { items: [] });

    expect(listener).not.toHaveBeenCalled();
  });
});
