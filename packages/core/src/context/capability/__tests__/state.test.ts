import { describe, expect, it } from "vitest";
import { CapabilityState, HOT_RETENTION_TURNS } from "../index.js";

// ─── 装配 / 初始化 ───

describe("CapabilityState · initialize", () => {
  it("空状态 → layerOf 返 undefined", () => {
    const state = new CapabilityState();
    expect(state.layerOf("read")).toBeUndefined();
  });

  it("initialize 后 layerOf 返设定层", () => {
    const state = new CapabilityState();
    state.initialize("memory", "always");
    state.initialize("read", "discoverable");
    state.initialize("legacy", "cold");
    expect(state.layerOf("memory")).toBe("always");
    expect(state.layerOf("read")).toBe("discoverable");
    expect(state.layerOf("legacy")).toBe("cold");
  });

  it("同名 initialize 覆盖前者", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");
    expect(state.layerOf("read")).toBe("discoverable");
    state.initialize("read", "always");
    expect(state.layerOf("read")).toBe("always");
  });

  it("toolsAt 按目标层批量返工具名", () => {
    const state = new CapabilityState();
    state.initialize("memory", "always");
    state.initialize("recall_history", "always");
    state.initialize("read", "discoverable");
    state.initialize("write", "discoverable");
    state.initialize("legacy", "cold");

    expect(state.toolsAt("always").sort()).toEqual(["memory", "recall_history"]);
    expect(state.toolsAt("discoverable").sort()).toEqual(["read", "write"]);
    expect(state.toolsAt("hot")).toEqual([]);
    expect(state.toolsAt("cold")).toEqual(["legacy"]);
  });
});

// ─── promoteToHot ───

describe("CapabilityState · promoteToHot", () => {
  it("discoverable → hot：返 true，lastUseTurn=currentTurn", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");
    state.advanceTurn(); // turn → 1
    expect(state.promoteToHot("read")).toBe(true);
    expect(state.layerOf("read")).toBe("hot");
  });

  it("已是 hot 的 promote → 返 false（无层跃迁）但刷新 lastUseTurn", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");
    state.advanceTurn();
    state.promoteToHot("read"); // → hot
    state.advanceTurn(); // turn → 2
    expect(state.promoteToHot("read")).toBe(false);
    expect(state.layerOf("read")).toBe("hot");
  });

  it("always 工具 promote → 返 false 不变层", () => {
    const state = new CapabilityState();
    state.initialize("memory", "always");
    expect(state.promoteToHot("memory")).toBe(false);
    expect(state.layerOf("memory")).toBe("always");
  });

  it("cold 工具 promote 是 no-op（layer 保持 cold）", () => {
    const state = new CapabilityState();
    state.initialize("legacy", "cold");
    expect(state.promoteToHot("legacy")).toBe(false);
    expect(state.layerOf("legacy")).toBe("cold");
  });

  it("未注册工具 promote 是 no-op（layerOf 仍 undefined）", () => {
    const state = new CapabilityState();
    expect(state.promoteToHot("unknown")).toBe(false);
    expect(state.layerOf("unknown")).toBeUndefined();
  });
});

// ─── recordToolUse（语义等价 promoteToHot） ───

describe("CapabilityState · recordToolUse", () => {
  it("等价于 promoteToHot：discoverable → hot", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");
    state.recordToolUse("read");
    expect(state.layerOf("read")).toBe("hot");
  });
});

// ─── advanceTurn 与 LRU 降级 ───

describe("CapabilityState · advanceTurn + LRU 降级", () => {
  it("turn 推进：currentTurn 单调递增", () => {
    const state = new CapabilityState();
    expect(state.turn).toBe(0);
    state.advanceTurn();
    expect(state.turn).toBe(1);
    state.advanceTurn();
    expect(state.turn).toBe(2);
  });

  it("hot 工具连续 HOT_RETENTION_TURNS 轮未命中 → 降级 discoverable", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");
    state.advanceTurn(); // turn=1
    state.recordToolUse("read"); // hot, lastUseTurn=1

    // 推进 HOT_RETENTION_TURNS 轮（不再命中 read）
    for (let i = 0; i < HOT_RETENTION_TURNS; i++) {
      state.advanceTurn();
    }
    // 此时 currentTurn = 1 + HOT_RETENTION_TURNS；distance = HOT_RETENTION_TURNS
    // 距离恰好等于阈值（边界），按 ">"  规则不降级
    expect(state.layerOf("read")).toBe("hot");

    // 再推进 1 轮 → 距离超过阈值 → 降级
    state.advanceTurn();
    expect(state.layerOf("read")).toBe("discoverable");
  });

  it("hot 工具在窗口内被 recordToolUse → 续期不降级", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");
    state.advanceTurn();
    state.recordToolUse("read");

    // 窗口接近过期前再次命中
    for (let i = 0; i < HOT_RETENTION_TURNS - 1; i++) {
      state.advanceTurn();
    }
    state.recordToolUse("read"); // 续期

    // 再推进 HOT_RETENTION_TURNS 轮，应保 hot
    for (let i = 0; i < HOT_RETENTION_TURNS; i++) {
      state.advanceTurn();
    }
    expect(state.layerOf("read")).toBe("hot");
  });

  it("always 工具不参与 LRU 降级（永远 always）", () => {
    const state = new CapabilityState();
    state.initialize("memory", "always");
    for (let i = 0; i < HOT_RETENTION_TURNS * 3; i++) {
      state.advanceTurn();
    }
    expect(state.layerOf("memory")).toBe("always");
  });

  it("cold 工具不参与 LRU 降级（永远 cold）", () => {
    const state = new CapabilityState();
    state.initialize("legacy", "cold");
    for (let i = 0; i < HOT_RETENTION_TURNS * 3; i++) {
      state.advanceTurn();
    }
    expect(state.layerOf("legacy")).toBe("cold");
  });

  it("多个 hot 工具 LRU 独立评估", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");
    state.initialize("grep", "discoverable");
    state.advanceTurn(); // turn=1
    state.recordToolUse("read");
    state.recordToolUse("grep");

    // 推进若干轮，途中只续 grep
    for (let i = 0; i < 3; i++) state.advanceTurn();
    state.recordToolUse("grep"); // grep 续期

    // 再推进直到 read 过期但 grep 不过期
    for (let i = 0; i < HOT_RETENTION_TURNS - 2; i++) {
      state.advanceTurn();
    }
    expect(state.layerOf("read")).toBe("discoverable"); // read 已降级
    expect(state.layerOf("grep")).toBe("hot"); // grep 仍在窗口
  });
});

// ─── reset（/clear 触发） ───

describe("CapabilityState · reset", () => {
  it("hot 工具全部降级到 discoverable，always / cold 不变", () => {
    const state = new CapabilityState();
    state.initialize("memory", "always");
    state.initialize("read", "discoverable");
    state.initialize("legacy", "cold");
    state.advanceTurn();
    state.recordToolUse("read"); // read → hot

    state.reset();

    expect(state.layerOf("memory")).toBe("always");
    expect(state.layerOf("read")).toBe("discoverable");
    expect(state.layerOf("legacy")).toBe("cold");
  });

  it("currentTurn 归零", () => {
    const state = new CapabilityState();
    state.advanceTurn();
    state.advanceTurn();
    expect(state.turn).toBe(2);
    state.reset();
    expect(state.turn).toBe(0);
  });

  it("reset 后第一次 advanceTurn 不会立即降级刚升级的工具", () => {
    const state = new CapabilityState();
    state.initialize("read", "discoverable");
    state.advanceTurn();
    state.recordToolUse("read");
    state.reset();
    // 重新使用 read
    state.recordToolUse("read"); // turn=0 此时 lastUseTurn=0
    state.advanceTurn(); // turn=1
    expect(state.layerOf("read")).toBe("hot");
  });
});
