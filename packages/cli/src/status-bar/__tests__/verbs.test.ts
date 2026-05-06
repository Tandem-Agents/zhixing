import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatTokens,
  truncate,
  VERBS,
  spinnerFrame,
  COMPLETED_GLYPH,
} from "../verbs.js";

describe("formatDuration", () => {
  it("毫秒级", () => {
    expect(formatDuration(450)).toBe("450ms");
  });
  it("秒级一位小数", () => {
    expect(formatDuration(7300)).toBe("7.3s");
  });
  it("分钟级", () => {
    expect(formatDuration(3 * 60_000 + 45_000)).toBe("3m 45s");
  });
  it("小时级", () => {
    expect(formatDuration(60 * 60_000 + 2 * 60_000)).toBe("1h 2m");
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
    expect(VERBS.done(7300)).toBe("完成于 7.3s");
  });
});

describe("spinnerFrame", () => {
  it("不同时间戳产生不同帧（按 80ms 推算）", () => {
    const a = spinnerFrame(0);
    const b = spinnerFrame(80);
    expect(a).not.toBe(b);
  });
  it("帧字符在 Braille 集合内", () => {
    const ch = spinnerFrame(0);
    expect(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]).toContain(ch);
  });
});

describe("COMPLETED_GLYPH", () => {
  it("六瓣花静态字符", () => {
    expect(COMPLETED_GLYPH).toBe("✻");
  });
});
