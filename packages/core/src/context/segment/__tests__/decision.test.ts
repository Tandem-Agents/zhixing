/**
 * decideSegmentAction 纯函数测试。
 *
 * 覆盖三档边界 + in-progress 任务对中段的影响 + 退化阈值兜底。
 */

import { describe, it, expect } from "vitest";
import { decideSegmentAction } from "../decision.js";
import type { SegmentThresholds } from "../types.js";

const capability: SegmentThresholds = {
  optimalMaxTokens: 128_000,
  riskMaxTokens: 256_000,
};

describe("decideSegmentAction", () => {
  // ─── 第一档：< optimal ───

  describe("currentTokens < optimal", () => {
    it("0 tokens 返 pass", () => {
      expect(
        decideSegmentAction({
          currentTokens: 0,
          capability,
          hasInProgressTask: false,
        }),
      ).toEqual({ kind: "pass", reason: "below-optimal" });
    });

    it("optimal 前一刻仍 pass", () => {
      expect(
        decideSegmentAction({
          currentTokens: 127_999,
          capability,
          hasInProgressTask: false,
        }),
      ).toEqual({ kind: "pass", reason: "below-optimal" });
    });

    it("pass 不受 in-progress 状态影响", () => {
      expect(
        decideSegmentAction({
          currentTokens: 100,
          capability,
          hasInProgressTask: true,
        }),
      ).toEqual({ kind: "pass", reason: "below-optimal" });
    });
  });

  // ─── 第二档：optimal ≤ x < risk ───

  describe("optimal ≤ currentTokens < risk", () => {
    it("恰好等于 optimal 且无 in-progress —— trigger optimal-exceeded", () => {
      expect(
        decideSegmentAction({
          currentTokens: 128_000,
          capability,
          hasInProgressTask: false,
        }),
      ).toEqual({
        kind: "trigger",
        reason: "optimal-exceeded",
        currentTokens: 128_000,
        threshold: 128_000,
      });
    });

    it("中段且有 in-progress —— defer 到 risk", () => {
      expect(
        decideSegmentAction({
          currentTokens: 200_000,
          capability,
          hasInProgressTask: true,
        }),
      ).toEqual({
        kind: "defer",
        reason: "in-progress-task",
        currentTokens: 200_000,
        threshold: 128_000,
      });
    });

    it("中段且无 in-progress —— trigger optimal-exceeded", () => {
      expect(
        decideSegmentAction({
          currentTokens: 200_000,
          capability,
          hasInProgressTask: false,
        }),
      ).toEqual({
        kind: "trigger",
        reason: "optimal-exceeded",
        currentTokens: 200_000,
        threshold: 128_000,
      });
    });

    it("risk 前一刻 + 无 in-progress —— 仍走 optimal-exceeded（不是 risk）", () => {
      expect(
        decideSegmentAction({
          currentTokens: 255_999,
          capability,
          hasInProgressTask: false,
        }),
      ).toEqual({
        kind: "trigger",
        reason: "optimal-exceeded",
        currentTokens: 255_999,
        threshold: 128_000,
      });
    });

    it("risk 前一刻 + 有 in-progress —— defer", () => {
      expect(
        decideSegmentAction({
          currentTokens: 255_999,
          capability,
          hasInProgressTask: true,
        }),
      ).toEqual({
        kind: "defer",
        reason: "in-progress-task",
        currentTokens: 255_999,
        threshold: 128_000,
      });
    });
  });

  // ─── 第三档：≥ risk ───

  describe("currentTokens ≥ risk", () => {
    it("恰好等于 risk —— 强制 trigger 即使 in-progress", () => {
      expect(
        decideSegmentAction({
          currentTokens: 256_000,
          capability,
          hasInProgressTask: true,
        }),
      ).toEqual({
        kind: "trigger",
        reason: "risk-exceeded",
        currentTokens: 256_000,
        threshold: 256_000,
      });
    });

    it("远超 risk —— 强制 trigger 不管 in-progress", () => {
      expect(
        decideSegmentAction({
          currentTokens: 500_000,
          capability,
          hasInProgressTask: true,
        }),
      ).toEqual({
        kind: "trigger",
        reason: "risk-exceeded",
        currentTokens: 500_000,
        threshold: 256_000,
      });
    });
  });

  // ─── 退化阈值兜底 ───

  describe("退化阈值", () => {
    it("optimal === risk === 0 —— 任何 tokens ≥ 0 都强制 trigger（避免 defer 死锁）", () => {
      const zero: SegmentThresholds = {
        optimalMaxTokens: 0,
        riskMaxTokens: 0,
      };
      expect(
        decideSegmentAction({
          currentTokens: 1,
          capability: zero,
          hasInProgressTask: true,
        }),
      ).toMatchObject({ kind: "trigger", reason: "risk-exceeded" });
    });

    it("optimal === risk（同值）—— 第二档区间为空，到 optimal 即走 risk-exceeded", () => {
      const tight: SegmentThresholds = {
        optimalMaxTokens: 1000,
        riskMaxTokens: 1000,
      };
      expect(
        decideSegmentAction({
          currentTokens: 1000,
          capability: tight,
          hasInProgressTask: true,
        }),
      ).toMatchObject({ kind: "trigger", reason: "risk-exceeded" });
    });
  });
});
