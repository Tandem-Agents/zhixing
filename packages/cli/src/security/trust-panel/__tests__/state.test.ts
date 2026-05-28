/**
 * /trust 面板 reducer 纯函数测试。
 *
 * 覆盖 invariant：
 * - init / 空列表初始 selectedIndex=-1
 * - move clamp 边界（首条上、末条下、空列表）
 * - 任意移动清除 deletePending
 * - 双击 d 在同一规则 → revoke effect
 * - 切换选中后再按 d → 重新计数（不直接 revoke）
 * - rules-reloaded 自动指向"原下一条"，末尾被删退回末尾
 * - exit 输出 exit effect
 */

import { describe, expect, it } from "vitest";
import type { PermissionRule } from "@zhixing/core";
import {
  createInitialState,
  reduce,
  type TrustPanelState,
} from "../state.js";

function makeRule(id: string, argument = "*"): PermissionRule {
  return {
    id,
    pattern: { tool: "bash", argument },
    decision: "allow",
    scope: "context",
    createdAt: 0,
    lastMatchedAt: 0,
    matchCount: 0,
    contextId: { kind: "main" },
  };
}

function stateWithRules(rules: PermissionRule[]): TrustPanelState {
  return reduce(createInitialState(), { kind: "init", rules }).state;
}

describe("trust-panel reducer", () => {
  describe("init", () => {
    it("非空列表初始 selectedIndex=0", () => {
      const s = stateWithRules([makeRule("a"), makeRule("b")]);
      expect(s.selectedIndex).toBe(0);
      expect(s.deletePendingRuleId).toBeNull();
    });

    it("空列表 selectedIndex=-1", () => {
      const s = stateWithRules([]);
      expect(s.selectedIndex).toBe(-1);
    });

    it("init 清除既有 deletePending", () => {
      const s0 = stateWithRules([makeRule("a")]);
      const s1 = reduce(s0, { kind: "request-delete" }).state;
      expect(s1.deletePendingRuleId).toBe("a");
      const s2 = reduce(s1, { kind: "init", rules: [makeRule("x")] }).state;
      expect(s2.deletePendingRuleId).toBeNull();
    });
  });

  describe("move", () => {
    it("向下移动 +1，不越过末尾", () => {
      const s = stateWithRules([makeRule("a"), makeRule("b"), makeRule("c")]);
      const s1 = reduce(s, { kind: "move", delta: 1 }).state;
      expect(s1.selectedIndex).toBe(1);
      const s2 = reduce(s1, { kind: "move", delta: 1 }).state;
      expect(s2.selectedIndex).toBe(2);
      const s3 = reduce(s2, { kind: "move", delta: 1 }).state;
      expect(s3.selectedIndex).toBe(2);
    });

    it("向上移动 -1，不越过首条", () => {
      const s = stateWithRules([makeRule("a"), makeRule("b")]);
      const s1 = reduce(s, { kind: "move", delta: 1 }).state;
      const s2 = reduce(s1, { kind: "move", delta: -1 }).state;
      expect(s2.selectedIndex).toBe(0);
      const s3 = reduce(s2, { kind: "move", delta: -1 }).state;
      expect(s3.selectedIndex).toBe(0);
    });

    it("空列表 move 无效果", () => {
      const s = stateWithRules([]);
      const s1 = reduce(s, { kind: "move", delta: 1 }).state;
      expect(s1).toBe(s);
    });

    it("move 清除 deletePending", () => {
      const s = stateWithRules([makeRule("a"), makeRule("b")]);
      const s1 = reduce(s, { kind: "request-delete" }).state;
      expect(s1.deletePendingRuleId).toBe("a");
      const s2 = reduce(s1, { kind: "move", delta: 1 }).state;
      expect(s2.deletePendingRuleId).toBeNull();
      expect(s2.selectedIndex).toBe(1);
    });
  });

  describe("request-delete 双击协议", () => {
    it("第一次 d → 标 deletePending，无 effect", () => {
      const s = stateWithRules([makeRule("a")]);
      const r = reduce(s, { kind: "request-delete" });
      expect(r.state.deletePendingRuleId).toBe("a");
      expect(r.effect).toBeUndefined();
    });

    it("第二次 d on same rule → revoke effect", () => {
      const s = stateWithRules([makeRule("a")]);
      const s1 = reduce(s, { kind: "request-delete" }).state;
      const r2 = reduce(s1, { kind: "request-delete" });
      expect(r2.effect).toEqual({ kind: "revoke", ruleId: "a" });
      expect(r2.state.deletePendingRuleId).toBeNull();
    });

    it("切换选中再按 d → 重新标 pending、不 revoke", () => {
      const s = stateWithRules([makeRule("a"), makeRule("b")]);
      const s1 = reduce(s, { kind: "request-delete" }).state;
      const s2 = reduce(s1, { kind: "move", delta: 1 }).state;
      const r3 = reduce(s2, { kind: "request-delete" });
      expect(r3.effect).toBeUndefined();
      expect(r3.state.deletePendingRuleId).toBe("b");
    });

    it("空列表 request-delete 无效果", () => {
      const s = stateWithRules([]);
      const r = reduce(s, { kind: "request-delete" });
      expect(r.state).toBe(s);
      expect(r.effect).toBeUndefined();
    });
  });

  describe("rules-reloaded（撤销后回灌）", () => {
    it("撤销中间一条 → selectedIndex 不变，自然指向原下一条", () => {
      const s = stateWithRules([makeRule("a"), makeRule("b"), makeRule("c")]);
      const s1 = reduce(s, { kind: "move", delta: 1 }).state;
      expect(s1.selectedIndex).toBe(1);
      const s2 = reduce(s1, {
        kind: "rules-reloaded",
        rules: [makeRule("a"), makeRule("c")],
      }).state;
      expect(s2.selectedIndex).toBe(1);
      expect(s2.rules[s2.selectedIndex]?.id).toBe("c");
    });

    it("撤销末尾一条 → selectedIndex 退回新末尾", () => {
      const s = stateWithRules([makeRule("a"), makeRule("b")]);
      const s1 = reduce(s, { kind: "move", delta: 1 }).state;
      expect(s1.selectedIndex).toBe(1);
      const s2 = reduce(s1, {
        kind: "rules-reloaded",
        rules: [makeRule("a")],
      }).state;
      expect(s2.selectedIndex).toBe(0);
    });

    it("撤销最后一条 → 列表空，selectedIndex=-1", () => {
      const s = stateWithRules([makeRule("a")]);
      const s1 = reduce(s, {
        kind: "rules-reloaded",
        rules: [],
      }).state;
      expect(s1.selectedIndex).toBe(-1);
      expect(s1.rules).toHaveLength(0);
    });

    it("rules-reloaded 清除 deletePending", () => {
      const s = stateWithRules([makeRule("a"), makeRule("b")]);
      const s1 = reduce(s, { kind: "request-delete" }).state;
      expect(s1.deletePendingRuleId).toBe("a");
      const s2 = reduce(s1, {
        kind: "rules-reloaded",
        rules: [makeRule("a"), makeRule("b")],
      }).state;
      expect(s2.deletePendingRuleId).toBeNull();
    });
  });

  describe("exit", () => {
    it("exit action → exit effect", () => {
      const s = stateWithRules([makeRule("a")]);
      const r = reduce(s, { kind: "exit" });
      expect(r.effect).toEqual({ kind: "exit" });
      expect(r.state).toBe(s);
    });
  });
});
