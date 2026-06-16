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

    it("returns null when trigger channel is disconnected", () => {
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
      expect(router.resolve({}, c)).toBeNull();
    });

    it("returns null when trigger channel has no default target configured", () => {
      const c = ctx({
        channelStatus: new Map([
          ["feishu", "connected"],
          ["dingtalk", "connected"],
        ]),
        triggerChannel: "feishu",
        channelDefaults: new Map([["dingtalk", dingtalk]]),
      });
      expect(router.resolve({}, c)).toBeNull();
    });
  });

  // ── 3. 不做隐式目标猜测 ──

  describe("no implicit target guessing", () => {
    it("does not pick the most recently active channel", () => {
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
      expect(router.resolve({}, c)).toBeNull();
    });

    it("does not use default channel without an explicit notification target", () => {
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
      expect(router.resolve({}, c)).toBeNull();
    });

    it("does not fall through from disconnected active channel to another channel", () => {
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
      expect(router.resolve({}, c)).toBeNull();
    });

    it("does not fall through to another channel when active channel has no default target", () => {
      const c = ctx({
        channelStatus: new Map([
          ["feishu", "connected"],
          ["dingtalk", "connected"],
        ]),
        channelActivity: new Map([["feishu", new Date()]]),
        channelDefaults: new Map([["dingtalk", dingtalk]]),
      });
      expect(router.resolve({}, c)).toBeNull();
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

    it("explicit > trigger", () => {
      expect(router.resolve({ explicit: feishu }, fullCtx)).toEqual(feishu);
    });

    it("trigger wins when there is no explicit target", () => {
      expect(router.resolve({}, fullCtx)).toEqual(dingtalk);
    });

    it("no explicit target and no trigger returns null even with activity/default facts", () => {
      const noTrigger = { ...fullCtx, triggerChannel: undefined };
      expect(router.resolve({}, noTrigger)).toBeNull();
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
