import { describe, it, expect } from "vitest";
import type { InboundMessage } from "@zhixing/core";
import {
  APPROVE_KEYWORDS,
  DENY_KEYWORDS,
} from "../../confirmation/match.js";
import { DEFAULT_CANCEL_KEYWORDS } from "../cancel-keywords.js";
import { createDefaultIntentClassifier } from "../intent-classifier.js";

function buildMsg(text: string): InboundMessage {
  return {
    channelId: "test",
    messageId: "m1",
    from: "u1",
    text,
    receivedAt: new Date().toISOString(),
  };
}

describe("createDefaultIntentClassifier", () => {
  describe("默认行为(无 confirmation 校验注入)", () => {
    const classifier = createDefaultIntentClassifier();

    it("空文本 → non-control", () => {
      expect(classifier.classify(buildMsg("")).kind).toBe("non-control");
      expect(classifier.classify(buildMsg("   ")).kind).toBe("non-control");
    });

    it("非关键词文本 → non-control", () => {
      expect(classifier.classify(buildMsg("hello")).kind).toBe("non-control");
      expect(classifier.classify(buildMsg("帮我写代码")).kind).toBe("non-control");
    });

    it("精确命中 cancel 关键词 → control + matchedKeyword", () => {
      const intent = classifier.classify(buildMsg("/cancel"));
      expect(intent.kind).toBe("control");
      if (intent.kind === "control") {
        expect(intent.control.kind).toBe("cancel");
        expect(intent.control.matchedKeyword).toBe("/cancel");
      }
    });

    it("中文 cancel 关键词", () => {
      const intent = classifier.classify(buildMsg("中止"));
      expect(intent.kind).toBe("control");
    });

    it.each(["停止", "停下", "中止", "中断", "终止", "停", "取消", "打住"])(
      "中文控制命令型词 '%s' 命中 cancel",
      (kw) => {
        const intent = classifier.classify(buildMsg(kw));
        expect(intent.kind).toBe("control");
        if (intent.kind === "control") {
          expect(intent.control.kind).toBe("cancel");
        }
      },
    );

    it.each(["stop", "cancel", "/cancel", "/stop", "/abort"])(
      "英文/控制命令 '%s' 命中 cancel",
      (kw) => {
        const intent = classifier.classify(buildMsg(kw));
        expect(intent.kind).toBe("control");
        if (intent.kind === "control") {
          expect(intent.control.kind).toBe("cancel");
        }
      },
    );

    it("'停止' 末尾标点 trim 后命中(IM 习惯)", () => {
      expect(classifier.classify(buildMsg("停止。")).kind).toBe("control");
      expect(classifier.classify(buildMsg("停下!")).kind).toBe("control");
    });

    it("大小写无关", () => {
      expect(classifier.classify(buildMsg("/CANCEL")).kind).toBe("control");
      expect(classifier.classify(buildMsg("/STOP")).kind).toBe("control");
    });

    it("末尾标点/空白 trim(IM 习惯,与 confirmation/match 同源)", () => {
      expect(classifier.classify(buildMsg("/cancel。")).kind).toBe("control");
      expect(classifier.classify(buildMsg("中止!")).kind).toBe("control");
      expect(classifier.classify(buildMsg("/cancel  ")).kind).toBe("control");
    });

    it("substring 不算命中(避免'我想取消订阅'误触)", () => {
      expect(classifier.classify(buildMsg("我想中止订阅")).kind).toBe("non-control");
      expect(classifier.classify(buildMsg("please /cancel my order")).kind).toBe(
        "non-control",
      );
    });

    it("NFKC 半角化(全角输入产出的全角斜杠/字符)", () => {
      // 全角 / + cancel
      expect(classifier.classify(buildMsg("/cancel")).kind).toBe("control");
    });

    it("matchedKeyword 字段返回原始字面值(诊断用)", () => {
      const intent = classifier.classify(buildMsg("/CANCEL"));
      expect(intent.kind).toBe("control");
      if (intent.kind === "control") {
        // 原始 cancel-keywords 列表里是 "/cancel"(小写),命中后返回该字面
        expect(intent.control.matchedKeyword).toBe("/cancel");
      }
    });
  });

  describe("自定义 cancelKeywords", () => {
    it("传空数组 → 永不命中(关闭 cancel 能力)", () => {
      const classifier = createDefaultIntentClassifier({ cancelKeywords: [] });
      expect(classifier.classify(buildMsg("/cancel")).kind).toBe("non-control");
      expect(classifier.classify(buildMsg("中止")).kind).toBe("non-control");
    });

    it("自定义关键词集替换默认", () => {
      const classifier = createDefaultIntentClassifier({
        cancelKeywords: ["停手", "halt"],
      });
      expect(classifier.classify(buildMsg("停手")).kind).toBe("control");
      expect(classifier.classify(buildMsg("HALT")).kind).toBe("control");
      // 默认关键词不再生效
      expect(classifier.classify(buildMsg("/cancel")).kind).toBe("non-control");
    });
  });

  describe("启动期互斥校验", () => {
    it("默认 cancel 词集 ∩ confirmation APPROVE/DENY = ∅,通过校验不抛", () => {
      expect(() =>
        createDefaultIntentClassifier({
          confirmationApproveKeywords: APPROVE_KEYWORDS,
          confirmationDenyKeywords: DENY_KEYWORDS,
        }),
      ).not.toThrow();
    });

    it("cancel 词与 approve 冲突 → throw,fail-fast", () => {
      expect(() =>
        createDefaultIntentClassifier({
          cancelKeywords: ["yes"],
          confirmationApproveKeywords: APPROVE_KEYWORDS,
          confirmationDenyKeywords: DENY_KEYWORDS,
        }),
      ).toThrow(/disjoint/i);
    });

    it("cancel 词与 deny 冲突 → throw,fail-fast", () => {
      expect(() =>
        createDefaultIntentClassifier({
          cancelKeywords: ["算了"],
          confirmationApproveKeywords: APPROVE_KEYWORDS,
          confirmationDenyKeywords: DENY_KEYWORDS,
        }),
      ).toThrow(/disjoint/i);
    });

    it("错误信息列出冲突词与冲突所在集", () => {
      try {
        createDefaultIntentClassifier({
          cancelKeywords: ["算了", "yes"],
          confirmationApproveKeywords: APPROVE_KEYWORDS,
          confirmationDenyKeywords: DENY_KEYWORDS,
        });
        expect.fail("expected throw");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain("算了");
        expect(msg).toContain("yes");
        expect(msg).toContain("approve");
        expect(msg).toContain("deny");
      }
    });

    it("不传 confirmation 词集 → 跳过校验(测试 / 单独使用场景)", () => {
      // 显式传冲突词,但不传 confirmation 词集 → 不校验,不抛
      expect(() =>
        createDefaultIntentClassifier({ cancelKeywords: ["算了"] }),
      ).not.toThrow();
    });

    it("校验是规范化后的(全角/大小写/标点都参与对比)", () => {
      expect(() =>
        createDefaultIntentClassifier({
          cancelKeywords: ["YES"],
          confirmationApproveKeywords: APPROVE_KEYWORDS,
          confirmationDenyKeywords: DENY_KEYWORDS,
        }),
      ).toThrow(/disjoint/i);
    });
  });
});

describe("DEFAULT_CANCEL_KEYWORDS", () => {
  it("与 confirmation APPROVE/DENY 必须完全不相交(硬不变量)", () => {
    const approveSet = new Set(APPROVE_KEYWORDS.map((s) => s.toLowerCase()));
    const denySet = new Set(DENY_KEYWORDS.map((s) => s.toLowerCase()));
    const conflicts: string[] = [];
    for (const kw of DEFAULT_CANCEL_KEYWORDS) {
      const k = kw.toLowerCase();
      if (approveSet.has(k)) conflicts.push(`${kw}(approve)`);
      if (denySet.has(k)) conflicts.push(`${kw}(deny)`);
    }
    expect(conflicts).toEqual([]);
  });
});
