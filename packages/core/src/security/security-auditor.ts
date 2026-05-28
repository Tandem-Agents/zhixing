/**
 * 安全审计器 —— run 级审计发射器
 *
 * 拿到一次工具调用的安全决策结果后，把安全事件发射到 EventBus。不做决策、
 * 不阻止操作——纯粹的可观测性组件，由 secure-executor 在每次工具调用的
 * 决策评估后调用。
 *
 * 设计要点：
 *   - run 级实例：由 create-agent-runtime 在每次 run 的 per-run eventBus 上实例化，
 *     生命周期与 eventBus 对齐（pipeline 是 runtime 级、跨 run 复用，不能持 per-run eventBus）。
 *   - 通过 AgentEventMap（已并入 SecurityEventMap）的 eventBus 发射，安全事件
 *     与 agent 运行事件同流，可被 renderer / accumulator / 任意订阅者消费。
 *   - 发射器 ≠ sink：本组件只 emit，落地（日志/UI/存储）由订阅者按需实现，可插拔。
 *
 * 发射的事件：
 *   - security:evaluation        每次策略评估的结果
 *   - security:classified        操作影响分类
 *   - security:permission_matched 命中用户权限规则
 *   - security:blocked           操作被阻止
 *   - security:path_resolved     路径规范化
 *   - security:steward_review    AI 安全管家的三态研判裁决
 */

import type { IEventBus } from "../events/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
import { PathGuard } from "./path-guard.js";
import type { TrustContext } from "./trust.js";
import { workspaceDirOf } from "./trust.js";
import type {
  PermissionContextId,
  PermissionScope,
  SecurityMiddlewareResult,
  TrustContribution,
} from "./types.js";

export class SecurityAuditor {
  constructor(private readonly eventBus: IEventBus<AgentEventMap>) {}

  /**
   * 发射一次 pipeline 安全决策评估的事件流（evaluation / classified /
   * permission_matched / blocked / path_resolved）。
   */
  async auditEvaluation(params: {
    toolName: string;
    toolInput: Record<string, unknown>;
    result: SecurityMiddlewareResult;
    trust: TrustContext;
    cwd: string;
    durationMs: number;
  }): Promise<void> {
    const { toolName, toolInput, result, trust, cwd, durationMs } = params;
    const decision = result.decision;
    const operation = describeOperation(toolName, toolInput);

    if (decision) {
      const operationClass = result.operationClass;

      await this.eventBus.emit("security:evaluation", {
        tool: toolName,
        operation,
        riskLevel: decision.riskLevel,
        decision: decision.action,
        matchedRules: decision.matchedRules.map((r) => r.id),
        duration: durationMs,
        operationClass,
      });

      if (operationClass) {
        await this.eventBus.emit("security:classified", {
          tool: toolName,
          operation,
          operationClass,
        });
      }

      const matchedPermRule = result.matchedPermissionRule;
      if (matchedPermRule) {
        await this.eventBus.emit("security:permission_matched", {
          tool: toolName,
          operation,
          ruleId: matchedPermRule.id,
          decision: matchedPermRule.decision,
          scope: matchedPermRule.scope,
        });
      }

      if (decision.action === "block") {
        await this.eventBus.emit("security:blocked", {
          tool: toolName,
          operation,
          reason: decision.reason,
          riskLevel: decision.riskLevel,
          matchedRules: decision.matchedRules.map((r) => r.id),
        });
      }
    }

    const resolvedPaths = result.resolvedPaths;
    if (resolvedPaths && resolvedPaths.length > 0) {
      const workspace = workspaceDirOf(trust);
      const originalPath = getOriginalPath(toolInput);
      for (const resolvedPath of resolvedPaths) {
        await this.eventBus.emit("security:path_resolved", {
          originalPath: originalPath ?? resolvedPath,
          resolvedPath,
          withinWorkspace: workspace
            ? PathGuard.isWithinWorkspace(resolvedPath, workspace, cwd)
            : false,
        });
      }
    }
  }

  /**
   * 发射 AI 安全管家的三态研判裁决事件（safe / needs-confirm / escalate）。
   * 由 secure-executor 在管家研判后调用（管家在 orchestrator 层、不属 pipeline）。
   */
  async auditStewardReview(params: {
    toolName: string;
    toolInput: Record<string, unknown>;
    decision: "safe" | "needs-confirm" | "escalate";
    reason: string;
    confidence: number;
  }): Promise<void> {
    await this.eventBus.emit("security:steward_review", {
      tool: params.toolName,
      operation: describeOperation(params.toolName, params.toolInput),
      decision: params.decision,
      reason: params.reason,
      confidence: params.confidence,
    });
  }

  /**
   * 发射自动信任沉淀事件 —— 累积阈值跨过那一刻产生持久放行规则。
   * 仅自动沉淀路径发射；用户在 confirm 弹窗显式选 allow-context / allow-global
   * 直接建规则不发射（用户主动行为无需事后提示）。
   */
  async auditRuleSedimented(params: {
    toolName: string;
    toolInput: Record<string, unknown>;
    pattern: { tool: string; argument: string };
    scope: PermissionScope;
    contextId: PermissionContextId;
    ruleId: string;
    contributors: TrustContribution[];
  }): Promise<void> {
    await this.eventBus.emit("security:rule_sedimented", {
      tool: params.toolName,
      operation: describeOperation(params.toolName, params.toolInput),
      pattern: params.pattern,
      scope: params.scope,
      contextId: params.contextId,
      ruleId: params.ruleId,
      contributors: params.contributors,
    });
  }
}

function describeOperation(
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (toolName === "bash" && typeof args["command"] === "string") {
    const cmd = args["command"];
    return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
  }
  if (typeof args["path"] === "string") {
    return `${toolName}: ${args["path"]}`;
  }
  return toolName;
}

function getOriginalPath(args: Record<string, unknown>): string | null {
  if (typeof args["path"] === "string") return args["path"];
  if (typeof args["file_path"] === "string") return args["file_path"];
  if (typeof args["target"] === "string") return args["target"];
  return null;
}
