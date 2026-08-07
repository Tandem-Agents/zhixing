import { describe, expect, it } from "vitest";
import type {
  AuthorityCallContext,
  DeferredGlobalIntent,
} from "@zhixing/core/contracts";
import { ConfirmationHub } from "@zhixing/owner-kernel";
import { PostAdoptionReviewCoordinator } from "../post-adoption-review.js";

const CONVERSATION = "local-12345678-01K1ZZZZZZ0000000000000000";

function scheduleIntent(): DeferredGlobalIntent {
  return {
    intentId: "intent-schedule",
    localDomainId: "local:12345678",
    conversationId: CONVERSATION,
    mutation: {
      kind: "schedule-create",
      spec: {
        name: "每日整理",
        enabled: true,
        priority: "normal",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
        action: { kind: "agent-turn", prompt: "整理今天的工作" },
      },
    },
    recordedAt: "2026-08-07T11:00:00.000Z",
    timeSensitive: true,
    status: "pending",
  };
}

function rubricIntent(): DeferredGlobalIntent {
  return {
    intentId: "intent-rubric",
    localDomainId: "local:12345678",
    conversationId: CONVERSATION,
    mutation: {
      kind: "rubric-save-own",
      rubric: {
        title: "交付检查",
        description: "检查交付是否完整",
        content: {
          digest: `sha256:${"1".repeat(64)}`,
          size: 10,
          mediaType: "application/json",
        },
      },
    },
    recordedAt: "2026-08-07T11:00:00.000Z",
    timeSensitive: false,
    status: "pending",
  } as DeferredGlobalIntent;
}

function harness(options: { failSchedule?: boolean } = {}) {
  let now = Date.parse("2026-08-07T11:00:00.000Z");
  const intents = [scheduleIntent(), rubricIntent()];
  const decisions: Array<{
    intentId: string;
    decision: string;
    context: AuthorityCallContext;
  }> = [];
  const review = {
    async list() {
      return intents.map((intent) => structuredClone(intent));
    },
    async decide(
      intentId: string,
      decision: "confirmed" | "discarded",
      context: AuthorityCallContext,
    ) {
      decisions.push({ intentId, decision, context });
      if (options.failSchedule && intentId === "intent-schedule") {
        throw new Error("internal conflict");
      }
      const intent = intents.find((candidate) => candidate.intentId === intentId)!;
      intent.status = decision;
      intent.reviewedAt = new Date(now).toISOString();
      return structuredClone(intent);
    },
  };
  const hub = new ConfirmationHub();
  const coordinator = new PostAdoptionReviewCoordinator({
    review,
    hub,
    workingDirectory: "C:\\workspace",
    now: () => now,
  });
  return {
    coordinator,
    hub,
    intents,
    decisions,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("PostAdoptionReviewCoordinator", () => {
  it("auto-applies non-time-sensitive rules and exposes a product summary", async () => {
    const fixture = harness();
    const result = await fixture.coordinator.reviewAfterAdoption(CONVERSATION);

    expect(result).toMatchObject({
      status: "ready",
      mergedConversationCount: 1,
      appliedRuleCount: 1,
      pendingScheduleCount: 1,
      pendingRuleCount: 0,
    });
    expect(result.message).toBe("已合并 1 个本机对话；1 项排程等待确认。");
    expect(result.message).not.toMatch(/anchor|owner|epoch|intent|CAS|stream/iu);
  });

  it("binds the current authenticated surface and durably decides one schedule", async () => {
    const fixture = harness();
    await fixture.coordinator.reviewForSurface({
      conversationId: CONVERSATION,
      surfacePrincipal: "rpc:zhixing-cli:test",
      connectionId: "41",
    });
    await fixture.coordinator.reviewForSurface({
      conversationId: CONVERSATION,
      surfacePrincipal: "rpc:zhixing-cli:test",
      connectionId: "41",
    });

    const pending = fixture.hub.listAllPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.request.turnOrigin).toEqual({
      channel: "rpc",
      triggeredBy: "rpc:zhixing-cli:test",
    });
    await expect(fixture.hub.resolveDurably(
      pending[0]!.request.id,
      { kind: "allow-once" },
    )).resolves.toBe(true);
    expect(fixture.intents[0]!.status).toBe("confirmed");
    expect(fixture.decisions.at(-1)).toMatchObject({
      intentId: "intent-schedule",
      decision: "confirmed",
      context: {
        principal: {
          kind: "surface",
          surfacePrincipal: "rpc:zhixing-cli:test",
          connectionId: "41",
        },
      },
    });
  });

  it("keeps the confirmation pending when applying the user decision fails", async () => {
    const fixture = harness({ failSchedule: true });
    await fixture.coordinator.reviewForSurface({
      conversationId: CONVERSATION,
      surfacePrincipal: "rpc:zhixing-cli:test",
      connectionId: "42",
    });
    const requestId = fixture.hub.listAllPending()[0]!.request.id;

    await expect(fixture.hub.resolveDurably(
      requestId,
      { kind: "allow-once" },
    )).rejects.toThrow("内容仍已保存");
    expect(fixture.intents[0]!.status).toBe("pending");
    expect(fixture.hub.findEntry(requestId)).toBeDefined();
  });
});
