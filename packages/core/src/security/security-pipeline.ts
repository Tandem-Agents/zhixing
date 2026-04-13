/**
 * 安全中间件管线
 *
 * 将策略评估、环境净化、路径守卫、审计记录等中间件按阶段串联执行。
 * Phase 1 管线：输入验证 → [策略评估] → [环境净化] → [路径守卫] → 执行 → [审计记录]
 *
 * 管线设计：
 * - authorize 阶段：策略引擎评估，决定 allow/confirm/block
 * - guard 阶段：环境净化、路径规范化等执行前保护
 * - post-execute 阶段：审计日志记录
 */

import type { IEventBus } from "../events/types.js";
import { EnvSanitize } from "./env-sanitize.js";
import { PathGuard } from "./path-guard.js";
import { PolicyEngine } from "./policy-engine.js";
import type { AgentEventMapWithSecurity } from "./security-auditor.js";
import { SecurityAuditor } from "./security-auditor.js";
import type {
  SecurityMiddleware,
  SecurityMiddlewareContext,
  SecurityMiddlewareResult,
  SecurityRequest,
  SessionType,
} from "./types.js";

/**
 * 策略评估中间件——authorize 阶段。
 * 调用 PolicyEngine 评估请求，将决策结果放入 ctx.state。
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
      return {
        allowed: false,
        reason: decision.reason,
      };
    }

    return next();
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
}

/**
 * 安全管线——Phase 1 实现。
 *
 * 创建管线实例后，对每个工具调用执行 evaluate() 方法。
 * 管线按阶段顺序执行所有中间件：authorize → guard → post-execute。
 */
export class SecurityPipeline {
  private readonly middlewares: SecurityMiddleware[];
  private readonly policyEngine: PolicyEngine;
  private readonly sessionType: SessionType;
  private readonly workspace: string | null;

  constructor(options: SecurityPipelineOptions = {}) {
    this.policyEngine = new PolicyEngine();
    this.sessionType = options.sessionType ?? "interactive";
    this.workspace = options.workspace ?? null;

    // 组装中间件管线
    this.middlewares = [
      new PolicyEvaluatorMiddleware(this.policyEngine),
      new EnvSanitize(),
      new PathGuard(),
    ];

    // 审计器依赖 EventBus
    if (options.eventBus) {
      this.middlewares.push(new SecurityAuditor(options.eventBus));
    }

    // 追加自定义中间件
    if (options.middlewares) {
      this.middlewares.push(...options.middlewares);
    }

    // 按阶段和顺序排序
    this.middlewares.sort((a, b) => {
      const phaseOrder = { authorize: 0, guard: 1, "post-execute": 2 };
      const phaseDiff =
        (phaseOrder[a.phase] ?? 0) - (phaseOrder[b.phase] ?? 0);
      if (phaseDiff !== 0) return phaseDiff;
      return a.order - b.order;
    });
  }

  /**
   * 对一个工具调用执行安全评估管线。
   * 返回是否允许执行以及相关的安全信息。
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

  /** 获取所有中间件（用于调试和测试） */
  getMiddlewares(): readonly SecurityMiddleware[] {
    return this.middlewares;
  }

  /**
   * 递归执行中间件链。
   * 每个中间件通过 next() 调用下一个，形成洋葱模型。
   */
  private async runPipeline(
    ctx: SecurityMiddlewareContext,
    index: number,
  ): Promise<SecurityMiddlewareResult> {
    if (index >= this.middlewares.length) {
      return { allowed: true };
    }

    const middleware = this.middlewares[index]!;

    return middleware.execute(ctx, () => this.runPipeline(ctx, index + 1));
  }
}
