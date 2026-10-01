import { describe, expect, it } from "vitest";
import { stringWidth } from "../../tui/line-width.js";
import {
  formatDuration,
  formatTokens,
  truncate,
  VERBS,
  spinnerFrame,
  COMPLETED_GLYPH,
} from "../verbs.js";

describe("formatDuration", () => {
  it("亚秒级 round 到 0s", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(450)).toBe("0s");
  });
  it("亚秒级 ≥500ms round 到 1s", () => {
    expect(formatDuration(500)).toBe("1s");
    expect(formatDuration(1499)).toBe("1s");
  });
  it("秒级整数无小数", () => {
    expect(formatDuration(7300)).toBe("7s");
    expect(formatDuration(8000)).toBe("8s");
    expect(formatDuration(59_400)).toBe("59s");
  });
  it("分钟级带秒——`Nm Ms`", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(9 * 60_000 + 27 * 1000)).toBe("9m 27s");
    expect(formatDuration(3 * 60_000 + 45_000)).toBe("3m 45s");
    expect(formatDuration(59 * 60_000 + 59_000)).toBe("59m 59s");
  });
  it("小时级带分秒——`Hh Mm Ss`（保留所有低位避免字段闪烁）", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m 0s");
    expect(formatDuration(60 * 60_000 + 2 * 60_000)).toBe("1h 2m 0s");
    expect(formatDuration(3_600_000 + 3 * 60_000 + 3_000)).toBe("1h 3m 3s");
  });
});

describe("formatTokens", () => {
  it("< 1k 整数", () => {
    expect(formatTokens(123)).toBe("123");
  });
  it("k 单位一位小数", () => {
    expect(formatTokens(14_300)).toBe("14.3k");
  });
  it("M 单位一位小数", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

describe("truncate", () => {
  it("不超长不变", () => {
    expect(truncate("abc", 10)).toBe("abc");
  });
  it("超长加省略号", () => {
    expect(truncate("hello world", 6)).toBe("hello…");
  });
});

describe("VERBS", () => {
  it("中文动词", () => {
    expect(VERBS.thinking).toBe("思考中");
    expect(VERBS.streaming).toBe("回复中");
    expect(VERBS.compacting).toBe("整理上下文");
    expect(VERBS.retrying).toBe("重试中");
  });
  it("toolCalling 拼接", () => {
    expect(VERBS.toolCalling("Read")).toBe("调用 Read");
  });
  it("task 含编号 + 描述", () => {
    expect(VERBS.task(2, "审查")).toBe("子任务 #2: 审查");
  });
  it("done 含时长", () => {
    expect(VERBS.done(7300)).toBe("用时 7s");
  });
});

describe("spinnerFrame · M1 交替滚", () => {
  const FRAMES = ["◇", "□", "◈", "▤", "◆", "▦", "◈", "▨", "◇", "▩"];

  it("按已定稿的十帧顺序播放，每帧保持 300ms，3 秒循环", () => {
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const [index, frame] of FRAMES.entries()) {
        const start = cycle * 3000 + index * 300;
        expect(spinnerFrame(start)).toBe(frame);
        expect(spinnerFrame(start + 299)).toBe(frame);
      }
    }
    expect(spinnerFrame(6000)).toBe(FRAMES[0]);
  });

  it("每帧和完成标记均占一列，状态文字不随纹理变化移动", () => {
    for (const frame of [...FRAMES, COMPLETED_GLYPH]) {
      expect(stringWidth(frame)).toBe(1);
    }
  });
});

describe("COMPLETED_GLYPH", () => {
  it("实心菱形（与 AI 文字段起首锚同字符）", () => {
    expect(COMPLETED_GLYPH).toBe("◆");
  });
});
