/**
 * 安全审计器
 *
 * 在安全决策流程的最后阶段，将安全事件发射到 EventBus。
 * 不做决策、不阻止操作——纯粹的可观测性组件。
 *
 * 发射的事件：
 * - security:evaluation — 每次策略评估的结果
 * - security:blocked — 操作被阻止时
 * - security:env_sanitized — 环境变量被净化时
 * - security:path_resolved — 路径被规范化时
 */

import type { IEventBus } from "../events/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
import type {
  SecurityAction,
  SecurityEventMap,
  SecurityMiddleware,
  SecurityMiddlewareContext,
  SecurityMiddlewareResult,
} from "./types.js";

/**
 * 扩展后的事件映射表，包含安全事件。
 * 使用交叉类型将安全事件合并到 AgentEventMap。
 */
import * as path from "node:path";

export type AgentEventMapWithSecurity = AgentEventMap & SecurityEventMap;

export class SecurityAuditor implements SecurityMiddleware {
  readonly name = "SecurityAuditor";
  readonly phase = "post-execute" as const;
  readonly order = 100;

  constructor(
    private readonly eventBus: IEventBus<AgentEventMapWithSecurity>,
  ) {}

  async execute(
    ctx: SecurityMiddlewareContext,
    next: () => Promise<SecurityMiddlewareResult>,
  ): Promise<SecurityMiddlewareResult> {
    const startTime = performance.now();

    const result = await next();

    const duration = performance.now() - startTime;
    const decision = ctx.state.decision;

    if (decision) {
      const action: SecurityAction = decision.action;
      const operationClass = ctx.state.operationClass;

      // 发射评估事件
      await this.eventBus.emit("security:evaluation", {
        tool: ctx.toolName,
        operation: this.describeOperation(ctx),
        riskLevel: decision.riskLevel,
        decision: action,
        matchedRules: decision.matchedRules.map((r) => r.id),
        duration,
        operationClass,
      });

      // 发射分类事件（Phase 2）
      if (operationClass) {
        await this.eventBus.emit("security:classified", {
          tool: ctx.toolName,
          operation: this.describeOperation(ctx),
          operationClass,
        });
      }

      // 发射权限匹配事件（Phase 2）
      const matchedPermRule = ctx.state.matchedPermissionRule;
      if (matchedPermRule) {
        await this.eventBus.emit("security:permission_matched", {
          tool: ctx.toolName,
          operation: this.describeOperation(ctx),
          ruleId: matchedPermRule.id,
          decision: matchedPermRule.decision,
          scope: matchedPermRule.scope,
        });
      }

      // 操作被阻止时发射专门事件
      if (action === "block") {
        await this.eventBus.emit("security:blocked", {
          tool: ctx.toolName,
          operation: this.describeOperation(ctx),
          reason: decision.reason,
          riskLevel: decision.riskLevel,
          matchedRules: decision.matchedRules.map((r) => r.id),
        });
      }
    }

    // 环境变量净化事件
    const removedVars = ctx.state.removedEnvVars as string[] | undefined;
    if (removedVars && removedVars.length > 0) {
      await this.eventBus.emit("security:env_sanitized", {
        removedVars,
        tool: ctx.toolName,
      });
    }

    // 路径规范化事件
    const resolvedPaths = ctx.state.resolvedPaths as string[] | undefined;
    if (resolvedPaths) {
      for (const resolvedPath of resolvedPaths) {
        await this.eventBus.emit("security:path_resolved", {
          originalPath: this.getOriginalPath(ctx) ?? resolvedPath,
          resolvedPath,
          withinWorkspace: this.checkWithinWorkspace(
            resolvedPath,
            ctx.request.context.workspace,
          ),
        });
      }
    }

    return result;
  }

  private describeOperation(ctx: SecurityMiddlewareContext): string {
    const args = ctx.toolInput;

    if (ctx.toolName === "bash" && typeof args["command"] === "string") {
      const cmd = args["command"];
      return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
    }

    if (typeof args["path"] === "string") {
      return `${ctx.toolName}: ${args["path"]}`;
    }

    return ctx.toolName;
  }

  private getOriginalPath(ctx: SecurityMiddlewareContext): string | null {
    const args = ctx.toolInput;
    if (typeof args["path"] === "string") return args["path"];
    if (typeof args["file_path"] === "string") return args["file_path"];
    if (typeof args["target"] === "string") return args["target"];
    return null;
  }

  private checkWithinWorkspace(
    resolvedPath: string,
    workspace: string | null,
  ): boolean {
    if (!workspace) return false;

    const normalizedWorkspace = path.normalize(path.resolve(workspace));
    return (
      resolvedPath.startsWith(normalizedWorkspace + path.sep) ||
      resolvedPath === normalizedWorkspace
    );
  }
}
