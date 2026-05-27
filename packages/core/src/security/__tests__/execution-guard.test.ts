/**
 * ExecutionGuard 单元测试
 *
 * 覆盖：
 *   - Profile 计算（默认 / 工具特定 / 自定义覆盖）
 *   - rate limit 集成（块超额请求）
 *   - wrapWithConstraints：rate limit 抛错、timeout 抛错、正常返回
 *   - truncateOutput：UTF-8 字符边界处截断
 */

import { describe, expect, it } from "vitest";

import {
  ExecutionGuardMiddleware,
  RateLimitError,
  TimeoutError,
  truncateOutput,
  wrapWithConstraints,
  type ExecutionConstraints,
} from "../execution-guard.js";
import { SlidingWindowRateLimiter } from "../rate-limiter.js";
import type {
  SecurityDecision,
  SecurityMiddlewareContext,
} from "../types.js";

// ─── 测试辅助 ───

function makeCtx(
  toolName: string,
  decision?: SecurityDecision,
): SecurityMiddlewareContext {
  return {
    request: {
      tool: toolName,
      arguments: {},
      context: { cwd: "/tmp", trust: { kind: "global" }, sessionType: "interactive" },
    },
    toolName,
    toolInput: {},
    workingDirectory: "/tmp",
    state: decision ? { decision } : {},
  };
}

function allowDecision(): SecurityDecision {
  return {
    action: "allow",
    matchedRules: [],
    reason: "",
    riskLevel: "low",
  };
}

// ─── ExecutionGuardMiddleware ───

describe("ExecutionGuardMiddleware", () => {
  describe("约束计算", () => {
    it("已知工具使用对应 profile（bash → 120s/10MB）", async () => {
      const guard = new ExecutionGuardMiddleware();
      const ctx = makeCtx("bash", allowDecision());

      await guard.execute(ctx, async () => ({ allowed: true }));

      const c = ctx.state.executionConstraints!;
      expect(c.timeoutMs).toBe(120_000);
      expect(c.maxOutputBytes).toBe(10 * 1024 * 1024);
    });

    it("write/edit 是紧凑配额（5s/1MB）", async () => {
      const guard = new ExecutionGuardMiddleware();
      const ctx = makeCtx("write", allowDecision());

      await guard.execute(ctx, async () => ({ allowed: true }));

      const c = ctx.state.executionConstraints!;
      expect(c.timeoutMs).toBe(5_000);
      expect(c.maxOutputBytes).toBe(1024 * 1024);
    });

    it("未知工具回退到默认 profile", async () => {
      const guard = new ExecutionGuardMiddleware();
      const ctx = makeCtx("unknown_mcp_tool", allowDecision());

      await guard.execute(ctx, async () => ({ allowed: true }));

      const c = ctx.state.executionConstraints!;
      expect(c.timeoutMs).toBe(60_000);
    });

    it("自定义 profile 覆盖默认", async () => {
      const guard = new ExecutionGuardMiddleware({
        toolProfiles: {
          bash: { timeoutMs: 5_000 },
        },
      });
      const ctx = makeCtx("bash", allowDecision());

      await guard.execute(ctx, async () => ({ allowed: true }));

      expect(ctx.state.executionConstraints!.timeoutMs).toBe(5_000);
      // 未覆盖的字段保留默认
      expect(ctx.state.executionConstraints!.maxOutputBytes).toBe(10 * 1024 * 1024);
    });

    it("工具名大小写不敏感", async () => {
      const guard = new ExecutionGuardMiddleware();
      const ctx = makeCtx("BASH", allowDecision());

      await guard.execute(ctx, async () => ({ allowed: true }));

      expect(ctx.state.executionConstraints!.timeoutMs).toBe(120_000);
    });
  });

  describe("频率限制", () => {
    it("窗口内未超限：放行 + 记录", async () => {
      let now = 1000;
      const limiter = new SlidingWindowRateLimiter(60_000, 5, () => now);
      const guard = new ExecutionGuardMiddleware({ rateLimiter: limiter });

      const ctx = makeCtx("bash", allowDecision());
      const result = await guard.execute(ctx, async () => ({ allowed: true }));

      expect(result.allowed).toBe(true);
      expect(ctx.state.executionConstraints!.rateLimited).toBe(false);
      expect(limiter.check("bash").used).toBe(1);
    });

    it("超限后短路为 block，不调用 next，不消耗额外配额", async () => {
      let now = 1000;
      const limiter = new SlidingWindowRateLimiter(60_000, 2, () => now);
      const guard = new ExecutionGuardMiddleware({ rateLimiter: limiter });

      // 用满配额
      limiter.record("bash");
      limiter.record("bash");

      let nextCalled = false;
      const ctx = makeCtx("bash", allowDecision());
      const result = await guard.execute(ctx, async () => {
        nextCalled = true;
        return { allowed: true };
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("超过频率限制");
      expect(nextCalled).toBe(false);
      // 被拒的请求不应再消耗配额
      expect(limiter.check("bash").used).toBe(2);
    });

    it("不同工具的限流相互独立", async () => {
      let now = 1000;
      const limiter = new SlidingWindowRateLimiter(60_000, 1, () => now);
      const guard = new ExecutionGuardMiddleware({ rateLimiter: limiter });

      const ctx1 = makeCtx("bash", allowDecision());
      const r1 = await guard.execute(ctx1, async () => ({ allowed: true }));
      expect(r1.allowed).toBe(true);

      // bash 已满载
      const ctx2 = makeCtx("bash", allowDecision());
      const r2 = await guard.execute(ctx2, async () => ({ allowed: true }));
      expect(r2.allowed).toBe(false);

      // 但 read 不受影响
      const ctx3 = makeCtx("read", allowDecision());
      const r3 = await guard.execute(ctx3, async () => ({ allowed: true }));
      expect(r3.allowed).toBe(true);
    });
  });
});

// ─── wrapWithConstraints ───

describe("wrapWithConstraints", () => {
  function constraints(
    overrides: Partial<ExecutionConstraints> = {},
  ): ExecutionConstraints {
    return {
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      rateLimited: false,
      rateRemaining: 100,
      rateWindowMs: 60_000,
      rateLimit: 100,
      ...overrides,
    };
  }

  it("正常返回", async () => {
    const result = await wrapWithConstraints(async () => 42, constraints());
    expect(result).toBe(42);
  });

  it("rateLimited=true 直接抛 RateLimitError", async () => {
    await expect(
      wrapWithConstraints(async () => 42, constraints({ rateLimited: true })),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("超时抛 TimeoutError 而非透传 abort 错误", async () => {
    await expect(
      wrapWithConstraints(async (signal) => {
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }, constraints({ timeoutMs: 50 })),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("非超时抛错被透传", async () => {
    await expect(
      wrapWithConstraints(async () => {
        throw new Error("custom error");
      }, constraints()),
    ).rejects.toThrow("custom error");
  });

  it("正常完成会清理 timer（不会留下挂起的 setTimeout）", async () => {
    // 通过快速完成验证：如果 timer 没清理，进程会卡 5s
    const start = Date.now();
    await wrapWithConstraints(async () => "ok", constraints({ timeoutMs: 5000 }));
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("不配合 abort signal 的工具也会被超时打断", async () => {
    // 模拟"不可取消"的工具：完全忽略 signal
    const start = Date.now();
    await expect(
      wrapWithConstraints(
        async () => new Promise((resolve) => setTimeout(() => resolve("done"), 5000)),
        constraints({ timeoutMs: 50 }),
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
    // await 应该在 ~50ms 后就返回，而不是等到 5000ms
    expect(Date.now() - start).toBeLessThan(500);
  });
});

// ─── truncateOutput ───

describe("truncateOutput", () => {
  it("短内容不被截断", () => {
    const result = truncateOutput("hello", 100);
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("hello");
  });

  it("超长内容被截断", () => {
    const long = "a".repeat(200);
    const result = truncateOutput(long, 50);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(50);
    expect(result.originalBytes).toBe(200);
  });

  it("UTF-8 多字节字符不会被切坏", () => {
    // 中文每字 3 字节，"你好世界" = 12 字节
    const text = "你好世界你好";
    const result = truncateOutput(text, 7);
    // 7 字节正好横跨第 3 个字符的中间，应该回退到第 2 个字符末尾（6 字节）
    expect(result.truncated).toBe(true);
    // 截断结果应该是有效的 UTF-8
    expect(result.content).toBe("你好");
  });

  it("截断到 0 字节返回空串", () => {
    const result = truncateOutput("hello", 0);
    expect(result.content).toBe("");
    expect(result.truncated).toBe(true);
  });
});
