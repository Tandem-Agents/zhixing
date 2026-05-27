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
import {
  PermissionStore,
  globMatches,
  globSpecificity,
  globToRegex,
} from "../permission-store.js";
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
    workspace: overrides.workspace,
  };
}

// ─── Glob 匹配 ───

describe("globToRegex / globMatches", () => {
  it("字面量字符串精确匹配", () => {
    expect(globMatches("npm install express", "npm install express")).toBe(true);
    expect(globMatches("npm install express", "npm install foo")).toBe(false);
  });

  it("不含 / 的模式中 * 匹配任意字符（bash 命令场景）", () => {
    expect(globMatches("npm install *", "npm install express")).toBe(true);
    expect(globMatches("npm install *", "npm install foo-bar")).toBe(true);
    // 不含 / 的模式 → * 也匹配带 / 的输入（如 @scope/pkg）
    expect(globMatches("npm install *", "npm install @scope/pkg")).toBe(true);
    expect(globMatches("*", "anything")).toBe(true);
    expect(globMatches("*", "/tmp/any/path")).toBe(true);
  });

  it("含 / 的模式中 * 是 path-aware（文件路径场景）", () => {
    expect(globMatches("src/*", "src/index.ts")).toBe(true);
    expect(globMatches("src/*", "src/sub/index.ts")).toBe(false);
  });

  it("** 匹配任意字符（包括 /）", () => {
    expect(globMatches("src/**", "src/index.ts")).toBe(true);
    expect(globMatches("src/**", "src/sub/deep/index.ts")).toBe(true);
    expect(globMatches("**/*.ts", "src/foo/bar.ts")).toBe(true);
  });

  it("? 匹配单个字符（含 / 的模式中不跨 /）", () => {
    expect(globMatches("foo?", "foos")).toBe(true);
    expect(globMatches("foo?", "foo")).toBe(false);
    expect(globMatches("foo?", "fooss")).toBe(false);
    // path-aware 模式
    expect(globMatches("src/?", "src/a")).toBe(true);
    expect(globMatches("src/?", "src/")).toBe(false);
  });

  it("regex 元字符被转义", () => {
    expect(globMatches("a.b", "a.b")).toBe(true);
    expect(globMatches("a.b", "aXb")).toBe(false);
    expect(globMatches("foo+bar", "foo+bar")).toBe(true);
    expect(globMatches("(group)", "(group)")).toBe(true);
  });

  it("整串匹配（前缀/后缀都有锚点）", () => {
    const re = globToRegex("src/*");
    expect(re.test("src/a.ts")).toBe(true);
    // 前缀不对
    expect(re.test("lib/src/a.ts")).toBe(false);
  });
});

describe("globSpecificity", () => {
  it("深度主导：深层模式 >> 浅层模式", () => {
    expect(globSpecificity("src/**/*.ts")).toBeGreaterThan(
      globSpecificity("src/**"),
    );
    expect(globSpecificity("src/**")).toBeGreaterThan(globSpecificity("*"));
  });

  it("同深度：literal 长度作为 tiebreaker（规格公式的扩展）", () => {
    // npm install * 和 npm * 同深度同通配符数 → literal 更长的胜出
    expect(globSpecificity("npm install *")).toBeGreaterThan(
      globSpecificity("npm *"),
    );
  });

  it("精确命令胜出通配符", () => {
    expect(globSpecificity("npm install express")).toBeGreaterThan(
      globSpecificity("npm install *"),
    );
  });

  it("catch-all `*` 得分最低", () => {
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
    it("创建的会话规则可被 list 和 match", () => {
      store.create(
        null,
        makeRule({
          pattern: { tool: "bash", argument: "git *" },
          scope: "session",
        }),
      );

      expect(store.list(null)).toHaveLength(1);
      const match = store.match(
        null,
        makeRequest("bash", { command: "git status" }),
      );
      expect(match).not.toBeNull();
      expect(match?.decision).toBe("allow");
    });

    it("session 规则按 workspaceId 隔离", () => {
      const wsA = "workspace-aaa";
      const wsB = "workspace-bbb";

      store.create(
        wsA,
        makeRule({
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );

      expect(store.list(wsA)).toHaveLength(1);
      expect(store.list(wsB)).toHaveLength(0);
    });

    it("未匹配时返回 null", () => {
      const match = store.match(
        null,
        makeRequest("bash", { command: "curl foo" }),
      );
      expect(match).toBeNull();
    });

    it("match 更新 matchCount 和 lastMatchedAt", () => {
      const timestamps = [1000, 2000, 3000];
      let idx = 0;
      const timedStore = new PermissionStore({
        rootDir: null,
        now: () => timestamps[idx++]!,
      });

      timedStore.create(
        null,
        makeRule({
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );

      timedStore.match(null, makeRequest("bash", { command: "ls" }));
      timedStore.match(null, makeRequest("bash", { command: "pwd" }));

      const rules = timedStore.list(null);
      expect(rules[0]!.matchCount).toBe(2);
      expect(rules[0]!.lastMatchedAt).toBeGreaterThan(0);
    });
  });

  describe("工具匹配", () => {
    it("工具名大小写不敏感", () => {
      store.create(
        null,
        makeRule({
          pattern: { tool: "BASH", argument: "*" },
          scope: "session",
        }),
      );

      const match = store.match(
        null,
        makeRequest("bash", { command: "ls" }),
      );
      expect(match).not.toBeNull();
    });

    it('pattern.tool = "*" 匹配任何工具', () => {
      store.create(
        null,
        makeRule({
          pattern: { tool: "*", argument: "*" },
          scope: "session",
        }),
      );

      expect(
        store.match(null, makeRequest("read", { path: "/tmp/a" })),
      ).not.toBeNull();
      expect(
        store.match(null, makeRequest("bash", { command: "ls" })),
      ).not.toBeNull();
    });

    it("不同工具的规则不会错配", () => {
      store.create(
        null,
        makeRule({
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );

      const match = store.match(
        null,
        makeRequest("write", { path: "/tmp/a" }),
      );
      expect(match).toBeNull();
    });
  });

  describe("参数提取", () => {
    it("bash 从 command 提取", () => {
      store.create(
        null,
        makeRule({
          pattern: { tool: "bash", argument: "git status" },
          scope: "session",
        }),
      );
      expect(
        store.match(null, makeRequest("bash", { command: "git status" })),
      ).not.toBeNull();
    });

    it("write/edit 从 path 或 file_path 提取", () => {
      store.create(
        null,
        makeRule({
          pattern: { tool: "write", argument: "src/**" },
          scope: "session",
        }),
      );

      expect(
        store.match(null, makeRequest("write", { path: "src/a.ts" })),
      ).not.toBeNull();
      expect(
        store.match(null, makeRequest("write", { file_path: "src/b.ts" })),
      ).not.toBeNull();
    });

    it("通用工具回退到第一个字符串参数", () => {
      store.create(
        null,
        makeRule({
          pattern: { tool: "wechat", argument: "*张三*" },
          scope: "session",
        }),
      );

      expect(
        store.match(null, makeRequest("wechat", { to: "张三", content: "x" })),
      ).not.toBeNull();
    });
  });

  describe("冲突解决（规格 §4.7）", () => {
    it("deny 胜出 allow", () => {
      store.create(
        null,
        makeRule({
          id: "allow-all",
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
          decision: "allow",
        }),
      );
      store.create(
        null,
        makeRule({
          id: "deny-rm",
          pattern: { tool: "bash", argument: "rm *" },
          scope: "session",
          decision: "deny",
        }),
      );

      const match = store.match(
        null,
        makeRequest("bash", { command: "rm foo" }),
      );
      expect(match?.id).toBe("deny-rm");
      expect(match?.decision).toBe("deny");
    });

    it("精确规则胜出宽泛规则（同决策）", () => {
      store.create(
        null,
        makeRule({
          id: "broad",
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );
      store.create(
        null,
        makeRule({
          id: "specific",
          pattern: { tool: "bash", argument: "git status" },
          scope: "session",
        }),
      );

      const match = store.match(
        null,
        makeRequest("bash", { command: "git status" }),
      );
      expect(match?.id).toBe("specific");
    });

    it("多条 deny 规则之间取最精确的", () => {
      store.create(
        null,
        makeRule({
          id: "deny-broad",
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
          decision: "deny",
        }),
      );
      store.create(
        null,
        makeRule({
          id: "deny-specific",
          pattern: { tool: "bash", argument: "rm -rf /" },
          scope: "session",
          decision: "deny",
        }),
      );

      const match = store.match(
        null,
        makeRequest("bash", { command: "rm -rf /" }),
      );
      expect(match?.id).toBe("deny-specific");
    });
  });

  describe("revoke", () => {
    it("按 id 撤销会话规则", () => {
      const ruleId = "target-rule";
      store.create(
        null,
        makeRule({
          id: ruleId,
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );

      expect(store.revoke(ruleId)).toBe(true);
      expect(store.list(null)).toHaveLength(0);
    });

    it("撤销不存在的 id 返回 false", () => {
      expect(store.revoke("nonexistent")).toBe(false);
    });
  });

  describe("reset / resetAll", () => {
    it("reset 清除给定 workspace 的会话规则", () => {
      store.create(
        "ws-1",
        makeRule({
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );
      store.create(
        "ws-2",
        makeRule({
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );

      store.reset("ws-1");
      expect(store.list("ws-1")).toHaveLength(0);
      expect(store.list("ws-2")).toHaveLength(1);
    });

    it("resetAll 清除全部规则", () => {
      store.create(
        "ws-1",
        makeRule({
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );
      store.create(
        "ws-2",
        makeRule({
          pattern: { tool: "bash", argument: "*" },
          scope: "session",
        }),
      );

      store.resetAll();
      expect(store.list("ws-1")).toHaveLength(0);
      expect(store.list("ws-2")).toHaveLength(0);
    });
  });

  describe("作用域参数校验", () => {
    it("workspace 作用域必须提供 workspaceId", () => {
      expect(() =>
        store.create(
          null,
          makeRule({
            pattern: { tool: "bash", argument: "*" },
            scope: "workspace",
          }),
        ),
      ).toThrow();
    });
  });
});

// ─── 磁盘持久化 ───

describe("PermissionStore (disk persistence)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createTempDir("perm");
  });

  it("创建 workspace 规则 → 文件被创建 → 新实例可加载", () => {
    const wsId = "ws-abc123";
    const storeA = new PermissionStore({ rootDir });

    storeA.create(
      wsId,
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "npm install *" },
        decision: "allow",
        scope: "workspace",
      }),
    );

    const file = path.join(rootDir, `${wsId}.json`);
    expect(fs.existsSync(file)).toBe(true);

    const storeB = new PermissionStore({ rootDir });
    const rules = storeB.list(wsId);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.pattern.argument).toBe("npm install *");
  });

  it("创建 global 规则 → global.json → 新实例可加载", () => {
    const storeA = new PermissionStore({ rootDir });
    storeA.create(
      null,
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
      "any-ws",
      makeRequest("bash", { command: "ls" }),
    );
    expect(match?.decision).toBe("deny");
  });

  it("revoke workspace 规则会立即落盘", () => {
    const wsId = "ws-revoke";
    const store = new PermissionStore({ rootDir });
    const rule = PermissionStore.createRule({
      pattern: { tool: "bash", argument: "*" },
      decision: "allow",
      scope: "workspace",
    });
    store.create(wsId, rule);
    store.revoke(rule.id);

    // 新实例加载时应该是空
    const store2 = new PermissionStore({ rootDir });
    expect(store2.list(wsId)).toHaveLength(0);
  });

  it("损坏的 JSON 文件 → 视为空规则集，不崩溃", () => {
    const wsId = "ws-corrupt";
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, `${wsId}.json`),
      "{ not valid json",
      "utf-8",
    );

    const store = new PermissionStore({ rootDir });
    expect(() => store.list(wsId)).not.toThrow();
    expect(store.list(wsId)).toHaveLength(0);
  });

  it("结构不正确的规则被过滤", () => {
    const wsId = "ws-partial";
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, `${wsId}.json`),
      JSON.stringify({
        version: 1,
        rules: [
          { id: "good", pattern: { tool: "bash", argument: "*" }, decision: "allow", scope: "workspace", createdAt: 1, lastMatchedAt: 0, matchCount: 0 },
          { id: "bad-no-pattern", decision: "allow", scope: "workspace" },
          { id: "bad-decision", pattern: { tool: "bash", argument: "*" }, decision: "maybe", scope: "workspace" },
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

  it("原子写：rename 后文件已存在且内容完整", () => {
    const wsId = "ws-atomic";
    const store = new PermissionStore({ rootDir });
    store.create(
      wsId,
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "ls" },
        decision: "allow",
        scope: "workspace",
      }),
    );

    const file = path.join(rootDir, `${wsId}.json`);
    expect(fs.existsSync(file)).toBe(true);
    // 不应该有 .tmp 残留
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);

    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(data.version).toBe(1);
    expect(data.rules).toHaveLength(1);
  });

  it("resetAll 会删除磁盘上所有 JSON 文件", () => {
    const store = new PermissionStore({ rootDir });
    store.create(
      "ws-x",
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "*" },
        decision: "allow",
        scope: "workspace",
      }),
    );
    store.create(
      null,
      PermissionStore.createRule({
        pattern: { tool: "*", argument: "*" },
        decision: "deny",
        scope: "global",
      }),
    );

    expect(fs.readdirSync(rootDir).length).toBeGreaterThan(0);
    store.resetAll();
    expect(fs.readdirSync(rootDir)).toHaveLength(0);
  });

  it("session 规则不落盘", () => {
    const store = new PermissionStore({ rootDir });
    store.create(
      "ws-session",
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "*" },
        decision: "allow",
        scope: "session",
      }),
    );

    expect(fs.existsSync(rootDir) && fs.readdirSync(rootDir).length).toBeFalsy();
  });
});

// ─── workspaceIdFromPath ───

describe("PermissionStore.workspaceIdFromPath", () => {
  it("相同路径产生相同 ID", () => {
    const a = PermissionStore.workspaceIdFromPath("/home/user/project");
    const b = PermissionStore.workspaceIdFromPath("/home/user/project");
    expect(a).toBe(b);
  });

  it("不同路径产生不同 ID", () => {
    const a = PermissionStore.workspaceIdFromPath("/home/user/a");
    const b = PermissionStore.workspaceIdFromPath("/home/user/b");
    expect(a).not.toBe(b);
  });

  it("ID 为 16 字符十六进制", () => {
    const id = PermissionStore.workspaceIdFromPath("/home/user/project");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("相对路径被解析为绝对路径", () => {
    const relative = PermissionStore.workspaceIdFromPath("./project");
    const absolute = PermissionStore.workspaceIdFromPath(
      path.resolve("./project"),
    );
    expect(relative).toBe(absolute);
  });
});

// ─── 跨作用域组合 ───

describe("PermissionStore 跨作用域组合", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await createTempDir("perm-cross");
  });

  it("list 返回 session + workspace + global 的并集", () => {
    const store = new PermissionStore({ rootDir });
    const wsId = "ws-mix";

    store.create(
      wsId,
      makeRule({
        pattern: { tool: "bash", argument: "*" },
        scope: "session",
      }),
    );
    store.create(
      wsId,
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "git *" },
        decision: "allow",
        scope: "workspace",
      }),
    );
    store.create(
      null,
      PermissionStore.createRule({
        pattern: { tool: "*", argument: "*" },
        decision: "deny",
        scope: "global",
      }),
    );

    const rules = store.list(wsId);
    expect(rules).toHaveLength(3);
  });

  it("match 时 deny（全局） > allow（workspace） > allow（session）", () => {
    const store = new PermissionStore({ rootDir });
    const wsId = "ws-priority";

    // 会话：宽泛 allow
    store.create(
      wsId,
      makeRule({
        id: "session-allow",
        pattern: { tool: "bash", argument: "*" },
        scope: "session",
      }),
    );
    // 工作区：更精确的 allow
    store.create(
      wsId,
      PermissionStore.createRule({
        pattern: { tool: "bash", argument: "git status" },
        decision: "allow",
        scope: "workspace",
      }),
    );
    // 全局：宽泛 deny —— deny 应胜出
    store.create(
      null,
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
