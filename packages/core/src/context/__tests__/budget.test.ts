import { describe, expect, it } from "vitest";
import {
  calculateBudget,
  calculateEffectiveWindow,
  getBudgetStatus,
} from "../budget.js";
import type { BudgetThresholds } from "../types.js";
import { DEFAULT_THRESHOLDS, MAX_OUTPUT_RESERVE } from "../types.js";

// ─── calculateEffectiveWindow ───

describe("calculateEffectiveWindow", () => {
  it("subtracts maxOutput from contextWindow", () => {
    // 200K window, 8K output → 192K effective
    expect(calculateEffectiveWindow(200_000, 8_192)).toBe(200_000 - 8_192);
  });

  it("caps output reserve at MAX_OUTPUT_RESERVE", () => {
    // 200K window, 100K output → 应用 20K cap → 180K effective
    expect(calculateEffectiveWindow(200_000, 100_000)).toBe(
      200_000 - MAX_OUTPUT_RESERVE,
    );
  });

  it("handles small output tokens", () => {
    // 200K window, 4K output → 196K effective
    expect(calculateEffectiveWindow(200_000, 4_096)).toBe(200_000 - 4_096);
  });

  it("handles tiny context window", () => {
    // 32K window, 8K output → 24K effective
    expect(calculateEffectiveWindow(32_000, 8_000)).toBe(24_000);
  });

  it("returns 0 for impossibly small window", () => {
    // Window smaller than output reserve → 0
    expect(calculateEffectiveWindow(1_000, 2_000)).toBe(0);
  });

  it("handles zero maxOutput", () => {
    expect(calculateEffectiveWindow(200_000, 0)).toBe(200_000);
  });
});

// ─── getBudgetStatus ───

describe("getBudgetStatus", () => {
  it('returns "normal" below warning threshold', () => {
    expect(getBudgetStatus(0)).toBe("normal");
    expect(getBudgetStatus(0.5)).toBe("normal");
    expect(getBudgetStatus(0.74)).toBe("normal");
  });

  it('returns "warning" at warning threshold', () => {
    expect(getBudgetStatus(0.75)).toBe("warning");
    expect(getBudgetStatus(0.80)).toBe("warning");
    expect(getBudgetStatus(0.84)).toBe("warning");
  });

  it('returns "compact" at compact threshold', () => {
    expect(getBudgetStatus(0.85)).toBe("compact");
    expect(getBudgetStatus(0.90)).toBe("compact");
    expect(getBudgetStatus(0.94)).toBe("compact");
  });

  it('returns "critical" at critical threshold', () => {
    expect(getBudgetStatus(0.95)).toBe("critical");
    expect(getBudgetStatus(1.0)).toBe("critical");
    expect(getBudgetStatus(1.5)).toBe("critical");
  });

  it("accepts custom thresholds", () => {
    const custom: BudgetThresholds = {
      warning: 0.6,
      compact: 0.7,
      critical: 0.8,
    };
    expect(getBudgetStatus(0.5, custom)).toBe("normal");
    expect(getBudgetStatus(0.65, custom)).toBe("warning");
    expect(getBudgetStatus(0.75, custom)).toBe("compact");
    expect(getBudgetStatus(0.85, custom)).toBe("critical");
  });
});

// ─── calculateBudget ───

describe("calculateBudget", () => {
  const claude3Model = { contextWindow: 200_000, maxOutputTokens: 8_192 };
  const smallModel = { contextWindow: 32_000, maxOutputTokens: 4_096 };

  it("calculates complete budget for Claude 3 model", () => {
    const budget = calculateBudget(claude3Model, 50_000);

    expect(budget.contextWindow).toBe(200_000);
    expect(budget.effectiveWindow).toBe(200_000 - 8_192);
    expect(budget.currentTokens).toBe(50_000);
    expect(budget.usageRatio).toBeCloseTo(50_000 / (200_000 - 8_192), 4);
    expect(budget.status).toBe("normal");
  });

  it("triggers warning status", () => {
    const effectiveWindow = 200_000 - 8_192; // 191_808
    const tokensAt75 = Math.ceil(effectiveWindow * 0.76);
    const budget = calculateBudget(claude3Model, tokensAt75);

    expect(budget.status).toBe("warning");
  });

  it("triggers compact status", () => {
    const effectiveWindow = 200_000 - 8_192;
    const tokensAt86 = Math.ceil(effectiveWindow * 0.86);
    const budget = calculateBudget(claude3Model, tokensAt86);

    expect(budget.status).toBe("compact");
  });

  it("triggers critical status", () => {
    const effectiveWindow = 200_000 - 8_192;
    const tokensAt96 = Math.ceil(effectiveWindow * 0.96);
    const budget = calculateBudget(claude3Model, tokensAt96);

    expect(budget.status).toBe("critical");
  });

  it("handles small model correctly", () => {
    const budget = calculateBudget(smallModel, 10_000);

    expect(budget.contextWindow).toBe(32_000);
    expect(budget.effectiveWindow).toBe(32_000 - 4_096);
    expect(budget.usageRatio).toBeCloseTo(10_000 / (32_000 - 4_096), 4);
    expect(budget.status).toBe("normal");
  });

  it("small model compacts at lower absolute threshold (percentage advantage)", () => {
    // 32K 窗口有效 = 27904
    // 85% = 23718 tokens 即触发 compact
    // 如果用 Claude Code 的固定 13K buffer → 已经超了
    const effectiveWindow = 32_000 - 4_096;
    const tokensAt86 = Math.ceil(effectiveWindow * 0.86);
    const budget = calculateBudget(smallModel, tokensAt86);

    expect(budget.status).toBe("compact");
    // 但是绝对值只有 ~24K，远小于大模型的 ~163K
    expect(budget.currentTokens).toBeLessThan(30_000);
  });

  it("accepts custom thresholds", () => {
    const custom: BudgetThresholds = {
      warning: 0.5,
      compact: 0.6,
      critical: 0.7,
    };
    const effectiveWindow = 200_000 - 8_192;
    const tokensAt55 = Math.ceil(effectiveWindow * 0.55);
    const budget = calculateBudget(claude3Model, tokensAt55, custom);

    expect(budget.status).toBe("warning");
  });

  it("handles zero tokens", () => {
    const budget = calculateBudget(claude3Model, 0);

    expect(budget.currentTokens).toBe(0);
    expect(budget.usageRatio).toBe(0);
    expect(budget.status).toBe("normal");
  });

  it("handles tokens exceeding window (overflow)", () => {
    const budget = calculateBudget(claude3Model, 250_000);

    expect(budget.usageRatio).toBeGreaterThan(1);
    expect(budget.status).toBe("critical");
  });
});
