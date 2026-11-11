import { describe, expect, it, vi } from "vitest";
import { advancementProposalExecutionInput, type AdvancementSession } from "@zhixing-ai/core/advancement";
import type { LifecycleBeforeRunContext } from "@zhixing-ai/orchestrator/runtime";
import { createAdvancementAcceptanceLifecycle } from "../advancement-acceptance-lifecycle.js";

function activeSession(id = "session-1", criterion = "测试通过"): AdvancementSession {
  return {
    id,
    conversationId: "conv-1",
    status: "active",
    originalUserTask: { parts: [{ type: "text", text: "把测试修到全绿" }] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    rubricDraftVersion: 1,
    confirmedRubric: {
      source: {
        kind: "library",
        rubricId: "rubric-1",
        rubricVersion: "v1",
      },
      title: "代码任务验收",
      description: "判断代码任务是否完成",
      content: {
        passCriteria: [
          { id: "pc-1", text: criterion },
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
  identity: Partial<Pick<LifecycleBeforeRunContext, "turnId" | "turnOrigin" | "messages">> = {},
): LifecycleBeforeRunContext & { injected: Array<unknown>; warnings: string[] } {
  const injected: Array<unknown> = [];
  const warnings: string[] = [];
  return {
    runtimeId: "rt-1",
    mode: "main",
    providerId: "mock",
    model: "mock-model",
    conversationId,
    turnIndex: 0,
    isWindowFirstRun: true,
    messages: [],
    ...identity,
    reportLifecycleWarning: async (event) => {
      warnings.push(event.message);
    },
    injectUserContext: (content) => {
      injected.push(content);
    },
    injected,
    warnings,
  } as never;
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

  it.each([
    ["确认执行 A", { sessionId: "session-a", mode: "advancement" as const, draftId: "draft-1" }],
    ["降级执行 A（此时 active 是 B）", { sessionId: "session-a", mode: "direct" as const }],
  ])("带执行标记的运行（%s）不注入任何内容、不查会话：原任务与契约由宿主裁决的指派材料给出", async (_label, marker) => {
    const advancement = {
      loadActiveSession: vi.fn(async () => activeSession("session-b", "CRITERION_B")),
    };
    const lifecycle = createAdvancementAcceptanceLifecycle(advancement as never);
    const ctx = beforeRunContext("conv-1", {
      turnId: marker.mode === "advancement" ? "turn-1:advancement:draft-1" : "turn-1:direct",
      turnOrigin: { channel: "rpc", triggeredBy: "rpc:test", advancementExecution: marker },
    });

    await lifecycle.onBeforeRun?.(ctx);

    expect(ctx.injected).toEqual([]);
    expect(ctx.warnings).toEqual([]);
    expect(advancement.loadActiveSession).not.toHaveBeenCalled();
  });

  it("普通运行即使复制了推进控制消息的文字，也只注入验收条件、没有原任务", async () => {
    const advancement = {
      loadActiveSession: vi.fn(async () => activeSession()),
    };
    const lifecycle = createAdvancementAcceptanceLifecycle(advancement as never);
    const ctx = beforeRunContext("conv-1", {
      messages: [{ role: "user", content: advancementProposalExecutionInput("advancement").parts }] as never,
    });

    await lifecycle.onBeforeRun?.(ctx);

    expect(ctx.injected).toHaveLength(1);
    expect(ctx.injected[0]).toContain("验收条件");
    expect(JSON.stringify(ctx.injected)).not.toContain("推进中的原任务");
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
