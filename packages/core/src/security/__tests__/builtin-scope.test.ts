/**
 * PermissionStore builtin scope + 两阶段匹配单元测试 (M4)
 *
 * 覆盖：
 * - 两阶段匹配：用户池命中 → builtin 不参与；用户池空 → builtin 接管
 * - 用户通配 deny + builtin 高特异性 allow → user 决定（产品语义保证）
 * - registerBuiltinRules namespace 追加式（多源支持）
 * - registerBuiltinRules 严格 scope 校验（throw 非 silent override）
 * - registerBuiltinRules 空数组 = 删除 namespace
 * - resetAll **不**清 builtin（boot-time 系统配置）
 * - create("builtin", ...) 抛错（builtin 应走 registerBuiltinRules）
 * - 老 user 规则（仅含旧 3 态 scope）反序列化兼容（M4 新增 "builtin" union 不破坏老文件）
 * - sanitizeRules 拒绝磁盘上的 builtin scope（防御性，避免幽灵规则）
 * - matchCount / lastMatchedAt 在 builtin 命中时正确更新
 * - listBuiltinNamespaces / getBuiltinRules 调试 API
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { createTempDir } from "@zhixing/test-utils";
import { PermissionStore } from "../permission-store.js";
import type { PermissionRule, SecurityRequest } from "../types.js";

// ─── 测试辅助 ───

function makeRequest(
  tool: string,
  args: Record<string, unknown>,
): SecurityRequest {
  return {
    tool,
    arguments: args,
    context: {
      cwd: process.cwd(),
      workspace: null,
      sessionType: "interactive",
    },
  };
}

function makeRule(
  overrides: Partial<PermissionRule> & { pattern: PermissionRule["pattern"] },
): PermissionRule {
  return {
    id: overrides.id ?? `r-${Math.random()}`,
    pattern: overrides.pattern,
    decision: overrides.decision ?? "allow",
    scope: overrides.scope ?? "session",
    createdAt: overrides.createdAt ?? 1000,
    lastMatchedAt: overrides.lastMatchedAt ?? 0,
    matchCount: overrides.matchCount ?? 0,
    workspace: overrides.workspace,
  };
}

/** 构造 builtin 规则的便捷函数（强制 scope=builtin） */
function makeBuiltinRule(
  pattern: PermissionRule["pattern"],
  decision: PermissionRule["decision"] = "allow",
  id?: string,
): PermissionRule {
  return makeRule({ pattern, decision, scope: "builtin", id });
}

// ─── 两阶段匹配 ───

describe("PermissionStore builtin scope", () => {
  describe("两阶段匹配（用户池严格优先）", () => {
    it("用户池为空 → builtin 池接管", () => {
      const store = new PermissionStore({ rootDir: null });
      store.registerBuiltinRules("test", [
        makeBuiltinRule({
          tool: "web_fetch",
          argument: "https://docs.npmjs.com/*",
        }),
      ]);

      const result = store.match(
        null,
        makeRequest("web_fetch", { url: "https://docs.npmjs.com/cli" }),
      );
      expect(result?.decision).toBe("allow");
      expect(result?.scope).toBe("builtin");
    });

    it("用户 allow 命中 → builtin 不参与（即便 builtin 也命中）", () => {
      const store = new PermissionStore({ rootDir: null });
      store.registerBuiltinRules("test", [
        makeBuiltinRule({ tool: "web_fetch", argument: "*" }, "deny"),
      ]);
      store.create(
        null,
        makeRule({
          pattern: { tool: "web_fetch", argument: "https://example.com/*" },
          decision: "allow",
          scope: "session",
        }),
      );

      const result = store.match(
        null,
        makeRequest("web_fetch", { url: "https://example.com/foo" }),
      );
      expect(result?.decision).toBe("allow");
      expect(result?.scope).toBe("session");
    });

    it("用户通配 deny + builtin 高特异性 allow → user 决定（核心产品语义）", () => {
      // 这是 ADR-TPE-008 选择两阶段匹配而非合并匹配的关键场景
      const store = new PermissionStore({ rootDir: null });
      store.registerBuiltinRules("test", [
        makeBuiltinRule({
          tool: "web_fetch",
          argument: "https://docs.npmjs.com/cli",
        }),
      ]);
      store.create(
        null,
        makeRule({
          pattern: { tool: "web_fetch", argument: "*" },
          decision: "deny",
          scope: "session",
        }),
      );

      const result = store.match(
        null,
        makeRequest("web_fetch", { url: "https://docs.npmjs.com/cli" }),
      );
      expect(result?.decision).toBe("deny");
      expect(result?.scope).toBe("session");
    });

    it("user 池有但全不命中 + builtin 命中 → builtin 接管", () => {
      const store = new PermissionStore({ rootDir: null });
      store.registerBuiltinRules("test", [
        makeBuiltinRule({
          tool: "web_fetch",
          argument: "https://npmjs.com/*",
        }),
      ]);
      store.create(
        null,
        makeRule({
          pattern: { tool: "bash", argument: "npm install *" },
          decision: "allow",
          scope: "session",
        }),
      );

      const result = store.match(
        null,
        makeRequest("web_fetch", { url: "https://npmjs.com/foo" }),
      );
      expect(result?.decision).toBe("allow");
      expect(result?.scope).toBe("builtin");
    });

    it("两阶段都无命中 → null", () => {
      const store = new PermissionStore({ rootDir: null });
      store.registerBuiltinRules("test", [
        makeBuiltinRule({ tool: "web_fetch", argument: "https://a.com/*" }),
      ]);

      expect(
        store.match(
          null,
          makeRequest("web_fetch", { url: "https://b.com/foo" }),
        ),
      ).toBeNull();
    });

    it("builtin 池内仍走 deny-wins + globSpecificity（同 namespace）", () => {
      const store = new PermissionStore({ rootDir: null });
      store.registerBuiltinRules("test", [
        makeBuiltinRule({ tool: "bash", argument: "npm *" }, "allow"),
        makeBuiltinRule({ tool: "bash", argument: "npm install *" }, "deny"),
      ]);

      const result = store.match(
        null,
        makeRequest("bash", { command: "npm install foo" }),
      );
      expect(result?.decision).toBe("deny");
    });

    it("跨 namespace 的 deny-wins（namespace 间平级，多 ns 命中走统一 resolveConflict）", () => {
      // ADR-TPE-008 语义守卫：namespace 间不分优先级，多 ns 同时命中合并参与
      // resolveConflict（deny-wins + globSpecificity）。守卫这条契约，防止未来误改
      // 成"先注册先优先"等其他策略。
      const store = new PermissionStore({ rootDir: null });
      store.registerBuiltinRules("ns_a", [
        makeBuiltinRule({ tool: "x", argument: "*" }, "allow"),
      ]);
      store.registerBuiltinRules("ns_b", [
        makeBuiltinRule({ tool: "x", argument: "*" }, "deny"),
      ]);

      const result = store.match(null, makeRequest("x", { foo: "bar" }));
      expect(result?.decision).toBe("deny");
    });

    it("跨 namespace 的 globSpecificity（同决策，特异性高的胜出）", () => {
      const store = new PermissionStore({ rootDir: null });
      store.registerBuiltinRules("ns_general", [
        makeBuiltinRule(
          { tool: "bash", argument: "npm *" },
          "allow",
          "general-rule",
        ),
      ]);
      store.registerBuiltinRules("ns_specific", [
        makeBuiltinRule(
          { tool: "bash", argument: "npm install *" },
          "allow",
          "specific-rule",
        ),
      ]);

      const result = store.match(
        null,
        makeRequest("bash", { command: "npm install foo" }),
      );
      // 特异性更高的 "npm install *" 胜出（即便在不同 namespace）
      expect(result?.id).toBe("specific-rule");
    });

    it("builtin 命中后 matchCount / lastMatchedAt 正确更新", () => {
      let nowValue = 12345;
      const store = new PermissionStore({
        rootDir: null,
        now: () => nowValue,
      });
      store.registerBuiltinRules("test", [
        makeBuiltinRule({ tool: "web_fetch", argument: "*" }),
      ]);

      const r1 = store.match(
        null,
        makeRequest("web_fetch", { url: "https://a.com" }),
      );
      expect(r1?.matchCount).toBe(1);
      expect(r1?.lastMatchedAt).toBe(12345);

      nowValue = 67890;
      const r2 = store.match(
        null,
        makeRequest("web_fetch", { url: "https://b.com" }),
      );
      expect(r2?.matchCount).toBe(2);
      expect(r2?.lastMatchedAt).toBe(67890);
    });
  });

  // ─── registerBuiltinRules 行为 ───

  describe("registerBuiltinRules namespace 追加式", () => {
    it("多 namespace 独立累加", () => {
      const store = new PermissionStore({ rootDir: null });
      store.registerBuiltinRules("web_fetch", [
        makeBuiltinRule({ tool: "web_fetch", argument: "*" }),
      ]);
      store.registerBuiltinRules("subagent", [
        makeBuiltinRule({ tool: "task", argument: "*" }),
      ]);

      // 两个 namespace 都生效（不互相覆盖）
      expect(
        store.match(null, makeRequest("web_fetch", { url: "x" }))?.decision,
      ).toBe("allow");
      expect(
        store.match(null, makeRequest("task", { name: "x" }))?.decision,
      ).toBe("allow");
    });

    it("同 namespace 重复调用：替换该 namespace 内规则（不影响其他 namespace）", () => {
      const store = new PermissionStore({ rootDir: null });
      store.registerBuiltinRules("a", [
        makeBuiltinRule({ tool: "tool_a", argument: "*" }),
      ]);
      store.registerBuiltinRules("b", [
        makeBuiltinRule({ tool: "tool_b", argument: "*" }),
      ]);

      // 替换 namespace "a" 的规则
      store.registerBuiltinRules("a", [
        makeBuiltinRule({ tool: "tool_a_new", argument: "*" }),
      ]);

      expect(store.match(null, makeRequest("tool_a", { x: "y" }))).toBeNull();
      expect(
        store.match(null, makeRequest("tool_a_new", { x: "y" }))?.decision,
      ).toBe("allow");
      // namespace "b" 不受影响
      expect(
        store.match(null, makeRequest("tool_b", { x: "y" }))?.decision,
      ).toBe("allow");
    });

    it("register 拒空数组 throw（fail-fast，不混入 unregister 语义）", () => {
      const store = new PermissionStore({ rootDir: null });
      store.registerBuiltinRules("web_fetch", [
        makeBuiltinRule({ tool: "web_fetch", argument: "*" }),
      ]);

      expect(() => store.registerBuiltinRules("web_fetch", [])).toThrow(
        /rules 不能为空数组/,
      );

      // 原注册保持不变（throw 不改 store 状态）
      expect(store.listBuiltinNamespaces()).toContain("web_fetch");
      expect(
        store.match(null, makeRequest("web_fetch", { url: "x" }))?.decision,
      ).toBe("allow");
    });

    it("严格 scope：传入 scope!=='builtin' 的规则 → throw", () => {
      const store = new PermissionStore({ rootDir: null });
      expect(() =>
        store.registerBuiltinRules("test", [
          makeRule({
            pattern: { tool: "x", argument: "*" },
            scope: "session", // 错误声明
          }),
        ]),
      ).toThrow(/scope 必须为 "builtin"/);
    });

    it("严格 scope：scope=='global' 也 throw（不静默改写）", () => {
      const store = new PermissionStore({ rootDir: null });
      expect(() =>
        store.registerBuiltinRules("test", [
          makeRule({
            pattern: { tool: "x", argument: "*" },
            scope: "global",
          }),
        ]),
      ).toThrow(/scope 必须为 "builtin"/);
    });

    it("namespace 必须是非空字符串", () => {
      const store = new PermissionStore({ rootDir: null });
      expect(() => store.registerBuiltinRules("", [])).toThrow(
        /非空字符串/,
      );
    });

    it("不修改 caller 传入的原 rule 对象（防御性拷贝）", () => {
      const store = new PermissionStore({ rootDir: null });
      const original = makeBuiltinRule({ tool: "x", argument: "*" });

      store.registerBuiltinRules("test", [original]);
      original.pattern.argument = "MUTATED"; // 模拟外部修改

      // store 内部规则不受影响
      const result = store.match(null, makeRequest("x", { foo: "bar" }));
      expect(result?.decision).toBe("allow");
      expect(result?.pattern.argument).toBe("*");
    });
  });

  // ─── resetAll **不**清 builtin ───

  describe("resetAll", () => {
    it("resetAll 不清除 builtin 规则（boot-time 系统配置语义）", () => {
      const store = new PermissionStore({ rootDir: null });
      store.registerBuiltinRules("test", [
        makeBuiltinRule({ tool: "web_fetch", argument: "*" }),
      ]);

      store.resetAll();

      // builtin 规则仍生效
      const result = store.match(null, makeRequest("web_fetch", { url: "x" }));
      expect(result?.decision).toBe("allow");
      expect(result?.scope).toBe("builtin");
      expect(store.listBuiltinNamespaces()).toContain("test");
    });

    it("resetAll 仍清除 user 池（session/workspace/global）", () => {
      const store = new PermissionStore({ rootDir: null });
      store.create(
        null,
        makeRule({
          pattern: { tool: "x", argument: "*" },
          decision: "allow",
          scope: "session",
        }),
      );

      store.resetAll();
      expect(store.match(null, makeRequest("x", { foo: "y" }))).toBeNull();
    });

    it("测试隔离推荐：每 test 创建新 store 实例（resetAll 不再保证完全隔离）", () => {
      // 文档化推荐做法——这条测试本身验证 resetAll 的新语义
      const store1 = new PermissionStore({ rootDir: null });
      store1.registerBuiltinRules("ns", [
        makeBuiltinRule({ tool: "x", argument: "*" }),
      ]);

      const store2 = new PermissionStore({ rootDir: null });
      // store2 是新实例，不受 store1 的 builtin 影响
      expect(store2.match(null, makeRequest("x", { foo: "y" }))).toBeNull();
      expect(store2.listBuiltinNamespaces()).toEqual([]);
    });
  });

  // ─── create 拒绝 builtin ───

  describe("create", () => {
    it("create 调 'builtin' scope 抛错（应走 registerBuiltinRules）", () => {
      const store = new PermissionStore({ rootDir: null });
      expect(() =>
        store.create(
          null,
          makeRule({
            pattern: { tool: "web_fetch", argument: "*" },
            decision: "allow",
            scope: "builtin",
          }),
        ),
      ).toThrow(/builtin.*registerBuiltinRules/);
    });
  });

  // ─── 调试 API ───

  describe("调试 / 可观测性 API", () => {
    it("listBuiltinNamespaces 返回所有已注册的 namespace", () => {
      const store = new PermissionStore({ rootDir: null });
      expect(store.listBuiltinNamespaces()).toEqual([]);

      store.registerBuiltinRules("a", [
        makeBuiltinRule({ tool: "x", argument: "*" }),
      ]);
      store.registerBuiltinRules("b", [
        makeBuiltinRule({ tool: "y", argument: "*" }),
      ]);

      const namespaces = store.listBuiltinNamespaces();
      expect(namespaces).toContain("a");
      expect(namespaces).toContain("b");
      expect(namespaces).toHaveLength(2);
    });

    it("getBuiltinRules 返回指定 namespace 的规则拷贝", () => {
      const store = new PermissionStore({ rootDir: null });
      const rule = makeBuiltinRule({ tool: "x", argument: "*" });
      store.registerBuiltinRules("test", [rule]);

      const fetched = store.getBuiltinRules("test");
      expect(fetched).toHaveLength(1);
      expect(fetched[0]!.pattern.tool).toBe("x");

      // 修改返回值不影响内部状态
      fetched[0]!.pattern.argument = "MUTATED";
      const refetched = store.getBuiltinRules("test");
      expect(refetched[0]!.pattern.argument).toBe("*");
    });

    it("getBuiltinRules 不存在 namespace → 空数组", () => {
      const store = new PermissionStore({ rootDir: null });
      expect(store.getBuiltinRules("nonexistent")).toEqual([]);
    });
  });

  // ─── 老 user 规则反序列化兼容 + 磁盘 builtin scope 拒绝 ───

  describe("磁盘反序列化（M4 新 union + S4 严格性）", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await createTempDir("permstore-builtin");
    });

    it("旧 global.json（仅含 session/workspace/global scope）能正常加载", () => {
      const file = path.join(tmpDir, "global.json");
      const oldFile = {
        version: 1,
        scope: "global",
        rules: [
          {
            id: "rule-1",
            pattern: { tool: "bash", argument: "npm install *" },
            decision: "allow",
            scope: "global",
            createdAt: 1700000000000,
            lastMatchedAt: 1700000001000,
            matchCount: 5,
          },
          {
            id: "rule-2",
            pattern: { tool: "bash", argument: "rm *" },
            decision: "deny",
            scope: "global",
            createdAt: 1700000002000,
            lastMatchedAt: 0,
            matchCount: 0,
          },
        ],
      };
      fs.writeFileSync(file, JSON.stringify(oldFile, null, 2), "utf-8");

      const store = new PermissionStore({ rootDir: tmpDir });

      const allowMatch = store.match(
        null,
        makeRequest("bash", { command: "npm install lodash" }),
      );
      expect(allowMatch?.decision).toBe("allow");
      expect(allowMatch?.scope).toBe("global");
      expect(allowMatch?.id).toBe("rule-1");

      const denyMatch = store.match(
        null,
        makeRequest("bash", { command: "rm -rf /" }),
      );
      expect(denyMatch?.decision).toBe("deny");
      expect(denyMatch?.scope).toBe("global");
    });

    it("S4: 磁盘上含 'builtin' scope 的规则被拒绝（不污染 builtin 池）", () => {
      // 防御性场景：磁盘文件意外含 builtin scope（旧 bug 或人工编辑）
      // sanitizeRules 应**显式拒绝**，避免幽灵规则
      const file = path.join(tmpDir, "global.json");
      const mixedFile = {
        version: 1,
        scope: "global",
        rules: [
          {
            id: "rule-good",
            pattern: { tool: "bash", argument: "ls *" },
            decision: "allow",
            scope: "global",
            createdAt: 1700000000000,
            lastMatchedAt: 0,
            matchCount: 0,
          },
          {
            id: "rule-disk-builtin",
            pattern: { tool: "web_fetch", argument: "*" },
            decision: "allow",
            scope: "builtin", // 不应在磁盘出现，必须被拒绝
            createdAt: 1700000000000,
            lastMatchedAt: 0,
            matchCount: 0,
          },
        ],
      };
      fs.writeFileSync(file, JSON.stringify(mixedFile, null, 2), "utf-8");

      const store = new PermissionStore({ rootDir: tmpDir });

      // 正常 global 规则被加载
      expect(
        store.match(null, makeRequest("bash", { command: "ls -la" }))?.id,
      ).toBe("rule-good");

      // 磁盘上的 builtin 规则被拒绝——既不进 builtin 池也不进其他池
      expect(
        store.match(null, makeRequest("web_fetch", { url: "https://x.com" })),
      ).toBeNull();
      expect(store.listBuiltinNamespaces()).toEqual([]);
    });
  });
});
