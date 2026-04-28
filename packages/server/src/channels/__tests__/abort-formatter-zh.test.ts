import { describe, it, expect } from "vitest";
import type { AbortReason } from "@zhixing/core";
import { formatAbortReasonZh } from "../abort-formatter-zh.js";

describe("formatAbortReasonZh", () => {
  describe("空值兜底", () => {
    it("null → 通用兜底", () => {
      expect(formatAbortReasonZh(null)).toBe("已停止处理。");
    });
    it("undefined → 通用兜底", () => {
      expect(formatAbortReasonZh(undefined)).toBe("已停止处理。");
    });
  });

  describe("user-cancel", () => {
    it("source=esc(CLI 路径,飞书理论上不会到达,兜底文案一致)", () => {
      expect(
        formatAbortReasonZh({ kind: "user-cancel", source: "esc", pressedAt: 0 }),
      ).toBe("已停止处理。");
    });
    it("source=rpc(飞书/RPC 用户主动取消的常见路径)", () => {
      expect(
        formatAbortReasonZh({ kind: "user-cancel", source: "rpc", pressedAt: 0 }),
      ).toBe("已停止处理。");
    });
  });

  describe("idle-timeout", () => {
    it("把 timeoutMs 渲染成秒", () => {
      expect(
        formatAbortReasonZh({
          kind: "idle-timeout",
          timeoutMs: 60_000,
          chunksReceived: 0,
          elapsedSinceLastChunkMs: 60_000,
        }),
      ).toBe("已停止处理。(等待响应超过 60 秒)");
    });
    it("非整 timeoutMs 四舍五入", () => {
      expect(
        formatAbortReasonZh({
          kind: "idle-timeout",
          timeoutMs: 45_500,
          chunksReceived: 0,
          elapsedSinceLastChunkMs: 45_500,
        }),
      ).toBe("已停止处理。(等待响应超过 46 秒)");
    });
  });

  describe("external by origin", () => {
    it("scheduler-shutdown", () => {
      expect(
        formatAbortReasonZh({ kind: "external", origin: "scheduler-shutdown" }),
      ).toBe("已停止处理。(服务正在重启,请稍后重试)");
    });
    it("cron-timeout", () => {
      expect(
        formatAbortReasonZh({ kind: "external", origin: "cron-timeout" }),
      ).toBe("已停止处理。(任务超出时长上限)");
    });
    it("rpc-connection-close", () => {
      expect(
        formatAbortReasonZh({ kind: "external", origin: "rpc-connection-close" }),
      ).toBe("已停止处理。(连接已断开)");
    });
    it("session-runtime-abort", () => {
      expect(
        formatAbortReasonZh({ kind: "external", origin: "session-runtime-abort" }),
      ).toBe("已停止处理。");
    });
    it("未知 origin → 默认兜底,不抛异常(渲染层 totality)", () => {
      expect(
        formatAbortReasonZh({ kind: "external", origin: "future-unknown-origin" }),
      ).toBe("已停止处理。");
    });
    it("origin 缺失 → 默认兜底", () => {
      expect(formatAbortReasonZh({ kind: "external" })).toBe("已停止处理。");
    });
  });

  describe("parent-abort 链路必须 unwrap 到根因", () => {
    it("0 层 wrap:idle-timeout 直接渲染(unwrap 是 no-op)", () => {
      expect(
        formatAbortReasonZh({
          kind: "idle-timeout",
          timeoutMs: 30_000,
          chunksReceived: 0,
          elapsedSinceLastChunkMs: 30_000,
        }),
      ).toBe("已停止处理。(等待响应超过 30 秒)");
    });

    it("1 层 wrap:parent-abort{ user-cancel{rpc} } → user-cancel 文案", () => {
      const wrapped: AbortReason = {
        kind: "parent-abort",
        parentReason: { kind: "user-cancel", source: "rpc", pressedAt: 0 },
      };
      expect(formatAbortReasonZh(wrapped)).toBe("已停止处理。");
    });

    it("2 层 wrap:parent-abort{ parent-abort{ idle-timeout } } → idle-timeout 文案", () => {
      const wrapped: AbortReason = {
        kind: "parent-abort",
        parentReason: {
          kind: "parent-abort",
          parentReason: {
            kind: "idle-timeout",
            timeoutMs: 60_000,
            chunksReceived: 0,
            elapsedSinceLastChunkMs: 60_000,
          },
        },
      };
      expect(formatAbortReasonZh(wrapped)).toBe("已停止处理。(等待响应超过 60 秒)");
    });

    it("N 层 wrap:任意层 parent-abort 嵌套都能正确分发到根因 origin", () => {
      let inner: AbortReason = {
        kind: "external",
        origin: "scheduler-shutdown",
      };
      for (let i = 0; i < 8; i++) {
        inner = { kind: "parent-abort", parentReason: inner };
      }
      expect(formatAbortReasonZh(inner)).toBe(
        "已停止处理。(服务正在重启,请稍后重试)",
      );
    });

    it("parentReason === null → 父是裸 abort,渲染为通用兜底", () => {
      expect(
        formatAbortReasonZh({ kind: "parent-abort", parentReason: null }),
      ).toBe("已停止处理。");
    });
  });
});
