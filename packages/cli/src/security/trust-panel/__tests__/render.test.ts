/**
 * /trust 面板渲染纯函数测试。
 *
 * 断言策略：stripAnsi 后逐行文本断言。验证内容契约（标题 / 列头 / 列内容 /
 * 详情区 / 空态 / footer），不锁视觉细节（颜色、indent 长度）—— 避免渲染
 * 配置调整时测试要"陪改"。
 */

import { describe, expect, it } from "vitest";
import type { PermissionContextId, PermissionRule } from "@zhixing/core";
import { renderState, type RenderContext, type RenderState } from "../render.js";

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "");
const joined = (lines: string[]) => lines.map(strip).join("\n");

function makeRule(overrides: Partial<PermissionRule> & {
  id?: string;
  argument?: string;
}): PermissionRule {
  return {
    id: overrides.id ?? "rule-id-1234567890",
    pattern: {
      tool: overrides.pattern?.tool ?? "bash",
      argument: overrides.pattern?.argument ?? overrides.argument ?? "ls",
    },
    decision: overrides.decision ?? "allow",
    scope: overrides.scope ?? "context",
    createdAt: overrides.createdAt ?? 0,
    lastMatchedAt: overrides.lastMatchedAt ?? 0,
    matchCount: overrides.matchCount ?? 0,
    contextId: overrides.contextId ?? ({ kind: "main" } as PermissionContextId),
    contextPath: overrides.contextPath,
    contributors: overrides.contributors,
  };
}

const CTX: RenderContext = {
  agentDisplayName: "知行",
  now: 1_700_000_000_000,
};

describe("renderState — 列表/详情/空态", () => {
  describe("非空列表", () => {
    it("标题 + 列头 + 一行规则 + 详情区 + footer", () => {
      const rule = makeRule({
        id: "abcd1234-xyz",
        argument: "curl *",
        contributors: [
          { origin: "user", timestamp: CTX.now - 60_000 },
          { origin: "steward", timestamp: CTX.now - 30_000 },
        ],
        matchCount: 3,
        lastMatchedAt: CTX.now - 10 * 60_000,
      });
      const state: RenderState = {
        rules: [rule],
        selectedIndex: 0,
        deletePendingRuleId: null,
      };
      const out = joined(renderState(state, CTX));

      expect(out).toContain("已沉淀信任规则");
      expect(out).toContain("id");
      expect(out).toContain("生效范围");
      expect(out).toContain("contributors");
      expect(out).toContain("pattern");
      expect(out).toContain("abcd1234");
      expect(out).toContain("主模式");
      expect(out).toContain("[你 助理]");
      expect(out).toContain("curl *");
      expect(out).toContain("3 次");
      expect(out).toContain("详情");
      expect(out).toContain("累计放行记录");
      expect(out).toContain("(↑↓ 选");
      expect(out).toContain("ESC 退出");
    });

    it("选中行有箭头标识", () => {
      const r0 = makeRule({ id: "rule-a", argument: "a" });
      const r1 = makeRule({ id: "rule-b", argument: "b" });
      const out0 = joined(renderState({ rules: [r0, r1], selectedIndex: 0, deletePendingRuleId: null }, CTX));
      const out1 = joined(renderState({ rules: [r0, r1], selectedIndex: 1, deletePendingRuleId: null }, CTX));

      const arrowOnA0 = out0.split("\n").find((l) => l.includes("rule-a"))?.includes("> ");
      const arrowOnA1 = out1.split("\n").find((l) => l.includes("rule-a"))?.includes("> ");
      expect(arrowOnA0).toBe(true);
      expect(arrowOnA1).toBe(false);
    });

    it("contributors `[你 你 助理]` token 顺序与原数组一致", () => {
      const rule = makeRule({
        contributors: [
          { origin: "user", timestamp: 1 },
          { origin: "user", timestamp: 2 },
          { origin: "steward", timestamp: 3 },
        ],
      });
      const out = joined(renderState({ rules: [rule], selectedIndex: 0, deletePendingRuleId: null }, CTX));
      expect(out).toContain("[你 你 助理]");
    });

    it("详情区按时间顺序展开 contributors 完整时间戳", () => {
      const rule = makeRule({
        contributors: [
          { origin: "user", timestamp: 1_700_000_000_000 },
          { origin: "steward", timestamp: 1_700_000_001_000 },
        ],
      });
      const out = joined(renderState({ rules: [rule], selectedIndex: 0, deletePendingRuleId: null }, CTX));
      expect(out).toMatch(/1\. \[你\]/);
      expect(out).toMatch(/2\. \[安全助理\]/);
    });

    it("详情区不显示 contextPath 行（主模式无 workdir）", () => {
      const rule = makeRule({ contextId: { kind: "main" }, contextPath: undefined });
      const out = joined(renderState({ rules: [rule], selectedIndex: 0, deletePendingRuleId: null }, CTX));
      expect(out).not.toContain("工作目录");
    });

    it("详情区显示 contextPath 行（workspace 信任有 workdir）", () => {
      const rule = makeRule({
        contextId: { kind: "workspace", hash: "abc123" },
        contextPath: "/home/user/proj",
      });
      const out = joined(renderState({ rules: [rule], selectedIndex: 0, deletePendingRuleId: null }, CTX));
      expect(out).toContain("工作目录");
      expect(out).toContain("/home/user/proj");
    });

    it("workspace / scene 都显示「当前工作场景」（用户面统一术语）", () => {
      const wsRule = makeRule({ contextId: { kind: "workspace", hash: "x" } });
      const sceneRule = makeRule({ contextId: { kind: "scene", sceneId: "y" } });
      expect(joined(renderState({ rules: [wsRule], selectedIndex: 0, deletePendingRuleId: null }, CTX))).toContain("当前工作场景");
      expect(joined(renderState({ rules: [sceneRule], selectedIndex: 0, deletePendingRuleId: null }, CTX))).toContain("当前工作场景");
    });

    it("scope=global 显示「全局」", () => {
      const rule = makeRule({ scope: "global", contextId: undefined });
      const out = joined(renderState({ rules: [rule], selectedIndex: 0, deletePendingRuleId: null }, CTX));
      expect(out).toContain("全局");
    });

    it("deletePending 行带红底高亮（含 ANSI 背景色码）", () => {
      const rule = makeRule({ id: "to-delete" });
      const state: RenderState = {
        rules: [rule],
        selectedIndex: 0,
        deletePendingRuleId: "to-delete",
      };
      const rawLines = renderState(state, CTX);
      const pendingLine = rawLines.find((l) => strip(l).includes("to-delet"));
      // 红底 bg = ESC[41-47m 或 4 开头 + 8/9 等扩展色
      expect(pendingLine).toMatch(/\x1b\[[0-9;]*4[1-7][0-9;]*m/);
    });

    // 单轨架构守护：pending 行经 stripAnsi 后的字符布局必须与同规则非 pending
    // 行字符级一致 —— 这条断言锁死"pending 装饰器不重写列结构"的不变量，
    // 防止未来回退到双轨拼接（plain* helper）导致的列错位 UX 回归。
    it("pending 行 stripAnsi 后内容与非 pending 行字符级一致（单轨列对齐）", () => {
      const rule = makeRule({
        id: "row-align",
        contributors: [
          { origin: "user", timestamp: CTX.now - 60_000 },
          { origin: "steward", timestamp: CTX.now - 30_000 },
        ],
        matchCount: 5,
        lastMatchedAt: CTX.now - 5 * 60_000,
      });

      const normal = renderState({ rules: [rule], selectedIndex: 0, deletePendingRuleId: null }, CTX);
      const pending = renderState({ rules: [rule], selectedIndex: 0, deletePendingRuleId: "row-align" }, CTX);

      const normalRow = normal.find((l) => strip(l).includes("row-alig"));
      const pendingRow = pending.find((l) => strip(l).includes("row-alig"));
      expect(normalRow).toBeDefined();
      expect(pendingRow).toBeDefined();
      expect(strip(pendingRow!)).toBe(strip(normalRow!));
    });

    it("pending 行实际渲染含红底 + bold 控制码（视觉装饰未丢）", () => {
      const rule = makeRule({ id: "deco-check" });
      const lines = renderState({
        rules: [rule],
        selectedIndex: 0,
        deletePendingRuleId: "deco-check",
      }, CTX);
      const pendingRow = lines.find((l) => strip(l).includes("deco-che"));
      expect(pendingRow).toMatch(/\x1b\[[0-9;]*4[1-7][0-9;]*m/); // 背景色
      expect(pendingRow).toMatch(/\x1b\[[0-9;]*1[0-9;]*m/); // bold
    });

    it("未匹配规则 matched 列显示「未匹配」", () => {
      const rule = makeRule({ matchCount: 0 });
      const out = joined(renderState({ rules: [rule], selectedIndex: 0, deletePendingRuleId: null }, CTX));
      expect(out).toContain("未匹配");
    });
  });

  describe("空态", () => {
    it("空 rules → 显示引导文案 + Tip + ESC 退出提示", () => {
      const out = joined(renderState(
        { rules: [], selectedIndex: -1, deletePendingRuleId: null },
        CTX,
      ));
      expect(out).toContain("已沉淀信任规则");
      expect(out).toContain("没有建立信任规则");
      expect(out).toContain("Tip:");
      expect(out).toContain("知行");
      expect(out).toContain("[a]/[g]");
      expect(out).toContain("ESC 退出");
    });

    it("空态不显示列头与详情区", () => {
      const out = joined(renderState(
        { rules: [], selectedIndex: -1, deletePendingRuleId: null },
        CTX,
      ));
      expect(out).not.toContain("contributors");
      expect(out).not.toContain("详情");
    });
  });
});
