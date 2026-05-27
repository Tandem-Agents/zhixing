/**
 * 信任等级分类器 —— 计算当前操作的有效信任级。
 *
 * 与操作影响分类（OperationClass）正交：影响看操作本身有多大破坏力，信任看用户
 * 在当前上下文授予了多少放宽空间。本中间件只产出 trustLevel、不做决策。
 *
 * - scene：用户主动进入工作场景，整会话生效、不依赖路径。
 * - workspace：操作目标路径全部落在工作目录内才算工作区信任；任一逃出即降为 global。
 * - global：无信任锚。
 *
 * 无路径的操作（如 bash）在 scene 下取 scene、否则取 global —— workspace 是路径锚，
 * 不锚无路径操作（其便利由信任沉淀提供，而非 per-operation 等级）。
 */

import { PathGuard } from "./path-guard.js";
import type { TrustLevel } from "./trust.js";
import type {
  SecurityMiddleware,
  SecurityMiddlewareContext,
  SecurityMiddlewareResult,
  SecurityRequest,
} from "./types.js";

export class TrustClassifierMiddleware implements SecurityMiddleware {
  readonly name = "TrustClassifier";
  readonly phase = "authorize" as const;
  readonly order = 15;

  async execute(
    ctx: SecurityMiddlewareContext,
    next: () => Promise<SecurityMiddlewareResult>,
  ): Promise<SecurityMiddlewareResult> {
    ctx.state.trustLevel = this.classify(ctx.request);
    return next();
  }

  private classify(request: SecurityRequest): TrustLevel {
    const trust = request.context.trust;
    switch (trust.kind) {
      case "scene":
        return "scene";
      case "global":
        return "global";
      case "workspace": {
        const paths = request.resolvedAccess?.paths ?? [];
        if (paths.length === 0) return "global";
        const allInside = paths.every((p) =>
          PathGuard.isWithinWorkspace(p, trust.dir, request.context.cwd),
        );
        return allInside ? "workspace" : "global";
      }
    }
  }
}
