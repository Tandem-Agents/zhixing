/**
 * 权限匹配中间件 — Phase 2
 *
 * authorize 阶段第三步：在 PolicyEvaluator + OperationClassifier 之后查询 PermissionStore，
 * 使 deny 规则在 observe / internal / confirm 全路径统一短路生效，allow 规则仅对 confirm 放行。
 *
 * ── 决策流程 ──
 * 1. decision.action === "block" → 已由上游硬阻断，直接透传
 * 2. 匹配到 deny 规则 → 无论上游是 allow(observe/internal) 还是 confirm，一律置为 block 并短路
 * 3. decision.action !== "confirm" → 无 deny 命中时保持上游 allow/undefined 透传
 * 4. confirm + 匹配到 allow 规则 → 升级为 allow（requiresExplicitConfirmation 工具除外）
 * 5. confirm + 无匹配 + interactive → 保持 confirm（上层 UI 处理）
 * 6. confirm + 无匹配 + ci/gateway/api → 降级为 block（非交互无 UI 可用）
 *
 * ── 会话类型策略（规格 §4.5） ──
 * interactive  — 弹出确认
 * ci / gateway / api — 直接拒绝（越界操作必须有预先配置的规则）
 */

import type {
  PermissionRuleExecutionSource,
  SecurityDecision,
  SecurityMiddleware,
  SecurityMiddlewareContext,
  SecurityMiddlewareResult,
} from "./types.js";

export class PermissionMatcherMiddleware implements SecurityMiddleware {
  readonly name = "PermissionMatcher";
  readonly phase = "authorize" as const;
  readonly order = 20;

  constructor(
    private readonly rules: PermissionRuleExecutionSource,
  ) {}

  async execute(
    ctx: SecurityMiddlewareContext,
    next: () => Promise<SecurityMiddlewareResult>,
  ): Promise<SecurityMiddlewareResult> {
    const current = ctx.state.decision;

    // 已由 PolicyEngine 等上游规则硬阻断时，不再重复匹配
    if (current?.action === "block") {
      return next();
    }

    const matched = ctx.permissionRules === undefined
      ? this.rules.match(ctx.request)
      : this.rules.matchFrozen(ctx.permissionRules, ctx.request);

    if (matched) {
      if (matched.decision === "deny") {
        // 全等级 deny 短路：无论当前是 confirm 还是 observe/internal(allow)，
        // 用户 deny 规则始终立即 block 并跳过 guards。
        ctx.state.matchedPermissionRule = matched;
        const blockDecision: SecurityDecision = {
          ...(current ?? {
            matchedRules: [],
            riskLevel: "low" as const,
          }),
          action: "block",
          reason: `被权限规则拒绝 "${matched.pattern.tool} ${matched.pattern.argument}" (${matched.scope})`,
        };
        ctx.state.decision = blockDecision;
        return {
          allowed: false,
          requiresConfirmation: false,
          operationClass: ctx.state.operationClass,
          trustLevel: ctx.state.trustLevel,
          decision: blockDecision,
          matchedPermissionRule: matched,
          reason: blockDecision.reason,
          resolvedPaths: ctx.state.resolvedPaths,
        };
      }

      // allow 仅对 confirm 决策生效升级；observe/internal 的原本 allow 保持不变
      if (current?.action === "confirm") {
        ctx.state.matchedPermissionRule = matched;
        const hasBypassImmune = current.matchedRules.some((r) => r.bypassImmune);
        if (hasBypassImmune) {
          return next();
        }

        // 升级为 allow，guards 仍需运行（准备 sanitized env / resolved paths）
        ctx.state.decision = {
          ...current,
          action: "allow",
          reason: `已匹配权限规则 "${matched.pattern.tool} ${matched.pattern.argument}" (${matched.scope})`,
        };
        return next();
      }
    }

    // 无匹配规则（或非 confirm 仅命中 allow）：维持原决策交由后续链路处理
    return next();
  }
}
