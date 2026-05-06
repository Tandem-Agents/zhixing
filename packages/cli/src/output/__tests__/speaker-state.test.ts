import { describe, expect, it } from "vitest";
import {
  ANCHOR_AI_DONE,
  ANCHOR_AI_RUNNING,
  aiTextAnchor,
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

  it("AI 完成态与进行中字符不同——形态独立编码进度", () => {
    expect(ANCHOR_AI_DONE).not.toBe(ANCHOR_AI_RUNNING);
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
});
