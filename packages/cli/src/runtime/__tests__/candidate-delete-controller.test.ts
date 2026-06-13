import { describe, expect, it, vi } from "vitest";
import type { SuggestionItem } from "@zhixing/core";
import { stripAnsi } from "../../tui/index.js";
import { createCandidateDeleteHandler } from "../candidate-delete-controller.js";

function item(commandId: string, argValue: string | undefined): SuggestionItem {
  return {
    id: `${commandId}:${argValue ?? "none"}`,
    providerId: "test",
    displayText: argValue ?? "",
    acceptPayload: {
      replacement: "",
      execute: false,
      metadata: { commandId, argValue },
    },
  };
}

function setup() {
  const lines: string[] = [];
  const cleanupCallbacks: Array<() => void> = [];
  const locallyDeletingConversations = new Set<string>();
  const controller = {
    current: {
      conversationId: "conv-current",
      name: "当前对话",
      mode: { kind: "main" as const },
    },
    deleteConversation: vi.fn(async () => {}),
    newConversation: vi.fn(async () => ({
      conversationId: "conv-new",
      name: "新对话",
      mode: { kind: "main" as const },
    })),
  };
  const workscene = { delete: vi.fn(async () => {}) };
  const management = { trustRevoke: vi.fn(async () => true) };
  const syncCurrentTaskListView = vi.fn(async () => {});
  const handler = createCandidateDeleteHandler({
    controller,
    workscene,
    management,
    writer: { line: (text: string) => lines.push(text) },
    locallyDeletingConversations,
    syncCurrentTaskListView,
    scheduleCleanup: (callback) => {
      cleanupCallbacks.push(callback);
      return {};
    },
  });

  return {
    handler,
    lines,
    controller,
    workscene,
    management,
    syncCurrentTaskListView,
    locallyDeletingConversations,
    cleanupCallbacks,
  };
}

describe("createCandidateDeleteHandler", () => {
  it("空 argValue 不执行任何宿主动作", async () => {
    const h = setup();
    await h.handler(item("resume:repl", undefined));

    expect(h.controller.deleteConversation).not.toHaveBeenCalled();
    expect(h.workscene.delete).not.toHaveBeenCalled();
    expect(h.management.trustRevoke).not.toHaveBeenCalled();
  });

  it("/work 候选删除只调用工作场景删除执行体", async () => {
    const h = setup();
    await h.handler(item("work:repl", "scene-1"));

    expect(h.workscene.delete).toHaveBeenCalledWith("scene-1");
    expect(h.controller.deleteConversation).not.toHaveBeenCalled();
  });

  it("/trust 候选删除按当前对话语境撤销规则", async () => {
    const h = setup();
    await h.handler(item("trust:repl", "rule-1"));

    expect(h.management.trustRevoke).toHaveBeenCalledWith(
      "rule-1",
      "conv-current",
    );
    expect(h.controller.deleteConversation).not.toHaveBeenCalled();
  });

  it("删除非当前对话只删目标,不切当前指针", async () => {
    const h = setup();
    await h.handler(item("resume:repl", "conv-other"));

    expect(h.controller.deleteConversation).toHaveBeenCalledWith("conv-other");
    expect(h.controller.newConversation).not.toHaveBeenCalled();
    expect(h.syncCurrentTaskListView).not.toHaveBeenCalled();
    expect(h.locallyDeletingConversations.size).toBe(0);
  });

  it("删除当前对话后新建空对话并同步任务视图,本地 deleted 回声短暂静默", async () => {
    const h = setup();
    await h.handler(item("resume:repl", "conv-current"));

    expect(h.controller.deleteConversation).toHaveBeenCalledWith("conv-current");
    expect(h.controller.newConversation).toHaveBeenCalledOnce();
    expect(h.syncCurrentTaskListView).toHaveBeenCalledOnce();
    expect(h.locallyDeletingConversations.has("conv-current")).toBe(true);

    h.cleanupCallbacks[0]?.();
    expect(h.locallyDeletingConversations.has("conv-current")).toBe(false);
  });

  it("当前对话删除失败会撤销本地静默标记并呈现错误", async () => {
    const h = setup();
    h.controller.deleteConversation.mockRejectedValueOnce(new Error("busy"));

    await h.handler(item("resume:repl", "conv-current"));

    expect(h.controller.newConversation).not.toHaveBeenCalled();
    expect(h.locallyDeletingConversations.has("conv-current")).toBe(false);
    expect(stripAnsi(h.lines.join("\n"))).toContain("删除对话失败: busy");
  });
});
