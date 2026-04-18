import { describe, expect, it } from "vitest";
import {
  classifyByKeywords,
  evaluateScenario,
  resolveCurrentHint,
  resolveInitialHint,
} from "../scenario-evaluator.js";
import {
  AUTONOMOUS_PROFILE,
  INTERACTIVE_PROFILE,
  LOOKUP_PROFILE,
  hintLevel,
  hintToProfile,
} from "../context-profile.js";
import type { ScenarioHint } from "../context-profile.js";

// ─── classifyByKeywords ───

describe("classifyByKeywords", () => {
  describe("lookup detection", () => {
    it("classifies factual Chinese questions as lookup", () => {
      expect(classifyByKeywords("今天天气怎么样")).toBe("lookup");
      expect(classifyByKeywords("什么是微服务？")).toBe("lookup");
      expect(classifyByKeywords("Python 3.13 新特性是什么")).toBe("lookup");
    });

    it("classifies factual English questions as lookup", () => {
      expect(classifyByKeywords("what is a monad?")).toBe("lookup");
      expect(classifyByKeywords("how many planets are there?")).toBe("lookup");
      expect(classifyByKeywords("define polymorphism")).toBe("lookup");
    });

    it("does not classify code tasks as lookup", () => {
      expect(classifyByKeywords("帮我重构这个函数")).toBeNull();
      expect(classifyByKeywords("实现一个排序算法")).toBeNull();
      expect(classifyByKeywords("fix the authentication bug")).toBeNull();
    });

    it("does not classify long messages as lookup", () => {
      const longMsg = "请帮我理解这段代码的含义，它在项目中的作用是什么，以及如何改进它来提高性能和可维护性";
      expect(classifyByKeywords(longMsg)).toBeNull();
    });

    it("does not classify messages with file paths as lookup", () => {
      expect(classifyByKeywords("什么是 src/auth.ts")).toBeNull();
    });
  });

  describe("social detection", () => {
    it("classifies social Chinese messages", () => {
      expect(classifyByKeywords("给张三发消息")).toBe("social");
      expect(classifyByKeywords("他最近对我很冷淡")).toBe("social");
      expect(classifyByKeywords("联系他同事")).toBe("social");
    });

    it("classifies social English messages", () => {
      expect(classifyByKeywords("talk to him about the project")).toBe("social");
    });

    it("classifies relationship analysis requests", () => {
      expect(classifyByKeywords("关系怎么处理建议")).toBe("social");
    });
  });

  describe("null (interactive default)", () => {
    it("returns null for code-related messages", () => {
      expect(classifyByKeywords("帮我重构这个函数")).toBeNull();
      expect(classifyByKeywords("review this pull request")).toBeNull();
      expect(classifyByKeywords("解释这段代码")).toBeNull();
    });

    it("returns null for empty messages", () => {
      expect(classifyByKeywords("")).toBeNull();
      expect(classifyByKeywords("  ")).toBeNull();
    });
  });
});

// ─── resolveInitialHint (Turn 1) ───

describe("resolveInitialHint", () => {
  it("returns hintOverride when provided (business code hardcode)", () => {
    expect(
      resolveInitialHint({
        hintOverride: "autonomous",
        userMessage: "今天天气怎么样",
      }),
    ).toBe("autonomous");
  });

  it("uses keyword classifier when no override", () => {
    expect(
      resolveInitialHint({ userMessage: "今天天气怎么样" }),
    ).toBe("lookup");

    expect(
      resolveInitialHint({ userMessage: "给张三发消息" }),
    ).toBe("social");
  });

  it("defaults to interactive when no match", () => {
    expect(
      resolveInitialHint({ userMessage: "帮我重构这个函数" }),
    ).toBe("interactive");
  });
});

// ─── resolveCurrentHint (Turn 2+) ───

describe("resolveCurrentHint", () => {
  it("returns autonomous unchanged (runtime immutable)", () => {
    expect(
      resolveCurrentHint({
        currentHint: "autonomous",
        agentEscalation: "interactive",
        turnCount: 10,
      }),
    ).toBe("autonomous");
  });

  describe("monotonic upgrade", () => {
    it("allows upgrade from lookup to interactive", () => {
      expect(
        resolveCurrentHint({
          currentHint: "lookup",
          agentEscalation: "interactive",
          turnCount: 1,
        }),
      ).toBe("interactive");
    });

    it("allows upgrade from interactive to social", () => {
      expect(
        resolveCurrentHint({
          currentHint: "interactive",
          agentEscalation: "social",
          turnCount: 5,
        }),
      ).toBe("social");
    });

    it("rejects downgrade from interactive to lookup", () => {
      expect(
        resolveCurrentHint({
          currentHint: "interactive",
          agentEscalation: "lookup",
          turnCount: 5,
        }),
      ).toBe("interactive");
    });

    it("rejects downgrade from social to interactive", () => {
      expect(
        resolveCurrentHint({
          currentHint: "social",
          agentEscalation: "interactive",
          turnCount: 5,
        }),
      ).toBe("social");
    });
  });

  describe("lookup auto-upgrade guard", () => {
    it("upgrades lookup to interactive on mutation", () => {
      expect(
        resolveCurrentHint({
          currentHint: "lookup",
          prevAgentDidMutation: true,
          turnCount: 1,
        }),
      ).toBe("interactive");
    });

    it("upgrades lookup to interactive after 3 turns", () => {
      expect(
        resolveCurrentHint({
          currentHint: "lookup",
          turnCount: 4,
        }),
      ).toBe("interactive");
    });

    it("keeps lookup within 3 turns without mutation", () => {
      expect(
        resolveCurrentHint({
          currentHint: "lookup",
          turnCount: 2,
        }),
      ).toBe("lookup");
    });
  });

  describe("sticky behavior", () => {
    it("preserves interactive without escalation", () => {
      expect(
        resolveCurrentHint({
          currentHint: "interactive",
          turnCount: 10,
        }),
      ).toBe("interactive");
    });

    it("preserves social without escalation", () => {
      expect(
        resolveCurrentHint({
          currentHint: "social",
          turnCount: 10,
        }),
      ).toBe("social");
    });
  });
});

// ─── evaluateScenario (convenience) ───

describe("evaluateScenario", () => {
  it("uses resolveInitialHint for turnCount=0", () => {
    expect(
      evaluateScenario({
        turnCount: 0,
        userMessage: "今天天气怎么样",
      }),
    ).toBe("lookup");
  });

  it("uses resolveCurrentHint for turnCount>0", () => {
    expect(
      evaluateScenario({
        turnCount: 5,
        userMessage: "继续",
        currentHint: "interactive",
        agentEscalation: "social",
      }),
    ).toBe("social");
  });

  it("treats undefined currentHint as Turn 1", () => {
    expect(
      evaluateScenario({
        turnCount: 3,
        userMessage: "给张三发消息",
        currentHint: undefined,
      }),
    ).toBe("social");
  });
});

// ─── hintLevel ───

describe("hintLevel", () => {
  it("orders lookup < interactive < social", () => {
    expect(hintLevel("lookup")).toBeLessThan(hintLevel("interactive"));
    expect(hintLevel("interactive")).toBeLessThan(hintLevel("social"));
  });

  it("autonomous is outside the ordering", () => {
    expect(hintLevel("autonomous")).toBe(-1);
  });
});

// ─── hintToProfile ───

describe("hintToProfile", () => {
  it("maps interactive to INTERACTIVE_PROFILE", () => {
    const profile = hintToProfile("interactive");
    expect(profile.name).toBe("interactive");
    expect(profile.includeProfile).toBe(true);
    expect(profile.layer2Mode).toBe("basic");
  });

  it("maps social to INTERACTIVE with enriched layer2", () => {
    const profile = hintToProfile("social");
    expect(profile.name).toBe("interactive");
    expect(profile.layer2Mode).toBe("enriched");
    expect(profile.includeProfile).toBe(true);
  });

  it("maps autonomous to AUTONOMOUS_PROFILE", () => {
    const profile = hintToProfile("autonomous");
    expect(profile.name).toBe("autonomous");
    expect(profile.includeProfile).toBe(false);
    expect(profile.onExhausted).toBe("yield-event-to-parent");
  });

  it("maps lookup to LOOKUP_PROFILE", () => {
    const profile = hintToProfile("lookup");
    expect(profile.name).toBe("lookup");
    expect(profile.includeProfile).toBe(false);
    expect(profile.layer2Mode).toBe("skip");
    expect(profile.tierThresholds).toBeNull();
  });

  it("interactive profile has all tool categories", () => {
    const profile = hintToProfile("interactive");
    expect(profile.toolCategories).toContain("query");
    expect(profile.toolCategories).toContain("mutation");
    expect(profile.toolCategories).toContain("execution");
    expect(profile.toolCategories).toContain("memory-write");
    expect(profile.toolCategories).toContain("task-ledger");
    expect(profile.toolCategories).toContain("social");
    expect(profile.toolCategories).toContain("scenario");
  });

  it("lookup profile only has query + scenario", () => {
    const profile = hintToProfile("lookup");
    expect(profile.toolCategories).toEqual(["query", "scenario"]);
  });
});

// ─── ContextProfile correctness ───

describe("ContextProfile built-in values", () => {
  it("interactive has correct budget thresholds", () => {
    expect(INTERACTIVE_PROFILE.budgetThresholds).toEqual({
      warning: 0.65,
      compact: 0.80,
      critical: 0.90,
    });
  });

  it("interactive has correct tier thresholds", () => {
    expect(INTERACTIVE_PROFILE.tierThresholds).toEqual({
      T1: 2,
      T2: 8,
      T3: 30,
    });
  });

  it("autonomous has tighter budget thresholds", () => {
    expect(AUTONOMOUS_PROFILE.budgetThresholds.compact).toBeLessThan(
      INTERACTIVE_PROFILE.budgetThresholds.compact,
    );
  });

  it("autonomous has tighter tier thresholds", () => {
    expect(AUTONOMOUS_PROFILE.tierThresholds!.T2).toBeLessThan(
      INTERACTIVE_PROFILE.tierThresholds!.T2,
    );
  });

  it("lookup has no tier thresholds", () => {
    expect(LOOKUP_PROFILE.tierThresholds).toBeNull();
  });

  it("social profile does not mutate INTERACTIVE_PROFILE", () => {
    hintToProfile("social");
    expect(INTERACTIVE_PROFILE.layer2Mode).toBe("basic");
  });
});
