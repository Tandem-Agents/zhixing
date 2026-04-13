import { describe, expect, it } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import { PermissionStore } from "../permission-store.js";
import type { AgentEventMapWithSecurity } from "../security-auditor.js";
import { SecurityPipeline } from "../security-pipeline.js";
import type {
  OperationClass,
  SecurityRule,
  ToolBoundaryRegistry,
} from "../types.js";

describe("SecurityPipeline", () => {
  describe("基本管线行为", () => {
    it("安全操作通过管线", async () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
      });

      const result = await pipeline.evaluate(
        "read",
        { path: "src/index.ts" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(true);
    });

    it("危险操作被阻止", async () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
      });

      const result = await pipeline.evaluate(
        "write",
        { path: ".git/config" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it("需确认的操作不被阻止但标记为 requiresConfirmation", async () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        sessionType: "interactive",
      });

      // curl 触发 cf-network-tools confirm 规则
      const result = await pipeline.evaluate(
        "bash",
        { command: "curl https://example.com" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.decision?.action).toBe("confirm");
    });
  });

  describe("管线组件", () => {
    it("包含必要的中间件", () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
      });

      const middlewares = pipeline.getMiddlewares();
      const names = middlewares.map((m) => m.name);

      expect(names).toContain("PolicyEvaluator");
      expect(names).toContain("EnvSanitize");
      expect(names).toContain("PathGuard");
    });

    it("有 EventBus 时包含审计器", () => {
      const eventBus = new EventBus<AgentEventMapWithSecurity>();
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        eventBus,
      });

      const middlewares = pipeline.getMiddlewares();
      const names = middlewares.map((m) => m.name);

      expect(names).toContain("SecurityAuditor");
    });

    it("无 EventBus 时不包含审计器", () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
      });

      const middlewares = pipeline.getMiddlewares();
      const names = middlewares.map((m) => m.name);

      expect(names).not.toContain("SecurityAuditor");
    });

    it("中间件按正确顺序排列（post-execute → authorize → guard）", () => {
      const eventBus = new EventBus<AgentEventMapWithSecurity>();
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        eventBus,
      });

      const middlewares = pipeline.getMiddlewares();
      const phases = middlewares.map((m) => m.phase);

      // post-execute 必须在数组最前（onion 最外层），以便在其他中间件 return 后观察到最终状态
      const phaseOrder = { "post-execute": 0, authorize: 1, guard: 2 };
      let lastPhaseOrder = -1;
      for (const phase of phases) {
        const order = phaseOrder[phase] ?? 0;
        expect(order).toBeGreaterThanOrEqual(lastPhaseOrder);
        lastPhaseOrder = order;
      }
    });

    it("包含 OperationClassifier 中间件", () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
      });

      const names = pipeline.getMiddlewares().map((m) => m.name);
      expect(names).toContain("OperationClassifier");
    });
  });

  describe("策略引擎集成", () => {
    it("可以通过管线访问策略引擎加载自定义规则", async () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
      });

      const customRule: SecurityRule = {
        id: "custom-block-docker",
        name: "禁止 Docker",
        description: "测试规则",
        enabled: true,
        match: { type: "command_prefix", prefixes: ["docker"] },
        action: "block",
        bypassImmune: false,
        severity: "high",
        category: "privilege_escalation",
        source: "project",
        message: "Docker 被禁止",
      };

      pipeline.getPolicyEngine().loadRules([customRule]);

      const result = await pipeline.evaluate(
        "bash",
        { command: "docker run nginx" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(false);
    });
  });

  describe("安全事件发射", () => {
    it("block 决策发射 security:blocked 事件（auditor 在 onion 外层观察最终状态）", async () => {
      const eventBus = new EventBus<AgentEventMapWithSecurity>();
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        eventBus,
      });

      const blockedEvents: unknown[] = [];
      eventBus.on("security:blocked", (payload) => {
        blockedEvents.push(payload);
      });

      await pipeline.evaluate(
        "write",
        { path: ".git/config" },
        "/home/user/project",
      );

      expect(blockedEvents.length).toBe(1);
    });

    it("allow 决策发射 security:evaluation 事件", async () => {
      const eventBus = new EventBus<AgentEventMapWithSecurity>();
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        eventBus,
      });

      const evalEvents: unknown[] = [];
      eventBus.on("security:evaluation", (payload) => {
        evalEvents.push(payload);
      });

      await pipeline.evaluate(
        "read",
        { path: "src/index.ts" },
        "/home/user/project",
      );

      expect(evalEvents.length).toBe(1);
    });
  });

  describe("操作分类集成", () => {
    it("observe 操作不需要确认", async () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
      });

      const result = await pipeline.evaluate(
        "read",
        { path: "src/index.ts" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBeFalsy();
      expect(result.operationClass).toBe("observe");
    });

    it("internal 操作不需要确认（工作区内写入）", async () => {
      const os = await import("node:os");
      const fs = await import("node:fs");
      const path = await import("node:path");

      const ws = fs.mkdtempSync(path.join(os.tmpdir(), "zx-pipe-internal-"));
      try {
        const pipeline = new SecurityPipeline({ workspace: ws });
        const result = await pipeline.evaluate(
          "write",
          { path: path.join(ws, "foo.ts") },
          ws,
        );

        expect(result.allowed).toBe(true);
        expect(result.requiresConfirmation).toBeFalsy();
        expect(result.operationClass).toBe("internal");
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    it("external 操作升级为 requiresConfirmation（即使无策略规则匹配）", async () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        // 没有传入 registry → 未声明边界的工具分类为 critical
        classifier: {
          classify: () => "external" as const,
        },
      });

      const result = await pipeline.evaluate(
        "mcp_unknown_tool",
        {},
        "/home/user/project",
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.operationClass).toBe("external");
      expect(result.decision?.action).toBe("confirm");
    });

    it("critical 操作升级为 requiresConfirmation 且 riskLevel=critical", async () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        classifier: {
          classify: (): OperationClass => "critical",
        },
      });

      const result = await pipeline.evaluate(
        "mystery_tool",
        {},
        "/home/user/project",
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.operationClass).toBe("critical");
      expect(result.decision?.riskLevel).toBe("critical");
    });

    it("未注册工具使用默认边界分类器 → critical → 升级为 confirm", async () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
      });

      const result = await pipeline.evaluate(
        "random_mcp_tool",
        { input: "foo" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.operationClass).toBe("critical");
    });

    it("工具边界注册表可以让 MCP 工具被精确分类", async () => {
      const registry: ToolBoundaryRegistry = {
        getBoundaries: (name) =>
          name === "wechat_send"
            ? [{ boundaryType: "messaging", access: "send", dynamic: true }]
            : undefined,
      };

      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        toolBoundaryRegistry: registry,
      });

      const result = await pipeline.evaluate(
        "wechat_send",
        { to: "张三", content: "hello" },
        "/home/user/project",
      );

      expect(result.operationClass).toBe("external");
      expect(result.requiresConfirmation).toBe(true);
    });

    it("block 优先于 classifier 的升级（policy block 不被分类器抵消）", async () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
      });

      // .git/ 写入触发 bi-git-write (block)
      const result = await pipeline.evaluate(
        "write",
        { path: ".git/config" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(false);
      expect(result.decision?.action).toBe("block");
    });

    it("policy confirm + classifier observe：仍 confirm（policy 胜出）", async () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
      });

      // cf-privilege-escalation 对 sudo 规则 confirm
      // 即使分类器判定为 observe/internal，policy 的 confirm 不会被降级
      const result = await pipeline.evaluate(
        "bash",
        { command: "sudo ls" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
    });

    it("发射 security:classified 事件", async () => {
      const eventBus = new EventBus<AgentEventMapWithSecurity>();
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        eventBus,
      });

      const events: Array<{ operationClass: OperationClass }> = [];
      eventBus.on("security:classified", (payload) => {
        events.push(payload as { operationClass: OperationClass });
      });

      await pipeline.evaluate(
        "read",
        { path: "src/a.ts" },
        "/home/user/project",
      );

      expect(events.length).toBe(1);
      expect(events[0]!.operationClass).toBe("observe");
    });
  });

  describe("权限匹配集成", () => {
    it("用户 allow 规则可以免除 confirm（curl 场景）", async () => {
      const store = new PermissionStore({ rootDir: null });
      store.create(
        null,
        PermissionStore.createRule({
          pattern: { tool: "bash", argument: "curl *" },
          decision: "allow",
          scope: "global",
        }),
      );

      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        permissionStore: store,
      });

      const result = await pipeline.evaluate(
        "bash",
        { command: "curl https://example.com" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBeFalsy();
      expect(result.matchedPermissionRule).toBeDefined();
      expect(result.matchedPermissionRule?.decision).toBe("allow");
    });

    it("用户 deny 规则将 confirm 操作降级为 block", async () => {
      const store = new PermissionStore({ rootDir: null });
      store.create(
        null,
        PermissionStore.createRule({
          pattern: { tool: "bash", argument: "curl *" },
          decision: "deny",
          scope: "global",
        }),
      );

      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        permissionStore: store,
      });

      const result = await pipeline.evaluate(
        "bash",
        { command: "curl https://evil.com" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(false);
      expect(result.decision?.action).toBe("block");
      expect(result.matchedPermissionRule?.decision).toBe("deny");
    });

    it("CI 模式 + 无匹配规则 + confirm 操作 → block", async () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        sessionType: "ci",
      });

      const result = await pipeline.evaluate(
        "bash",
        { command: "curl https://example.com" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/ci.*无匹配/);
    });

    it("CI 模式 + 预配置 allow 规则 → 放行", async () => {
      const store = new PermissionStore({ rootDir: null });
      store.create(
        null,
        PermissionStore.createRule({
          pattern: { tool: "bash", argument: "curl *" },
          decision: "allow",
          scope: "global",
        }),
      );

      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        sessionType: "ci",
        permissionStore: store,
      });

      const result = await pipeline.evaluate(
        "bash",
        { command: "curl https://example.com" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(true);
    });

    it("workspace 作用域规则可以精确匹配当前工作区", async () => {
      const store = new PermissionStore({ rootDir: null });
      const wsPath = "/home/user/project";
      const wsId = PermissionStore.workspaceIdFromPath(wsPath);

      store.create(
        wsId,
        PermissionStore.createRule({
          pattern: { tool: "bash", argument: "npm install *" },
          decision: "allow",
          scope: "workspace",
        }),
      );

      const pipeline = new SecurityPipeline({
        workspace: wsPath,
        permissionStore: store,
      });

      // npm install 本身是 internal（不会触发 confirm），
      // 用一个会触发 confirm 的命令来验证
      store.create(
        wsId,
        PermissionStore.createRule({
          pattern: { tool: "bash", argument: "sudo *" },
          decision: "allow",
          scope: "workspace",
        }),
      );

      const result = await pipeline.evaluate(
        "bash",
        { command: "sudo apt update" },
        wsPath,
      );

      expect(result.allowed).toBe(true);
      expect(result.matchedPermissionRule?.scope).toBe("workspace");
    });

    it("deny 规则 + 短路：guards 不应运行", async () => {
      // 通过 resolvedPaths 是否被设置来验证 PathGuard 是否跑过
      const store = new PermissionStore({ rootDir: null });
      store.create(
        null,
        PermissionStore.createRule({
          pattern: { tool: "bash", argument: "*" },
          decision: "deny",
          scope: "global",
        }),
      );

      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        permissionStore: store,
      });

      const result = await pipeline.evaluate(
        "bash",
        { command: "curl https://evil.com" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(false);
      // PathGuard 应该没跑过（bash 工具没有 path 参数，所以 resolvedPaths 会是 undefined 不管跑没跑）
      // 更可靠的验证：EnvSanitize 的 sanitizedEnv 应该不存在
      expect(result.sanitizedEnv).toBeUndefined();
    });

    it("包含 PermissionMatcher 中间件", () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
      });

      const names = pipeline.getMiddlewares().map((m) => m.name);
      expect(names).toContain("PermissionMatcher");
    });

    it("pipeline.getPermissionStore 和 getWorkspaceId 暴露访问", () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
      });

      expect(pipeline.getPermissionStore()).toBeDefined();
      expect(pipeline.getWorkspaceId()).toMatch(/^[0-9a-f]{16}$/);
    });

    it("发射 security:permission_matched 事件", async () => {
      const eventBus = new EventBus<AgentEventMapWithSecurity>();
      const store = new PermissionStore({ rootDir: null });
      store.create(
        null,
        PermissionStore.createRule({
          pattern: { tool: "bash", argument: "curl *" },
          decision: "allow",
          scope: "global",
        }),
      );

      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
        permissionStore: store,
        eventBus,
      });

      const events: Array<{ ruleId: string; decision: string }> = [];
      eventBus.on("security:permission_matched", (payload) => {
        events.push(payload as { ruleId: string; decision: string });
      });

      await pipeline.evaluate(
        "bash",
        { command: "curl https://example.com" },
        "/home/user/project",
      );

      expect(events.length).toBe(1);
      expect(events[0]!.decision).toBe("allow");
    });
  });

  describe("路径守卫集成", () => {
    it("文件操作的路径被解析", async () => {
      const pipeline = new SecurityPipeline({
        workspace: "/home/user/project",
      });

      const result = await pipeline.evaluate(
        "read",
        { path: "./src/test.ts" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(true);
      if (result.resolvedPaths) {
        for (const p of result.resolvedPaths) {
          expect(p).not.toContain("./");
        }
      }
    });
  });
});
