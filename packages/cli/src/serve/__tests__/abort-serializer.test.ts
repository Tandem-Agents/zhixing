import { describe, it, expect } from "vitest";
import type { AbortReason } from "@zhixing/core";
import { formatAbortReasonEn, serializeAbortReason } from "../abort-serializer.js";

describe("formatAbortReasonEn", () => {
  it("null → 通用兜底", () => {
    expect(formatAbortReasonEn(null)).toBe("Aborted.");
  });
  it("undefined → 通用兜底", () => {
    expect(formatAbortReasonEn(undefined)).toBe("Aborted.");
  });

  describe("user-cancel by source", () => {
    it("esc 用纯字面量", () => {
      expect(
        formatAbortReasonEn({ kind: "user-cancel", source: "esc", pressedAt: 0 }),
      ).toBe("Aborted by user (esc).");
    });
    it("ctrl-c 翻译为 ctrl+c(更符合终端习惯)", () => {
      expect(
        formatAbortReasonEn({ kind: "user-cancel", source: "ctrl-c", pressedAt: 0 }),
      ).toBe("Aborted by user (ctrl+c).");
    });
    it("rpc 用纯字面量(IDE / 飞书等远程客户端)", () => {
      expect(
        formatAbortReasonEn({ kind: "user-cancel", source: "rpc", pressedAt: 0 }),
      ).toBe("Aborted by user (rpc).");
    });
    it("sigint", () => {
      expect(
        formatAbortReasonEn({ kind: "user-cancel", source: "sigint", pressedAt: 0 }),
      ).toBe("Aborted by user (sigint).");
    });
  });

  describe("idle-timeout", () => {
    it("把 timeoutMs 渲染成秒", () => {
      expect(
        formatAbortReasonEn({
          kind: "idle-timeout",
          timeoutMs: 60_000,
          chunksReceived: 0,
          elapsedSinceLastChunkMs: 60_000,
        }),
      ).toBe("Aborted: stream idle for 60s.");
    });
  });

  describe("external", () => {
    it("有 origin → 字面量拼接", () => {
      expect(
        formatAbortReasonEn({ kind: "external", origin: "scheduler-shutdown" }),
      ).toBe("Aborted: scheduler-shutdown.");
    });
    it("无 origin → 通用兜底", () => {
      expect(formatAbortReasonEn({ kind: "external" })).toBe(
        "Aborted by external signal.",
      );
    });
  });

  describe("parent-abort unwrap 链路", () => {
    it("0 层:idle-timeout 直接渲染", () => {
      expect(
        formatAbortReasonEn({
          kind: "idle-timeout",
          timeoutMs: 30_000,
          chunksReceived: 0,
          elapsedSinceLastChunkMs: 30_000,
        }),
      ).toBe("Aborted: stream idle for 30s.");
    });
    it("1 层:parent-abort{ user-cancel{rpc} } → user-cancel 文案", () => {
      expect(
        formatAbortReasonEn({
          kind: "parent-abort",
          parentReason: { kind: "user-cancel", source: "rpc", pressedAt: 0 },
        }),
      ).toBe("Aborted by user (rpc).");
    });
    it("N 层嵌套都正确分发到根因", () => {
      let inner: AbortReason = {
        kind: "external",
        origin: "rpc-connection-close",
      };
      for (let i = 0; i < 5; i++) {
        inner = { kind: "parent-abort", parentReason: inner };
      }
      expect(formatAbortReasonEn(inner)).toBe("Aborted: rpc-connection-close.");
    });
    it("parentReason === null → 父是裸 abort,通用 parent 文案", () => {
      expect(
        formatAbortReasonEn({ kind: "parent-abort", parentReason: null }),
      ).toBe("Aborted by parent.");
    });
  });
});

describe("serializeAbortReason", () => {
  it("status 恒为 aborted", () => {
    expect(serializeAbortReason(null).status).toBe("aborted");
    expect(
      serializeAbortReason({ kind: "user-cancel", source: "rpc", pressedAt: 0 })
        .status,
    ).toBe("aborted");
  });

  it("message 走 unwrap 后的根因文案", () => {
    const wrapped: AbortReason = {
      kind: "parent-abort",
      parentReason: { kind: "external", origin: "cron-timeout" },
    };
    const out = serializeAbortReason(wrapped);
    expect(out.message).toBe("Aborted: cron-timeout.");
  });

  it("detail 保留完整原始结构(含全部 wrap 层),不做 unwrap", () => {
    const wrapped: AbortReason = {
      kind: "parent-abort",
      parentReason: {
        kind: "parent-abort",
        parentReason: { kind: "user-cancel", source: "rpc", pressedAt: 123 },
      },
    };
    const out = serializeAbortReason(wrapped);
    expect(out.detail).toEqual(wrapped);
    expect(out.detail?.kind).toBe("parent-abort");
  });

  it("null reason → detail null + message 兜底", () => {
    const out = serializeAbortReason(null);
    expect(out.detail).toBeNull();
    expect(out.message).toBe("Aborted.");
  });
});
