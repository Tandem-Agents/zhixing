import { describe, expect, it, vi } from "vitest";
import type { AdvancementSession } from "@zhixing/core";
import type { LifecycleBeforeRunContext } from "@zhixing/orchestrator/runtime";
import { createAdvancementAcceptanceLifecycle } from "../advancement-acceptance-lifecycle.js";

function activeSession(): AdvancementSession {
  return {
    id: "session-1",
    conversationId: "conv-1",
    status: "active",
    originalUserTask: { parts: [{ type: "text", text: "把测试修到全绿" }] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    rubricDraftVersion: 1,
    confirmedRubric: {
      rubricId: "rubric-1",
      rubricVersion: "v1",
      title: "代码任务验收",
      description: "判断代码任务是否完成",
      content: {
        passCriteria: [
          { id: "pc-1", text: "测试通过" },
          { id: "pc-2", text: "实现满足需求" },
        ],
        evidenceRequirements: [
          {
            id: "tests",
            kind: "test-result",
            description: "相关测试必须通过",
            required: true,
          },
        ],
        failureHandling: [
          { id: "fix", scenario: "测试失败", reply: "请修复失败测试。" },
        ],
      },
      confirmedAt: "2026-01-01T00:01:00.000Z",
      confirmedBy: "user",
    },
    runs: [],
    proxyMessages: [],
  };
}

function beforeRunContext(
  conversationId: string | undefined,
): LifecycleBeforeRunContext & { injected: Array<string | null> } {
  const injected: Array<string | null> = [];
  return {
    runtimeId: "rt-1",
    mode: "main",
    providerId: "mock",
    model: "mock-model",
    conversationId,
    turnIndex: 0,
    isWindowFirstRun: true,
    messages: [],
    injectUserContext: (content) => {
      injected.push(content);
    },
    injected,
  };
}

describe("createAdvancementAcceptanceLifecycle", () => {
  it("active 推进会话把契约验收条件注入当前 run", async () => {
    const advancement = {
      loadActiveSession: vi.fn(async () => activeSession()),
    };
    const lifecycle = createAdvancementAcceptanceLifecycle(
      advancement as never,
    );
    const ctx = beforeRunContext("conv-1");

    await lifecycle.onBeforeRun?.(ctx);

    expect(advancement.loadActiveSession).toHaveBeenCalledWith("conv-1");
    expect(ctx.injected).toHaveLength(1);
    expect(ctx.injected[0]).toContain("验收条件");
    expect(ctx.injected[0]).toContain("- 测试通过");
    expect(ctx.injected[0]).toContain("- 相关测试必须通过");
    expect(ctx.injected[0]).not.toContain("请修复失败测试。");
  });

  it("无 active 推进会话时不注入", async () => {
    const advancement = {
      loadActiveSession: vi.fn(async () => null),
    };
    const lifecycle = createAdvancementAcceptanceLifecycle(
      advancement as never,
    );
    const ctx = beforeRunContext("conv-1");

    await lifecycle.onBeforeRun?.(ctx);

    expect(ctx.injected).toEqual([]);
  });

  it("awaiting 阶段（未确认）不注入", async () => {
    const advancement = {
      loadActiveSession: vi.fn(async () => ({
        ...activeSession(),
        status: "awaiting-rubric-confirmation" as const,
        confirmedRubric: undefined,
      })),
    };
    const lifecycle = createAdvancementAcceptanceLifecycle(
      advancement as never,
    );
    const ctx = beforeRunContext("conv-1");

    await lifecycle.onBeforeRun?.(ctx);

    expect(ctx.injected).toEqual([]);
  });

  it("无会话身份的 run（ephemeral）直接跳过、不查推进状态", async () => {
    const advancement = {
      loadActiveSession: vi.fn(async () => activeSession()),
    };
    const lifecycle = createAdvancementAcceptanceLifecycle(
      advancement as never,
    );
    const ctx = beforeRunContext(undefined);

    await lifecycle.onBeforeRun?.(ctx);

    expect(advancement.loadActiveSession).not.toHaveBeenCalled();
    expect(ctx.injected).toEqual([]);
  });
});
