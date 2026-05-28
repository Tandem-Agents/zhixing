/**
 * match.ts 单元测试
 *
 * 覆盖 remote-confirmation-execution.md §3.6 的全部语义：
 *   - APPROVE_SET / DENY_SET 全覆盖（中英文 + 数字 + 口语）
 *   - 大小写无关
 *   - 前后空白 trim
 *   - 末尾标点 trim（中英全半角）
 *   - 内部标点保留（理由的一部分）
 *   - 其他文本 → deny（自由文本 reason） 保留原文
 *   - 超长 reason 截断到 MAX_REASON_LENGTH + "…（理由已截断）" 标注
 *   - formatResolutionReceipt 四分支
 */

import { describe, expect, it } from "vitest";
import type { ConfirmationRequest } from "@zhixing/core";
import {
  MAX_REASON_LENGTH,
  formatResolutionReceipt,
  matchTextToDecision,
} from "../match.js";

// ─── 测试辅助 ───

function makeRequest(title: string = "Bash 命令"): ConfirmationRequest {
  const now = Date.now();
  return {
    id: "req-1",
    tool: "bash",
    toolInput: { command: "ls" },
    workingDirectory: "/tmp",
    display: {
      title,
      body: { kind: "bash", command: "ls", commandPreview: "ls" },
      cwd: "/tmp",
    },
    options: [],
    sessionType: "interactive",
    contextId: { kind: "main" },
    createdAt: now,
    expiresAt: now + 60_000,
  };
}

// ─── APPROVE_SET ───

describe("matchTextToDecision — APPROVE_SET", () => {
  const approve = [
    // 英文
    "y", "yes", "yep", "yeah", "yup", "ok", "okay", "sure", "approve",
    // 数字
    "1",
    // 中文短词
    "好", "好的", "好啊", "行", "行的", "可以", "同意", "允许",
    "批准", "通过", "执行", "继续", "没问题",
    // 口语 / 情绪
    "干吧", "去吧", "做吧", "来", "来吧", "嗯", "嗯嗯",
  ];

  for (const word of approve) {
    it(`"${word}" → allow-once`, () => {
      expect(matchTextToDecision(word)).toEqual({ kind: "allow-once" });
    });
  }

  it("大小写无关：Y / YES / Ok", () => {
    expect(matchTextToDecision("Y")).toEqual({ kind: "allow-once" });
    expect(matchTextToDecision("YES")).toEqual({ kind: "allow-once" });
    expect(matchTextToDecision("Ok")).toEqual({ kind: "allow-once" });
  });

  it("前后空白 trim：'  yes  ' → allow", () => {
    expect(matchTextToDecision("  yes  ")).toEqual({ kind: "allow-once" });
  });
});

// ─── DENY_SET ───

describe("matchTextToDecision — DENY_SET", () => {
  const deny = [
    // 英文（纯否定型；"cancel"/"stop" 是控制命令归 CANCEL）
    "n", "no", "nope", "deny", "reject",
    // 数字
    "2",
    // 中文短词（纯否定型；"取消"/"停" 是控制命令归 CANCEL）
    "不", "不行", "不要", "不用", "拒绝", "否",
    "不同意", "不可以", "不批准", "不通过",
    // 口语 / 情绪
    "算了", "别", "不了",
  ];

  for (const word of deny) {
    it(`"${word}" → deny`, () => {
      expect(matchTextToDecision(word)).toEqual({ kind: "deny" });
    });
  }
});

// 边界：控制命令型词("stop"/"cancel"/"停"/"取消")已迁出 DENY，归 CANCEL（intent 模块）。
// confirmation 单独跑时（未经 IntentClassifier 前置拦截）这些词会走自由文本 deny 路径
// 带 reason，而不是结构化 deny。生产路径下它们在 InboundRouter 被 IntentClassifier
// 优先拦截 → cancel turn，不会走到本路径。
describe("matchTextToDecision — 控制命令型词不再走结构化 DENY", () => {
  for (const word of ["stop", "cancel", "停", "取消"]) {
    it(`"${word}" → 自由文本 deny（带 reason）`, () => {
      expect(matchTextToDecision(word)).toEqual({ kind: "deny", reason: word });
    });
  }
});

// ─── 末尾标点 trim ───

describe("matchTextToDecision — 末尾标点 trim（IM 习惯性输入）", () => {
  it('"好。" → allow-once（中文句号）', () => {
    expect(matchTextToDecision("好。")).toEqual({ kind: "allow-once" });
  });

  it('"好的！" → allow-once（中文感叹号）', () => {
    expect(matchTextToDecision("好的！")).toEqual({ kind: "allow-once" });
  });

  it('"yes." → allow-once（英文句点）', () => {
    expect(matchTextToDecision("yes.")).toEqual({ kind: "allow-once" });
  });

  it('"Yes!" → allow-once（英文感叹号）', () => {
    expect(matchTextToDecision("Yes!")).toEqual({ kind: "allow-once" });
  });

  it('"可以～" → allow-once（波浪号）', () => {
    expect(matchTextToDecision("可以～")).toEqual({ kind: "allow-once" });
  });

  it('"同意，" → allow-once（中文逗号）', () => {
    expect(matchTextToDecision("同意，")).toEqual({ kind: "allow-once" });
  });

  it('"不行！" → deny（拒绝词 + 标点）', () => {
    expect(matchTextToDecision("不行！")).toEqual({ kind: "deny" });
  });

  it('"no?" → deny', () => {
    expect(matchTextToDecision("no?")).toEqual({ kind: "deny" });
  });
});

// ─── NFKC 归一化（全角字母识别） ───

describe("matchTextToDecision — NFKC 归一化", () => {
  it('"ｙｅｓ"（全角）→ allow-once', () => {
    expect(matchTextToDecision("ｙｅｓ")).toEqual({ kind: "allow-once" });
  });

  it('"Ｙｅｓ"（全角 + 大写）→ allow-once', () => {
    expect(matchTextToDecision("Ｙｅｓ")).toEqual({ kind: "allow-once" });
  });

  it('"Ｏｋ。"（全角 + 末尾中文句号）→ allow-once', () => {
    expect(matchTextToDecision("Ｏｋ。")).toEqual({ kind: "allow-once" });
  });

  it('"ｎｏ"（全角）→ deny', () => {
    expect(matchTextToDecision("ｎｏ")).toEqual({ kind: "deny" });
  });
});

// ─── deny（自由文本 reason）（自由文本） ───

describe("matchTextToDecision — deny（自由文本 reason）（内部标点保留）", () => {
  it("自由文本 → deny（自由文本 reason），保留原文含内部标点", () => {
    const text = "不要删数据库！那是生产环境";
    const result = matchTextToDecision(text);
    expect(result).toEqual({ kind: "deny", reason: text });
    if (result.kind === "deny") {
      expect(result.reason).toContain("！");
    }
  });

  it("带换行的多行理由原样保留", () => {
    const text = "line1\nline2\nline3";
    expect(matchTextToDecision(text)).toEqual({
      kind: "deny",
      reason: text,
    });
  });

  it("非集合内的短词（如 '好啊我知道了'）→ deny（自由文本 reason） 不误判为 allow", () => {
    const text = "好啊我知道了";
    const result = matchTextToDecision(text);
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toBe(text);
    }
  });

  it("前后空白 trim，但内部空白保留", () => {
    const result = matchTextToDecision("  hello world  ");
    expect(result).toEqual({ kind: "deny", reason: "hello world" });
  });
});

// ─── MAX_REASON_LENGTH 截断 ───

describe("matchTextToDecision — reason 长度截断", () => {
  it("超长 reason 截断到 MAX_REASON_LENGTH + 省略标注", () => {
    const long = "x".repeat(MAX_REASON_LENGTH + 100);
    const result = matchTextToDecision(long);
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason.length).toBe(MAX_REASON_LENGTH + "…（理由已截断）".length);
      expect(result.reason).toMatch(/…（理由已截断）$/u);
      expect(result.reason.startsWith("x".repeat(MAX_REASON_LENGTH))).toBe(true);
    }
  });

  it("恰好 MAX_REASON_LENGTH 长度不截断", () => {
    const exact = "y".repeat(MAX_REASON_LENGTH);
    const result = matchTextToDecision(exact);
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toBe(exact);
      expect(result.reason).not.toMatch(/已截断/);
    }
  });
});

// ─── formatResolutionReceipt ───

describe("formatResolutionReceipt", () => {
  it("ok=false → 已被处理提示", () => {
    const req = makeRequest("写入文件");
    expect(
      formatResolutionReceipt(req, { kind: "allow-once" }, false),
    ).toContain("已被处理");
  });

  it("allow-once → ✅ 已允许", () => {
    const req = makeRequest("Bash 命令");
    expect(
      formatResolutionReceipt(req, { kind: "allow-once" }, true),
    ).toBe("✅ 已允许：Bash 命令");
  });

  it("deny → ❌ 已拒绝", () => {
    const req = makeRequest("Bash 命令");
    expect(formatResolutionReceipt(req, { kind: "deny" }, true)).toBe(
      "❌ 已拒绝：Bash 命令",
    );
  });

  it("deny（自由文本 reason） → ❌ 已拒绝 + 理由段", () => {
    const req = makeRequest("Bash 命令");
    const msg = formatResolutionReceipt(
      req,
      { kind: "deny", reason: "不要碰生产数据" },
      true,
    );
    expect(msg).toContain("❌ 已拒绝：Bash 命令");
    expect(msg).toContain("理由已转给 AI：不要碰生产数据");
  });
});
