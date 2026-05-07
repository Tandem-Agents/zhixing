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

describe("spinnerFrame · 印鉴流转", () => {
  /** 「印鉴流转」帧序列——4 个图形在 2x2 矩阵上沿外周顺时针滚动 */
  const SEAL_FRAMES = ["◈", "▣", "■", "◆"];

  it("不同时间戳产生不同帧（按 250ms 推算）", () => {
    const a = spinnerFrame(0);
    const b = spinnerFrame(250);
    expect(a).not.toBe(b);
  });

  it("帧字符在「印鉴流转」4 帧集内（不再使用 braille / 雪花）", () => {
    const ch = spinnerFrame(0);
    expect(SEAL_FRAMES).toContain(ch);
    // 防回归：不应出现旧的 braille 或 ✻ 雪花字符
    expect(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]).not.toContain(ch);
    expect(["✦", "✶", "✸", "✺", "✻"]).not.toContain(ch);
  });

  it("帧序列是 4 帧 × 250ms = 1000ms 一周期", () => {
    // t=0 与 t=1000 应同帧（一个周期）
    expect(spinnerFrame(0)).toBe(spinnerFrame(1000));
    // t=0 与 t=250 不同帧
    expect(spinnerFrame(0)).not.toBe(spinnerFrame(250));
  });

  it("帧顺序：◈ → ▣ → ■ → ◆ → ◈（沿矩阵外周顺时针滚动）", () => {
    expect(spinnerFrame(0)).toBe("◈"); // 带核菱
    expect(spinnerFrame(250)).toBe("▣"); // 带核方（步 1: 形状变）
    expect(spinnerFrame(500)).toBe("■"); // 实心方（步 2: 密度变）
    expect(spinnerFrame(750)).toBe("◆"); // 实心菱（步 3: 形状变）
    // 1000ms 后回到 ◈
    expect(spinnerFrame(1000)).toBe("◈");
  });

  it("相邻帧只变一个属性——产生连续滚动视觉而非对角跳跃", () => {
    // 步 1: ◈→▣ 形状变（菱→方），密度保持带核
    // 步 2: ▣→■ 密度变（带核→实心），形状保持方
    // 步 3: ■→◆ 形状变（方→菱），密度保持实心
    // 步 4: ◆→◈ 密度变（实心→带核），形状保持菱
    // —— 这是矩阵 4 条边的环路径，不是对角线
    const isDiamond = (s: string) => s === "◈" || s === "◆";
    const isHollow = (s: string) => s === "◈" || s === "▣";
    const frames = [0, 250, 500, 750, 1000].map(spinnerFrame);
    // 验证每相邻两帧之间，形状或密度恰好有一个改变（不是两个都变也不是都不变）
    for (let i = 0; i < 4; i++) {
      const a = frames[i]!;
      const b = frames[i + 1]!;
      const shapeChanged = isDiamond(a) !== isDiamond(b);
      const densityChanged = isHollow(a) !== isHollow(b);
      expect(shapeChanged !== densityChanged).toBe(true); // XOR：恰好一个变
    }
  });

  it("◆（实心菱）出现在帧 3——与 COMPLETED_GLYPH 同形，形态守恒（动→静形状不变）", () => {
    // 帧 3 时间戳 = 3 × 250 = 750ms
    expect(spinnerFrame(750)).toBe(COMPLETED_GLYPH);
  });

  it("250ms 采样下 4 帧字符全部覆盖——防止 FRAME_MS 与 status-bar TICK_INTERVAL_MS 不同步导致跳帧", () => {
    // status-bar.ts 的 ticker 每 TICK_INTERVAL_MS=250ms 重画一次状态条，每次调
    // spinnerFrame(now)。如果 FRAME_MS 与 TICK_INTERVAL_MS 不整除（如 180/250），
    // 部分帧字符会永远不被采样到（如 180ms 帧步长下 ◆ 永远不显示）。本测试确保
    // 250ms 间隔的 4 个采样点恰好覆盖 4 个不同字符。
    const sampledChars = new Set([0, 250, 500, 750].map(spinnerFrame));
    expect(sampledChars.size).toBe(4); // 4 个采样点 = 4 个不同字符
    expect(sampledChars).toEqual(new Set(SEAL_FRAMES)); // 恰好覆盖整个帧集
  });
});

describe("COMPLETED_GLYPH", () => {
  it("实心菱形（与 AI 文字段起首锚同字符）", () => {
    expect(COMPLETED_GLYPH).toBe("◆");
  });
});
