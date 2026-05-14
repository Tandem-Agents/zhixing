import { describe, expect, it } from "vitest";
import {
  ANCHOR_AI_DONE,
  ANCHOR_AI_RUNNING,
  ANCHOR_SIDE_EFFECT,
  aiTextAnchor,
  sideEffectAnchor,
  toolRunningAnchor,
  toolDoneAnchor,
} from "../speaker-state.js";

describe("speaker-state 锚字符常量", () => {
  it("AI 完成态用实心菱形 ◆", () => {
    expect(ANCHOR_AI_DONE).toBe("◆");
  });

  it("AI 进行中用空心菱形 ◇", () => {
    expect(ANCHOR_AI_RUNNING).toBe("◇");
  });

  it("副作用工具用铅笔 ✎——语义即时无需学习", () => {
    expect(ANCHOR_SIDE_EFFECT).toBe("✎");
  });

  it("AI 完成态与进行中字符不同——形态独立编码进度", () => {
    expect(ANCHOR_AI_DONE).not.toBe(ANCHOR_AI_RUNNING);
  });

  it("锚家族字符两两不同——形态独立性保证扫读区分度", () => {
    const all = new Set([ANCHOR_AI_DONE, ANCHOR_AI_RUNNING, ANCHOR_SIDE_EFFECT]);
    expect(all.size).toBe(3);
  });
});

describe("speaker-state 锚字符工厂", () => {
  it("aiTextAnchor 输出实心菱形", () => {
    expect(aiTextAnchor()).toContain(ANCHOR_AI_DONE);
  });

  it("toolRunningAnchor bright/dim 都输出空心菱形", () => {
    expect(toolRunningAnchor("bright")).toContain(ANCHOR_AI_RUNNING);
    expect(toolRunningAnchor("dim")).toContain(ANCHOR_AI_RUNNING);
  });

  it("toolDoneAnchor success/failure 都输出实心菱形", () => {
    expect(toolDoneAnchor(true)).toContain(ANCHOR_AI_DONE);
    expect(toolDoneAnchor(false)).toContain(ANCHOR_AI_DONE);
  });

  it("sideEffectAnchor 输出铅笔字符", () => {
    expect(sideEffectAnchor()).toContain(ANCHOR_SIDE_EFFECT);
  });
});
