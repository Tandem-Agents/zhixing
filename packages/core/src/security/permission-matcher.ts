/**
 * 权限匹配中间件 — Phase 2
 *
 * authorize 阶段第三步：当 PolicyEvaluator + OperationClassifier 产出 confirm 决策时，
 * 查询 PermissionStore 看用户是否创建过匹配的权限规则。
 *
 * ── 决策流程 ──
 * 1. decision.action !== "confirm"  → 无需介入（allow/block 已定）
 * 2. 匹配到 allow 规则 → 升级为 allow，继续执行
 * 3. 匹配到 deny 规则  → 降级为 block，短路（不执行 guards）
 * 4. 无匹配 + interactive  → 保持 confirm（上层 UI 处理）
 * 5. 无匹配 + ci/gateway/api → 降级为 block（非交互无 UI 可用）
 *
 * ── 会话类型策略（规格 §4.5） ──
 * interactive  — 弹出确认
 * ci / gateway / api — 直接拒绝（越界操作必须有预先配置的规则）
 */

import type {
  IPermissionStore,
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
    private readonly store: IPermissionStore,
    /** 返回当前工作区 ID 的 getter（null 表示无工作区上下文） */
    private readonly getWorkspaceId: () => string | null,
  ) {}

  async execute(
    ctx: SecurityMiddlewareContext,
    next: () => Promise<SecurityMiddlewareResult>,
  ): Promise<SecurityMiddlewareResult> {
    const current = ctx.state.decision;

    // 只在需要确认时介入——allow/block 决策与权限规则无关
    if (!current || current.action !== "confirm") {
      return next();
    }

    const workspaceId = this.getWorkspaceId();
    const matched = this.store.match(workspaceId, ctx.request);

    if (matched) {
      ctx.state.matchedPermissionRule = matched;

      if (matched.decision === "allow") {
        // bypassImmune 规则的 confirm 决策不可被权限规则自动放行——
        // 改变工作区信任边界、访问密钥目录等操作必须每次确认。
        const hasBypassImmune = current.matchedRules.some(r => r.bypassImmune);
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

      // deny：短路避免 guards 做无谓的文件系统调用
      const blockDecision: SecurityDecision = {
        ...current,
        action: "block",
        reason: `被权限规则拒绝 "${matched.pattern.tool} ${matched.pattern.argument}" (${matched.scope})`,
      };
      ctx.state.decision = blockDecision;
      return {
        allowed: false,
        requiresConfirmation: false,
        operationClass: ctx.state.operationClass,
        decision: blockDecision,
        matchedPermissionRule: matched,
        reason: blockDecision.reason,
      };
    }

    // 无匹配规则：按会话类型决定
    const sessionType = ctx.request.context.sessionType;
    if (sessionType !== "interactive") {
      const blockDecision: SecurityDecision = {
        ...current,
        action: "block",
        reason: `${sessionType} 模式下无匹配权限规则，非交互环境默认拒绝`,
      };
      ctx.state.decision = blockDecision;
      return {
        allowed: false,
        requiresConfirmation: false,
        operationClass: ctx.state.operationClass,
        decision: blockDecision,
        reason: blockDecision.reason,
      };
    }

    // interactive + 无匹配：保持 confirm，上层弹 UI
    return next();
  }
}
