import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../tui/index.js";
import { formatHostReloadChannelMessages } from "../config-command.js";

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
