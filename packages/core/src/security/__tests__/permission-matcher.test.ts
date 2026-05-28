/**
 * PermissionMatcherMiddleware 单元测试
 *
 * 用 mock store + 裸 next() 调用测试中间件的决策逻辑，不经过完整管线。
 */

import { describe, expect, it, vi } from "vitest";

import { PermissionMatcherMiddleware } from "../permission-matcher.js";
import { PermissionStore } from "../permission-store.js";
import type {
  IPermissionStore,
  PermissionRule,
  SecurityDecision,
  SecurityMiddlewareContext,
  SessionType,
} from "../types.js";

// ─── 测试辅助 ───

function makeCtx(
  decision: SecurityDecision | undefined,
  sessionType: SessionType = "interactive",
  tool: string = "bash",
  args: Record<string, unknown> = { command: "git push" },
): SecurityMiddlewareContext {
  return {
    request: {
      tool,
      arguments: args,
      context: {
        cwd: "/tmp",
        trust: { kind: "global" },
        sessionType,
      },
    },
    toolName: tool,
    toolInput: args,
    workingDirectory: "/tmp",
    state: decision ? { decision } : {},
  };
}

function confirmDecision(reason: string = "需要确认"): SecurityDecision {
  return {
    action: "confirm",
    matchedRules: [],
    reason,
    riskLevel: "medium",
  };
}

function makeRule(
  overrides: Partial<PermissionRule> & { pattern: PermissionRule["pattern"] },
): PermissionRule {
  return {
    id: overrides.id ?? "test-rule",
    pattern: overrides.pattern,
    decision: overrides.decision ?? "allow",
    scope: overrides.scope ?? "session",
    createdAt: 1000,
    lastMatchedAt: 0,
    matchCount: 0,
  };
}

// ─── Tests ───

describe("PermissionMatcherMiddleware", () => {
  describe("不介入的情况", () => {
    it("decision 为 undefined → 透传", async () => {
      const store = new PermissionStore({ rootDir: null });
      const matcher = new PermissionMatcherMiddleware(store, () => null);
      const ctx = makeCtx(undefined);
      const next = vi.fn(async () => ({ allowed: true }));

      await matcher.execute(ctx, next);
      expect(next).toHaveBeenCalled();
      // 不应该调用 store.match
    });

    it("decision.action = allow → 透传，不查询 store", async () => {
      const store = new PermissionStore({ rootDir: null });
      const matchSpy = vi.spyOn(store, "match");
      const matcher = new PermissionMatcherMiddleware(store, () => null);
      const ctx = makeCtx({
        action: "allow",
        matchedRules: [],
        reason: "",
        riskLevel: "low",
      });
      const next = vi.fn(async () => ({ allowed: true }));

      await matcher.execute(ctx, next);
      expect(matchSpy).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });
  });

  describe("confirm + 匹配到 allow 规则", () => {
    it("决策升级为 allow，继续执行", async () => {
      const store: IPermissionStore = {
        match: () =>
          makeRule({
            id: "user-allow-git",
            pattern: { tool: "bash", argument: "git *" },
            decision: "allow",
            scope: "context",
          }),
        create: () => {},
        list: () => [],
        revoke: () => false,
        reset: () => {},
        resetAll: () => {},
      };
      const matcher = new PermissionMatcherMiddleware(store, () => "ws-1");
      const ctx = makeCtx(confirmDecision());
      const next = vi.fn(async () => ({ allowed: true }));

      const result = await matcher.execute(ctx, next);

      expect(ctx.state.decision?.action).toBe("allow");
      expect(ctx.state.matchedPermissionRule?.id).toBe("user-allow-git");
      expect(next).toHaveBeenCalled();
      expect(result.allowed).toBe(true);
    });
  });

  describe("confirm + 匹配到 deny 规则", () => {
    it("决策降级为 block 并短路（不调用 next）", async () => {
      const denyRule = makeRule({
        id: "user-deny",
        pattern: { tool: "bash", argument: "rm *" },
        decision: "deny",
        scope: "global",
      });
      const store: IPermissionStore = {
        match: () => denyRule,
        create: () => {},
        list: () => [],
        revoke: () => false,
        reset: () => {},
        resetAll: () => {},
      };
      const matcher = new PermissionMatcherMiddleware(store, () => "ws-1");
      const ctx = makeCtx(confirmDecision());
      const next = vi.fn(async () => ({ allowed: true }));

      const result = await matcher.execute(ctx, next);

      expect(result.allowed).toBe(false);
      expect(result.matchedPermissionRule?.id).toBe("user-deny");
      expect(ctx.state.decision?.action).toBe("block");
      // 关键：短路 → next 不被调用
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe("confirm + 无匹配 + 会话类型", () => {
    it("interactive：保持 confirm，继续", async () => {
      const store: IPermissionStore = {
        match: () => null,
        create: () => {},
        list: () => [],
        revoke: () => false,
        reset: () => {},
        resetAll: () => {},
      };
      const matcher = new PermissionMatcherMiddleware(store, () => null);
      const ctx = makeCtx(confirmDecision(), "interactive");
      const next = vi.fn(async () => ({
        allowed: true,
        requiresConfirmation: true,
      }));

      await matcher.execute(ctx, next);

      expect(ctx.state.decision?.action).toBe("confirm");
      expect(next).toHaveBeenCalled();
    });

    for (const sessionType of ["ci", "gateway", "api"] as const) {
      it(`${sessionType}：无匹配 → 保持 confirm，交编排层（会话策略下移 broker）`, async () => {
        const store: IPermissionStore = {
          match: () => null,
          create: () => {},
          list: () => [],
          revoke: () => false,
          reset: () => {},
          resetAll: () => {},
        };
        const matcher = new PermissionMatcherMiddleware(store, () => null);
        const ctx = makeCtx(confirmDecision(), sessionType);
        const next = vi.fn(async () => ({
          allowed: true,
          requiresConfirmation: true,
        }));

        await matcher.execute(ctx, next);

        expect(ctx.state.decision?.action).toBe("confirm");
        expect(next).toHaveBeenCalled();
      });
    }
  });

  describe("作用域 ID 传递", () => {
    it("match 调用使用 getContextId 返回的值", async () => {
      const store: IPermissionStore = {
        match: vi.fn(() => null),
        create: () => {},
        list: () => [],
        revoke: () => false,
        reset: () => {},
        resetAll: () => {},
      };
      const matcher = new PermissionMatcherMiddleware(
        store,
        () => "specific-ws-id",
      );
      const ctx = makeCtx(confirmDecision());

      await matcher.execute(ctx, async () => ({ allowed: true }));

      expect(store.match).toHaveBeenCalledWith(
        "specific-ws-id",
        expect.objectContaining({ tool: "bash" }),
      );
    });
  });
});
