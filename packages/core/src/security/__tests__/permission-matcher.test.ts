/**
 * PermissionMatcherMiddleware 单元测试
 *
 * 用 mock store + 裸 next() 调用测试中间件的决策逻辑，不经过完整管线。
 */

import { describe, expect, it, vi } from "vitest";

import { PermissionMatcherMiddleware } from "../permission-matcher.js";
import {
  bindPermissionRuleExecutionSource,
  PermissionStore,
} from "../permission-store.js";
import type {
  IPermissionStore,
  PermissionContextId,
  PermissionRuleExecutionSource,
  PermissionRule,
  SecurityDecision,
  SecurityMiddlewareContext,
  SessionType,
} from "../types.js";

function executionSource(
  store: IPermissionStore,
  context: PermissionContextId = { kind: "main" },
): PermissionRuleExecutionSource {
  return bindPermissionRuleExecutionSource(store, context);
}

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
  describe("不介入或仅响应 deny 的情况", () => {
    it("decision 为 undefined 且无规则匹配 → 透传", async () => {
      const store = new PermissionStore({ rootDir: null });
      const matcher = new PermissionMatcherMiddleware(executionSource(store));
      const ctx = makeCtx(undefined);
      const next = vi.fn(async () => ({ allowed: true }));

      await matcher.execute(ctx, next);
      expect(next).toHaveBeenCalled();
    });

    it("decision.action = allow + allow 规则 → 透传，不改 decision", async () => {
      const store = new PermissionStore({ rootDir: null });
      await store.create(
        { kind: "main" },
        makeRule({
          id: "allow-git",
          pattern: { tool: "bash", argument: "git *" },
          decision: "allow",
          scope: "session",
        }),
      );
      const matcher = new PermissionMatcherMiddleware(executionSource(store));
      const ctx = makeCtx({
        action: "allow",
        matchedRules: [],
        reason: "",
        riskLevel: "low",
      });
      const next = vi.fn(async () => ({ allowed: true }));

      await matcher.execute(ctx, next);
      expect(ctx.state.decision?.action).toBe("allow");
      expect(ctx.state.matchedPermissionRule).toBeUndefined();
      expect(next).toHaveBeenCalled();
    });

    it("decision.action = allow（observe/internal）+ deny 规则 → 仍立即 block 短路", async () => {
      const store = new PermissionStore({ rootDir: null });
      await store.create(
        { kind: "main" },
        makeRule({
          id: "deny-read-secret",
          pattern: { tool: "read", argument: "secret/**" },
          decision: "deny",
          scope: "session",
        }),
      );
      const matcher = new PermissionMatcherMiddleware(executionSource(store));
      const ctx: SecurityMiddlewareContext = {
        request: {
          tool: "read",
          arguments: { path: "secret/token.txt" },
          resolvedAccess: { paths: ["/tmp/secret/token.txt"], fileAccess: "read" },
          context: {
            cwd: "/tmp",
            trust: { kind: "global" },
            sessionType: "interactive",
          },
        },
        toolName: "read",
        toolInput: { path: "secret/token.txt" },
        workingDirectory: "/tmp",
        state: {
          decision: {
            action: "allow",
            matchedRules: [],
            reason: "observe",
            riskLevel: "low",
          },
        },
      };
      const next = vi.fn(async () => ({ allowed: true }));

      const result = await matcher.execute(ctx, next);
      expect(result.allowed).toBe(false);
      expect(ctx.state.decision?.action).toBe("block");
      expect(ctx.state.matchedPermissionRule?.id).toBe("deny-read-secret");
      expect(next).not.toHaveBeenCalled();
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
        matchFrozen: () => null,
        create: () => {},
        list: () => [],
        snapshot: () => [],
        revoke: () => false,
        reset: () => {},
        resetAll: () => {},
      };
      const matcher = new PermissionMatcherMiddleware(executionSource(store));
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
        matchFrozen: () => null,
        create: () => {},
        list: () => [],
        snapshot: () => [],
        revoke: () => false,
        reset: () => {},
        resetAll: () => {},
      };
      const matcher = new PermissionMatcherMiddleware(executionSource(store));
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
        matchFrozen: () => null,
        create: () => {},
        list: () => [],
        snapshot: () => [],
        revoke: () => false,
        reset: () => {},
        resetAll: () => {},
      };
      const matcher = new PermissionMatcherMiddleware(executionSource(store));
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
          matchFrozen: () => null,
          create: () => {},
          list: () => [],
          snapshot: () => [],
          revoke: () => false,
          reset: () => {},
          resetAll: () => {},
        };
        const matcher = new PermissionMatcherMiddleware(executionSource(store));
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
    it("省略 pattern.argument 的内置 allow 规则在 internal/observe 全路径查询下默认按 * 匹配且不抛错", async () => {
      const store = new PermissionStore({ rootDir: null });
      store.registerBuiltinRules("test-ns", [
        PermissionStore.createRule({
          pattern: { tool: "mark_done" },
          decision: "allow",
          scope: "builtin",
        }),
      ]);
      const matcher = new PermissionMatcherMiddleware(executionSource(store));
      const ctx: SecurityMiddlewareContext = {
        request: {
          tool: "mark_done",
          arguments: {},
          context: {
            cwd: "/tmp",
            trust: { kind: "global" },
            sessionType: "interactive",
          },
        },
        toolName: "mark_done",
        toolInput: {},
        workingDirectory: "/tmp",
        state: {
          decision: {
            action: "allow",
            matchedRules: [],
            reason: "internal",
            riskLevel: "low",
          },
        },
      };
      const next = vi.fn(async () => ({ allowed: true }));

      const res = await matcher.execute(ctx, next);
      expect(res.allowed).toBe(true);
      expect(next).toHaveBeenCalledOnce();
    });
  });

  describe("作用域 ID 传递", () => {
    it("match 调用使用预绑定的不可变上下文", async () => {
      const store: IPermissionStore = {
        match: vi.fn(() => null),
        matchFrozen: () => null,
        create: () => {},
        list: () => [],
        snapshot: () => [],
        revoke: () => false,
        reset: () => {},
        resetAll: () => {},
      };
      const context = { kind: "workspace" as const, hash: "specific-ws-id" };
      const matcher = new PermissionMatcherMiddleware(executionSource(store, context));
      const ctx = makeCtx(confirmDecision());

      await matcher.execute(ctx, async () => ({ allowed: true }));

      expect(store.match).toHaveBeenCalledWith(
        context,
        expect.objectContaining({ tool: "bash" }),
      );
    });
  });
});
