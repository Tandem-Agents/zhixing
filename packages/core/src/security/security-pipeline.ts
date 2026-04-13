/**
 * 安全中间件管线
 *
 * 将策略评估、操作分类、环境净化、路径守卫、审计记录等中间件串联执行。
 *
 * Phase 2 管线：
 *   post-execute (outermost wrapper)
 *     └── authorize
 *           ├── PolicyEvaluator       (order=0)   评估内置/用户规则
 *           └── OperationClassifier   (order=10)  按影响范围分类
 *     └── guard
 *           ├── EnvSanitize           (order=10)  清理危险环境变量
 *           └── PathGuard             (order=20)  路径规范化 + 边界检查
 *
 * ── Onion 模型排序 ──
 * post-execute 阶段（SecurityAuditor）在数组中位于最前，作为 onion 最外层包装器。
 * 这样即使 PolicyEvaluator 在 block 时短路，auditor 仍能观察到最终决策并发射事件。
 *
 * ── 决策累积 ──
 * 中间件不各自拼装结果，而是把状态写入 ctx.state（decision / operationClass / ...）。
 * 管线最底层的 buildFinalResult 从累积状态构造统一的 SecurityMiddlewareResult。
 */

import type { IEventBus } from "../events/types.js";
import {
  CompositeClassifier,
  createDefaultClassifier,
} from "./classifier.js";
import { EnvSanitize } from "./env-sanitize.js";
import { PathGuard } from "./path-guard.js";
import { PermissionMatcherMiddleware } from "./permission-matcher.js";
import { PermissionStore } from "./permission-store.js";
import { PolicyEngine } from "./policy-engine.js";
import type { AgentEventMapWithSecurity } from "./security-auditor.js";
import { SecurityAuditor } from "./security-auditor.js";
import type {
  IPermissionStore,
  OperationClass,
  OperationClassifier,
  SecurityDecision,
  SecurityMiddleware,
  SecurityMiddlewareContext,
  SecurityMiddlewareResult,
  SecurityRequest,
  SessionType,
  ToolBoundaryRegistry,
} from "./types.js";

// ─── 阶段排序 ───

/**
 * 阶段在数组中的位置。
 * post-execute 最前（onion 最外层），authorize 次之，guard 最内。
 * 关键：post-execute 的中间件以 `await next(); emit events` 的形态工作，
 * 必须在最外层才能在其他中间件 return 后观察到最终状态。
 */
const PHASE_ORDER: Record<SecurityMiddleware["phase"], number> = {
  "post-execute": 0,
  authorize: 1,
  guard: 2,
};

// ─── Policy Evaluator 中间件 ───

/**
 * 策略评估中间件——authorize 阶段第一步。
 * 调用 PolicyEngine 把决策写入 ctx.state.decision。
 * 仅在 block 时短路（避免执行后续的 guard 阶段的文件系统调用）。
 */
class PolicyEvaluatorMiddleware implements SecurityMiddleware {
  readonly name = "PolicyEvaluator";
  readonly phase = "authorize" as const;
  readonly order = 0;

  constructor(private readonly engine: PolicyEngine) {}

  async execute(
    ctx: SecurityMiddlewareContext,
    next: () => Promise<SecurityMiddlewareResult>,
  ): Promise<SecurityMiddlewareResult> {
    const decision = this.engine.evaluate(ctx.request);
    ctx.state.decision = decision;

    if (decision.action === "block") {
      // 短路：不执行 guard 阶段的副作用（filesystem realpath 等）
      // 但 post-execute 的 auditor 在 onion 外层，仍会观察到此 state
      return {
        allowed: false,
        requiresConfirmation: false,
        decision,
        reason: decision.reason,
      };
    }

    return next();
  }
}

// ─── Operation Classifier 中间件 ───

/**
 * 操作分类中间件——authorize 阶段第二步，PolicyEvaluator 之后。
 * 将影响等级写入 ctx.state.operationClass，并按需升级当前决策：
 * - observe / internal：不改决策（放行）
 * - external / critical：若当前决策是 allow，升级为 confirm
 *
 * 不处理 block —— block 已由 PolicyEvaluator 短路。
 */
class OperationClassifierMiddleware implements SecurityMiddleware {
  readonly name = "OperationClassifier";
  readonly phase = "authorize" as const;
  readonly order = 10;

  constructor(private readonly classifier: OperationClassifier) {}

  async execute(
    ctx: SecurityMiddlewareContext,
    next: () => Promise<SecurityMiddlewareResult>,
  ): Promise<SecurityMiddlewareResult> {
    const operationClass = this.classifier.classify(ctx.request);
    ctx.state.operationClass = operationClass;

    if (operationClass === "external" || operationClass === "critical") {
      const current = ctx.state.decision;
      if (!current || current.action === "allow") {
        ctx.state.decision = this.upgradeDecision(current, operationClass);
      }
    }

    return next();
  }

  private upgradeDecision(
    current: SecurityDecision | undefined,
    operationClass: OperationClass,
  ): SecurityDecision {
    const riskLevel = operationClass === "critical" ? "critical" : "medium";
    const reason =
      operationClass === "critical"
        ? "操作影响范围为 critical，需要用户确认"
        : "操作影响范围为 external，需要用户确认";

    return {
      action: "confirm",
      matchedRules: current?.matchedRules ?? [],
      reason: current?.reason ?? reason,
      riskLevel: current?.riskLevel
        ? this.maxRisk(current.riskLevel, riskLevel)
        : riskLevel,
      suggestion: current?.suggestion,
    };
  }

  private maxRisk(
    a: "low" | "medium" | "high" | "critical",
    b: "low" | "medium" | "high" | "critical",
  ): "low" | "medium" | "high" | "critical" {
    const order = ["low", "medium", "high", "critical"] as const;
    return order.indexOf(a) >= order.indexOf(b) ? a : b;
  }
}

// ─── 管线选项 ───

export interface SecurityPipelineOptions {
  /** 事件总线（用于审计事件发射） */
  eventBus?: IEventBus<AgentEventMapWithSecurity>;
  /** 额外的自定义中间件 */
  middlewares?: SecurityMiddleware[];
  /** 会话类型 */
  sessionType?: SessionType;
  /** 工作区路径 */
  workspace?: string | null;
  /**
   * 操作分类器。未提供时使用默认分类器（FS + Shell + 空边界注册表）。
   * 生产环境应注入真实的 ToolBoundaryRegistry，让 MCP 工具能被正确分类。
   */
  classifier?: OperationClassifier;
  /**
   * 工具边界注册表。当未提供 classifier 时用于构造默认分类器。
   */
  toolBoundaryRegistry?: ToolBoundaryRegistry;
  /**
   * 权限规则存储。未提供时使用 in-memory 默认 store（rootDir=null）。
   * 生产环境应显式构造 `new PermissionStore({})` 以启用 ~/.zhixing/permissions/ 持久化。
   */
  permissionStore?: IPermissionStore;
}

/**
 * 安全管线 — Phase 2 实现。
 *
 * 使用方式：
 *   const pipeline = new SecurityPipeline({ workspace, eventBus });
 *   const result = await pipeline.evaluate(toolName, toolInput, cwd);
 *   if (!result.allowed) reject(result.reason);
 *   else if (result.requiresConfirmation) askUser();
 *   else execute();
 */
export class SecurityPipeline {
  private readonly middlewares: SecurityMiddleware[];
  private readonly policyEngine: PolicyEngine;
  private readonly classifier: OperationClassifier;
  private readonly permissionStore: IPermissionStore;
  private readonly sessionType: SessionType;
  private readonly workspace: string | null;
  private readonly workspaceId: string | null;

  constructor(options: SecurityPipelineOptions = {}) {
    this.policyEngine = new PolicyEngine();
    this.sessionType = options.sessionType ?? "interactive";
    this.workspace = options.workspace ?? null;
    this.workspaceId = this.workspace
      ? PermissionStore.workspaceIdFromPath(this.workspace)
      : null;
    this.classifier =
      options.classifier ??
      createDefaultClassifier({ registry: options.toolBoundaryRegistry });
    // 默认 store 是纯内存的——生产代码显式传入持久化 store 以避免污染测试环境
    this.permissionStore =
      options.permissionStore ?? new PermissionStore({ rootDir: null });

    // 组装中间件管线
    const middlewares: SecurityMiddleware[] = [
      new PolicyEvaluatorMiddleware(this.policyEngine),
      new OperationClassifierMiddleware(this.classifier),
      new PermissionMatcherMiddleware(
        this.permissionStore,
        () => this.workspaceId,
      ),
      new EnvSanitize(),
      new PathGuard(),
    ];

    // 审计器（post-execute）作为 onion 最外层包装其他中间件
    if (options.eventBus) {
      middlewares.push(new SecurityAuditor(options.eventBus));
    }

    // 追加用户自定义中间件
    if (options.middlewares) {
      middlewares.push(...options.middlewares);
    }

    // 按阶段和 order 稳定排序
    middlewares.sort((a, b) => {
      const phaseDiff = PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase];
      if (phaseDiff !== 0) return phaseDiff;
      return a.order - b.order;
    });

    this.middlewares = middlewares;
  }

  /**
   * 对一个工具调用执行安全评估管线。
   */
  async evaluate(
    toolName: string,
    toolInput: Record<string, unknown>,
    workingDirectory: string,
  ): Promise<SecurityMiddlewareResult> {
    const request: SecurityRequest = {
      tool: toolName,
      arguments: toolInput,
      context: {
        cwd: workingDirectory,
        workspace: this.workspace,
        sessionType: this.sessionType,
      },
    };

    const ctx: SecurityMiddlewareContext = {
      request,
      toolName,
      toolInput,
      workingDirectory,
      state: {},
    };

    return this.runPipeline(ctx, 0);
  }

  /** 获取策略引擎实例（用于加载额外规则） */
  getPolicyEngine(): PolicyEngine {
    return this.policyEngine;
  }

  /** 获取操作分类器实例 */
  getClassifier(): OperationClassifier {
    return this.classifier;
  }

  /** 获取权限规则存储（用于 /trust 命令、CLI 规则管理） */
  getPermissionStore(): IPermissionStore {
    return this.permissionStore;
  }

  /** 获取当前工作区的稳定 ID（用于创建 workspace 作用域规则） */
  getWorkspaceId(): string | null {
    return this.workspaceId;
  }

  /** 获取所有中间件（用于调试和测试） */
  getMiddlewares(): readonly SecurityMiddleware[] {
    return this.middlewares;
  }

  /**
   * 递归执行中间件链。
   * 每个中间件通过 next() 调用下一个，形成洋葱模型。
   * 到达链底时从累积的 ctx.state 构造最终结果。
   */
  private async runPipeline(
    ctx: SecurityMiddlewareContext,
    index: number,
  ): Promise<SecurityMiddlewareResult> {
    if (index >= this.middlewares.length) {
      return this.buildFinalResult(ctx);
    }

    const middleware = this.middlewares[index]!;
    return middleware.execute(ctx, () => this.runPipeline(ctx, index + 1));
  }

  /**
   * 从 ctx.state 构造最终结果。
   * 决策优先级：block → confirm → allow。allow 是默认。
   */
  private buildFinalResult(
    ctx: SecurityMiddlewareContext,
  ): SecurityMiddlewareResult {
    const decision = ctx.state.decision;
    const action = decision?.action ?? "allow";

    return {
      allowed: action !== "block",
      requiresConfirmation: action === "confirm",
      operationClass: ctx.state.operationClass,
      decision,
      matchedPermissionRule: ctx.state.matchedPermissionRule,
      reason: decision?.reason,
      sanitizedEnv: ctx.state.sanitizedEnv,
      resolvedPaths: ctx.state.resolvedPaths,
    };
  }
}

/** 导出给测试和集成使用的类型 */
export type { CompositeClassifier };
