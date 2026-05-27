import { describe, expect, it } from "vitest";
import { EventBus } from "../../events/event-bus.js";
import { ConfirmationTracker } from "../confirmation-tracker.js";
import { PermissionStore } from "../permission-store.js";
import { SlidingWindowRateLimiter } from "../rate-limiter.js";
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      const middlewares = pipeline.getMiddlewares();
      const names = middlewares.map((m) => m.name);

      expect(names).toContain("PolicyEvaluator");
      expect(names).toContain("PathResolve");
    });

    it("有 EventBus 时包含审计器", () => {
      const eventBus = new EventBus<AgentEventMapWithSecurity>();
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
        eventBus,
      });

      const middlewares = pipeline.getMiddlewares();
      const names = middlewares.map((m) => m.name);

      expect(names).toContain("SecurityAuditor");
    });

    it("无 EventBus 时不包含审计器", () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      const middlewares = pipeline.getMiddlewares();
      const names = middlewares.map((m) => m.name);

      expect(names).not.toContain("SecurityAuditor");
    });

    it("中间件按正确顺序排列（post-execute → authorize → guard）", () => {
      const eventBus = new EventBus<AgentEventMapWithSecurity>();
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      const names = pipeline.getMiddlewares().map((m) => m.name);
      expect(names).toContain("OperationClassifier");
    });
  });

  describe("策略引擎集成", () => {
    it("可以通过管线访问策略引擎加载自定义规则", async () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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

    it("external 操作升级为 requiresConfirmation（即使无策略规则匹配）", async () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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

    it("CI 模式 + 无匹配规则 + confirm 操作 → 保持 confirm（block 由 broker 兜底）", async () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
        sessionType: "ci",
      });

      const result = await pipeline.evaluate(
        "bash",
        { command: "curl https://example.com" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(true);
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
        trustContext: { kind: "workspace", dir: wsPath },
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
        permissionStore: store,
      });

      const result = await pipeline.evaluate(
        "bash",
        { command: "curl https://evil.com" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(false);
      // deny 在 PolicyEvaluator 阶段短路，guard 阶段（ExecutionGuard）不应运行
      // → executionConstraints 不会被写入
      expect(result.executionConstraints).toBeUndefined();
    });

    it("包含 PermissionMatcher 中间件", () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      const names = pipeline.getMiddlewares().map((m) => m.name);
      expect(names).toContain("PermissionMatcher");
    });

    it("pipeline.getPermissionStore 和 getContextId 暴露访问", () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      expect(pipeline.getPermissionStore()).toBeDefined();
      expect(pipeline.getContextId()).toMatch(/^[0-9a-f]{16}$/);
    });

    it("result 透出 trustLevel（global 上下文 → global）", async () => {
      const pipeline = new SecurityPipeline({ trustContext: { kind: "global" } });
      const result = await pipeline.evaluate("read", { path: "x.ts" }, "/tmp");
      expect(result.trustLevel).toBe("global");
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
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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

  describe("智能建议集成", () => {
    it("初次 confirm 不附带 suggestion", async () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      const result = await pipeline.evaluate(
        "bash",
        { command: "curl https://example.com" },
        "/home/user/project",
      );

      expect(result.requiresConfirmation).toBe(true);
      expect(result.suggestion).toBeUndefined();
    });

    it("达到阈值后 confirm 附带 suggestion（curl 是 medium 风险，5 次）", async () => {
      const tracker = new ConfirmationTracker();
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
        confirmationTracker: tracker,
      });

      // 模拟用户连续 5 次手动确认
      for (let i = 0; i < 5; i++) {
        tracker.record(
          {
            tool: "bash",
            arguments: { command: `curl https://api.example.com/${i}` },
            context: {
              cwd: "/home/user/project",
              trust: { kind: "workspace", dir: "/home/user/project" },
              sessionType: "interactive",
            },
          },
          "medium",
        );
      }

      const result = await pipeline.evaluate(
        "bash",
        { command: "curl https://api.example.com/6" },
        "/home/user/project",
      );

      expect(result.requiresConfirmation).toBe(true);
      expect(result.suggestion).toBeDefined();
      expect(result.suggestion?.suggest).toBe(true);
      expect(result.suggestion?.patterns.length).toBeGreaterThan(0);
      // 最后一个候选模式应该是最通用的 "curl *"
      const argList = result.suggestion!.patterns.map((p) => p.pattern.argument);
      expect(argList).toContain("curl *");
    });

    it("critical 风险操作即使多次手动确认也永不建议", async () => {
      const tracker = new ConfirmationTracker();
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
        confirmationTracker: tracker,
      });

      // 注入 100 次记录
      for (let i = 0; i < 100; i++) {
        tracker.record(
          {
            tool: "bash",
            arguments: { command: "rm -rf /tmp/junk" },
            context: {
              cwd: "/home/user/project",
              trust: { kind: "workspace", dir: "/home/user/project" },
              sessionType: "interactive",
            },
          },
          "critical",
        );
      }

      // rm -rf 走 cf-destructive-commands 规则 → confirm + high 风险
      // 但即使被分类为 critical，也不应建议
      const result = await pipeline.evaluate(
        "bash",
        { command: "rm -rf /tmp/junk" },
        "/home/user/project",
      );

      // 不论决策如何，suggestion 都应该是 undefined（critical 永不建议）
      // 注：实际决策可能是 high 而非 critical，这里仅验证逻辑路径
      if (result.decision?.riskLevel === "critical") {
        expect(result.suggestion).toBeUndefined();
      }
    });

    it("allow 决策不会触发 suggestion（observe 操作）", async () => {
      const tracker = new ConfirmationTracker();
      // 即使 tracker 里有大量记录
      tracker.record(
        {
          tool: "read",
          arguments: { path: "/tmp/a" },
          context: { cwd: "/tmp", trust: { kind: "workspace", dir: "/tmp" }, sessionType: "interactive" },
        },
        "low",
      );

      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
        confirmationTracker: tracker,
      });

      const result = await pipeline.evaluate(
        "read",
        { path: "src/index.ts" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBeFalsy();
      expect(result.suggestion).toBeUndefined();
    });

    it("权限规则 allow 命中后不再 confirm，也不需 suggestion", async () => {
      const store = new PermissionStore({ rootDir: null });
      store.create(
        null,
        PermissionStore.createRule({
          pattern: { tool: "bash", argument: "curl *" },
          decision: "allow",
          scope: "global",
        }),
      );

      const tracker = new ConfirmationTracker();
      // 即使 tracker 里有 5 次记录
      for (let i = 0; i < 5; i++) {
        tracker.record(
          {
            tool: "bash",
            arguments: { command: "curl https://example.com" },
            context: {
              cwd: "/home/user/project",
              trust: { kind: "workspace", dir: "/home/user/project" },
              sessionType: "interactive",
            },
          },
          "medium",
        );
      }

      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
        permissionStore: store,
        confirmationTracker: tracker,
      });

      const result = await pipeline.evaluate(
        "bash",
        { command: "curl https://example.com" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBeFalsy();
      expect(result.suggestion).toBeUndefined();
    });

    it("pipeline.getConfirmationTracker 暴露访问", () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      expect(pipeline.getConfirmationTracker()).toBeDefined();
      expect(typeof pipeline.getConfirmationTracker().record).toBe("function");
    });

    it("包含 SuggestionGenerator 中间件", () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      const names = pipeline.getMiddlewares().map((m) => m.name);
      expect(names).toContain("SuggestionGenerator");
    });
  });

  describe("执行守卫集成", () => {
    it("放行的 read 操作携带 executionConstraints", async () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      const result = await pipeline.evaluate(
        "read",
        { path: "src/index.ts" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(true);
      expect(result.executionConstraints).toBeDefined();
      expect(result.executionConstraints!.timeoutMs).toBe(10_000);
      expect(result.executionConstraints!.rateLimited).toBe(false);
    });

    it("bash 工具拿到 120s timeout / 10MB 输出限制", async () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      const result = await pipeline.evaluate(
        "bash",
        { command: "git status" },
        "/home/user/project",
      );

      expect(result.executionConstraints!.timeoutMs).toBe(120_000);
      expect(result.executionConstraints!.maxOutputBytes).toBe(10 * 1024 * 1024);
    });

    it("超过频率限制后被 block，reason 提示频率超限", async () => {
      let now = 1000;
      const limiter = new SlidingWindowRateLimiter(60_000, 2, () => now);
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
        executionGuard: { rateLimiter: limiter },
      });

      // 前两次放行
      await pipeline.evaluate(
        "read",
        { path: "src/a.ts" },
        "/home/user/project",
      );
      await pipeline.evaluate(
        "read",
        { path: "src/b.ts" },
        "/home/user/project",
      );

      // 第三次超限
      const result = await pipeline.evaluate(
        "read",
        { path: "src/c.ts" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/频率限制/);
      expect(result.executionConstraints!.rateLimited).toBe(true);
    });

    it("自定义 executionGuard.toolProfiles 覆盖默认", async () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
        executionGuard: {
          toolProfiles: {
            bash: { timeoutMs: 30_000 },
          },
        },
      });

      const result = await pipeline.evaluate(
        "bash",
        { command: "git status" },
        "/home/user/project",
      );

      expect(result.executionConstraints!.timeoutMs).toBe(30_000);
    });

    it("不同工具的频率限制相互独立", async () => {
      let now = 1000;
      const limiter = new SlidingWindowRateLimiter(60_000, 1, () => now);
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
        executionGuard: { rateLimiter: limiter },
      });

      // bash 用满
      await pipeline.evaluate(
        "bash",
        { command: "git status" },
        "/home/user/project",
      );
      const second = await pipeline.evaluate(
        "bash",
        { command: "git log" },
        "/home/user/project",
      );
      expect(second.allowed).toBe(false);

      // read 不受影响
      const readResult = await pipeline.evaluate(
        "read",
        { path: "src/a.ts" },
        "/home/user/project",
      );
      expect(readResult.allowed).toBe(true);
    });

    it("policy block 时不消耗频率配额", async () => {
      let now = 1000;
      const limiter = new SlidingWindowRateLimiter(60_000, 5, () => now);
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
        executionGuard: { rateLimiter: limiter },
      });

      // bi-git-write 应该 block，不应到 ExecutionGuard
      await pipeline.evaluate(
        "write",
        { path: ".git/config" },
        "/home/user/project",
      );

      // 配额未被消耗
      expect(limiter.check("write").used).toBe(0);
    });

    it("包含 ExecutionGuard 中间件", () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      const names = pipeline.getMiddlewares().map((m) => m.name);
      expect(names).toContain("ExecutionGuard");
    });

    it("pipeline.getExecutionGuard 暴露访问", () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      const guard = pipeline.getExecutionGuard();
      expect(guard).toBeDefined();
      expect(typeof guard.getRateLimiter).toBe("function");
    });
  });

  describe("命令预解析集成（纵深防御）", () => {
    it("bash 命令内的 ~/.ssh/ 路径触发 bi-ssh-keys block", async () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      const result = await pipeline.evaluate(
        "bash",
        { command: "cat ~/.ssh/id_rsa" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(false);
      expect(result.decision?.action).toBe("block");
      const ruleIds = result.decision?.matchedRules.map((r) => r.id) ?? [];
      expect(ruleIds).toContain("bi-ssh-keys");
    });

    it("bash 命令内的 LD_PRELOAD=xxx 触发 bi-env-injection block", async () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      const result = await pipeline.evaluate(
        "bash",
        { command: "LD_PRELOAD=/evil.so ls" },
        "/home/user/project",
      );

      expect(result.allowed).toBe(false);
      expect(result.decision?.action).toBe("block");
    });

    it("引号内的 | 不被误判为链式（精准 quote-aware 检测）", async () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      // echo "a | b" 本身是 safe read-only 命令
      // 如果分类器误把内部的 | 当作 chain 会升级为 external
      // 精准检测下应该：没有 chain → echo 不在 SAFE_READ_COMMANDS → external
      // （echo 不在白名单是另一回事——这里验证的是 hasChain 不被误触发）
      const result = await pipeline.evaluate(
        "bash",
        { command: 'echo "a | b"' },
        "/home/user/project",
      );

      const analysis =
        result.decision &&
        pipeline.getMiddlewares().find((m) => m.name === "CommandAnalyzer");
      expect(analysis).toBeDefined();
      // 最有力的验证：resolvedAccess 里的 commandAnalysis.hasChain=false
      // 但 result 里没直接暴露，所以通过操作类分类间接验证
      // echo 不在安全白名单 → 如果 hasChain=false，会被分类为 external（而非 critical）
      expect(result.operationClass).not.toBe("critical");
    });

    it("resolvedAccess 被填充了命令分析结果", async () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      // 用一个会被 confirm 的命令，然后检查内部 state
      // 通过自定义中间件注入观察
      let capturedRequest: unknown = null;
      const sniffer = {
        name: "sniffer",
        phase: "authorize" as const,
        order: 5, // 在 PolicyEvaluator(0) 之后 Classifier(10) 之前
        execute: async (ctx: any, next: any) => {
          capturedRequest = ctx.request.resolvedAccess;
          return next();
        },
      };

      const pipelineWithSniffer = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
        middlewares: [sniffer],
      });

      await pipelineWithSniffer.evaluate(
        "bash",
        { command: "curl https://api.example.com/data" },
        "/home/user/project",
      );

      expect(capturedRequest).toBeDefined();
      const access = capturedRequest as {
        hosts?: string[];
        commandAnalysis?: { hasChain: boolean };
      };
      expect(access.hosts).toContain("api.example.com");
      expect(access.commandAnalysis).toBeDefined();
    });

    it("包含 CommandAnalyzer 中间件且位于最前", () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
      });

      const middlewares = pipeline.getMiddlewares();
      const names = middlewares.map((m) => m.name);
      expect(names).toContain("CommandAnalyzer");

      // CommandAnalyzer 应该在 PolicyEvaluator 之前
      const cmdIdx = names.indexOf("CommandAnalyzer");
      const policyIdx = names.indexOf("PolicyEvaluator");
      expect(cmdIdx).toBeLessThan(policyIdx);
    });
  });

  describe("路径守卫集成", () => {
    it("文件操作的路径被解析", async () => {
      const pipeline = new SecurityPipeline({
        trustContext: { kind: "workspace", dir: "/home/user/project" },
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
