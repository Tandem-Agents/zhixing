/**
 * PermissionStore 单元测试
 *
 * 测试矩阵：
 *   - Glob 匹配：字面量 / * / ** / ? / 特殊字符
 *   - 特异性计算（规格 §4.7 公式）
 *   - 三种作用域的 create/list/match/revoke/reset
 *   - 磁盘持久化：落盘 → 新实例 → 规则自动加载
 *   - 损坏文件 → 空规则集，不崩溃
 *   - 冲突解决：deny > allow、精确 > 宽泛
 *   - 跨作用域规则可见性
 *   - 工作区 ID 稳定性
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { createTempDir } from "@zhixing/test-utils";
import { DurablePermissionRuleStore } from "../durable-permission-rules.js";
import {
  PermissionStore,
  bindPermissionRuleExecutionSource,
  globMatches,
  globSpecificity,
  globToRegex,
  toStorageKey,
} from "../permission-store.js";
import type {
  PermissionContextId,
  PermissionRule,
  SecurityRequest,
} from "../types.js";

// ─── 测试辅助 ───

/** 主模式上下文 ID —— 测试 fixture，避免每个调用点重复构造 union。 */
const MAIN: PermissionContextId = { kind: "main" };

/** 构造工作场景上下文 ID（接 fixture hash 字符串）。 */
function ws(hash: string): PermissionContextId {
  return { kind: "workspace", hash };
}

function makeRequest(
  tool: string,
  args: Record<string, unknown>,
): SecurityRequest {
  return {
    tool,
    arguments: args,
    context: {
      cwd: process.cwd(),
      trust: { kind: "global" },
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
    contextId: overrides.contextId,
    contextPath: overrides.contextPath,
    contributors: overrides.contributors,
  };
}

// ─── Glob 匹配 ───

describe("globToRegex / globMatches", () => {
  it("字面量字符串精确匹配", async () => {
    expect(globMatches("npm install express", "npm install express")).toBe(true);
    expect(globMatches("npm install express", "npm install foo")).toBe(false);
  });

  it("不含 / 的模式中 * 匹配任意字符（bash 命令场景）", async () => {
    expect(globMatches("npm install *", "npm install express")).toBe(true);
    expect(globMatches("npm install *", "npm install foo-bar")).toBe(true);
    // 不含 / 的模式 → * 也匹配带 / 的输入（如 @scope/pkg）
    expect(globMatches("npm install *", "npm install @scope/pkg")).toBe(true);
    expect(globMatches("*", "anything")).toBe(true);
    expect(globMatches("*", "/tmp/any/path")).toBe(true);
  });

  it("含 / 的模式中 * 是 path-aware（文件路径场景）", async () => {
    expect(globMatches("src/*", "src/index.ts")).toBe(true);
    expect(globMatches("src/*", "src/sub/index.ts")).toBe(false);
  });

  it("** 匹配任意字符（包括 /）", async () => {
    expect(globMatches("src/**", "src/index.ts")).toBe(true);
    expect(globMatches("src/**", "src/sub/deep/index.ts")).toBe(true);
    expect(globMatches("**/*.ts", "src/foo/bar.ts")).toBe(true);
  });

  it("? 匹配单个字符（含 / 的模式中不跨 /）", async () => {
    expect(globMatches("foo?", "foos")).toBe(true);
    expect(globMatches("foo?", "foo")).toBe(false);
    expect(globMatches("foo?", "fooss")).toBe(false);
    // path-aware 模式
    expect(globMatches("src/?", "src/a")).toBe(true);
    expect(globMatches("src/?", "src/")).toBe(false);
  });

  it("regex 元字符被转义", async () => {
    expect(globMatches("a.b", "a.b")).toBe(true);
    expect(globMatches("a.b", "aXb")).toBe(false);
    expect(globMatches("foo+bar", "foo+bar")).toBe(true);
    expect(globMatches("(group)", "(group)")).toBe(true);
  });

  it("整串匹配（前缀/后缀都有锚点）", async () => {
    const re = globToRegex("src/*");
    expect(re.test("src/a.ts")).toBe(true);
    // 前缀不对
    expect(re.test("lib/src/a.ts")).toBe(false);
  });
});

describe("globSpecificity", () => {
  it("深度主导：深层模式 >> 浅层模式", async () => {
    expect(globSpecificity("src/**/*.ts")).toBeGreaterThan(
      globSpecificity("src/**"),
    );
    expect(globSpecificity("src/**")).toBeGreaterThan(globSpecificity("*"));
  });

  it("同深度：literal 长度作为 tiebreaker（规格公式的扩展）", async () => {
    // npm install * 和 npm * 同深度同通配符数 → literal 更长的胜出
    expect(globSpecificity("npm install *")).toBeGreaterThan(
      globSpecificity("npm *"),
    );
  });

  it("精确命令胜出通配符", async () => {
    expect(globSpecificity("npm install express")).toBeGreaterThan(
      globSpecificity("npm install *"),
    );
  });

  it("catch-all `*` 得分最低", async () => {
    expect(globSpecificity("*")).toBeLessThan(globSpecificity("foo"));
    expect(globSpecificity("*")).toBeLessThan(globSpecificity("src/*"));
  });
});

// ─── 纯内存行为 ───

describe("PermissionStore (in-memory)", () => {
  let store: PermissionStore;

  beforeEach(() => {
    store = new PermissionStore({ rootDir: null, now: () => 1000 });
  });

  describe("会话作用域", () => {
    it("创建的会话规则可被 list 和 match", async () => {
      await store.create(
        MAIN,
        makeRule({
          pattern: { tool: "bash", argument: "git *" },
          scope: "session",
        }),
      );

      expect(store.list(MAIN)).toHaveLength(1);
      const match = store.match(
        MAIN,
        makeRequest("bash", { command: "git status" }),
      );
      expect(match).not.toBeNull();
      expect(match?.decision).toBe("allow");
    });

    it("session 规则按 contextId 隔离", async () => {
      const wsA = ws("workspace-aaa");
      const wsB = ws("workspace-bbb");

      await store.create(
        wsA,
        makeRule({
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );

      expect(store.list(wsA)).toHaveLength(1);
      expect(store.list(wsB)).toHaveLength(0);
    });

    it("未匹配时返回 null", async () => {
      const match = store.match(
        MAIN,
        makeRequest("bash", { command: "curl foo" }),
      );
      expect(match).toBeNull();
    });

    it("match 更新 matchCount 和 lastMatchedAt", async () => {
      const timestamps = [1000, 2000, 3000];
      let idx = 0;
      const timedStore = new PermissionStore({
        rootDir: null,
        now: () => timestamps[idx++]!,
      });

      await timedStore.create(
        MAIN,
        makeRule({
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );

      timedStore.match(MAIN, makeRequest("bash", { command: "ls" }));
      timedStore.match(MAIN, makeRequest("bash", { command: "pwd" }));

      const rules = timedStore.list(MAIN);
      expect(rules[0]!.matchCount).toBe(2);
      expect(rules[0]!.lastMatchedAt).toBeGreaterThan(0);
    });
  });

  describe("工具匹配", () => {
    it("工具名大小写不敏感", async () => {
      await store.create(
        MAIN,
        makeRule({
          pattern: { tool: "BASH", argument: "*" },
          scope: "session",
        }),
      );

      const match = store.match(
        MAIN,
        makeRequest("bash", { command: "ls" }),
      );
      expect(match).not.toBeNull();
    });

    it('pattern.tool = "*" 匹配任何工具', async () => {
      await store.create(
        MAIN,
        makeRule({
          pattern: { tool: "*", argument: "*" },
          scope: "session",
        }),
      );

      expect(
        store.match(MAIN, makeRequest("read", { path: "/tmp/a" })),
      ).not.toBeNull();
      expect(
        store.match(MAIN, makeRequest("bash", { command: "ls" })),
      ).not.toBeNull();
    });

    it("不同工具的规则不会错配", async () => {
      await store.create(
        MAIN,
        makeRule({
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );

      const match = store.match(
        MAIN,
        makeRequest("write", { path: "/tmp/a" }),
      );
      expect(match).toBeNull();
    });
  });

  describe("参数提取", () => {
    it("bash 从 command 提取", async () => {
      await store.create(
        MAIN,
        makeRule({
          pattern: { tool: "bash", argument: "git status" },
          scope: "session",
        }),
      );
      expect(
        store.match(MAIN, makeRequest("bash", { command: "git status" })),
      ).not.toBeNull();
    });

    it("write/edit 从 path 或 file_path 提取", async () => {
      await store.create(
        MAIN,
        makeRule({
          pattern: { tool: "write", argument: "src/**" },
          scope: "session",
        }),
      );

      expect(
        store.match(MAIN, makeRequest("write", { path: "src/a.ts" })),
      ).not.toBeNull();
      expect(
        store.match(MAIN, makeRequest("write", { file_path: "src/b.ts" })),
      ).not.toBeNull();
    });

    it("通用工具回退到第一个字符串参数", async () => {
      await store.create(
        MAIN,
        makeRule({
          pattern: { tool: "wechat", argument: "*张三*" },
          scope: "session",
        }),
      );

      expect(
        store.match(MAIN, makeRequest("wechat", { to: "张三", content: "x" })),
      ).not.toBeNull();
    });
  });

  describe("冲突解决（规格 §4.7）", () => {
    it("deny 胜出 allow", async () => {
      await store.create(
        MAIN,
        makeRule({
          id: "allow-all",
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
          decision: "allow",
        }),
      );
      await store.create(
        MAIN,
        makeRule({
          id: "deny-rm",
          pattern: { tool: "bash", argument: "rm *" },
          scope: "session",
          decision: "deny",
        }),
      );

      const match = store.match(
        MAIN,
        makeRequest("bash", { command: "rm foo" }),
      );
      expect(match?.id).toBe("deny-rm");
      expect(match?.decision).toBe("deny");
    });

    it("精确规则胜出宽泛规则（同决策）", async () => {
      await store.create(
        MAIN,
        makeRule({
          id: "broad",
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );
      await store.create(
        MAIN,
        makeRule({
          id: "specific",
          pattern: { tool: "bash", argument: "git status" },
          scope: "session",
        }),
      );

      const match = store.match(
        MAIN,
        makeRequest("bash", { command: "git status" }),
      );
      expect(match?.id).toBe("specific");
    });

    it("多条 deny 规则之间取最精确的", async () => {
      await store.create(
        MAIN,
        makeRule({
          id: "deny-broad",
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
          decision: "deny",
        }),
      );
      await store.create(
        MAIN,
        makeRule({
          id: "deny-specific",
          pattern: { tool: "bash", argument: "rm -rf /" },
          scope: "session",
          decision: "deny",
        }),
      );

      const match = store.match(
        MAIN,
        makeRequest("bash", { command: "rm -rf /" }),
      );
      expect(match?.id).toBe("deny-specific");
    });
  });

  describe("revoke", () => {
    it("按 id 撤销会话规则", async () => {
      const ruleId = "target-rule";
      await store.create(
        MAIN,
        makeRule({
          id: ruleId,
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );

      expect(await store.revoke(ruleId)).toBe(true);
      expect(store.list(MAIN)).toHaveLength(0);
    });

    it("撤销不存在的 id 返回 false", async () => {
      expect(await store.revoke("nonexistent")).toBe(false);
    });
  });

  describe("reset / resetAll", () => {
    it("reset 清除给定 workspace 的会话规则", async () => {
      await store.create(
        ws("ws-1"),
        makeRule({
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );
      await store.create(
        ws("ws-2"),
        makeRule({
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );

      await store.reset(ws("ws-1"));
      expect(store.list(ws("ws-1"))).toHaveLength(0);
      expect(store.list(ws("ws-2"))).toHaveLength(1);
    });

    it("resetAll 清除全部规则", async () => {
      await store.create(
        ws("ws-1"),
        makeRule({
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );
      await store.create(
        ws("ws-2"),
        makeRule({
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );

      await store.resetAll();
      expect(store.list(ws("ws-1"))).toHaveLength(0);
      expect(store.list(ws("ws-2"))).toHaveLength(0);
    });
  });

});

// ─── 磁盘持久化 ───

describe("PermissionStore (disk persistence)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createTempDir("perm");
  });

  it("非冻结 match 不改持久规则的计数：统计只由命中记录计入，避免与直接记账双计", async () => {
    const durable = new DurablePermissionRuleStore(rootDir);
    const store = new PermissionStore({ durable });
    const context = ws("ws-hits");
    await store.create(context, makeRule({ id: "ctx", pattern: { tool: "bash", argument: "*" }, scope: "context", contextId: context }));
    await store.create(context, makeRule({ id: "glob", pattern: { tool: "web_fetch", argument: "*" }, scope: "global" }));

    expect(store.match(context, makeRequest("bash", { command: "ls" }))?.id).toBe("ctx");
    expect(store.match(context, makeRequest("web_fetch", { url: "https://example.com" }))?.id).toBe("glob");
    // 同一个 durable 的管理读取看到的仍是未计数的值；按规则权威的直接记账只计一次
    const management = new PermissionStore({ durable });
    expect(management.list(context).map((rule) => [rule.id, rule.matchCount])).toEqual([["ctx", 0], ["glob", 0]]);
    expect(await durable.recordHits("\u0000global", [{ ruleId: "glob", at: 5 }])).toBe(1);
    expect(management.list(context).find((rule) => rule.id === "glob")?.matchCount).toBe(1);
  });

  it("创建 workspace 规则 → 文件被创建 → 新实例可加载", async () => {
    const wsId = ws("ws-abc123");
    const storeA = new PermissionStore({ rootDir });

    await storeA.create(
      wsId,
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "npm install *" },
        decision: "allow",
        scope: "context",
      }),
    );

    const file = path.join(rootDir, `${toStorageKey(wsId)}.json`);
    expect(fs.existsSync(file)).toBe(true);

    const storeB = new PermissionStore({ rootDir });
    const rules = storeB.list(wsId);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.pattern.argument).toBe("npm install *");
  });

  it("创建 global 规则 → global.json → 新实例可加载", async () => {
    const storeA = new PermissionStore({ rootDir });
    await storeA.create(
      MAIN,
      PermissionStore.createRule({
        pattern: { tool: "*", argument: "*" },
        decision: "deny",
        scope: "global",
      }),
    );

    expect(fs.existsSync(path.join(rootDir, "global.json"))).toBe(true);

    const storeB = new PermissionStore({ rootDir });
    // global 规则对任何 workspace 可见
    const match = storeB.match(
      ws("any-ws"),
      makeRequest("bash", { command: "ls" }),
    );
    expect(match?.decision).toBe("deny");
  });

  it("revoke workspace 规则会立即落盘", async () => {
    const wsId = ws("ws-revoke");
    const store = new PermissionStore({ rootDir });
    const rule = PermissionStore.createRule({
      pattern: { tool: "bash", argument: "*" },
      decision: "allow",
      scope: "context",
    });
    await store.create(wsId, rule);
    await store.revoke(rule.id);

    // 新实例加载时应该是空
    const store2 = new PermissionStore({ rootDir });
    expect(store2.list(wsId)).toHaveLength(0);
  });

  it("损坏的 JSON 文件 → 视为空规则集，不崩溃", async () => {
    const wsId = ws("ws-corrupt");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, `${toStorageKey(wsId)}.json`),
      "{ not valid json",
      "utf-8",
    );

    const store = new PermissionStore({ rootDir });
    expect(() => store.list(wsId)).not.toThrow();
    expect(store.list(wsId)).toHaveLength(0);
  });

  it("结构不正确的规则被过滤", async () => {
    const wsId = ws("ws-partial");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, `${toStorageKey(wsId)}.json`),
      JSON.stringify({
        version: 1,
        rules: [
          { id: "good", pattern: { tool: "bash", argument: "*" }, decision: "allow", scope: "context", createdAt: 1, lastMatchedAt: 0, matchCount: 0 },
          { id: "bad-no-pattern", decision: "allow", scope: "context" },
          { id: "bad-decision", pattern: { tool: "bash", argument: "*" }, decision: "maybe", scope: "context" },
          null,
          "not-an-object",
        ],
      }),
      "utf-8",
    );

    const store = new PermissionStore({ rootDir });
    const rules = store.list(wsId);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.id).toBe("good");
  });

  it("原子写：rename 后文件已存在且内容完整", async () => {
    const wsId = ws("ws-atomic");
    const store = new PermissionStore({ rootDir });
    await store.create(
      wsId,
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "ls" },
        decision: "allow",
        scope: "context",
      }),
    );

    const file = path.join(rootDir, `${toStorageKey(wsId)}.json`);
    expect(fs.existsSync(file)).toBe(true);
    // 不应该有 .tmp 残留
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);

    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(data.version).toBe(1);
    expect(data.rules).toHaveLength(1);
  });

  it("resetAll 会删除磁盘上所有 JSON 文件", async () => {
    const store = new PermissionStore({ rootDir });
    await store.create(
      ws("ws-x"),
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "*" },
        decision: "allow",
        scope: "context",
      }),
    );
    await store.create(
      MAIN,
      PermissionStore.createRule({
        pattern: { tool: "*", argument: "*" },
        decision: "deny",
        scope: "global",
      }),
    );

    expect(fs.readdirSync(rootDir).length).toBeGreaterThan(0);
    await store.resetAll();
    expect(fs.readdirSync(rootDir)).toHaveLength(0);
  });

  it("session 规则不落盘", async () => {
    const store = new PermissionStore({ rootDir });
    await store.create(
      ws("ws-session"),
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "*" },
        decision: "allow",
        scope: "session",
      }),
    );

    expect(fs.existsSync(rootDir) && fs.readdirSync(rootDir).length).toBeFalsy();
  });
});

// ─── sanitizeRules 字段持久化往返（含 contributors / contextId / contextPath） ───
//
// sanitizeRules 是反序列化关键链路 —— 任何字段在 JSON 往返中漏读都不会被 build /
// 类型检查发现，但会在生产破坏 /trust 面板（contributors 显示空、生效范围误判）。
// 这组测试把 sanitize 链路所有分支（happy path / 单条 filter 鲁棒 / optional 缺失
// 兼容 / 类型错误降级）锁死，未来 PermissionRule 加字段时按同一模式扩展即可。

describe("PermissionStore — sanitizeRules 字段持久化往返", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createTempDir("perm-sanitize");
  });

  it("完整字段往返：contributors / contextId / contextPath 全部恢复", async () => {
    const wsId = ws("ws-full");
    const storeA = new PermissionStore({ rootDir });
    await storeA.create(
      wsId,
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "npm install *" },
        decision: "allow",
        scope: "context",
        contextId: wsId,
        contextPath: "/home/user/project",
        contributors: [
          { origin: "user", timestamp: 1_700_000_000_000 },
          { origin: "steward", timestamp: 1_700_000_001_000 },
        ],
      }),
    );

    // 新实例读盘 → sanitizeRules 必须恢复所有字段（schema 升级时易遗漏的回归点）
    const storeB = new PermissionStore({ rootDir });
    const rules = storeB.list(wsId).filter((r) => r.scope === "context");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.contextId).toEqual(wsId);
    expect(rules[0]!.contextPath).toBe("/home/user/project");
    expect(rules[0]!.contributors).toEqual([
      { origin: "user", timestamp: 1_700_000_000_000 },
      { origin: "steward", timestamp: 1_700_000_001_000 },
    ]);
  });

  it("contributors 中混入非法条目：单条 filter，合法条目正常恢复", async () => {
    const wsId = ws("ws-mixed");
    const storageKey = toStorageKey(wsId);
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, `${storageKey}.json`),
      JSON.stringify({
        version: 1,
        contextStorageKey: storageKey,
        rules: [
          {
            id: "rule-mixed",
            pattern: { tool: "bash", argument: "*" },
            decision: "allow",
            scope: "context",
            contextId: wsId,
            createdAt: 1,
            lastMatchedAt: 0,
            matchCount: 0,
            contributors: [
              { origin: "user", timestamp: 1 },
              { origin: "invalid", timestamp: 2 }, // origin 不在白名单
              { origin: "steward", timestamp: 3 },
              { timestamp: 4 }, // 缺 origin
              { origin: "user" }, // 缺 timestamp
              null, // null 整条
            ],
          },
        ],
      }),
      "utf-8",
    );

    const store = new PermissionStore({ rootDir });
    const rules = store.list(wsId).filter((r) => r.scope === "context");
    expect(rules).toHaveLength(1);
    // 仅保留合法 user + steward 两条，其余降级丢弃
    expect(rules[0]!.contributors).toEqual([
      { origin: "user", timestamp: 1 },
      { origin: "steward", timestamp: 3 },
    ]);
  });

  it("contributors / contextId / contextPath 字段缺失：恢复为 undefined，不崩溃", async () => {
    // 模拟旧版本或外部手写 JSON：没有新增字段。这是 optional 字段语义的兼容性
    // 保护点 —— 历史数据 / 第三方工具写盘的最小 schema 仍能读
    const wsId = ws("ws-minimal");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, `${toStorageKey(wsId)}.json`),
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: "rule-min",
            pattern: { tool: "bash", argument: "*" },
            decision: "allow",
            scope: "context",
            createdAt: 1,
            lastMatchedAt: 0,
            matchCount: 0,
          },
        ],
      }),
      "utf-8",
    );

    const store = new PermissionStore({ rootDir });
    const rules = store.list(wsId).filter((r) => r.scope === "context");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.contributors).toBeUndefined();
    expect(rules[0]!.contextId).toBeUndefined();
    expect(rules[0]!.contextPath).toBeUndefined();
  });

  it("contributors 类型错（非数组）：整体降级 undefined，不崩溃", async () => {
    // 防御性：JSON 损坏或第三方工具写错类型时，sanitizeContributors 应单条丢弃
    // 而不让整个 PermissionStore.load 抛错
    const wsId = ws("ws-typeerr");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, `${toStorageKey(wsId)}.json`),
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: "rule-typeerr",
            pattern: { tool: "bash", argument: "*" },
            decision: "allow",
            scope: "context",
            createdAt: 1,
            lastMatchedAt: 0,
            matchCount: 0,
            contributors: "not-an-array",
          },
        ],
      }),
      "utf-8",
    );

    expect(() => {
      const store = new PermissionStore({ rootDir });
      const rules = store.list(wsId);
      expect(rules[0]!.contributors).toBeUndefined();
    }).not.toThrow();
  });

  it("global 规则不依赖 contextId / contextPath：往返后 scope=global、上下文字段为 undefined", async () => {
    const storeA = new PermissionStore({ rootDir });
    await storeA.create(
      MAIN,
      PermissionStore.createRule({
        pattern: { tool: "*", argument: "*" },
        decision: "allow",
        scope: "global",
        contributors: [{ origin: "user", timestamp: 1_700_000_000_000 }],
      }),
    );

    const storeB = new PermissionStore({ rootDir });
    const rules = storeB.list(MAIN).filter((r) => r.scope === "global");
    expect(rules).toHaveLength(1);
    expect(rules[0]!.contextId).toBeUndefined();
    expect(rules[0]!.contextPath).toBeUndefined();
    expect(rules[0]!.contributors).toEqual([
      { origin: "user", timestamp: 1_700_000_000_000 },
    ]);
  });
});

// ─── 工作区绑定修订 ───

describe("PermissionStore 工作区绑定修订", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createTempDir("perm-revision");
  });

  const workspaceRule = (revision: number, argument: string) =>
    PermissionStore.createRule({
      pattern: { tool: "bash", argument },
      decision: "allow",
      scope: "context",
      contextId: { kind: "workspace", hash: "binding-a", revision },
    });

  it("运行上下文带修订时只匹配同修订的工作区规则，全局规则不受影响", async () => {
    const store = new PermissionStore({ rootDir });
    await store.create({ kind: "workspace", hash: "binding-a", revision: 1 }, workspaceRule(1, "npm test"));
    await store.create({ kind: "workspace", hash: "binding-a", revision: 2 }, workspaceRule(2, "npm run build"));
    await store.create(MAIN, PermissionStore.createRule({
      pattern: { tool: "bash", argument: "git status" },
      decision: "allow",
      scope: "global",
    }));

    const current = { kind: "workspace", hash: "binding-a", revision: 2 } as const;
    expect(store.match(current, makeRequest("bash", { command: "npm test" }))).toBeNull();
    expect(store.match(current, makeRequest("bash", { command: "npm run build" }))?.decision).toBe("allow");
    expect(store.match(current, makeRequest("bash", { command: "git status" }))?.scope).toBe("global");
  });

  it("不带修订的视图（管理面、owner 组合快照）列出该绑定全部修订", async () => {
    const store = new PermissionStore({ rootDir });
    await store.create({ kind: "workspace", hash: "binding-a", revision: 1 }, workspaceRule(1, "npm test"));
    await store.create({ kind: "workspace", hash: "binding-a", revision: 2 }, workspaceRule(2, "npm run build"));
    expect(store.list({ kind: "workspace", hash: "binding-a" }).map((rule) => rule.pattern.argument))
      .toEqual(["npm test", "npm run build"]);
    expect(store.list({ kind: "workspace", hash: "binding-a", revision: 1 }).map((rule) => rule.pattern.argument))
      .toEqual(["npm test"]);
  });

  it("冻结快照按绑定的运行修订过滤", async () => {
    const owner = new PermissionStore({ rootDir });
    await owner.create({ kind: "workspace", hash: "binding-a", revision: 1 }, workspaceRule(1, "npm test"));
    const snapshot = owner.snapshot({ kind: "workspace", hash: "binding-a" });
    const executor = bindPermissionRuleExecutionSource(
      new PermissionStore({ rootDir: null }),
      { kind: "workspace", hash: "binding-a", revision: 2 },
    );
    expect(executor.matchFrozen(snapshot, makeRequest("bash", { command: "npm test" }))).toBeNull();
    const sameRevision = bindPermissionRuleExecutionSource(
      new PermissionStore({ rootDir: null }),
      { kind: "workspace", hash: "binding-a", revision: 1 },
    );
    expect(sameRevision.matchFrozen(snapshot, makeRequest("bash", { command: "npm test" }))?.decision).toBe("allow");
  });
});

// ─── 进程内唯一持久所有者 ───

describe("PermissionStore 共享持久所有者", () => {
  it("一处写入或撤销，共享同一所有者的其他实例立即可见", async () => {
    const durable = new DurablePermissionRuleStore(await createTempDir("perm-shared"));
    const runtimeA = new PermissionStore({ durable });
    const runtimeB = new PermissionStore({ durable });
    expect(runtimeB.list(ws("shared"))).toHaveLength(0);
    const rule = PermissionStore.createRule({
      pattern: { tool: "bash", argument: "npm test" },
      decision: "allow",
      scope: "context",
      contextId: ws("shared"),
    });
    await runtimeA.create(ws("shared"), rule);
    expect(runtimeB.match(ws("shared"), makeRequest("bash", { command: "npm test" }))?.id).toBe(rule.id);
    await expect(new PermissionStore({ durable }).revoke(rule.id)).resolves.toBe(true);
    expect(runtimeB.list(ws("shared"))).toHaveLength(0);
  });

  it("耐久写失败时不发布内存状态并把错误交给调用方", async () => {
    const parent = await createTempDir("perm-write-failure");
    // 权限目录位置被普通文件占住：创建目录失败，写入必然失败
    const rootDir = path.join(parent, "blocked");
    fs.writeFileSync(rootDir, "not a directory");
    const store = new PermissionStore({ durable: new DurablePermissionRuleStore(rootDir) });
    const rule = PermissionStore.createRule({
      pattern: { tool: "bash", argument: "npm test" },
      decision: "allow",
      scope: "global",
    });
    await expect(store.create(MAIN, rule)).rejects.toThrow();
    expect(store.list(MAIN)).toHaveLength(0);
    expect(store.match(MAIN, makeRequest("bash", { command: "npm test" }))).toBeNull();
  });

  it("快照组合内置＋会话＋该范围持久＋全局", async () => {
    const store = new PermissionStore({ rootDir: await createTempDir("perm-snapshot") });
    store.registerBuiltinRules("fixture", [PermissionStore.createRule({
      pattern: { tool: "read", argument: "*" },
      decision: "allow",
      scope: "builtin",
    })]);
    await store.create(ws("scope"), makeRule({ pattern: { tool: "bash", argument: "ls" }, scope: "session" }));
    await store.create(ws("scope"), PermissionStore.createRule({
      pattern: { tool: "bash", argument: "npm test" },
      decision: "allow",
      scope: "context",
      contextId: ws("scope"),
    }));
    await store.create(ws("other"), PermissionStore.createRule({
      pattern: { tool: "bash", argument: "rm *" },
      decision: "allow",
      scope: "context",
      contextId: ws("other"),
    }));
    await store.create(MAIN, PermissionStore.createRule({
      pattern: { tool: "bash", argument: "git status" },
      decision: "allow",
      scope: "global",
    }));
    expect(store.snapshot(ws("scope")).map((rule) => `${rule.scope}:${rule.pattern.argument}`)).toEqual([
      "session:ls",
      "context:npm test",
      "global:git status",
      "builtin:*",
    ]);
  });
});

// ─── 跨作用域组合 ───

describe("PermissionStore 跨作用域组合", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createTempDir("perm-cross");
  });

  it("list 返回 session + workspace + global 的并集", async () => {
    const store = new PermissionStore({ rootDir });
    const wsId = ws("ws-mix");

    await store.create(
      wsId,
      makeRule({
        pattern: { tool: "bash", argument: "*" },
        scope: "session",
      }),
    );
    await store.create(
      wsId,
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "git *" },
        decision: "allow",
        scope: "context",
      }),
    );
    await store.create(
      MAIN,
      PermissionStore.createRule({
        pattern: { tool: "*", argument: "*" },
        decision: "deny",
        scope: "global",
      }),
    );

    const rules = store.list(wsId);
    expect(rules).toHaveLength(3);
  });

  it("match 时 deny（全局） > allow（workspace） > allow（session）", async () => {
    const store = new PermissionStore({ rootDir });
    const wsId = ws("ws-priority");

    // 会话：宽泛 allow
    await store.create(
      wsId,
      makeRule({
        id: "session-allow",
        pattern: { tool: "bash", argument: "*" },
        scope: "session",
      }),
    );
    // 工作区：更精确的 allow
    await store.create(
      wsId,
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "git status" },
        decision: "allow",
        scope: "context",
      }),
    );
    // 全局：宽泛 deny —— deny 应胜出
    await store.create(
      MAIN,
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "*" },
        decision: "deny",
        scope: "global",
      }),
    );

    const match = store.match(
      wsId,
      makeRequest("bash", { command: "git status" }),
    );
    expect(match?.decision).toBe("deny");
  });
});
