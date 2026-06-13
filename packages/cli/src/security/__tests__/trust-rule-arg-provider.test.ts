/**
 * trustRuleArgProvider 单元测试。
 *
 * 覆盖：
 * - list() 过滤 builtin（builtin 不进 /trust，归 /security）
 * - description 含「生效范围 · contributors · 匹配次数」三段紧凑信息
 * - contributors 渲染 [你 你 助理] token 序列（按时间顺序）
 * - scope 标签按 PermissionContextId.kind 分支（main / workspace+scene 都显「主模式」or「当前工作场景」/ global「全局」）
 * - inlineActions 声明 delete: true（启用 Ctrl+D 双击撤销）
 * - emptyHint 空态文案
 * - query 过滤大小写不敏感（匹配 tool / argument / id）
 */

import { describe, expect, it } from "vitest";
import {
  type ArgQueryContext,
  type CommandDef,
  type PermissionRule,
} from "@zhixing/core";
import { createTrustRuleArgProvider } from "../trust-rule-arg-provider.js";

// ─── 装配 ───

function makeRule(overrides: Partial<PermissionRule> & {
  argument?: string;
  tool?: string;
}): PermissionRule {
  return {
    id: overrides.id ?? `rule-${Math.random().toString(36).slice(2, 8)}`,
    pattern: {
      tool: overrides.pattern?.tool ?? overrides.tool ?? "bash",
      argument: overrides.pattern?.argument ?? overrides.argument ?? "ls",
    },
    decision: overrides.decision ?? "allow",
    scope: overrides.scope ?? "context",
    createdAt: overrides.createdAt ?? 0,
    lastMatchedAt: overrides.lastMatchedAt ?? 0,
    matchCount: overrides.matchCount ?? 0,
    contextId: overrides.contextId ?? { kind: "main" },
    contextPath: overrides.contextPath,
    contributors: overrides.contributors,
  };
}

/** 宿主 trust.list 的替身——builtin 过滤与语境派生在宿主,此处直接喂用户可管规则 */
function listRulesOf(rules: PermissionRule[]): () => Promise<PermissionRule[]> {
  return async () => rules;
}

function makeCtx(query = ""): ArgQueryContext {
  return {
    query,
    command: { id: "trust:repl", name: "trust" } as unknown as CommandDef,
    argIndex: 0,
    runtime: {
      sessionBusy: false,
      workspaceId: null,
      cwd: "/tmp",
      target: "cli",
      features: {},
      now: Date.now(),
    },
  };
}

const NEVER_ABORT = new AbortController().signal;

// ─── 测试 ───

describe("trustRuleArgProvider", () => {
  describe("候选过滤", () => {
    it("候选原样渲染注入列表(builtin 过滤与语境派生由宿主 trust.list 保证)", async () => {
      const user = makeRule({ id: "user-y", tool: "bash", argument: "ls" });
      const provider = createTrustRuleArgProvider(listRulesOf([user]));

      const choices = await provider.list(makeCtx(), NEVER_ABORT);
      const values = choices.map((c) => (typeof c === "string" ? c : c.value));
      expect(values).toEqual(["user-y"]);
    });

    it("query 大小写不敏感匹配 tool / argument / id", async () => {
      const a = makeRule({ id: "abc-curl-rule", tool: "bash", argument: "curl *" });
      const b = makeRule({ id: "xyz-write-rule", tool: "write", argument: "src/**" });
      const listRules = listRulesOf([a, b]);
      const provider = createTrustRuleArgProvider(listRules);

      const byTool = await provider.list(makeCtx("WRITE"), NEVER_ABORT);
      expect(byTool.map((c) => (typeof c === "string" ? c : c.value))).toEqual(["xyz-write-rule"]);

      const byArg = await provider.list(makeCtx("curl"), NEVER_ABORT);
      expect(byArg.map((c) => (typeof c === "string" ? c : c.value))).toEqual(["abc-curl-rule"]);

      const byId = await provider.list(makeCtx("xyz"), NEVER_ABORT);
      expect(byId.map((c) => (typeof c === "string" ? c : c.value))).toEqual(["xyz-write-rule"]);
    });

    it("signal abort 提前返回空数组", async () => {
      const listRules = listRulesOf([makeRule({ id: "r1" })]);
      const provider = createTrustRuleArgProvider(listRules);
      const ac = new AbortController();
      ac.abort();
      const choices = await provider.list(makeCtx(), ac.signal);
      expect(choices).toEqual([]);
    });
  });

  describe("候选 description 紧凑信息", () => {
    it("description 含「生效范围 · contributors · 匹配次数」三段", async () => {
      const rule = makeRule({
        id: "r1",
        tool: "bash",
        argument: "curl *",
        matchCount: 3,
        contributors: [
          { origin: "user", timestamp: 1 },
          { origin: "user", timestamp: 2 },
          { origin: "steward", timestamp: 3 },
        ],
      });
      const listRules = listRulesOf([rule]);
      const provider = createTrustRuleArgProvider(listRules);

      const [choice] = await provider.list(makeCtx(), NEVER_ABORT);
      if (typeof choice !== "object") throw new Error("expected object choice");
      expect(choice.description).toContain("主模式");
      expect(choice.description).toContain("[你 你 助理]");
      expect(choice.description).toContain("3 次");
    });

    it("label = tool + argument", async () => {
      const rule = makeRule({ tool: "bash", argument: "npm install *" });
      const listRules = listRulesOf([rule]);
      const provider = createTrustRuleArgProvider(listRules);
      const [choice] = await provider.list(makeCtx(), NEVER_ABORT);
      if (typeof choice !== "object") throw new Error("expected object choice");
      expect(choice.label).toBe("bash npm install *");
    });

    it("未匹配规则显示「未匹配」而非 0 次", async () => {
      const rule = makeRule({ matchCount: 0 });
      const listRules = listRulesOf([rule]);
      const provider = createTrustRuleArgProvider(listRules);
      const [choice] = await provider.list(makeCtx(), NEVER_ABORT);
      if (typeof choice !== "object") throw new Error("expected object choice");
      expect(choice.description).toContain("未匹配");
    });

    it("contributors 为空时显示 [—]", async () => {
      const rule = makeRule({ contributors: undefined });
      const listRules = listRulesOf([rule]);
      const provider = createTrustRuleArgProvider(listRules);
      const [choice] = await provider.list(makeCtx(), NEVER_ABORT);
      if (typeof choice !== "object") throw new Error("expected object choice");
      expect(choice.description).toContain("[—]");
    });
  });

  describe("scope 标签按 PermissionContextId.kind 分支", () => {
    it("main → 「主模式」", async () => {
      const listRules = listRulesOf([
        makeRule({ contextId: { kind: "main" } }),
      ]);
      const provider = createTrustRuleArgProvider(listRules);
      const [choice] = await provider.list(makeCtx(), NEVER_ABORT);
      if (typeof choice !== "object") throw new Error("expected object");
      expect(choice.description).toContain("主模式");
    });

    it("global scope → 「全局」", async () => {
      const listRules = listRulesOf([
        makeRule({ scope: "global", contextId: undefined }),
      ]);
      const provider = createTrustRuleArgProvider(listRules);
      const [choice] = await provider.list(makeCtx(), NEVER_ABORT);
      if (typeof choice !== "object") throw new Error("expected object");
      expect(choice.description).toContain("全局");
    });
  });

  describe("inlineActions + emptyHint 静态声明", () => {
    it("声明 delete: true（启用 Ctrl+D 双击撤销协议）", () => {
      const listRules = listRulesOf([]);
      const provider = createTrustRuleArgProvider(listRules);
      expect(provider.inlineActions).toEqual({ delete: true });
    });

    it("emptyHint 包含创建规则引导文案", () => {
      const listRules = listRulesOf([]);
      const provider = createTrustRuleArgProvider(listRules);
      expect(provider.emptyHint).toContain("[a]/[g]");
    });
  });
});
