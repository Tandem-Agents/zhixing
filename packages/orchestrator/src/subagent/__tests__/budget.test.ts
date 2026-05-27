import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUB_CONFIRMATION_POLICY,
  DEFAULT_SUB_IDLE_TIMEOUT_MS,
  DEFAULT_SUB_MAX_TOKENS,
  DEFAULT_SUB_MAX_TURNS,
  DEFAULT_SUB_WALL_CLOCK_MS,
  resolveSubAgentBudget,
} from "../budget.js";

describe("resolveSubAgentBudget", () => {
  it("budget 完全 undefined → 全部走默认值", () => {
    expect(resolveSubAgentBudget(undefined)).toEqual({
      maxTurns: DEFAULT_SUB_MAX_TURNS,
      maxTokens: DEFAULT_SUB_MAX_TOKENS,
      llmIdleTimeoutMs: DEFAULT_SUB_IDLE_TIMEOUT_MS,
      wallClockTimeoutMs: DEFAULT_SUB_WALL_CLOCK_MS,
      confirmationPolicy: DEFAULT_SUB_CONFIRMATION_POLICY,
    });
  });

  it("空对象 → 同样取默认 (覆盖 undefined vs {} 两种缺省形态)", () => {
    expect(resolveSubAgentBudget({})).toEqual({
      maxTurns: DEFAULT_SUB_MAX_TURNS,
      maxTokens: DEFAULT_SUB_MAX_TOKENS,
      llmIdleTimeoutMs: DEFAULT_SUB_IDLE_TIMEOUT_MS,
      wallClockTimeoutMs: DEFAULT_SUB_WALL_CLOCK_MS,
      confirmationPolicy: DEFAULT_SUB_CONFIRMATION_POLICY,
    });
  });

  it("部分字段覆盖 → 仅覆盖给定字段,其余取默认", () => {
    const resolved = resolveSubAgentBudget({
      maxTurns: 5,
      confirmationPolicy: "inherit-or-deny",
    });
    expect(resolved.maxTurns).toBe(5);
    expect(resolved.confirmationPolicy).toBe("inherit-or-deny");
    expect(resolved.maxTokens).toBe(DEFAULT_SUB_MAX_TOKENS);
    expect(resolved.wallClockTimeoutMs).toBe(DEFAULT_SUB_WALL_CLOCK_MS);
    expect(resolved.llmIdleTimeoutMs).toBe(DEFAULT_SUB_IDLE_TIMEOUT_MS);
  });

  it("0 显式传入应保留 (允许显式禁用,不被 ?? 操作符当作 falsy)", () => {
    const resolved = resolveSubAgentBudget({ maxTurns: 0, maxTokens: 0 });
    expect(resolved.maxTurns).toBe(0);
    expect(resolved.maxTokens).toBe(0);
  });
});

describe("默认值哨兵 (锁定值变更需通过测试感知)", () => {
  it("默认值与 spec 值对齐", () => {
    expect(DEFAULT_SUB_MAX_TURNS).toBe(20);
    expect(DEFAULT_SUB_MAX_TOKENS).toBe(50_000);
    expect(DEFAULT_SUB_IDLE_TIMEOUT_MS).toBe(60_000);
    expect(DEFAULT_SUB_WALL_CLOCK_MS).toBe(600_000);
    expect(DEFAULT_SUB_CONFIRMATION_POLICY).toBe("inherit-or-deny");
  });
});
