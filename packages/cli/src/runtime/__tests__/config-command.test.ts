import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../tui/index.js";
import {
  formatHostReloadChannelMessages,
  settleConfigPostCommitEffects,
} from "../config-command.js";

describe("formatHostReloadChannelMessages", () => {
  it("按通道状态输出事实反馈", () => {
    const lines = formatHostReloadChannelMessages({
      channels: [
        { channelId: "feishu", state: "connected" },
        { channelId: "slack", state: "connecting" },
        { channelId: "mail", state: "error", error: "bad token" },
      ],
    }).map(stripAnsi);

    expect(lines.join("\n")).toContain("消息通道已连接：feishu");
    expect(lines.join("\n")).toContain("消息通道仍在后台连接：slack");
    expect(lines.join("\n")).toContain("消息通道连接失败：mail（bad token）");
  });

  it("无通道时不追加提示", () => {
    expect(formatHostReloadChannelMessages({ channels: [] })).toEqual([]);
    expect(formatHostReloadChannelMessages(undefined)).toEqual([]);
  });
});

describe("settleConfigPostCommitEffects", () => {
  it.each([
    [false, false, ["reload", "reconcile"]],
    [true, false, ["reload", "reconcile"]],
    [false, true, ["reload", "reconcile"]],
    [true, true, ["reload", "reconcile"]],
  ] as const)(
    "terminates reload failure=%s and reconcile failure=%s independently",
    async (reloadFails, reconcileFails, expectedOrder) => {
      const order: string[] = [];
      const result = await settleConfigPostCommitEffects({
        launchSelectionChanged: true,
        reload: async () => {
          order.push("reload");
          if (reloadFails) throw new Error("reload response lost");
          return { channels: [] };
        },
        reconcile: async () => {
          order.push("reconcile");
          if (reconcileFails) throw new Error("reconcile failed");
        },
      });

      expect(order).toEqual(expectedOrder);
      expect(result.reload.status).toBe(reloadFails ? "failed" : "succeeded");
      expect(result.reconcile.status).toBe(reconcileFails ? "failed" : "succeeded");
    },
  );

  it("does not reconcile when the durable launch selection is unchanged", async () => {
    const order: string[] = [];
    const result = await settleConfigPostCommitEffects({
      launchSelectionChanged: false,
      reload: async () => {
        order.push("reload");
      },
      reconcile: async () => {
        order.push("reconcile");
      },
    });

    expect(order).toEqual(["reload"]);
    expect(result.reconcile).toEqual({ status: "not-required" });
  });
});
