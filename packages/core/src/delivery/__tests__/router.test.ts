import { describe, it, expect } from "vitest";
import {
  DefaultDeliveryRouter,
  buildRoutingContext,
  type RoutingContext,
} from "../router.js";
import type { DeliveryTarget } from "../../channels/types.js";

// ─── 测试用固定目标 ───

const feishu: DeliveryTarget = { channelId: "feishu", to: "uid_feishu" };
const dingtalk: DeliveryTarget = { channelId: "dingtalk", to: "uid_dingtalk" };
const slack: DeliveryTarget = { channelId: "slack", to: "uid_slack" };

function ctx(overrides?: Partial<RoutingContext>): RoutingContext {
  return {
    channelActivity: new Map(),
    channelStatus: new Map(),
    channelDefaults: new Map(),
    ...overrides,
  };
}

// ─── DefaultDeliveryRouter ───

describe("DefaultDeliveryRouter", () => {
  const router = new DefaultDeliveryRouter();

  // ── 1. 显式指定 ──

  describe("explicit target", () => {
    it("returns explicit target when channel is connected", () => {
      const c = ctx({
        channelStatus: new Map([["feishu", "connected"]]),
      });
      expect(router.resolve({ explicit: feishu }, c)).toEqual(feishu);
    });

    it("returns explicit target even when channel is disconnected", () => {
      const c = ctx({
        channelStatus: new Map([["feishu", "disconnected"]]),
      });
      expect(router.resolve({ explicit: feishu }, c)).toEqual(feishu);
    });

    it("returns explicit target even when channel is in error state", () => {
      const c = ctx({
        channelStatus: new Map([["feishu", "error"]]),
      });
      expect(router.resolve({ explicit: feishu }, c)).toEqual(feishu);
    });

    it("returns explicit target without falling through to trigger", () => {
      const c = ctx({
        channelStatus: new Map([
          ["feishu", "disconnected"],
          ["dingtalk", "connected"],
        ]),
        triggerChannel: "dingtalk",
        channelDefaults: new Map([["dingtalk", dingtalk]]),
      });
      expect(router.resolve({ explicit: feishu }, c)).toEqual(feishu);
    });
  });

  // ── 2. 触发来源通道 ──

  describe("trigger channel", () => {
    it("routes to trigger channel when connected with default", () => {
      const c = ctx({
        channelStatus: new Map([
          ["feishu", "connected"],
          ["dingtalk", "connected"],
        ]),
        triggerChannel: "feishu",
        channelDefaults: new Map([
          ["feishu", feishu],
          ["dingtalk", dingtalk],
        ]),
      });
      expect(router.resolve({}, c)).toEqual(feishu);
    });

    it("skips trigger channel when disconnected", () => {
      const c = ctx({
        channelStatus: new Map([
          ["feishu", "disconnected"],
          ["dingtalk", "connected"],
        ]),
        triggerChannel: "feishu",
        channelDefaults: new Map([
          ["feishu", feishu],
          ["dingtalk", dingtalk],
        ]),
      });
      expect(router.resolve({}, c)).toEqual(dingtalk);
    });

    it("skips trigger channel when no default target configured", () => {
      const c = ctx({
        channelStatus: new Map([
          ["feishu", "connected"],
          ["dingtalk", "connected"],
        ]),
        triggerChannel: "feishu",
        channelDefaults: new Map([["dingtalk", dingtalk]]),
      });
      expect(router.resolve({}, c)).toEqual(dingtalk);
    });
  });

  // ── 3. 活跃度排序 ──

  describe("activity-based routing", () => {
    it("picks most recently active channel", () => {
      const now = Date.now();
      const c = ctx({
        channelStatus: new Map([
          ["feishu", "connected"],
          ["dingtalk", "connected"],
        ]),
        channelActivity: new Map([
          ["feishu", new Date(now - 60_000)],
          ["dingtalk", new Date(now - 1_000)],
        ]),
        channelDefaults: new Map([
          ["feishu", feishu],
          ["dingtalk", dingtalk],
        ]),
      });
      expect(router.resolve({}, c)).toEqual(dingtalk);
    });

    it("prefers default channel as tiebreaker when no activity", () => {
      const c = ctx({
        channelStatus: new Map([
          ["feishu", "connected"],
          ["dingtalk", "connected"],
        ]),
        channelDefaults: new Map([
          ["feishu", feishu],
          ["dingtalk", dingtalk],
        ]),
        defaultChannel: "dingtalk",
      });
      expect(router.resolve({}, c)).toEqual(dingtalk);
    });

    it("skips disconnected channels even if most active", () => {
      const now = Date.now();
      const c = ctx({
        channelStatus: new Map([
          ["feishu", "disconnected"],
          ["dingtalk", "connected"],
        ]),
        channelActivity: new Map([
          ["feishu", new Date(now)],
          ["dingtalk", new Date(now - 60_000)],
        ]),
        channelDefaults: new Map([
          ["feishu", feishu],
          ["dingtalk", dingtalk],
        ]),
      });
      expect(router.resolve({}, c)).toEqual(dingtalk);
    });

    it("skips connected channels without default target", () => {
      const c = ctx({
        channelStatus: new Map([
          ["feishu", "connected"],
          ["dingtalk", "connected"],
        ]),
        channelActivity: new Map([["feishu", new Date()]]),
        channelDefaults: new Map([["dingtalk", dingtalk]]),
      });
      expect(router.resolve({}, c)).toEqual(dingtalk);
    });
  });

  // ── 4. 无可用通道 ──

  describe("no route available", () => {
    it("returns null when all channels disconnected", () => {
      const c = ctx({
        channelStatus: new Map([
          ["feishu", "disconnected"],
          ["dingtalk", "error"],
        ]),
        channelDefaults: new Map([
          ["feishu", feishu],
          ["dingtalk", dingtalk],
        ]),
      });
      expect(router.resolve({}, c)).toBeNull();
    });

    it("returns null when no channels registered", () => {
      expect(router.resolve({}, ctx())).toBeNull();
    });

    it("returns null when connected channels have no defaults", () => {
      const c = ctx({
        channelStatus: new Map([["feishu", "connected"]]),
      });
      expect(router.resolve({}, c)).toBeNull();
    });
  });

  // ── 完整决策链 ──

  describe("full decision chain priority", () => {
    const now = Date.now();
    const fullCtx = ctx({
      channelStatus: new Map([
        ["feishu", "connected"],
        ["dingtalk", "connected"],
        ["slack", "connected"],
      ]),
      triggerChannel: "dingtalk",
      channelActivity: new Map([["slack", new Date(now)]]),
      channelDefaults: new Map([
        ["feishu", feishu],
        ["dingtalk", dingtalk],
        ["slack", slack],
      ]),
      defaultChannel: "slack",
    });

    it("explicit > trigger > activity", () => {
      expect(router.resolve({ explicit: feishu }, fullCtx)).toEqual(feishu);
    });

    it("trigger > activity (no explicit)", () => {
      expect(router.resolve({}, fullCtx)).toEqual(dingtalk);
    });

    it("activity > default (no trigger)", () => {
      const noTrigger = { ...fullCtx, triggerChannel: undefined };
      expect(router.resolve({}, noTrigger)).toEqual(slack);
    });
  });
});

// ─── buildRoutingContext ───

describe("buildRoutingContext", () => {
  it("maps channel statuses to routing context", () => {
    const statuses = [
      {
        channelId: "feishu",
        state: "connected" as const,
        lastMessageAt: "2026-04-20T12:00:00Z",
      },
      {
        channelId: "dingtalk",
        state: "disconnected" as const,
      },
    ];

    const defaults = new Map([["feishu", feishu]]);

    const result = buildRoutingContext(statuses, {
      defaultChannel: "feishu",
      channelDefaults: defaults,
      triggerChannel: "feishu",
    });

    expect(result.channelStatus.get("feishu")).toBe("connected");
    expect(result.channelStatus.get("dingtalk")).toBe("disconnected");
    expect(result.channelActivity.get("feishu")).toEqual(
      new Date("2026-04-20T12:00:00Z"),
    );
    expect(result.channelActivity.has("dingtalk")).toBe(false);
    expect(result.defaultChannel).toBe("feishu");
    expect(result.triggerChannel).toBe("feishu");
    expect(result.channelDefaults).toBe(defaults);
  });

  it("defaults to empty maps when no options", () => {
    const result = buildRoutingContext([]);
    expect(result.channelStatus.size).toBe(0);
    expect(result.channelActivity.size).toBe(0);
    expect(result.channelDefaults.size).toBe(0);
    expect(result.triggerChannel).toBeUndefined();
    expect(result.defaultChannel).toBeUndefined();
  });
});
